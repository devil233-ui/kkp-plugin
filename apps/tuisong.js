import plugin from "../../../lib/plugins/plugin.js";
import schedule from "node-schedule";
import fetch from "node-fetch";
import yaml from "yaml";
import fs from "fs";

// 使用原生 API 时的通用请求头
const baseHeaders = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Accept-Language": "zh-CN,zh;q=0.9",
    "Referer": "https://www.pixiv.net/"
};

export class kkp extends plugin {
    constructor() {
        super({
            name: "KKP推送与帮助(纯本地版)",
            dsc: "本地直连Pixiv进行画师更新检查",
            event: "message",
            priority: 50,
            rule: [
                {
                    reg: "^#?kkp帮助$",
                    fnc: "sendKKPImage",
                },
                {
                    reg: "^#?强制推送p?$",
                    fnc: "forcePush",
                    permission: "master"
                }
            ]
        });
    }

    async sendKKPImage(e) {
        const imagePath = "./plugins/kkp-plugin/config/kkp.jpg";
        let msg = [ segment.image(`file://${imagePath}`) ];
        await e.reply(msg);
        return true;
    }

    async forcePush(e) {
        await e.reply("正在通过东京服务器直连 Pixiv 检查更新...");
        const result = await this.executePushLogic(true);

        if (result === "empty") {
            await e.reply("检查完毕：订阅的画师暂无更新。");
        } else if (result === "error") {
            await e.reply("检查失败：请查看控制台日志排查网络或接口问题。");
        } else if (result === "success") {
            await e.reply("手动检查及推送任务执行完毕！");
        }
    }

