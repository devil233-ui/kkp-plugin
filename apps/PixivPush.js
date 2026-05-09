import plugin from "../../../lib/plugins/plugin.js";
import schedule from "node-schedule";
import fetch from "node-fetch";
import crypto from "crypto";
import YAML from "yaml";
import fs from "fs";
import path from "path";

function getRefreshToken() {
    const configPath = "./plugins/kkp-plugin/config/token.yaml";
    if (!fs.existsSync(configPath)) {
        // 自动生成模板配置文件
        fs.writeFileSync(configPath, "RefreshToken: \"\"\n", "utf8");
        return "";
    }
    const config = YAML.parse(fs.readFileSync(configPath, "utf8")) || {};
    return config.RefreshToken ? String(config.RefreshToken).trim() : "";
}

const CLIENT_ID = "MOBrBDS8blbauoSck0ZfDbtuzpyT";
const CLIENT_SECRET = "lsACyCD94FhDUtGTXi3QzcFE2uU1hqtDaKeqrdwj";
const HASH_SECRET = "28c1fdd170a5204386cb1313c7077b34f83e4aaf4aa829ce78c231e05b0bae2c";

// 内存缓存 access_token，订阅和推送共享
let accessTokenCache = null;
let tokenExpireTime = 0;

export class PixivPushPlugin extends plugin {
    constructor() {
        super({
            name: "P站画师订阅与推送",
            dsc: "基于App端API的订阅管理与自动推送",
            event: "message",
            priority: 50,
            rule: [
                { reg: "^#?kkp帮助$", fnc: "sendKKPImage" },
                { reg: "^#?强制推送p?$", fnc: "forcePush", permission: "master" },
                { reg: "^#?订阅画师(\\d+)$", fnc: "subscribeArtist" },
                { reg: "^#?(取消订阅|删画师)(\\d+)$", fnc: "unsubscribeArtist" },
                { reg: "^#?(订阅|画师)列表$", fnc: "listSubscribedArtists" },
                { reg: "^#?开启p推送$", fnc: "enablePush" },
                { reg: "^#?关闭p推送$", fnc: "disablePush" },
                { reg: "^#?(添加|删除)(白|黑)名单标签(.+)$", fnc: "manageTags" },
                { reg: "^#?导入关注(列表)?(\\d+)$", fnc: "importFollowing", permission: "master" }
            ]
        });
    }

    // ================= 基础配置读取 =================
    ensureDirectoryExistence(filePath) {
        const dirname = path.dirname(filePath);
        if (!fs.existsSync(dirname)) {
            this.ensureDirectoryExistence(dirname);
            fs.mkdirSync(dirname);
        }
    }

    loadData() {
        const filePath = "./plugins/kkp-plugin/config/dingyue.yaml";
        if (!fs.existsSync(filePath)) return {};
        const fileContents = fs.readFileSync(filePath, "utf8");
        return YAML.parse(fileContents) || {};
    }

    saveData(data) {
        const filePath = "./plugins/kkp-plugin/config/dingyue.yaml";
        this.ensureDirectoryExistence(filePath);
        fs.writeFileSync(filePath, YAML.stringify(data), "utf8");
    }

    async sendKKPImage(e) {
        const imagePath = "./plugins/kkp-plugin/config/kkp.jpg";
        let msg = [segment.image(`file://${imagePath}`)];
        await e.reply(msg);
        return true;
    }

