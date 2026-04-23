import plugin from '../../../lib/plugins/plugin.js';
import schedule from "node-schedule";
import fetch from 'node-fetch';
import crypto from 'crypto';
import yaml from 'yaml';
import fs from 'fs';

// ================= 必填配置 =================
// 请在这里填入你的 Pixiv Refresh Token
const REFRESH_TOKEN = "jImLzWI0YxqPUutxPfzHNCMJquS9d3hPZr2Pyl5n5c4";
// ============================================

const CLIENT_ID = "MOBrBDS8blbauoSck0ZfDbtuzpyT";
const CLIENT_SECRET = "lsACyCD94FhDUtGTXi3QzcFE2uU1hqtDaKeqrdwj";
const HASH_SECRET = "28c1fdd170a5204386cb1313c7077b34f83e4aaf4aa829ce78c231e05b0bae2c";

// 内存缓存 access_token
let accessTokenCache = null;
let tokenExpireTime = 0;

export class kkp extends plugin {
    constructor() {
        super({
            name: 'KKP推送与帮助(App API完美版)',
            dsc: '基于RefreshToken与App端API检查更新',
            event: 'message',
            priority: 50,
            rule: [
                {
                    reg: '^#?kkp帮助$',
                    fnc: 'sendKKPImage',
                },
                {
                    reg: '^#?强制推送p?$',
                    fnc: 'forcePush',
                    permission: 'master'
                }
            ]
        });
    }

    async sendKKPImage(e) {
        const imagePath = './plugins/kkp-plugin/config/kkp.jpg';
        let msg = [segment.image(`file://${imagePath}`)];
        await e.reply(msg);
        return true;
    }

    // 获取并维护 Access Token
    async getAccessToken() {
        if (accessTokenCache && Date.now() < tokenExpireTime) {
            return { token: accessTokenCache, error: null };
        }

        const clientTime = new Date().toISOString().split('.')[0] + '+00:00';
        const clientHash = crypto.createHash("md5").update(clientTime + HASH_SECRET).digest("hex");

        const params = new URLSearchParams({
            "client_id": CLIENT_ID,
            "client_secret": CLIENT_SECRET,
            "grant_type": "refresh_token",
            "refresh_token": REFRESH_TOKEN
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
            'Authorization': `Bearer ${token}`,
            'User-Agent': 'PixivAndroidApp/5.0.234 (Android 11; Pixel 5)',
            'App-OS': 'android',
            'App-OS-Version': '11',
            'App-Version': '5.0.234',
            'Accept-Language': 'zh-CN'
        };
    }

    async forcePush(e) {
        await e.reply("正在通过 App API 检查订阅更新...");
        const result = await this.executePushLogic(true);

        // 彻底修复回复判断逻辑
        if (result.state === "empty") {
            await e.reply("检查完毕：订阅的画师暂无更新。");
        } else if (result.state === "error") {
            await e.reply(`检查失败，请核对日志或原因：\n${result.reason}`);
        } else if (result.state === "success") {
            await e.reply("手动检查及推送任务执行完毕，发现新作品！");
        }
        return true;
    }

    async executePushLogic(isManual = false) {
        try {
            const filePath = './plugins/kkp-plugin/config/dingyue.yaml';
            if (!fs.existsSync(filePath)) {
                return { state: "error", reason: "找不到 dingyue.yaml 配置文件" };
            }
            
            const data = yaml.parse(fs.readFileSync(filePath, 'utf8'));
            if (!data) return { state: "empty" };

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

                    const redisKey = "kkp:pixiv:latest_illust_app";
                    const storedMaxStr = await redis.hGet(redisKey, artistId);
                    const storedMax = storedMaxStr ? Number(storedMaxStr) : 0;

                    if (storedMax === 0) {
                        await redis.hSet(redisKey, artistId, maxId);
                        debugResponse[artistId] = `init_${maxId}`;
                        continue;
                    }

                    if (maxId <= storedMax) {
                        debugResponse[artistId] = `no_update (local: ${storedMax}, remote: ${maxId})`;
                        continue;
                    }

                    const newIllusts = latestIllusts.filter(ill => ill.id > storedMax).reverse();
                    hasUpdates = true;
                    debugResponse[artistId] = `new:[${newIllusts.map(i => i.id).join(",")}]`;

                    logger.mark(`[kkp-plugin] 发现画师 ${artistId} 有 ${newIllusts.length} 篇更新！`);

                    for (let illust of newIllusts.slice(0, 3)) {
                        let originalUrl = "";
                        if (illust.meta_pages && illust.meta_pages.length > 0) {
                            originalUrl = illust.meta_pages[0].image_urls.original;
                        } else if (illust.meta_single_page) {
                            originalUrl = illust.meta_single_page.original_image_url;
                        }

                        let imgBuffer = null;
                        if (originalUrl) {
                            try {
                                const imgRes = await fetch(originalUrl, {
                                    headers: { "Referer": "https://app-api.pixiv.net/" } 
                                });
                                imgBuffer = Buffer.from(await imgRes.arrayBuffer());
                            } catch (e) {
                                logger.error(`[kkp-plugin] 作品下载失败：${e.message}`);
                            }
                        }

                        const date = new Date(illust.create_date);
                        const utc8Date = new Date(date.getTime() + 8 * 60 * 60 * 1000);
                        const formattedTime = `${utc8Date.getUTCFullYear()}-${String(utc8Date.getUTCMonth() + 1).padStart(2, "0")}-${String(utc8Date.getUTCDate()).padStart(2, "0")} ${String(utc8Date.getUTCHours()).padStart(2, "0")}:${String(utc8Date.getUTCMinutes()).padStart(2, "0")}:${String(utc8Date.getUTCSeconds()).padStart(2, "0")}`;
                        
                        const tags = illust.tags.map(t => t.translated_name || t.name).join(", ");
                        
                        const infoMsg = [
                            `爷爷，您关注的画师：${illust.user.name}（${illust.user.id}）更新了`,
                            `pid：${illust.id}`,
                            `是否ai：${illust.illust_ai_type === 2 ? "是" : "否"}`,
                            `标题：${illust.title}`,
                            `上传时间：${formattedTime}`,
                            `😊：${illust.total_bookmarks},👁：${illust.total_view}`,
                            `tag：${tags}`
                        ].join("\n");

                        let message = [infoMsg];
                        if (imgBuffer) {
                            message.push(segment.image(imgBuffer));
                        } else {
                            message.push("\n[由于网络原因，图片下载失败，请直接点击 PID 访问]");
                        }

                        const targetGroups = artistToGroups[artistId] || [];
                        for (let groupId of targetGroups) {
                            const group = Bot.pickGroup(groupId);
                            await group.sendMsg(message).catch(err => {
                                logger.error(`[kkp-plugin] 推送失败：`, err);
                            });
                            await new Promise(res => setTimeout(res, 5000)); 
                        }
                    }

                    await redis.hSet(redisKey, artistId, maxId);

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

schedule.scheduleJob('0 */2 * * *', async () => {
    const randomDelay = Math.floor(Math.random() * 60 * 60 * 1000); 
    setTimeout(() => {
        logger.mark('[kkp-plugin] 触发定时自动画师推送检查');
        new kkp().executePushLogic();
    }, randomDelay);
});