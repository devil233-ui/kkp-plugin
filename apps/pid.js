import plugin from "../../../lib/plugins/plugin.js";
import fetch from "node-fetch";
import fs from "fs";
import YAML from "yaml";
import crypto from "crypto";
import { sendPixivImageWithFallback, buildPixivMessage } from "./pixivSender.js";
import { getAppApiHeaders } from "./pixivAuth.js";
import { extractPixivId, PIXIV_INPUT_RULE } from "./pixivInput.js";

export class PixivImageFetcher extends plugin {
    constructor() {
        super({
            name: "获取p站图",
            dsc: "获取p站图(App端Token版)",
            event: "message",
            priority: -114514,
            rule: [
                {
                    reg: PIXIV_INPUT_RULE,
                    fnc: "processPixivImages"
                }
            ]
        });
    }

    getConfig() {
        const path = "./plugins/kkp-plugin/config/config.yaml";
        if (!fs.existsSync(path)) return { "recall": false, "time": 60000, "max_images": 40 };
        return YAML.parse(fs.readFileSync(path, "utf8")) || {};
    }

    // ================= 核心处理逻辑 =================
    async processPixivImages(e) {
        try {
            const matchedPid = extractPixivId(e.msg);

            if (!matchedPid) return false;

            // await e.reply(`正在通过 App API 获取作品: ${matchedPid}...`);
            await this.sendPixivDetails(e, matchedPid);
        } catch (error) {
            await e.reply(`发生错误：${error.message}`);
        }
    }

    async sendPixivDetails(e, matchedPid) {
        const headers = await getAppApiHeaders();
        const illustUrl = `https://app-api.pixiv.net/v1/illust/detail?illust_id=${matchedPid}`;
        let resData;
        try {
            // 直接将公共 headers 传给 fetch，并加上超时控制
            const res = await fetch(illustUrl, { headers, timeout: 10000 });
            resData = await res.json();
        } catch (err) {
            return e.reply(`请求 App API 失败: ${err.message}`);
        }

        if (!resData.illust) {
            return e.reply("获取失败，该作品可能已被删除，或账号无权限访问(如R-18)。");
        }

        const illust = resData.illust;

        // 提取原图链接
        let targetImageUrls = [];
        if (illust.meta_pages && illust.meta_pages.length > 0) {
            targetImageUrls = illust.meta_pages.map(p => p.image_urls.original);
        } else if (illust.meta_single_page && illust.meta_single_page.original_image_url) {
            targetImageUrls = [ illust.meta_single_page.original_image_url ];
        }

        const pluginConfig = this.getConfig();
        
        // 直接调包，极其清爽
        const msgData = buildPixivMessage(illust);
        await sendPixivImageWithFallback(e, msgData, targetImageUrls, pluginConfig);
    }
}
