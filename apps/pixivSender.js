import axios from "axios";
import fs from "fs";
import path from "path";
import { FlipImage } from "./flip.js";
import { pximgProxy } from "../config/api.js"; 

// 注意第4个参数统一改名为 config，内部解构提取
export async function sendPixivImageWithFallback(target, initialMsg, originalUrls, config = {}) {
    const isEvent = !!target.reply;
    
    // 从 config 中提取配置，如果没有则给默认值
    const recallConfig = config.recallConfig || { recall: config.recall || false, time: config.time || 60000 };
    const maxImages = config.max_images || 40; 

    // 基础消息与撤回 API
    const sendMsg = async(msg) => isEvent ? await target.reply(msg).catch(() => null) : await target.sendMsg(msg).catch(() => null);
    const makeForwardMsg = async(nodes) => {
        try {
            if (isEvent) return target.isGroup ? await target.group.makeForwardMsg(nodes) : await target.friend.makeForwardMsg(nodes);
            if (target.makeForwardMsg) return await target.makeForwardMsg(nodes);
            if (global.Bot?.makeForwardMsg) return await global.Bot.makeForwardMsg(nodes);
            return nodes.map(n => ({
                type: "node",
                data: { name: String(n.nickname), uin: String(n.user_id), content: Array.isArray(n.message) ? n.message : [ n.message ] }
            }));
        } catch (err) { return null; }
    };
    const recallMsg = (msgId) => {
        try {
            if (isEvent) target.isGroup ? target.group.recallMsg(msgId) : target.friend.recallMsg(msgId);
            else target.recallMsg(msgId);
        } catch(e) {}
    };

    const sendFileMsg = async(filePath) => {
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

    let finalUrls = originalUrls;
    let overflowMsg = "";
    if (originalUrls.length > maxImages) {
        finalUrls = originalUrls.slice(0, maxImages);
        // 去掉手写的 \n，间距交由底层统一处理
        overflowMsg = `⚠️本作多达 ${originalUrls.length} 张图，为防止伊涅芙过载，仅展示前 ${maxImages} 张`;
    }

    let proxyUrlsPool = finalUrls.map(url => pximgProxy(url));
    let proxyUrlsDisplay = proxyUrlsPool.map(pool => pool[0]);

    let localFiles = [];
    let pixelBombs = []; 
    let sentMsgIds = [];

    // 1. 【核心排版重构】：区块化组装文字节点
    let forwardNodes = [];

    // 组装第一个节点（主信息 + 警告 + 直链 + 动图提示）
    // 因为 initialMsg 现在可能包含简介，这里必须明确取第一个元素 initialMsg[0]
    let mainParts = [ initialMsg[0] ];
    
    if (overflowMsg) mainParts.push(overflowMsg);
    
    mainParts.push(`风控时请戳反代直链：\n${proxyUrlsDisplay.join("\n")}`);
    
    const isUgoira = originalUrls.some(url => url.includes("ugoira"));
    if (isUgoira) {
        mainParts.push("[⚠️本作是 Pixiv 动图(Ugoira)，此处仅展示首帧封面，请去原站查看动效]");
    }
    
    forwardNodes.push(makeNode([ mainParts.join("\n\n") ]));

    // 【核心新增】：如果存在作品简介，则单独封装成一个独立节点塞进合并转发队列
    if (initialMsg[1]) {
        forwardNodes.push(makeNode([ initialMsg[1] ]));
    }

    let textForward = await makeForwardMsg(forwardNodes);
    let fallbackText = initialMsg[1] ? `${mainParts.join("\n\n")}\n\n${initialMsg[1]}` : mainParts.join("\n\n");
    let textRes = await sendMsg(textForward || [ fallbackText ]); 
    if (textRes && textRes.message_id) sentMsgIds.push(textRes.message_id);

    // 2. 下载至本地，扫描体积雷达 (注意这里全改用 finalUrls)
    for (let i = 0; i < finalUrls.length; i++) {
        const rawUrl = finalUrls[i];
        const backupUrls = proxyUrlsPool[i]; 
        
        let filePrefix = `${Date.now()}_p${i}`;
        const match = rawUrl.match(/(\d+_(?:p|ugoira)\d+)/);
        if (match) filePrefix = match[1];
        
        const filePath = path.join(tempDir, `${filePrefix}.png`); 

        let buf = null;
        try {
            const imgRes = await axios.get(rawUrl, { responseType: "arraybuffer", timeout: 15000, headers: { "Referer": "https://app-api.pixiv.net/" } });
            buf = imgRes.data;
        } catch (err1) {
            for (let backupUrl of backupUrls) {
                try {
                    const imgRes2 = await axios.get(backupUrl, { responseType: "arraybuffer", timeout: 15000 });
                    buf = imgRes2.data;
                    break; 
                } catch (err2) { continue; }
            }
        }

        if (buf) {
            fs.writeFileSync(filePath, buf);
            localFiles.push(filePath);
            const stats = fs.statSync(filePath);
            if (stats.size > 10 * 1024 * 1024) pixelBombs.push(filePath);
            buf = null; 
        }
    }

    if (localFiles.length === 0) {
        let failRes = await sendMsg("⚠️图片全节点下载失败，请点击上方合并转发气泡内的直链查看。");
        if (failRes && failRes.message_id) sentMsgIds.push(failRes.message_id);
        return false;
    }

    // 3. 超过 10MB 的图强制转为文件发送
    if (pixelBombs.length > 0) {
        let warnRes = await sendMsg(`检测到 ${pixelBombs.length} 张大体积图，需以文件格式强制发送...`);
        if (warnRes && warnRes.message_id) sentMsgIds.push(warnRes.message_id);
        for (let filePath of pixelBombs) {
            await sendFileMsg(filePath);
            await new Promise(r => setTimeout(r, 2000)); 
        }
    }

    // 4. 常规图片智能分流
    let normalImages = localFiles.filter(f => !pixelBombs.includes(f));
    let allSuccess = true;

    if (normalImages.length > 0) {
        if (normalImages.length <= 3) {
            let directMsg = [];
            for (let filePath of normalImages) directMsg.push(segment.image(`file://${filePath}`));
            let res = await sendMsg(directMsg); 
            if (res && res.message_id) sentMsgIds.push(res.message_id);
            if (!res || res.message_id === undefined) allSuccess = false;
        } else {
            const chunkArray = (arr, size) => Array.from({ length: Math.ceil(arr.length / size) }, (v, i) => arr.slice(i * size, i * size + size));
            const fileChunks = chunkArray(normalImages, 5); 
            for (let i = 0; i < fileChunks.length; i++) {
                let forwardNodes = [];
                for (let filePath of fileChunks[i]) forwardNodes.push(makeNode([ segment.image(`file://${filePath}`) ]));
                let forwardMsg = await makeForwardMsg(forwardNodes);
                let res = forwardMsg ? await sendMsg(forwardMsg) : null;
                if (res && res.message_id) sentMsgIds.push(res.message_id);
                if (!res || res.message_id === undefined) allSuccess = false;
                if (i < fileChunks.length - 1) await new Promise(r => setTimeout(r, 2000));
            }
        }

        // 5. 常规图片发送失败 -> 竖直翻转兜底 
        if (!allSuccess) {
            let flippedImages = [];
            for (let i = 0; i < normalImages.length; i++) {
                try {
                    const sourceFilePath = normalImages[i];
                    if (sourceFilePath.endsWith(".gif")) {
                        flippedImages.push(sourceFilePath);
                        continue;
                    }
                    const rawBuffer = fs.readFileSync(sourceFilePath);
                    const flippedBuffer = await FlipImage(rawBuffer);
                    if (flippedBuffer) {
                        const flippedFilePath = sourceFilePath.replace(".png", "_flip.png");
                        fs.writeFileSync(flippedFilePath, flippedBuffer);
                        localFiles.push(flippedFilePath); 
                        flippedImages.push(flippedFilePath);
                    }
                } catch (e) {}
            }

            if (flippedImages.length > 0) {
                if (flippedImages.length <= 3) {
                    let directMsg = [];
                    for (let filePath of flippedImages) directMsg.push(segment.image(`file://${filePath}`));
                    let res = await sendMsg(directMsg);
                    if (res && res.message_id) {
                        sentMsgIds.push(res.message_id);
                    } else {
                        // 【核心新增】：翻转后直发依然失败（被吞/风控），尝试打包成合并转发最后挣扎一下！
                        let forwardNodes = [];
                        for (let filePath of flippedImages) forwardNodes.push(makeNode([ segment.image(`file://${filePath}`) ]));
                        let retryForward = await makeForwardMsg(forwardNodes);
                        let resFwd = retryForward ? await sendMsg(retryForward) : null;
                        if (resFwd && resFwd.message_id) sentMsgIds.push(resFwd.message_id);
                    }
                } else {
                    const chunkArray = (arr, size) => Array.from({ length: Math.ceil(arr.length / size) }, (v, i) => arr.slice(i * size, i * size + size));
                    const flippedChunks = chunkArray(flippedImages, 5);
                    for (let i = 0; i < flippedChunks.length; i++) {
                        let forwardNodes = [];
                        for (let filePath of flippedChunks[i]) forwardNodes.push(makeNode([ segment.image(`file://${filePath}`) ]));
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

// 【新增：公共文案生成器，一键统管所有 Pixiv 消息结构】
export function buildPixivMessage(illust, customPrefix = "") {
    const tagsStr = illust.tags.map(t => t.translated_name || t.name).join(", ");
    
    // 统一的时间格式化
    const date = new Date(illust.create_date);
    const utc8Date = new Date(date.getTime() + 8 * 60 * 60 * 1000);
    const formattedTime = `${utc8Date.getUTCFullYear()}-${String(utc8Date.getUTCMonth() + 1).padStart(2, "0")}-${String(utc8Date.getUTCDate()).padStart(2, "0")} ${String(utc8Date.getUTCHours()).padStart(2, "0")}:${String(utc8Date.getUTCMinutes()).padStart(2, "0")}:${String(utc8Date.getUTCSeconds()).padStart(2, "0")}`;

    let msg = [];
    if (customPrefix) msg.push(customPrefix);
    
    msg.push(
        `https://www.pixiv.net/artworks/${illust.id} (共${illust.page_count}P)`,
        `画师：${illust.user.name}（${illust.user.id}）`,
        `是否ai：${illust.illust_ai_type === 2 ? "是" : "否"}`,
        `标题：${illust.title}`,
        `上传时间：${formattedTime}`,
        `♥：${illust.total_bookmarks} 👁：${illust.total_view}`,
        `tag：${tagsStr}`
    );
    
    const mainInfo = msg.join("\n");
    
    // 【核心新增】：提取并清洗作品简介（将 HTML 换行标签转为标准换行，并剥离其余高危网页标签）
    let captionNode = "";
    if (illust.caption) {
        const cleanCaption = illust.caption
            .replace(/<br\s*\/?>/gi, "\n")
            .replace(/<[^>]+>/g, "")
            .trim();
        if (cleanCaption) {
            captionNode = `【作品简介】\n${cleanCaption}`;
        }
    }
    
    // 如果有简介则返回包含两个节点文本的数组，否则只返回主信息节点
    return captionNode ? [ mainInfo, captionNode ] : [ mainInfo ];
}