    // ================= Pixiv API 核心 =================
    async getAccessToken() {
        if (accessTokenCache && Date.now() < tokenExpireTime) {
            return { token: accessTokenCache, error: null };
        }

        const clientTime = new Date().toISOString().split(".")[0] + "+00:00";
        const clientHash = crypto.createHash("md5").update(clientTime + HASH_SECRET).digest("hex");

        const refreshToken = getRefreshToken();
        if (!refreshToken) {
            logger.error("[kkp-plugin] 未配置 RefreshToken，请在 config/token.yaml 中填写");
            return { token: null, error: "插件未配置 RefreshToken，请前往 token.yaml 填写" };
        }

        const params = new URLSearchParams({
            "client_id": CLIENT_ID,
            "client_secret": CLIENT_SECRET,
            "grant_type": "refresh_token",
            "refresh_token": refreshToken
        });

        try {
            const res = await fetch("https://oauth.secure.pixiv.net/auth/token", {
                method: "POST",
                body: params.toString(),
                headers: {
                    "User-Agent": "PixivAndroidApp/5.0.234 (Android 11; Pixel 5)",
                    "Content-Type": "application/x-www-form-urlencoded",
                    "X-Client-Time": clientTime,
                    "X-Client-Hash": clientHash,
                    "App-OS": "android",
                    "App-OS-Version": "11",
                    "App-Version": "5.0.234"
                }
            });

            const data = await res.json();
            if (data.has_error) {
                const errMsg = JSON.stringify(data.errors || data);
                logger.error(`[kkp-plugin] 刷新Token失败: ${errMsg}`);
                return { token: null, error: `Pixiv接口拒绝请求：${errMsg}` };
            }

            accessTokenCache = data.response.access_token;
            tokenExpireTime = Date.now() + (data.response.expires_in - 300) * 1000;
            logger.mark("[kkp-plugin] Pixiv Access Token 已成功刷新");
            return { token: accessTokenCache, error: null };
        } catch (error) {
            logger.error(`[kkp-plugin] 获取Token报错: ${error.message}`);
            return { token: null, error: `网络请求错误：${error.message}` };
        }
    }

    getAppHeaders(token) {
        return {
            "Authorization": `Bearer ${token}`,
            "User-Agent": "PixivAndroidApp/5.0.234 (Android 11; Pixel 5)",
            "App-OS": "android",
            "App-OS-Version": "11",
            "App-Version": "5.0.234",
            "Accept-Language": "zh-CN"
        };
    }

