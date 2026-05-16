import plugin from "../../../lib/plugins/plugin.js";
import axios from "axios";
import fs from "fs";
import YAML from "yaml";
import { sendPixivImageWithFallback, buildPixivMessage } from "./pixivSender.js";
import { getAppApiHeaders } from "./pixivAuth.js"; // 【接入公共鉴权模块】

export class PixivArtistWorksFetcher extends plugin {
    constructor() {
        super({
            name: "p站画师id获取图片",
            dsc: "通过画师ID获取作品图片",
            event: "message",
            priority: 50,
            rule: [
                { reg: "^#来(\\d+)张(\\d+)作品$", fnc: "processLatestArtistWorks" },
                { reg: "^#?随机(\\d+)张(\\d+)作品$", fnc: "processRandomArtistWorks" }
            ]
        });
    }

    getConfig() {
        const path = "./plugins/kkp-plugin/config/config.yaml";
        if (!fs.existsSync(path)) return { "max_images": 40, "recall": false, "time": 60000 };
        const fileContents = fs.readFileSync(path, "utf8");
        return YAML.parse(fileContents) || {};
    }

    // 【新增】：读取当前群的黑白名单配置
    getGroupTags(groupId) {
        const filePath = "./plugins/kkp-plugin/config/dingyue.yaml";
        if (!fs.existsSync(filePath)) return { whitelist: [], blacklist: [] };
        const data = YAML.parse(fs.readFileSync(filePath, "utf8")) || {};
        return data[groupId]?.tags || { whitelist: [], blacklist: [] };
    }

    async processLatestArtistWorks(e) {
        await this._processArtistWorks(e, false);
    }

    async processRandomArtistWorks(e) {
        await this._processArtistWorks(e, true);
    }

    async _processArtistWorks(e, isRandom) {
        const match = e.msg.match(isRandom ? /^#?随机(\d+)张(\d+)作品$/ : /^#来(\d+)张(\d+)作品$/);
        if (!match) return;

        const num = parseInt(match[1]);
        const artistId = match[2];

        if (num > 30) {
            await e.reply("一次最多看30部作品哦，太多会被封号的！");
            return;
        }

        try {
            // 一行代码搞定鉴权头！
            const headers = await getAppApiHeaders();
            
            const url = `https://app-api.pixiv.net/v1/user/illusts?user_id=${artistId}&type=illust`;
            const response = await axios.get(url, { headers, timeout: 10000 });
            let illusts = response.data.illusts;

            if (!illusts || illusts.length === 0) {
                await e.reply(`未找到画师 ${artistId} 的作品，可能是ID错误或此人未发图。`);
                return;
            }

            // 【核心修复】：群黑白名单过滤！
            if (e.isGroup) {
                const groupTags = this.getGroupTags(e.group_id.toString());
                const whitelist = groupTags.whitelist || [];
                const blacklist = groupTags.blacklist || [];
                
                illusts = illusts.filter(ill => {
                    const illustTags = ill.tags.flatMap(t => [ t.name, t.translated_name ]).filter(Boolean);
                    if (blacklist.some(b => illustTags.some(i => i.includes(b)))) return false;
                    if (whitelist.length > 0 && !whitelist.some(w => illustTags.some(i => i.includes(w)))) return false;
                    return true;
                });
                
                if (illusts.length === 0) {
                    await e.reply("该画师的作品全部被当前群的黑白名单过滤掉了！");
                    return;
                }
            }

            let targetIllusts = illusts;
            if (isRandom) {
                targetIllusts = this.shuffleArray(targetIllusts).slice(0, num);
            } else {
                targetIllusts = targetIllusts.slice(0, num);
            }

            const pluginConfig = this.getConfig();
            await e.reply(`正在发送画师 ${artistId} 的 ${targetIllusts.length} 部作品...`);

            for (let i = 0; i < targetIllusts.length; i++) {
                const illust = targetIllusts[i];
                try {
                    // 【核心修复】：先提取图片URL，再拼装文案，最后只调用一次引擎！
                    let targetImgUrls = [];
                    if (illust.meta_pages && illust.meta_pages.length > 0) {
                        targetImgUrls = illust.meta_pages.map(p => p.image_urls.original);
                    } else if (illust.meta_single_page && illust.meta_single_page.original_image_url) {
                        targetImgUrls = [ illust.meta_single_page.original_image_url ];
                    }

                    const msgData = buildPixivMessage(illust);
                    await sendPixivImageWithFallback(e, msgData, targetImgUrls, pluginConfig);

                    if (i < targetIllusts.length - 1) {
                        await new Promise(r => setTimeout(r, 2000));
                    }
                } catch (err) {
                    logger.error(`[kkp-plugin] 发送作品 ${illust.id} 失败: ${err.message}`);
                }
            }

        } catch (error) {
            await e.reply(`发生错误：${error.message}`);
        }
    }

    shuffleArray(array) {
        let currentIndex = array.length, randomIndex;
        while (currentIndex !== 0) {
            randomIndex = Math.floor(Math.random() * currentIndex);
            currentIndex--;
            [ array[currentIndex], array[randomIndex] ] = [ array[randomIndex], array[currentIndex] ];
        }
        return array;
    }
}