    async executePushLogic(isManual = false) {
        try {
            const filePath = "./plugins/kkp-plugin/config/dingyue.yaml";
            if (!fs.existsSync(filePath)) {
                logger.error("[kkp-plugin] 找不到 dingyue.yaml 配置文件");
                return "error";
            }
            
            const data = yaml.parse(fs.readFileSync(filePath, "utf8"));
            if (!data) return "empty";

            // 整理需要检查的画师及其对应的订阅群
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
            if (artistIds.length === 0) return "empty";

            let hasUpdates = false;

            for (let artistId of artistIds) {
                try {
                    // 1. 调用 Pixiv 官方 AJAX 接口获取画师所有作品 ID
                    const profileRes = await fetch(`https://www.pixiv.net/ajax/user/${artistId}/profile/all?lang=zh`, {
                        headers: { ...baseHeaders, "Referer": `https://www.pixiv.net/users/${artistId}` },
                        timeout: 10000
                    });
                    
                    if (!profileRes.ok) {
                        logger.error(`[kkp-plugin] 请求画师 ${artistId} 主页失败，HTTP状态码：${profileRes.status}`);
                        continue;
                    }

                    const profileData = await profileRes.json();
                    if (profileData.error) {
                        logger.error(`[kkp-plugin] 获取画师 ${artistId} 数据被阻截：${profileData.message}`);
                        continue;
                    }

                    // 提取所有插画和漫画 ID
                    const illusts = profileData.body.illusts || {};
                    const manga = profileData.body.manga || {};
                    const allIds = [ ...Object.keys(illusts), ...Object.keys(manga) ]
                                    .map(Number)
                                    .filter(id => !isNaN(id));

                    if (allIds.length === 0) continue; // 画师没发过图

                    const maxId = Math.max(...allIds); // 获取最新一张图的 ID
                    const redisKey = "kkp:pixiv:latest_illust"; // 使用 Redis Hash 存储进度
                    const storedMaxStr = await redis.hGet(redisKey, artistId);
                    const storedMax = storedMaxStr ? Number(storedMaxStr) : 0;

                    // 2. 初始化逻辑（防刷屏）
                    if (storedMax === 0) {
                        // 第一次抓取该画师，只记录最新进度，不往前推送旧图
                        await redis.hSet(redisKey, artistId, maxId);
                        logger.mark(`[kkp-plugin] 初始化画师 ${artistId} 阅读进度，基准线 ID 设置为 ${maxId}`);
                        continue;
                    }

                    if (maxId <= storedMax) continue; // 当前最新 ID 没变，说明无更新

                    // 3. 发现更新！筛选出所有比基准线 ID 大的作品，按从小到大排序（先推旧的再推最新的）
                    const newIds = allIds.filter(id => id > storedMax).sort((a, b) => a - b);
                    hasUpdates = true;

                    logger.mark(`[kkp-plugin] 发现画师 ${artistId} 有 ${newIds.length} 篇新更新：${newIds.join(", ")}`);

                    // 限制单次最多推 3 张，防止画师爆肝导致机器人被风控
                    for (let newId of newIds.slice(0, 3)) {
                        // 4. 获取单张图片的详情
                        const detailRes = await fetch(`https://www.pixiv.net/ajax/illust/${newId}?lang=zh`, {
                            headers: { ...baseHeaders, "Referer": `https://www.pixiv.net/artworks/${newId}` }
                        });
                        const detailData = await detailRes.json();

                        if (detailData.error || !detailData.body) {
                            logger.error(`[kkp-plugin] 作品 ${newId} 详情解析失败`);
                            continue;
                        }

                        const body = detailData.body;
                        const tagList = body.tags.tags.map(t => t.tag);
                        
                        // 转换 UTC 时间为东八区 (北京时间) YYYY-MM-DD HH:mm:ss
                        const date = new Date(body.createDate);
                        const utc8Date = new Date(date.getTime() + 8 * 60 * 60 * 1000);
                        const formattedTime = `${utc8Date.getUTCFullYear()}-${String(utc8Date.getUTCMonth() + 1).padStart(2, "0")}-${String(utc8Date.getUTCDate()).padStart(2, "0")} ${String(utc8Date.getUTCHours()).padStart(2, "0")}:${String(utc8Date.getUTCMinutes()).padStart(2, "0")}:${String(utc8Date.getUTCSeconds()).padStart(2, "0")}`;

                        // 获取原图最高画质的直链 (i.pximg.net)
                        
                        // 获取原图最高画质的直链 (i.pximg.net)
                        const originalUrl = body.urls.original; 

                        // 5. 利用东京服务器的网络，直接将图片下载到内存 Buffer
                        let imgBuffer = null;
                        try {
                            const imgRes = await fetch(originalUrl, {
                                headers: { "Referer": "https://www.pixiv.net/" } // 下载 pximg.net 必须带 Referer
                            });
                            imgBuffer = Buffer.from(await imgRes.arrayBuffer());
                        } catch (e) {
                            logger.error(`[kkp-plugin] 作品 ${newId} 图片流下载失败：${e.message}`);
                        }

                        // 6. 构造推送消息
                        const infoMsg = [
                            `爷爷，您关注的画师：${body.userName}（${body.userId}）更新了`,
                            `pid：${body.illustId}`,
                            `是否ai：${body.aiType === 2 ? "是" : "否"}`,
                            `标题：${body.illustTitle}`,
                            `上传时间：${formattedTime}`,
                            `♥：${body.likeCount},😊：${body.bookmarkCount},👁：${body.viewCount}`,
                            `tag：${tagList.join(", ")}`
                        ].join("\n");

                        let message = [ infoMsg ];
                        if (imgBuffer) {
                            message.push(segment.image(imgBuffer));
                        } else {
                            message.push("\n[由于网络原因，图片下载失败，请直接点击 PID 访问]");
                        }

                        // 7. 发送到对应的群聊
                        const targetGroups = artistToGroups[artistId] || [];
                        for (let groupId of targetGroups) {
                            const group = Bot.pickGroup(groupId);
                            await group.sendMsg(message).catch(err => {
                                logger.error(`[kkp-plugin] 向群 ${groupId} 推送失败：`, err);
                            });
                            await new Promise(res => setTimeout(res, 5000)); // 群发缓冲 5 秒，防风控
                        }
                    }

                    // 8. 成功处理完该画师的新作品后，才将进度记录写入 Redis
                    await redis.hSet(redisKey, artistId, maxId);

                } catch (err) {
                    logger.error(`[kkp-plugin] 检查画师 ${artistId} 时发生未捕获异常：${err.message}`);
                }

                // 检查完一个画师，休息 3 秒，防止给 Pixiv 发送过快导致 IP 暂时被 ban
                await new Promise(res => setTimeout(res, 3000));
            }

            return hasUpdates ? "success" : "empty";

        } catch (error) {
            logger.error(`[kkp-plugin] 顶层推送逻辑执行崩溃: ${error.stack}`);
            return "error";
        }
    }
}

// 依然保持原有的定时任务逻辑
schedule.scheduleJob("0 */2 * * *", async() => {
    const randomDelay = Math.floor(Math.random() * 60 * 60 * 1000); 
    setTimeout(() => {
        logger.mark("[kkp-plugin] 触发定时自动画师推送检查");
        new kkp().executePushLogic();
    }, randomDelay);
});