    // ================= 订阅管理相关指令 =================
    async subscribeArtist(e) {
        if (!e.isGroup) return;
        const groupId = e.group_id.toString();
        const data = this.loadData();

        if (!data[groupId]) data[groupId] = { "pushEnabled": false, "artists": {} };
        if (Object.keys(data).length > 5) return e.reply("已达到群订阅上限！");
        if (Object.keys(data[groupId].artists).length >= 20) return e.reply("该群已达到画师订阅上限！");

        const matches = e.msg.trim().match(/^#?订阅画师(\d+)$/);
        const artistId = matches ? matches[1] : null;
        if (!artistId) return;

        if (data[groupId].artists[artistId]) {
            await e.reply(`已经订阅了 ${artistId}`);
            return;
        }

        const tokenResult = await this.getAccessToken();
        if (!tokenResult.token) {
            await e.reply("Pixiv 授权失败，请检查 RefreshToken 是否正确。");
            return;
        }

        let latestId = 0;
        let artistName = "";
        try {
            const res = await fetch(`https://app-api.pixiv.net/v1/user/illusts?user_id=${artistId}&type=illust`, {
                headers: this.getAppHeaders(tokenResult.token)
            });
            const resData = await res.json();
            if (!resData.illusts) {
                await e.reply(`获取画师 ${artistId} 信息失败，请检查 ID 是否正确。`);
                return;
            }
            artistName = resData.illusts[0]?.user?.name || artistId;
            latestId = resData.illusts[0]?.id || 0;
        } catch (err) {
            await e.reply("连接 Pixiv API 超时，请稍后再试。");
            return;
        }

        // 保存到 yaml
        data[groupId].artists[artistId] = artistName;
        data[groupId].pushEnabled = true; // 订阅时默认开启推送
        this.saveData(data);

        await e.reply(`成功订阅画师 ${artistId} (${artistName})，已同步设置推送基准线。`);
    }

    async unsubscribeArtist(e) {
        if (!e.isGroup) return;
        const groupId = e.group_id.toString();
        const data = this.loadData();
        if (!data[groupId]) return;

        const matches = e.msg.trim().match(/^#?(取消订阅|删画师)(\d+)$/);
        const artistId = matches ? matches[2] : null;
        if (!artistId) return;

        if (!data[groupId].artists[artistId]) {
            await e.reply(`还未订阅 ${artistId} 哦`);
            return;
        }

        const artistName = data[groupId].artists[artistId];
        delete data[groupId].artists[artistId];
        this.saveData(data);

        const redisKey = `kkp:pixiv:progress:${groupId}`;
        await redis.hDel(redisKey, artistId);

        logger.mark(`[kkp-plugin] 群 ${groupId} 取消订阅画师 ${artistId}，相关 Redis 记录已清理`);
        await e.reply(`已成功取消订阅画师：${artistName} (${artistId})`);
    }

    async importFollowing(e) {
        if (!e.isGroup) return;
        const groupId = e.group_id.toString();
        const matches = e.msg.trim().match(/^#?导入关注(列表)?(\d+)$/);
        const targetUid = matches[2];
        
        let data = this.loadData();
        if (!data[groupId]) data[groupId] = { "pushEnabled": true, "artists": {}, "tags": { "whitelist": [], "blacklist": [] } };

        const tokenResult = await this.getAccessToken();
        if (!tokenResult.token) return e.reply(`授权失败：${tokenResult.error}`);

        await e.reply(`正在拉取 Pixiv 用户 ${targetUid} 的公开关注列表，由于名单较长（正在翻页），请稍候...`);

        try {
            let url = `https://app-api.pixiv.net/v1/user/following?user_id=${targetUid}&restrict=public`;
            let newArtists = [];

            // 核心修改：利用 next_url 循环翻页拉取所有名单
            while (url) {
                const res = await fetch(url, { headers: this.getAppHeaders(tokenResult.token) });
                const resData = await res.json();

                if (!resData.user_previews) {
                    if (newArtists.length === 0) return e.reply("拉取失败！请确认该 UID 存在，且关注列表对外公开。");
                    break; // 如果后续翻页突然报错，直接跳出循环用已有的数据
                }

                for (let preview of resData.user_previews) {
                    const artistId = preview.user.id.toString();
                    const artistName = preview.user.name;
                    
                    // 剔除已经订阅过的画师
                    if (!data[groupId].artists[artistId]) {
                        newArtists.push({ id: artistId, name: artistName });
                    }
                }

                // 拿到下一页的链接，如果为空则说明拉完了，循环自然结束
                url = resData.next_url || null;
            }

            if (newArtists.length === 0) return e.reply("该用户的关注列表中没有发现新画师（或已全部订阅）。");

            // 预估时间：200人 * 1秒 / 60 = 约 3.3 分钟
            const estimateMin = (newArtists.length * 2 / 60).toFixed(1);
            await e.reply(`翻页拉取完毕，成功获取到 ${newArtists.length} 位新画师！\n为防止大量请求导致服务器 IP 被封，正在后台逐一静默建立基准线，预计需要 ${estimateMin} 分钟，请耐心等待完成提示...`);

            let successCount = 0;
            // 遍历静默获取每个人的最新作品 ID
            for (let artist of newArtists) {
                try {
                    const illustUrl = `https://app-api.pixiv.net/v1/user/illusts?user_id=${artist.id}&type=illust`;
                    const illustRes = await fetch(illustUrl, { headers: this.getAppHeaders(tokenResult.token) });
                    const illustData = await illustRes.json();
                    
                    data[groupId].artists[artist.id] = artist.name;
                    
                    if (illustData.illusts && illustData.illusts.length > 0) {
                        const maxId = illustData.illusts[0].id;
                        await redis.hSet(`kkp:pixiv:progress:${groupId}`, artist.id, maxId);
                    } else {
                        await redis.hSet(`kkp:pixiv:progress:${groupId}`, artist.id, 1);
                    }
                    successCount++;
                } catch (err) {
                    logger.error(`[kkp-plugin] 导入画师 ${artist.id} 基准线失败：${err.message}`);
                }
                // 强制延时 1 秒，保护你的东京服务器 IP
                await new Promise(r => setTimeout(r, 1000));
            }

            // 保存到本地 yaml
            this.saveData(data);
            await e.reply(`🎉 批量导入完成！共成功添加并静默初始化了 ${successCount} 位画师。\n（注意：你现在订阅了几百个画师，后续每次自动检查都会发送大量请求，建议保留此延时配置，否则容易吃 429 封禁）`);

        } catch (err) {
            await e.reply(`导入过程中发生异常：${err.message}`);
        }
    }

    async listSubscribedArtists(e) {
        if (!e.isGroup) return;
        const groupId = e.group_id.toString();
        const data = this.loadData();

        if (!data[groupId] || Object.keys(data[groupId].artists).length === 0) {
            await e.reply("当前没有订阅任何画师");
            return;
        }

        let response = `群 [${groupId}] 订阅列表：\n`;
        response += `推送状态：${data[groupId].pushEnabled ? "✅已开启" : "❌已关闭"}\n`;

        const groupTags = data[groupId].tags || { "whitelist": [], "blacklist": [] };
        if (groupTags.whitelist && groupTags.whitelist.length > 0) response += `白名单：${groupTags.whitelist.join(", ")}\n`;
        if (groupTags.blacklist && groupTags.blacklist.length > 0) response += `黑名单：${groupTags.blacklist.join(", ")}\n`;
        response += "\n";
        for (const [artistId, artistName] of Object.entries(data[groupId].artists)) {
            response += `${artistName}  ${artistId}\n`;
        }
        await e.reply(response);
    }

    async enablePush(e) {
        const groupId = e.group_id.toString();
        let data = this.loadData();
        if (!data[groupId]) data[groupId] = { "pushEnabled": false, "artists": {} };

        if (!data[groupId].pushEnabled) {
            data[groupId].pushEnabled = true;
            this.saveData(data);
            await e.reply("已开启p推送。");
        } else {
            await e.reply("已经开启了p推送。");
        }
    }

    async disablePush(e) {
        const groupId = e.group_id.toString();
        let data = this.loadData();
        if (!data[groupId]) return;

        if (data[groupId].pushEnabled) {
            data[groupId].pushEnabled = false;
            this.saveData(data);
            await e.reply("已关闭p推送。");
        } else {
            await e.reply("尚未开启p推送，无需关闭。");
        }
    }

    async manageTags(e) {
        if (!e.isGroup) return;
        const groupId = e.group_id.toString();
        let data = this.loadData();

        if (!data[groupId]) data[groupId] = { "pushEnabled": false, "artists": {} };
        if (!data[groupId].tags) data[groupId].tags = { "whitelist": [], "blacklist": [] };

        const match = e.msg.trim().match(/^#?(添加|删除)(白|黑)名单标签(.+)$/);
        if (!match) return;

        const action = match[1];
        const type = match[2] === "白" ? "whitelist" : "blacklist";
        const tag = match[3].trim();
        const typeName = match[2] + "名单";

        let targetList = data[groupId].tags[type];

        if (action === "添加") {
            if (targetList.includes(tag)) return e.reply(`该群${typeName}中已存在标签：${tag}`);
            targetList.push(tag);
            this.saveData(data);
            await e.reply(`成功添加${typeName}标签：${tag}`);
        } else {
            const index = targetList.indexOf(tag);
            if (index === -1) return e.reply(`该群${typeName}中没有标签：${tag}`);
            targetList.splice(index, 1);
            this.saveData(data);
            await e.reply(`成功移除${typeName}标签：${tag}`);
        }
    }

    // ================= 自动推送核心 =================
    async forcePush(e) {
        await e.reply("正在通过 App API 检查订阅更新...");
        const result = await this.executePushLogic(true);

        if (result.state === "empty") {
            await e.reply("检查完毕：订阅的画师暂无更新。");
        } else if (result.state === "error") {
            await e.reply(`检查失败，请核对日志或原因：\n${result.reason}`);
        } else if (result.state === "success") {
            // await e.reply("手动检查及推送任务执行完毕，发现新作品！");
        }
        return true;
    }

    async executePushLogic(isManual = false) {
        try {
            const data = this.loadData();
            if (Object.keys(data).length === 0) return { state: "empty" };

            const artistToGroups = {};
            for (let groupId in data) {
                if (data[groupId].pushEnabled) {
                    for (let artistId in data[groupId].artists) {
                        if (!artistToGroups[artistId]) artistToGroups[artistId] = [];
                        if (!artistToGroups[artistId].includes(groupId)) {
                            artistToGroups[artistId].push(groupId);
                        }
                    }
                }
            }

            const artistIds = Object.keys(artistToGroups);
            if (artistIds.length === 0) return { state: "empty" };

            const tokenResult = await this.getAccessToken();
            if (!tokenResult.token) return { state: "error", reason: tokenResult.error };
            const token = tokenResult.token;

            let hasUpdates = false;
            let debugResponse = {};

            for (let artistId of artistIds) {
                try {
                    const url = `https://app-api.pixiv.net/v1/user/illusts?user_id=${artistId}&type=illust`;
                    const res = await fetch(url, {
                        headers: this.getAppHeaders(token),
                        timeout: 10000
                    });

                    if (!res.ok) {
                        logger.error(`[kkp-plugin] 画师 ${artistId} API请求失败：${res.status}`);
                        debugResponse[artistId] = "fetch_failed";
                        continue;
                    }

                    const resData = await res.json();
                    if (!resData.illusts || resData.illusts.length === 0) {
                        debugResponse[artistId] = "no_works";
                        continue;
                    }

                    const latestIllusts = resData.illusts;
                    const maxId = latestIllusts[0].id;
                    const targetGroups = artistToGroups[artistId] || [];

                    // 1. 定义变量（之前报错就是因为这里被误删了）
                    let needsUpdateGroups = [];
                    let initGroups = [];
                    let globalStoredMax = maxId;

                    // 2. 遍历检查各群的进度
                    for (let groupId of targetGroups) {
                        const redisKey = `kkp:pixiv:progress:${groupId}`;
                        const storedMaxStr = await redis.hGet(redisKey, artistId);
                        const storedMax = storedMaxStr ? Number(storedMaxStr) : 0;

                        if (storedMax === 0) {
                            initGroups.push(groupId);
                        } else if (maxId > storedMax) {
                            needsUpdateGroups.push(groupId);
                            if (storedMax < globalStoredMax) globalStoredMax = storedMax;
                        } else {
                            debugResponse[`${artistId}_${groupId}`] = "no_update";
                        }
                    }

                    // 【关键拦截】如果都没更新，必须直接跳过后面的发图逻辑
                    if (needsUpdateGroups.length === 0 && initGroups.length === 0) continue;

                    // 准备待推送的作品列表与映射
                    let targetIllusts = [];
                    let initIllustMap = {}; // 记录每个新群最终“顺延”拿到了哪张图

                    // 1. 处理正常更新的群（拿比基准线大的，最多3张）
                    if (needsUpdateGroups.length > 0) {
                        targetIllusts = latestIllusts.filter(ill => ill.id > globalStoredMax).reverse().slice(-3);
                    }

                    // 2. 处理新订阅初始化的群（核心：顺延回溯逻辑）
                    for (let groupId of initGroups) {
                        const groupTags = data[groupId].tags || { "whitelist": [], "blacklist": [] };
                        const whitelist = groupTags.whitelist || [];
                        const blacklist = groupTags.blacklist || [];

                        // 从新到旧遍历 App API 返回的这批图（通常是近 30 张）
                        for (let ill of latestIllusts) {
                            const illustTags = ill.tags.flatMap(t => [t.name, t.translated_name]).filter(Boolean);
                            // 黑白名单判定
                            if (blacklist.some(b => illustTags.some(i => i.includes(b)))) continue;
                            if (whitelist.length > 0 && !whitelist.some(w => illustTags.some(i => i.includes(w)))) continue;

                            // 找到了第一张合规的图！
                            initIllustMap[groupId] = ill.id;
                            // 如果这张图还没被加进下载队列，就加进去
                            if (!targetIllusts.some(i => i.id === ill.id)) {
                                targetIllusts.push(ill);
                            }
                            break; // 找到一张就够了，停止回溯
                        }
                    }

                    targetIllusts.sort((a, b) => a.id - b.id);

                    for (let illust of targetIllusts) {
                        const illustTags = illust.tags.flatMap(t => [t.name, t.translated_name]).filter(Boolean);
                        let validGroups = [];

                        for (let gid of [...needsUpdateGroups, ...initGroups]) {
                            if (initGroups.includes(gid)) {
                                if (illust.id === initIllustMap[gid]) validGroups.push(gid);
                                continue;
                            }
                            const groupTags = data[gid].tags || { whitelist: [], blacklist: [] };
                            if (groupTags.blacklist.some(b => illustTags.some(i => i.includes(b)))) continue;
                            if (groupTags.whitelist.length > 0 && !groupTags.whitelist.some(w => illustTags.some(i => i.includes(w)))) continue;
                            validGroups.push(gid);
                        }

                        // 【核心改动 1】支持多P推送，并依然使用 large 压缩图
                        let targetImgUrls = [];
                        if (illust.meta_pages && illust.meta_pages.length > 0) {
                            // Pixiv 多图作品，为防止一次发太多卡死，最多截取前 10 张
                            targetImgUrls = illust.meta_pages.slice(0, 10).map(p => p.image_urls.large);
                        } else if (illust.image_urls && illust.image_urls.large) {
                            // 单图作品
                            targetImgUrls = [illust.image_urls.large];
                        }

                        let imgBuffers = [];
                        // 只有当有群需要接收这张图时，才去执行下载
                        if (validGroups.length > 0 && targetImgUrls.length > 0) {
                            for (let url of targetImgUrls) {
                                try {
                                    const imgRes = await fetch(url, { headers: { "Referer": "https://app-api.pixiv.net/" } });
                                    imgBuffers.push(Buffer.from(await imgRes.arrayBuffer()));
                                } catch (e) {
                                    logger.error(`[kkp-plugin] 图片下载失败：${e.message}`);
                                }
                            }
                        }
                        
                        const date = new Date(illust.create_date);
                        const utc8Date = new Date(date.getTime() + 8 * 60 * 60 * 1000);
                        const formattedTime = `${utc8Date.getUTCFullYear()}-${String(utc8Date.getUTCMonth() + 1).padStart(2, "0")}-${String(utc8Date.getUTCDate()).padStart(2, "0")} ${String(utc8Date.getUTCHours()).padStart(2, "0")}:${String(utc8Date.getUTCMinutes()).padStart(2, "0")}:${String(utc8Date.getUTCSeconds()).padStart(2, "0")}`;

                        const tagsStr = illust.tags.map(t => t.translated_name || t.name).join(", ");
                        const pageCountInfo = illust.page_count > 1 ? ` (共${illust.page_count}P)` : "";
                        const infoMsg = [
                            `爷爷，您关注的画师：${illust.user.name}（${illust.user.id}）更新了`,
                            `pid：${illust.id}${pageCountInfo}`,
                            `是否ai：${illust.illust_ai_type === 2 ? "是" : "否"}`,
                            `标题：${illust.title}`,
                            `上传时间：${formattedTime}`,
                            `😊：${illust.total_bookmarks}，👁：${illust.total_view}`,
                            `tag：${tagsStr}`
                        ].join("\n");

                        let sendSuccessGroups = [];

                        for (let gid of validGroups) {
                            let msg = [infoMsg];
                            
                            if (imgBuffers.length > 0) {
                                // 把下载好的多张图统统塞进一条消息里
                                for (let buf of imgBuffers) {
                                    msg.push(segment.image(buf));
                                }
                                // 如果真实图数超过了我们的限制，给个提示
                                if (illust.page_count > targetImgUrls.length) {
                                    msg.push(`\n[本作多达 ${illust.page_count} 张图，此处仅展示前 ${targetImgUrls.length} 张]，获取原图使用pidxxx`);
                                }
                            } else {
                                msg.push("\n[图片下载失败，请输入pidxxx重试]");
                            }

                            try {
                                await Bot.pickGroup(gid).sendMsg(msg);
                                // 记录成功发送的群
                                sendSuccessGroups.push(gid);
                            } catch (err) {
                                logger.error(`[kkp-plugin] 群 ${gid} 发送失败：${err.message}`);
                            }
                            // 加入延时，防止高频发送被风控
                            await new Promise(r => setTimeout(r, 2000));
                        }

                        hasUpdates = true;

                        // 【核心改动 2】完美的防丢图 Redis 更新逻辑
                        for (let gid of [...needsUpdateGroups, ...initGroups]) {
                            // 如果该群在发送名单里，但是“没在”成功名单里，说明发送抛错了
                            if (validGroups.includes(gid) && !sendSuccessGroups.includes(gid)) {
                                continue; // 跳过更新，保持 Redis 为旧进度，等待下次轮询重试！
                            }
                            // 如果发送成功了，或者压根就是因为命中黑白名单被过滤跳过的，正常把进度推到当前图 ID
                            await redis.hSet(`kkp:pixiv:progress:${gid}`, artistId, illust.id);
                        }
                    }
                    
                    // 【非常重要】确保下面紧接着的就是 } catch (err) {，
                    // 原版代码最底部的那个统一下发 redis.hSet 的循环已经被我们彻底删除了！

                } catch (err) {
                    logger.error(`[kkp-plugin] 检查画师 ${artistId} 异常：${err.message}`);
                    debugResponse[artistId] = "error";
                } finally {
                    await new Promise(res => setTimeout(res, 2000));
                }
            }

            if (isManual) {
                logger.mark(`[kkp-plugin] App API直连检查完毕，各画师状态：\n${JSON.stringify(debugResponse, null, 2)}`);
            }

            return { state: hasUpdates ? "success" : "empty" };

        } catch (error) {
            logger.error(`[kkp-plugin] 顶层推送逻辑崩溃: ${error.stack}`);
            return { state: "error", reason: error.message };
        }
    }
}

// ================= 定时任务 =================
schedule.scheduleJob("0 */2 * * *", async () => {
    const randomDelay = Math.floor(Math.random() * 60 * 60 * 1000);
    setTimeout(() => {
        logger.mark("[kkp-plugin] 触发定时自动画师推送检查");
        new PixivPushPlugin().executePushLogic();
    }, randomDelay);
});