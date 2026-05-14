import axios from "axios";
import { FlipImage } from "./flip.js";
import { pximgProxy } from "../config/api.js"; 

export async function sendPixivImageWithFallback(target, initialMsg, originalUrls, recallConfig = { recall: false, time: 60000 }) {
    const isEvent = !!target.reply;
    
    const sendMsg = async (msg) => isEvent ? await target.reply(msg).catch(() => null) : await target.sendMsg(msg).catch(() => null);
    const makeForwardMsg = async (nodes) => {
        try {
            if (isEvent) return target.isGroup ? await target.group.makeForwardMsg(nodes) : await target.friend.makeForwardMsg(nodes);
            return await target.makeForwardMsg(nodes);
        } catch (err) { return null; }
    };
    const recallMsg = (msgId) => {
        try {
            if (isEvent) target.isGroup ? target.group.recallMsg(msgId) : target.friend.recallMsg(msgId);
            else target.recallMsg(msgId);
        } catch(e) {}
    };

    const uin = isEvent ? target.user_id : (global.Bot?.uin || 123456);
    const name = isEvent ? (target.sender?.card || target.sender?.nickname || "用户") : (global.Bot?.nickname || "Bot");
    const makeNode = (content) => ({ message: content, nickname: String(name), user_id: Number(uin) });

    let proxyUrlsCache = originalUrls.map(url => pximgProxy(url));

    // 【终极防御：物理剥离】
    // 将文案和直链彻底脱离合并转发，作为第一条独立消息直接糊脸！
    // 这样无论后续图片怎么炸裂、断连，信息和链接都 100% 稳稳到达群内。
    let textMsg = [...initialMsg, `\n风控时请戳反代直链：\n${proxyUrlsCache.join("\n")}`];
    let sentMsgIds = [];
    
    let textRes = await sendMsg(textMsg);
    if (textRes && textRes.message_id) sentMsgIds.push(textRes.message_id);

    let imgBuffers = [];
    for (let i = 0; i < originalUrls.length; i++) {
        const rawUrl = originalUrls[i];
        const backupUrl = proxyUrlsCache[i]; 

        try {
            const imgRes = await axios.get(rawUrl, { responseType: "arraybuffer", timeout: 15000, headers: { "Referer": "https://app-api.pixiv.net/" } });
            imgBuffers.push(imgRes.data);
        } catch (err1) {
            try {
                const imgRes2 = await axios.get(backupUrl, { responseType: "arraybuffer", timeout: 15000 });
                imgBuffers.push(imgRes2.data);
            } catch (err2) {}
        }
    }

    if (imgBuffers.length === 0) {
        let failRes = await sendMsg("⚠️ 图片全节点下载失败，请直接通过上方直链查看。");
        if (failRes && failRes.message_id) sentMsgIds.push(failRes.message_id);
        return false;
    }

    // 分批合并转发（只放图片，不放任何文字）
    const chunkArray = (arr, size) => Array.from({ length: Math.ceil(arr.length / size) }, (v, i) => arr.slice(i * size, i * size + size));
    const bufferChunks = chunkArray(imgBuffers, 5);
    
    let allSuccess = true;
    for (let i = 0; i < bufferChunks.length; i++) {
        let forwardNodes = [];
        for (let buf of bufferChunks[i]) {
            forwardNodes.push(makeNode([segment.image(buf)]));
        }
        
        let forwardMsg = await makeForwardMsg(forwardNodes);
        let res = forwardMsg ? await sendMsg(forwardMsg) : null;
        
        if (res && res.message_id) sentMsgIds.push(res.message_id);
        if (!res || res.message_id === undefined) allSuccess = false;
        
        if (i < bufferChunks.length - 1) await new Promise(r => setTimeout(r, 2000));
    }

    // 翻转兜底 (不再发多余的提示文本去撞断网的枪口，默默在后台处理)
    if (!allSuccess) {
        let flippedNodes = [];
        for (let buf of imgBuffers) {
            try {
                const flippedBuffer = await FlipImage(buf);
                if (flippedBuffer) {
                    flippedNodes.push(makeNode([segment.image(flippedBuffer)]));
                }
            } catch (e) {
                // 防止超大分辨率在翻转时 OOM 炸毁 Node.js
            }
        }

        if (flippedNodes.length > 0) {
            let retryForward = await makeForwardMsg(flippedNodes);
            let res = retryForward ? await sendMsg(retryForward) : null;
            if (res && res.message_id) sentMsgIds.push(res.message_id);
        } 
    }

    // 统一撤回控制 (到点后，把刚才独立发的文字和所有的合并转发气泡一起清空)
    if (recallConfig && recallConfig.recall && sentMsgIds.length > 0) {
        setTimeout(() => {
            for (let msgId of sentMsgIds) recallMsg(msgId);
        }, recallConfig.time || 60000);
    }

    imgBuffers = null; 
    return sentMsgIds.length > 0;
}