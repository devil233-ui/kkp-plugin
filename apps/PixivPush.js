import plugin from "../../../lib/plugins/plugin.js";
import schedule from "node-schedule";
import fetch from "node-fetch";
import crypto from "crypto";
import YAML from "yaml";
import fs from "fs";
import path from "path";
import { sendPixivImageWithFallback } from "./pixivSender.js";

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

    getConfig() {
        const configPath = "./plugins/kkp-plugin/config/config.yaml";
        if (!fs.existsSync(configPath)) return { "recall": false, "time": 60000, "max_images": 40 };
        return YAML.parse(fs.readFileSync(configPath, "utf8")) || {};
    }

    async sendKKPImage(e) {
        const imagePath = "./plugins/kkp-plugin/config/kkp.jpg";
        let msg = [ segment.image(`file://${imagePath}`) ];
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
        if (Object.keys(data[groupId].artists).length >= 500) return e.reply("该群已达到画师订阅上限！");

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

        if (latestId > 0) {
            await redis.hSet(`kkp:pixiv:progress:${groupId}`, artistId, latestId);
        } else {
            await redis.hSet(`kkp:pixiv:progress:${groupId}`, artistId, 1);
        }

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

            while (url) {
                const res = await fetch(url, { headers: this.getAppHeaders(tokenResult.token) });
                const resData = await res.json();

                if (!resData.user_previews) {
                    if (newArtists.length === 0) return e.reply("拉取失败！请确认该 UID 存在，且关注列表对外公开。");
                    break;
                }

                for (let preview of resData.user_previews) {
                    const artistId = preview.user.id.toString();
                    const artistName = preview.user.name;

                    if (!data[groupId].artists[artistId]) {
                        newArtists.push({ id: artistId, name: artistName });
                    }
                }

                url = resData.next_url || null;
            }

            if (newArtists.length === 0) return e.reply("该用户的关注列表中没有发现新画师（或已全部订阅）。");

            const estimateMin = (newArtists.length * 2 / 60).toFixed(1);
            await e.reply(`翻页拉取完毕，成功获取到 ${newArtists.length} 位新画师！\n为防止大量请求导致服务器 IP 被封，正在后台逐一静默建立基准线，预计需要 ${estimateMin} 分钟，请耐心等待完成提示...`);

            let successCount = 0;
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
                await new Promise(r => setTimeout(r, 1000));
            }

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
        for (const [ artistId, artistName ] of Object.entries(data[groupId].artists)) {
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
        await e.reply("正在检查订阅更新...");
        const result = await this.executePushLogic(true, e.group_id.toString());

        if (result.state === "empty") {
            await e.reply("检查完毕：订阅的画师暂无更新。");
        } else if (result.state === "error") {
            await e.reply(`检查失败，请核对日志或原因：\n${result.reason}`);
        }
        return true;
    }

    async executePushLogic(isManual = false, targetGroupId = null) {
        try {
            const data = this.loadData();
            if (Object.keys(data).length === 0) return { state: "empty" };

            const pluginConfig = this.getConfig();
            const artistToGroups = {};
            for (let groupId in data) {
                if (targetGroupId && groupId !== targetGroupId) continue;

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

                    // 1. 彻底清理无用变量，只保留单纯的新进度列表
                    let needsUpdateGroups = [];
                    let globalStoredMax = maxId;

                    // 2. 遍历检查各群的进度
                    for (let groupId of targetGroups) {
                        const redisKey = `kkp:pixiv:progress:${groupId}`;
                        const storedMaxStr = await redis.hGet(redisKey, artistId);
                        const storedMax = storedMaxStr ? Number(storedMaxStr) : 0;

                        if (storedMax === 0) {
                            // 【核心修复：防 YAML 偷渡客的静默初始化】
                            // 没有进度的一律只记进度不发图！彻底超度冗余的回溯逻辑！
                            await redis.hSet(redisKey, artistId, maxId);
                            logger.mark(`[kkp-plugin] 检测到群 ${groupId} 手动添加了画师 ${artistId}，已静默初始化基准线为 ${maxId}`);
                        } else if (maxId > storedMax) {
                            needsUpdateGroups.push(groupId);
                            if (storedMax < globalStoredMax) globalStoredMax = storedMax;
                        } else {
                            debugResponse[`${artistId}_${groupId}`] = "no_update";
                        }
                    }

                    // 拦截：如果没有群需要正常更新（全都没更新或全是刚初始化的），直接切到下一个画师
                    if (needsUpdateGroups.length === 0) continue;

                    // 准备待推送的作品列表（取大于基准线的最老3张发出来）
                    let targetIllusts = latestIllusts.filter(ill => ill.id > globalStoredMax).reverse().slice(-3);

                    for (let illust of targetIllusts) {
                        const illustTags = illust.tags.flatMap(t => [ t.name, t.translated_name ]).filter(Boolean);
                        let validGroups = [];

                        for (let gid of needsUpdateGroups) {
                            const groupTags = data[gid].tags || { whitelist: [], blacklist: [] };
                            if (groupTags.blacklist.some(b => illustTags.some(i => i.includes(b)))) continue;
                            if (groupTags.whitelist.length > 0 && !groupTags.whitelist.some(w => illustTags.some(i => i.includes(w)))) continue;
                            validGroups.push(gid);
                        }

                        let targetImgUrls = [];
                        if (illust.meta_pages && illust.meta_pages.length > 0) {
                            // 去掉 slice，把全量图片直接全取出来
                            targetImgUrls = illust.meta_pages.map(p => p.image_urls.original);
                        } else if (illust.meta_single_page && illust.meta_single_page.original_image_url) {
                            targetImgUrls = [ illust.meta_single_page.original_image_url ];
                        }

                        // 只有当有群需要接收这张图时，才去拼文案和发图
                        if (validGroups.length > 0 && targetImgUrls.length > 0) {
                            const date = new Date(illust.create_date);
                            const utc8Date = new Date(date.getTime() + 8 * 60 * 60 * 1000);
                            const formattedTime = `${utc8Date.getUTCFullYear()}-${String(utc8Date.getUTCMonth() + 1).padStart(2, "0")}-${String(utc8Date.getUTCDate()).padStart(2, "0")} ${String(utc8Date.getUTCHours()).padStart(2, "0")}:${String(utc8Date.getUTCMinutes()).padStart(2, "0")}:${String(utc8Date.getUTCSeconds()).padStart(2, "0")}`;

                            const tagsStr = illust.tags.map(t => t.translated_name || t.name).join(", ");
                            const pageCountInfo = illust.page_count > 1 ? ` (共${illust.page_count}P)` : "";
                            let extraInfo = illust.page_count > targetImgUrls.length ? `\n[本作多达 ${illust.page_count} 张图，此处仅展示前 ${targetImgUrls.length} 张]` : "";
                            let ugoiraAlert = illust.illust_type === 2 ? "\n[⚠️本作是 Pixiv特殊动图(Ugoira)，受限于机制此处仅展示首帧封面，请前往原站查看动效]" : "";

                            const infoMsg = [
                                `爷爷，您关注的画师：${illust.user.name}（${illust.user.id}）更新了`,
                                `https://www.pixiv.net/artworks/${illust.id}${pageCountInfo}`,
                                `是否ai：${illust.illust_ai_type === 2 ? "是" : "否"}`,
                                `标题：${illust.title}`,
                                `上传时间：${formattedTime}`,
                                `tag：${tagsStr}${extraInfo}${ugoiraAlert}`
                            ].join("\n");

                            let sendSuccessGroups = [];
                            for (let gid of validGroups) {
                                const group = Bot.pickGroup(Number(gid));
                                if (!group) continue;

                                // 【核心逻辑】：将 config.yaml 的全局配置与群独立撤回配置完美缝合！
                                let sendConfig = {
                                    ...pluginConfig, // 垫底：包含 max_images=40, 全局 recall 等
                                    ...(data[gid]?.recallConfig || {}) // 覆盖：如果群有独立撤回设置，则覆盖全局
                                };

                                // 将组装好的 sendConfig 传给引擎，引擎会自动根据里面的 max_images 进行截断并发出警告！
                                const isSuccess = await sendPixivImageWithFallback(group, [ infoMsg ], targetImgUrls, sendConfig);
                                
                                if (isSuccess) sendSuccessGroups.push(gid);

                                await new Promise(r => setTimeout(r, 2000)); 
                            }

                            hasUpdates = true;

                            // 防丢图更新进度：只更新那些真正发送成功的群
                            for (let gid of needsUpdateGroups) {
                                if (validGroups.includes(gid) && !sendSuccessGroups.includes(gid)) {
                                    continue; // 被风控拦截全军覆没，不更新进度，等下次重试
                                }
                                await redis.hSet(`kkp:pixiv:progress:${gid}`, artistId, illust.id);
                            }
                        }
                    }

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
schedule.scheduleJob("0 */2 * * *", async() => {
    const randomDelay = Math.floor(Math.random() * 60 * 60 * 1000);
    setTimeout(() => {
        logger.mark("[kkp-plugin] 触发定时自动画师推送检查");
        new PixivPushPlugin().executePushLogic();
    }, randomDelay);
});