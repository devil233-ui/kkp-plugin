import axios from "axios";
import fs from "fs";
import path from "path";
import { FlipImage } from "./flip.js";
import { pximgProxy } from "../config/api.js";
const sentPrivatePids = new Set();
import { getAppApiHeaders } from "./pixivAuth.js";

// 注意第4个参数统一改名为 config，内部解构提取
export async function sendPixivImageWithFallback(target, initialMsg, originalUrls, config = {}) {
    const isEvent = !!target.reply;

    // 从 config 中提取配置，如果没有则给默认值
    const recallConfig = config.recallConfig || { recall: config.recall || false, time: config.time || 60000 };
    const maxImages = config.max_images || 40;

    // 基础消息与撤回 API
    const sendMsg = async (msg) => isEvent ? await target.reply(msg).catch(() => null) : await target.sendMsg(msg).catch(() => null);
    const makeForwardMsg = async (nodes) => {
        try {
            if (isEvent) return target.isGroup ? await target.group.makeForwardMsg(nodes) : await target.friend.makeForwardMsg(nodes);
            if (target.makeForwardMsg) return await target.makeForwardMsg(nodes);
            if (global.Bot?.makeForwardMsg) return await global.Bot.makeForwardMsg(nodes);
            return nodes.map(n => ({
                type: "node",
                data: { name: String(n.nickname), uin: String(n.user_id), content: Array.isArray(n.message) ? n.message : [n.message] }
            }));
        } catch (err) { return null; }
    };
    const recallMsg = (msgId) => {
        try {
            if (isEvent) target.isGroup ? target.group.recallMsg(msgId) : target.friend.recallMsg(msgId);
            else target.recallMsg(msgId);
        } catch (e) { }
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

    const isGroupChat = isEvent ? target.isGroup : !!target.group_id;
    const isR18 = initialMsg[0] && /tag：.*?(R-18|R-18G)/i.test(initialMsg[0]);

    // 1. 无论群聊私聊，第一步雷打不动：先根据最大限制截断全量原图链接（保护内存与防过载）
    let finalUrls = originalUrls;
    let overflowMsg = "";
    if (originalUrls.length > maxImages) {
        finalUrls = originalUrls.slice(0, maxImages);
        overflowMsg = `⚠️本作多达 ${originalUrls.length} 张图，为防止伊涅芙过载，仅展示前 ${maxImages} 张`;
    }

    let isTextOnly = false;

    // 2. 核心流转策略：群聊遇到 R-18 触发防爆盾与私聊重定向
    if (isGroupChat && isR18 && !config.isPrivateRedirect) {
        isTextOnly = true;

        const privateQq = config.r18_private_qq;
            if (privateQq && global.Bot?.pickFriend) {
                // 【终极修复】：直接从咱们自己构建的文案里提取 PID，彻底无视任何 API 的 URL 格式差异！
                const currentPidMatch = initialMsg[0]?.match(/artworks\/(\d+)/);
                const currentPid = currentPidMatch ? currentPidMatch[1] : null;

                // 如果老哥觉得测试同一张图不转发很烦，可以把 && !sentPrivatePids.has(currentPid) 删掉
                if (currentPid && !sentPrivatePids.has(currentPid)) {
                const privateTarget = global.Bot.pickFriend(Number(privateQq));
                if (privateTarget) {
                    // 标记去重缓存
                    sentPrivatePids.add(currentPid);
                    if (sentPrivatePids.size > 200) sentPrivatePids.clear();

                    // 【核心修复】：异步流传，群聊静默退场，发图任务完全交棒给私聊，并安全包裹配置对象
                    logger.mark(`[kkp-plugin] 检测到群聊 R-18 作品 ${currentPid}，正在重定向投递至私聊 ${privateQq}`);

                    // 必须让私聊独立去跑完整的下载发送大本营流程
                    sendPixivImageWithFallback(privateTarget, initialMsg, originalUrls, {
                        ...config,
                        isPrivateRedirect: true,
                        max_images: maxImages // 确保截断数安全透传
                    });
                }
            }
        }
        // 群聊防爆，将发图队列彻底清空
        finalUrls = [];
    }

    // 3. 【核心修复】：反代直链池生成必须严格绑定已被max_images截断过的内容！如果群聊被清空，则直链展示原图截断后的部分
    let targetUrlsForProxy = finalUrls.length > 0 ? finalUrls : originalUrls.slice(0, maxImages);
    let proxyUrlsPool = targetUrlsForProxy.map(url => pximgProxy(url));
    let proxyUrlsDisplay = proxyUrlsPool.map(pool => pool[0]);

    let localFiles = [];
    let pixelBombs = [];
    // 【核心修正】：专门用于收集过程中的风控提示，绝不碰主体推送的内容
    let warningMsgIds = [];

    // 1. 【区块化组装文字节点】
    let forwardNodes = [];
    let mainParts = [initialMsg[0]];

    if (overflowMsg) mainParts.push(overflowMsg);
    // mainParts.push(`风控时请戳反代直链：\n${proxyUrlsDisplay.join("\n")}`);

    const isUgoira = originalUrls.some(url => url.includes("ugoira"));
    if (isUgoira) {
        mainParts.push("✨本作是Pixiv网页动图(Ugoira)，已调用外部专属服务为您实时渲染为 GIF");
    }

    forwardNodes.push(makeNode([mainParts.join("\n\n")]));

    if (initialMsg[1]) {
        forwardNodes.push(makeNode([initialMsg[1]]));
    }

    let textForward = await makeForwardMsg(forwardNodes);
    let fallbackText = initialMsg[1] ? `${mainParts.join("\n\n")}\n\n${initialMsg[1]}` : mainParts.join("\n\n");
    // 主体文案发送后，不加入撤回列表！稳稳留在记录里！
    await sendMsg(textForward || [fallbackText]);

    if (isTextOnly) {
        return true;
    }

    // 2. 下载至本地，扫描体积雷达（植入 Ugoira 云端合成拦截）
    for (let i = 0; i < finalUrls.length; i++) {
        const rawUrl = finalUrls[i];
        const backupUrls = proxyUrlsPool[i];

        let filePrefix = `${Date.now()}_p${i}`;
        const match = rawUrl.match(/(\d+_(?:p|ugoira)\d+)/);
        if (match) filePrefix = match[1];

        // 【核心新增】：如果是动图，立刻外包给美国机专属 API
        if (rawUrl.includes("ugoira")) {
            const pidMatch = rawUrl.match(/(\d+)_ugoira/);
            const pid = pidMatch ? pidMatch[1] : null;

            if (pid) {
                let warnMsg = await sendMsg("⏳检测到高帧率动图，正呼叫海外服务器进行无损压缩渲染，请稍候...");
                if (warnMsg && warnMsg.message_id) warningMsgIds.push(warnMsg.message_id);

                try {
                    // 云端合成比较耗时，把超时时间放宽到 60 秒
                    // 1. 从咱们自己的鉴权模块里秒取缓存的 headers
                    const appHeaders = await getAppApiHeaders();
                    // 2. 剥离出纯净的 access_token (去掉 "Bearer " 前缀)
                    const accessToken = appHeaders.Authorization.replace("Bearer ", "");

                    /// 3. 从配置中读取独立 API 地址，未配置则默认兜底本地环回
                    const apiUrl = config.ugoira_api || "http://127.0.0.1:3008/ugoira";
                    const apiRes = await axios.post(apiUrl, {
                        pid: pid,
                        access_token: accessToken
                    }, { timeout: 60000 });

                    if (apiRes.data && apiRes.data.status === "success") {
                        const gifBuffer = Buffer.from(apiRes.data.data, 'base64');
                        const gifPath = path.join(tempDir, `${filePrefix}.gif`); // 必须以 .gif 结尾
                        fs.writeFileSync(gifPath, gifBuffer);

                        localFiles.push(gifPath);
                        const stats = fs.statSync(gifPath);
                        // GIF通常较大，同样进雷达扫描，超过10MB走文件形式发送防风控
                        if (stats.size > 10 * 1024 * 1024) pixelBombs.push(gifPath);

                        continue; // GIF 渲染成功，直接跳过后面的普通下载逻辑！
                    }
                } catch (apiErr) {
                    let failWarn = await sendMsg(`⚠️云端 GIF 渲染超时或失败，已自动降级为您下载高清静态首帧图...`);
                    if (failWarn && failWarn.message_id) warningMsgIds.push(failWarn.message_id);
                }
            }
        }

        // 默认逻辑：常规静态图下载（也是动图合成失败时的兜底降级方案）
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
        // 垃圾提示，加入撤回垃圾桶！
        if (failRes && failRes.message_id) warningMsgIds.push(failRes.message_id);
        return false;
    }

    // 3. 超过 10MB 的图强制转为文件发送
    if (pixelBombs.length > 0) {
        let warnRes = await sendMsg(`检测到 ${pixelBombs.length} 张大体积图，需以文件格式强制发送。若长时间未收到可能是网络抽风，请重发链接或pid。`);
        if (warnRes && warnRes.message_id) warningMsgIds.push(warnRes.message_id);
        for (let filePath of pixelBombs) {
            await sendFileMsg(filePath);
            await new Promise(r => setTimeout(r, 2000));
        }
    }

    // 4. 常规图片下发（带超时与风控记录）
    let normalImages = localFiles.filter(f => !pixelBombs.includes(f));
    let failedImages = [];

    if (normalImages.length > 0) {
        for (let i = 0; i < normalImages.length; i++) {
            let res = await sendMsg(segment.image("file://" + normalImages[i]));
            if (!res || res.message_id === undefined) {
                failedImages.push(normalImages[i]);
            }
            if (i < normalImages.length - 1) await new Promise(r => setTimeout(r, 1500));
        }

        // 5. 折叠兜底（将翻转后的图片与直链打包为合并转发，彻底解决误报与刷屏问题）
        if (failedImages.length > 0) {
            let flippedImages = [];
            for (let i = 0; i < failedImages.length; i++) {
                try {
                    const sourceFilePath = failedImages[i];
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
                } catch (e) { }
            }

            if (flippedImages.length > 0) {
                let forwardNodes = [];

                // 节点1：顶部提示文案
                forwardNodes.push({
                    message: "⚠️检测到 " + failedImages.length + " 张图片被风控拦截（或网络超时），已尝试竖直翻转并折叠重发。",
                    nickname: "防风控系统",
                    user_id: 80000000
                });

                // 节点2~N：翻转图及备用直链
                for (let i = 0; i < flippedImages.length; i++) {
                    let fileNameMatch = flippedImages[i].match(/(\d+_(?:p|ugoira)\d+)/);
                    let deadProxyUrl = fileNameMatch ? proxyUrlsDisplay.find(u => u.includes(fileNameMatch[1])) : "";

                    let nodeContent = [segment.image("file://" + flippedImages[i])];
                    if (deadProxyUrl) {
                        nodeContent.push("\n⚠️若图彻底阵亡，请戳备用的反代直链查看：\n" + deadProxyUrl);
                    }

                    forwardNodes.push({
                        message: nodeContent,
                        nickname: "防风控系统",
                        user_id: 80000000
                    });
                }

                // 以原生 Node 格式交由底层适配器发送合并转发消息
                await sendMsg({
                    type: "node",
                    data: forwardNodes
                });
            }
        }
    }

    // 6. 撤回控制 (仅针对风控提示垃圾)
    if (recallConfig && recallConfig.recall && warningMsgIds.length > 0) {
        // 彻底抛弃大小判定！配置里写几秒，就老老实实乘 1000 转成毫秒！
        const delayTime = (recallConfig.time || 600) * 1000;

        setTimeout(() => {
            for (let msgId of warningMsgIds) recallMsg(msgId);
        }, delayTime);
    }

    // 7. 延时 3 分钟清理文件
    setTimeout(() => {
        for (let filePath of localFiles) {
            try {
                if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
            } catch (e) { }
        }
    }, 3 * 60 * 1000);

    return true; // 只要执行完毕（无论是直发还是兜底发出），统一宣告处理成功，确保不影响外层的进度保存
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
        `♥：${illust.total_bookmarks}  👁：${illust.total_view}`,
        `tag：${tagsStr}`
    );

    const mainInfo = msg.join("\n");

    // 【核心新增】：提取并清洗作品简介（将 HTML 换行转标准换行，剥离网页标签，并反转义 HTML 实体）
    let captionNode = "";
    if (illust.caption) {
        const cleanCaption = illust.caption
            .replace(/<br\s*\/?>/gi, "\n")
            .replace(/<[^>]+>/g, "")
            .replace(/&quot;/g, "\"")
            .replace(/&amp;/g, "&")
            .replace(/&lt;/g, "<")
            .replace(/&gt;/g, ">")
            .replace(/&#39;/g, "'")
            .trim();
        if (cleanCaption) {
            captionNode = `【作品简介】\n${cleanCaption}`;
        }
    }

    // 如果有简介则返回包含两个节点文本的数组，否则只返回主信息节点
    return captionNode ? [mainInfo, captionNode] : [mainInfo];
}