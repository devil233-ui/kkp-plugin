import axios from "axios";
import fs from "fs";
import path from "path";
import { FlipImage } from "./flip.js";
import { pximgProxy } from "../config/api.js"; 

export async function sendPixivImageWithFallback(target, initialMsg, originalUrls, recallConfig = { recall: false, time: 60000 }) {
    const isEvent = !!target.reply;
    
    // 基础消息与撤回 API
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

    const sendFileMsg = async (filePath) => {
        try {
            if (isEvent) {
                if (target.isGroup && target.group?.sendFile) await target.group.sendFile(filePath);
                else if (!target.isGroup && target.friend?.sendFile) await target.friend.sendFile(filePath);
            } else {
                if (target.sendFile) await target.sendFile(filePath);
            }
        } catch (err) { }
    };

    const uin = isEvent ? target.user_id : (global.Bot?.uin || 123456);
    const name = isEvent ? (target.sender?.card || target.sender?.nickname || "用户") : (global.Bot?.nickname || "Bot");
    const makeNode = (content) => ({ message: content, nickname: String(name), user_id: Number(uin) });

    const tempDir = path.resolve("./temp/kkp-plugin");
    if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

    let proxyUrlsCache = originalUrls.map(url => pximgProxy(url));
    let localFiles = [];
    let pixelBombs = []; 
    let sentMsgIds = [];

    // 1. 文字打包进合并转发 
    let textMsg = [...initialMsg, `\n风控时请戳反代直链：\n${proxyUrlsCache.join("\n")}`];
    let textForward = await makeForwardMsg([makeNode(textMsg)]);
    
    let textRes = await sendMsg(textForward || textMsg); 
    if (textRes && textRes.message_id) sentMsgIds.push(textRes.message_id);

    // 2. 下载至本地，扫描体积雷达
    for (let i = 0; i < originalUrls.length; i++) {
        const rawUrl = originalUrls[i];
        const backupUrl = proxyUrlsCache[i]; 
        
        let filePrefix = `${Date.now()}_p${i}`;
        const match = rawUrl.match(/(\d+)_p(\d+)/);
        if (match) filePrefix = `${match[1]}_p${match[2]}`;
        
        const filePath = path.join(tempDir, `${filePrefix}.png`); 

        let buf = null;
        try {
            const imgRes = await axios.get(rawUrl, { responseType: "arraybuffer", timeout: 15000, headers: { "Referer": "https://app-api.pixiv.net/" } });
            buf = imgRes.data;
        } catch (err1) {
            try {
                const imgRes2 = await axios.get(backupUrl, { responseType: "arraybuffer", timeout: 15000 });
                buf = imgRes2.data;
            } catch (err2) {}
        }

        if (buf) {
            fs.writeFileSync(filePath, buf);
            localFiles.push(filePath);
            
            // 【调整阈值为 10MB】
            const stats = fs.statSync(filePath);
            if (stats.size > 10 * 1024 * 1024) {
                pixelBombs.push(filePath);
            }
            buf = null; 
        }
    }

    if (localFiles.length === 0) {
        let failRes = await sendMsg("⚠️ 图片全节点下载失败，请点击上方合并转发气泡内的直链查看。");
        if (failRes && failRes.message_id) sentMsgIds.push(failRes.message_id);
        return false;
    }

    // 3. 超过 10MB 的图强制转为文件发送
    if (pixelBombs.length > 0) {
        // 【应用你调整后的文案】
        let warnRes = await sendMsg(`检测到 ${pixelBombs.length} 张大体积图，需以文件格式强制发送...`);
        if (warnRes && warnRes.message_id) sentMsgIds.push(warnRes.message_id);
        
        for (let filePath of pixelBombs) {
            await sendFileMsg(filePath);
            await new Promise(r => setTimeout(r, 2000)); 
        }
    }

    // 4. 常规图片智能分流：<=3 张直发，>3 张打包成合并转发
    let normalImages = localFiles.filter(f => !pixelBombs.includes(f));
    let allSuccess = true;

    if (normalImages.length > 0) {
        if (normalImages.length <= 3) {
            // 【策略 A】：数量少，直接直发（1~3张转Base64压力不大，群聊版面也干净）
            let directMsg = [];
            for (let filePath of normalImages) {
                directMsg.push(segment.image(`file://${filePath}`));
            }
            let res = await sendMsg(directMsg); 
            
            if (res && res.message_id) sentMsgIds.push(res.message_id);
            if (!res || res.message_id === undefined) allSuccess = false;
        } else {
            // 【策略 B】：数量多，按 5 张一组打包成合并转发（完美跳过 Base64 强转，防断连防刷屏）
            const chunkArray = (arr, size) => Array.from({ length: Math.ceil(arr.length / size) }, (v, i) => arr.slice(i * size, i * size + size));
            const fileChunks = chunkArray(normalImages, 5); 
            
            for (let i = 0; i < fileChunks.length; i++) {
                let forwardNodes = [];
                for (let filePath of fileChunks[i]) {
                    forwardNodes.push(makeNode([segment.image(`file://${filePath}`)]));
                }
                
                let forwardMsg = await makeForwardMsg(forwardNodes);
                let res = forwardMsg ? await sendMsg(forwardMsg) : null;
                
                if (res && res.message_id) sentMsgIds.push(res.message_id);
                if (!res || res.message_id === undefined) allSuccess = false;
                
                if (i < fileChunks.length - 1) await new Promise(r => setTimeout(r, 2000));
            }
        }

        // 5. 常规图片直发/转发失败 -> 翻转兜底 (同样应用智能分流逻辑)
        if (!allSuccess) {
            let flippedImages = [];
            for (let i = 0; i < normalImages.length; i++) {
                try {
                    const sourceFilePath = normalImages[i];
                    const rawBuffer = fs.readFileSync(sourceFilePath);
                    const flippedBuffer = await FlipImage(rawBuffer);
                    
                    if (flippedBuffer) {
                        const flippedFilePath = sourceFilePath.replace(".png", "_flip.png");
                        fs.writeFileSync(flippedFilePath, flippedBuffer);
                        localFiles.push(flippedFilePath); 
                        flippedImages.push(flippedFilePath); // 只存路径，推迟包装
                    }
                } catch (e) {}
            }

            if (flippedImages.length > 0) {
                if (flippedImages.length <= 3) {
                    let directMsg = [];
                    for (let filePath of flippedImages) {
                        directMsg.push(segment.image(`file://${filePath}`));
                    }
                    let res = await sendMsg(directMsg);
                    if (res && res.message_id) sentMsgIds.push(res.message_id);
                } else {
                    const chunkArray = (arr, size) => Array.from({ length: Math.ceil(arr.length / size) }, (v, i) => arr.slice(i * size, i * size + size));
                    const flippedChunks = chunkArray(flippedImages, 5);
                    
                    for (let i = 0; i < flippedChunks.length; i++) {
                        let forwardNodes = [];
                        for (let filePath of flippedChunks[i]) {
                            forwardNodes.push(makeNode([segment.image(`file://${filePath}`)]));
                        }
                        let retryForward = await makeForwardMsg(forwardNodes);
                        let res = retryForward ? await sendMsg(retryForward) : null;
                        
                        if (res && res.message_id) sentMsgIds.push(res.message_id);
                        if (i < flippedChunks.length - 1) await new Promise(r => setTimeout(r, 2000));
                    }
                }
            } 
        }
    }

    // 6. 撤回控制
    if (recallConfig && recallConfig.recall && sentMsgIds.length > 0) {
        setTimeout(() => {
            for (let msgId of sentMsgIds) recallMsg(msgId);
        }, recallConfig.time || 60000);
    }

    // 7. 延时 3 分钟清理文件
    setTimeout(() => {
        for (let filePath of localFiles) {
            try {
                if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
            } catch (e) {}
        }
    }, 3 * 60 * 1000);

    return sentMsgIds.length > 0 || pixelBombs.length > 0;
}