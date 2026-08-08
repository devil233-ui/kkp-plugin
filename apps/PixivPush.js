import plugin from "../../../lib/plugins/plugin.js";
import schedule from "node-schedule";
import fetch from "node-fetch";
// import crypto from "crypto";
import YAML from "yaml";
import fs from "fs";
import path from "path";
import { sendPixivImageWithFallback, buildPixivMessage } from "./pixivSender.js";
import { getAppApiHeaders, isPixivTokenActionRequired } from "./pixivAuth.js";
import { buildPerTargetQueues } from "./pixivPushState.js";
import { keyValue } from "../config/api.js";

const TOKEN_NOTICE_COOLDOWN = 6 * 60 * 60 * 1000;
let lastTokenNoticeAt = 0;
let pushInProgress = false;

async function notifyMasterAboutToken(error) {
    const now = Date.now();
    if (now - lastTokenNoticeAt < TOKEN_NOTICE_COOLDOWN) return;

    const masterQQ = Number(keyValue);
    if (!Number.isSafeInteger(masterQQ) || !global.Bot?.pickFriend) {
        logger.error("[kkp-plugin] 无法发送Token失效通知：未找到主人QQ或私聊适配器");
        return;
    }

    lastTokenNoticeAt = now;
    try {
        const target = global.Bot.pickFriend(masterQQ);
        await target.sendMsg(`⚠️[kkp-plugin] ${error.message}\n更换后无需重启，下一次请求会自动使用新Token。`);
    } catch (notifyError) {
        lastTokenNoticeAt = 0;
        logger.error(`[kkp-plugin] Token失效通知发送失败：${notifyError.message}`);
    }
}

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

    async requireGroupAdmin(e) {
        const role = e.sender?.role || e.member?.role;
        if (!e.isGroup || e.isMaster || role === "owner" || role === "admin") return true;

        await e.reply("仅群主、群管理员或主人可修改本群订阅配置。");
        return false;
    }

    // ================= 订阅管理相关指令 =================
    async subscribeArtist(e) {
        if (!(await this.requireGroupAdmin(e))) return false;

        const targetId = (e.isGroup ? e.group_id : e.user_id).toString();
        const data = this.loadData();

        if (!data[targetId]) data[targetId] = { "pushEnabled": false, "artists": {} };
        if (Object.keys(data).length > 5) return e.reply("已达到订阅上限！");
        if (Object.keys(data[targetId].artists).length >= 500) return e.reply("已达到画师订阅上限！");

        const matches = e.msg.trim().match(/^#?订阅画师(\d+)$/);
        const artistId = matches ? matches[1] : null;
        if (!artistId) return;

        if (data[targetId].artists[artistId]) {
            await e.reply(`已经订阅了 ${artistId}`);
            return;
        }

        let latestId = 0;
        let artistName = "";
        try {
            const headers = await getAppApiHeaders();
            const res = await fetch(`https://app-api.pixiv.net/v1/user/illusts?user_id=${artistId}&type=illust`, { headers, timeout: 10000 });
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

        data[targetId].artists[artistId] = artistName;
        data[targetId].pushEnabled = true;
        this.saveData(data);

        if (latestId > 0) {
            await redis.hSet(`kkp:pixiv:progress:${targetId}`, artistId, latestId);
        } else {
            await redis.hSet(`kkp:pixiv:progress:${targetId}`, artistId, 1);
        }

        await e.reply(`成功订阅画师 ${artistId} (${artistName})，已同步设置推送基准线。`);
    }

    async unsubscribeArtist(e) {
        if (!(await this.requireGroupAdmin(e))) return false;

        const targetId = (e.isGroup ? e.group_id : e.user_id).toString();
        const data = this.loadData();
        if (!data[targetId]) return;

        const matches = e.msg.trim().match(/^#?(取消订阅|删画师)(\d+)$/);
        const artistId = matches ? matches[2] : null;
        if (!artistId) return;

        if (!data[targetId].artists[artistId]) {
            await e.reply(`还未订阅 ${artistId} 哦`);
            return;
        }

        const artistName = data[targetId].artists[artistId];
        delete data[targetId].artists[artistId];
        this.saveData(data);

        const redisKey = `kkp:pixiv:progress:${targetId}`;
        await redis.hDel(redisKey, artistId);

        logger.mark(`[kkp-plugin] 目标 ${targetId} 取消订阅画师 ${artistId}，相关 Redis 记录已清理`);
        await e.reply(`已成功取消订阅画师：${artistName} (${artistId})`);
    }

    async importFollowing(e) {
        const targetId = (e.isGroup ? e.group_id : e.user_id).toString();
        const matches = e.msg.trim().match(/^#?导入关注(列表)?(\d+)$/);
        const targetUid = matches[2];

        let data = this.loadData();
        if (!data[targetId]) data[targetId] = { "pushEnabled": true, "artists": {}, "tags": { "whitelist": [], "blacklist": [] } };

        const headers = await getAppApiHeaders();

        await e.reply(`正在拉取 Pixiv 用户 ${targetUid} 的公开关注列表，由于名单较长（正在翻页），请稍候...`);

        try {
            let url = `https://app-api.pixiv.net/v1/user/following?user_id=${targetUid}&restrict=public`;
            let newArtists = [];

            while (url) {
                const res = await fetch(url, { headers });
                const resData = await res.json();

                if (!resData.user_previews) {
                    if (newArtists.length === 0) return e.reply("拉取失败！请确认该 UID 存在，且关注列表对外公开。");
                    break;
                }

                for (let preview of resData.user_previews) {
                    const artistId = preview.user.id.toString();
                    const artistName = preview.user.name;

                    if (!data[targetId].artists[artistId]) {
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
                    // 【核心修复】：原代码调用的 this.getAppHeaders(token) 根本不存在，已改为直调 headers
                    const illustRes = await fetch(illustUrl, { headers });
                    const illustData = await illustRes.json();

                    data[targetId].artists[artist.id] = artist.name;

                    if (illustData.illusts && illustData.illusts.length > 0) {
                        const maxId = illustData.illusts[0].id;
                        await redis.hSet(`kkp:pixiv:progress:${targetId}`, artist.id, maxId);
                    } else {
                        await redis.hSet(`kkp:pixiv:progress:${targetId}`, artist.id, 1);
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
        const targetId = (e.isGroup ? e.group_id : e.user_id).toString();
        const data = this.loadData();

        if (!data[targetId] || Object.keys(data[targetId].artists).length === 0) {
            await e.reply("当前没有订阅任何画师");
            return;
        }

        let response = `${e.isGroup ? "群" : "私聊"} [${targetId}] 订阅列表：\n`;
        response += `推送状态：${data[targetId].pushEnabled ? "✅已开启" : "❌已关闭"}\n`;

        const groupTags = data[targetId].tags || { "whitelist": [], "blacklist": [] };
        if (groupTags.whitelist && groupTags.whitelist.length > 0) response += `白名单：${groupTags.whitelist.join(", ")}\n`;
        if (groupTags.blacklist && groupTags.blacklist.length > 0) response += `黑名单：${groupTags.blacklist.join(", ")}\n`;
        response += "\n";
        for (const [ artistId, artistName ] of Object.entries(data[targetId].artists)) {
            response += `${artistName}  ${artistId}\n`;
        }
        await e.reply(response);
    }

    async enablePush(e) {
        if (!(await this.requireGroupAdmin(e))) return false;

        const targetId = (e.isGroup ? e.group_id : e.user_id).toString();
        let data = this.loadData();
        if (!data[targetId]) data[targetId] = { "pushEnabled": false, "artists": {} };

        if (!data[targetId].pushEnabled) {
            data[targetId].pushEnabled = true;
            this.saveData(data);
            await e.reply("已开启p推送。");
        } else {
            await e.reply("已经开启了p推送。");
        }
    }

    async disablePush(e) {
        if (!(await this.requireGroupAdmin(e))) return false;

        const targetId = (e.isGroup ? e.group_id : e.user_id).toString();
        let data = this.loadData();
        if (!data[targetId]) return;

        if (data[targetId].pushEnabled) {
            data[targetId].pushEnabled = false;
            this.saveData(data);
            await e.reply("已关闭p推送。");
        } else {
            await e.reply("尚未开启p推送，无需关闭。");
        }
    }

    async manageTags(e) {
        if (!(await this.requireGroupAdmin(e))) return false;

        const targetId = (e.isGroup ? e.group_id : e.user_id).toString();
        let data = this.loadData();

        if (!data[targetId]) data[targetId] = { "pushEnabled": false, "artists": {} };
        if (!data[targetId].tags) data[targetId].tags = { "whitelist": [], "blacklist": [] };

        const match = e.msg.trim().match(/^#?(添加|删除)(白|黑)名单标签(.+)$/);
        if (!match) return;

        const action = match[1];
        const type = match[2] === "白" ? "whitelist" : "blacklist";
        const tag = match[3].trim();
        const typeName = match[2] + "名单";

        let targetList = data[targetId].tags[type];

        if (action === "添加") {
            if (targetList.includes(tag)) return e.reply(`当前${typeName}中已存在标签：${tag}`);
            targetList.push(tag);
            this.saveData(data);
            await e.reply(`成功添加${typeName}标签：${tag}`);
        } else {
            const index = targetList.indexOf(tag);
            if (index === -1) return e.reply(`当前${typeName}中没有标签：${tag}`);
            targetList.splice(index, 1);
            this.saveData(data);
            await e.reply(`成功移除${typeName}标签：${tag}`);
        }
    }

    // ================= 自动推送核心 =================
    async forcePush(e) {
        await e.reply("正在检查订阅更新...");
        const targetId = (e.isGroup ? e.group_id : e.user_id).toString();
        const result = await this.executePushLogic(true, targetId);

        if (result.state === "empty") {
            await e.reply("检查完毕：订阅的画师暂无更新。");
        } else if (result.state === "busy") {
            await e.reply("已有推送检查正在执行，请稍后再试。");
        } else if (result.state === "error") {
            await e.reply(`检查失败，请核对日志或原因：\n${result.reason}`);
        }
        return true;
    }

    async executePushLogic(isManual = false, targetGroupId = null) {
        if (pushInProgress) return { state: "busy" };
        pushInProgress = true;

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

            const headers = await getAppApiHeaders();

            let hasUpdates = false;
            let debugResponse = {};

            for (let artistId of artistIds) {
                try {
                    const url = `https://app-api.pixiv.net/v1/user/illusts?user_id=${artistId}&type=illust`;
                    const res = await fetch(url, { headers, timeout: 10000 });

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
                    const maxId = Math.max(...latestIllusts.map(illust => Number(illust.id)));
                    const targetGroups = artistToGroups[artistId] || [];

                    let needsUpdateGroups = [];
                    const groupProgress = new Map();

                    for (let groupId of targetGroups) {
                        const redisKey = `kkp:pixiv:progress:${groupId}`;
                        const storedMaxStr = await redis.hGet(redisKey, artistId);
                        const storedMax = storedMaxStr ? Number(storedMaxStr) : 0;

                        if (storedMax === 0) {
                            // 【核心修复：防 YAML 偷渡客的静默初始化】
                            // 没有进度的一律只记进度不发图！彻底超度冗余的回溯逻辑！
                            await redis.hSet(redisKey, artistId, maxId);
                            logger.mark(`[kkp-plugin] 检测到目标 ${groupId} 手动添加了画师 ${artistId}，已静默初始化基准线为 ${maxId}`);
                        } else if (maxId > storedMax) {
                            needsUpdateGroups.push(groupId);
                            groupProgress.set(groupId, storedMax);
                        } else {
                            debugResponse[`${artistId}_${groupId}`] = "no_update";
                        }
                    }

                    // 拦截：如果没有群需要正常更新（全都没更新或全是刚初始化的），直接切到下一个画师
                    if (needsUpdateGroups.length === 0) continue;

                    const { queuedIdsByGroup, targetIllusts } = buildPerTargetQueues(
                        latestIllusts,
                        groupProgress,
                        needsUpdateGroups
                    );
                    const blockedGroups = new Set();

                    for (let illust of targetIllusts) {
                        const illustId = Number(illust.id);
                        const eligibleGroups = needsUpdateGroups.filter(gid => (
                            !blockedGroups.has(gid) && queuedIdsByGroup.get(gid)?.has(String(illust.id))
                        ));
                        const illustTags = illust.tags.flatMap(t => [ t.name, t.translated_name ]).filter(Boolean);
                        let validGroups = [];

                        for (let gid of eligibleGroups) {
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

                        const sendSuccessGroups = [];
                        if (validGroups.length > 0 && targetImgUrls.length > 0) {
                            const customPrefix = `爷爷，您关注的画师：${illust.user.name}（${illust.user.id}）更新了`;
                            const infoMsg = buildPixivMessage(illust, customPrefix);

                            for (let gid of validGroups) {
                                let target = global.Bot.gl && global.Bot.gl.has(Number(gid))
                                    ? global.Bot.pickGroup(Number(gid))
                                    : global.Bot.pickFriend(Number(gid));

                                if (!target) {
                                    blockedGroups.add(gid);
                                    continue;
                                }

                                let sendConfig = {
                                    ...pluginConfig,
                                    ...(data[gid]?.recallConfig || {})
                                };

                                try {
                                    const isSuccess = await sendPixivImageWithFallback(target, infoMsg, targetImgUrls, sendConfig);
                                    if (isSuccess) {
                                        sendSuccessGroups.push(gid);
                                        hasUpdates = true;
                                    } else {
                                        blockedGroups.add(gid);
                                    }
                                } catch (sendError) {
                                    blockedGroups.add(gid);
                                    logger.error(`[kkp-plugin] 向目标 ${gid} 推送作品 ${illust.id} 失败：${sendError.message}`);
                                }

                                await new Promise(r => setTimeout(r, 2000));
                            }
                        }

                        const filteredGroups = eligibleGroups.filter(gid => !validGroups.includes(gid));
                        const noImageGroups = targetImgUrls.length === 0 ? validGroups : [];
                        const advanceGroups = new Set([ ...filteredGroups, ...noImageGroups, ...sendSuccessGroups ]);

                        for (let gid of advanceGroups) {
                            const currentProgress = Number(groupProgress.get(gid) || 0);
                            const nextProgress = Math.max(currentProgress, illustId);
                            if (nextProgress > currentProgress) {
                                await redis.hSet(`kkp:pixiv:progress:${gid}`, artistId, nextProgress);
                                groupProgress.set(gid, nextProgress);
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
            if (isPixivTokenActionRequired(error)) {
                logger.error(`[kkp-plugin] ${error.message}`);
                await notifyMasterAboutToken(error);
            } else {
                logger.error(`[kkp-plugin] 顶层推送逻辑崩溃: ${error.stack}`);
            }
            return { state: "error", reason: error.message };
        } finally {
            pushInProgress = false;
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
