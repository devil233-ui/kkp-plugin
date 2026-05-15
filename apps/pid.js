import plugin from "../../../lib/plugins/plugin.js";
import axios from "axios";
import fetch from "node-fetch";
import fs from "fs";
import path from "path";
import YAML from "yaml";
import crypto from "crypto";
import { sendPixivImageWithFallback } from "./pixivSender.js";

const CLIENT_ID = "MOBrBDS8blbauoSck0ZfDbtuzpyT";
const CLIENT_SECRET = "lsACyCD94FhDUtGTXi3QzcFE2uU1hqtDaKeqrdwj";
const HASH_SECRET = "28c1fdd170a5204386cb1313c7077b34f83e4aaf4aa829ce78c231e05b0bae2c";

let accessTokenCache = null;
let tokenExpireTime = 0;

export class PixivImageFetcher extends plugin {
    constructor() {
        super({
            name: "获取p站图",
            dsc: "获取p站图(App端Token版)",
            event: "message",
            priority: -114514,
            rule: [
                {
                    reg: "#?pid(\\d+)|pixiv\\.net\\/(?:\\w+\\/)?(?:artworks|i)\\/(\\d+)",
                    fnc: "processPixivImages"
                }
            ]
        });
    }

    // ================= Token 机制 (复用推送插件逻辑) =================
    getRefreshToken() {
        const configPath = "./plugins/kkp-plugin/config/token.yaml";
        if (!fs.existsSync(configPath)) return "";
        const config = YAML.parse(fs.readFileSync(configPath, "utf8")) || {};
        return config.RefreshToken ? String(config.RefreshToken).trim() : "";
    }

    async getAccessToken() {
        if (accessTokenCache && Date.now() < tokenExpireTime) return { token: accessTokenCache };

        const clientTime = new Date().toISOString().split(".")[0] + "+00:00";
        const clientHash = crypto.createHash("md5").update(clientTime + HASH_SECRET).digest("hex");
        const refreshToken = this.getRefreshToken();
        
        if (!refreshToken) return { error: "未配置 RefreshToken" };

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
            if (data.has_error) return { error: "刷新Token失败" };

            accessTokenCache = data.response.access_token;
            tokenExpireTime = Date.now() + (data.response.expires_in - 300) * 1000;
            return { token: accessTokenCache };
        } catch (error) {
            return { error: `网络请求错误：${error.message}` };
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

    getConfig() {
        const path = "./plugins/kkp-plugin/config/config.yaml";
        if (!fs.existsSync(path)) return { "recall": false, "time": 60000, "max_images": 40 };
        return YAML.parse(fs.readFileSync(path, "utf8")) || {};
    }

    // ================= 核心处理逻辑 =================
    async processPixivImages(e) {
        try {
            let matchedPid = null;
            const pidMatch = e.msg.match(/#?pid\s*(\d+)/i);
            const urlMatch = e.msg.match(/pixiv\.net\/(?:\w+\/)?(?:artworks|i)\/(\d+)/i);

            if (pidMatch) matchedPid = pidMatch[1];
            else if (urlMatch) matchedPid = urlMatch[1];

            if (!matchedPid) return false;

            // await e.reply(`正在通过 App API 获取作品: ${matchedPid}...`);
            await this.sendPixivDetails(e, matchedPid);
        } catch (error) {
            await e.reply(`发生错误：${error.message}`);
        }
    }

    async sendPixivDetails(e, matchedPid) {
        const tokenResult = await this.getAccessToken();
        if (!tokenResult.token) {
            return e.reply(`Token 异常，请检查 token.yaml: ${tokenResult.error}`);
        }

        const illustUrl = `https://app-api.pixiv.net/v1/illust/detail?illust_id=${matchedPid}`;
        let resData;
        try {
            const res = await fetch(illustUrl, { headers: this.getAppHeaders(tokenResult.token) });
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
        const tagsStr = illust.tags.map(t => t.translated_name || t.name).join(", ");
        const date = new Date(illust.create_date);
        const utc8Date = new Date(date.getTime() + 8 * 60 * 60 * 1000);
        const formattedTime = `${utc8Date.getUTCFullYear()}-${String(utc8Date.getUTCMonth() + 1).padStart(2, "0")}-${String(utc8Date.getUTCDate()).padStart(2, "0")} ${String(utc8Date.getUTCHours()).padStart(2, "0")}:${String(utc8Date.getUTCMinutes()).padStart(2, "0")}:${String(utc8Date.getUTCSeconds()).padStart(2, "0")}`;

        let ugoiraAlert = illust.illust_type === 2 ? "\n⚠️本作是 Pixiv 动图(Ugoira)，此处仅展示首帧封面，请去原站查看动效" : "";
        
        const msgData = [
            `https://www.pixiv.net/artworks/${illust.id} (共${illust.page_count}张)\n`,
            `画师：${illust.user.name}（${illust.user.id}）\n`,
            `是否ai：${illust.illust_ai_type === 2 ? "是" : "否"}\n`,
            `标题：${illust.title}\n`,
            `上传时间：${formattedTime}\n`,
            `♥：${illust.total_bookmarks} 👁：${illust.total_view}\n`,
            `tag：${tagsStr}${ugoiraAlert}`
        ];

        // 直接把全量 urls 扔给引擎，引擎会自动根据 pluginConfig.max_images 截断并警告
        await sendPixivImageWithFallback(e, msgData, targetImageUrls, pluginConfig);
    }
}