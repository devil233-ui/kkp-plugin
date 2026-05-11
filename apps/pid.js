import plugin from "../../../lib/plugins/plugin.js";
import axios from "axios";
import fetch from "node-fetch";
import fs from "fs";
import path from "path";
import YAML from "yaml";
import crypto from "crypto";
// import { pid as pidAPI } from "../config/api.js";
import { FlipImage } from "./flip.js";

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
                    reg: "#?pid\\s*(\\d+)|pixiv\\.net\\/(?:\\w+\\/)?(?:artworks|i)\\/(\\d+)",
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
            if (data.has_error) return { error: `刷新Token失败` };

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

            await e.reply(`正在通过 App API 获取作品: ${matchedPid}...`);
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

        // 1. 彻底抛弃 Web API，直接调 App API 获取作品详情 (原生自带多图数据，无视404)
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

        // 2. 提取原图链接 (与 PixivPush 逻辑完全一致)
        let targetImageUrls = [];
        if (illust.meta_pages && illust.meta_pages.length > 0) {
            targetImageUrls = illust.meta_pages.map(p => p.image_urls.original);
        } else if (illust.meta_single_page && illust.meta_single_page.original_image_url) {
            targetImageUrls = [illust.meta_single_page.original_image_url];
        }

        // 3. 数量拦截，防止 OOM 炸机
        const pluginConfig = this.getConfig();
        const maxImages = pluginConfig.max_images || 40; // 读不到就默认40

        const totalImages = targetImageUrls.length;
        let finalUrls = targetImageUrls;
        let overflowMsg = "";

        if (totalImages > maxImages) {
            finalUrls = targetImageUrls.slice(0, maxImages);
            overflowMsg = `\n[⚠️本作多达 ${totalImages} 张图，为防止伊涅芙过载，仅展示前 ${maxImages} 张]`;
        }

        // 4. 核心机制：官方直连主链路 + 极其稳定的公用反代备胎
        let imgBuffers = [];
        let fallbackUrls = []; // 用于发给用户点击的直链兜底

        for (let url of finalUrls) {
            // 你要求的那个稳定备胎：pixiv.manbomanbo.asia
            const backupUrl = url.replace("i.pximg.net", "pixiv.manbomanbo.asia");
            fallbackUrls.push(backupUrl);

            try {
                // 第一梯队：优先尝试拉取官方原图
                // 注意：直连 i.pximg.net 必须带上 Referer 防盗链，否则必 403
                const imgRes = await axios.get(url, { 
                    responseType: "arraybuffer", 
                    timeout: 10000,
                    headers: { "Referer": "https://app-api.pixiv.net/" } 
                });
                imgBuffers.push(imgRes.data);
            } catch (err1) {
                try {
                    // 第二梯队：主链路阵亡/被墙，丝滑切入你提供的备用反代
                    logger.warn(`[kkp-plugin] 官方节点下载失败，切入备胎反代: ${backupUrl}`);
                    // 走第三方反代通常不需要复杂的 Referer，直接拉即可
                    const imgRes2 = await axios.get(backupUrl, { 
                        responseType: "arraybuffer", 
                        timeout: 15000 
                    });
                    imgBuffers.push(imgRes2.data);
                } catch (err2) {
                    logger.error(`[kkp-plugin] 备胎节点也挂了: ${err2.message}`);
                }
            }
        }

        // 5. 拼装文案
        const tagsStr = illust.tags.map(t => t.translated_name || t.name).join(", ");
        const date = new Date(illust.create_date);
        const utc8Date = new Date(date.getTime() + 8 * 60 * 60 * 1000);
        const formattedTime = `${utc8Date.getUTCFullYear()}-${String(utc8Date.getUTCMonth() + 1).padStart(2, "0")}-${String(utc8Date.getUTCDate()).padStart(2, "0")} ${String(utc8Date.getUTCHours()).padStart(2, "0")}:${String(utc8Date.getUTCMinutes()).padStart(2, "0")}:${String(utc8Date.getUTCSeconds()).padStart(2, "0")}`;

        const pageCountInfo = totalImages > 1 ? ` (共${totalImages}张)` : "";
        const msgData = [
            `https://www.pixiv.net/artworks/${illust.id}${pageCountInfo}\n`,
            `画师：${illust.user.name}（${illust.user.id}）\n`,
            `是否ai：${illust.illust_ai_type === 2 ? "是" : "否"}\n`,
            `标题：${illust.title}\n`,
            `上传时间：${formattedTime}\n`,
            `♥：${illust.total_bookmarks} 👁：${illust.total_view}\n`,
            `tag：${tagsStr}\n`
        ];

        if (overflowMsg) msgData.push(overflowMsg + "\n");

        if (imgBuffers.length === 0) {
            return e.reply("图片下载失败，官方主节点与备用反代均无响应，请稍后再试。");
        }
        const makeNode = (content) => ({ message: content, nickname: e.user_id.toString(), user_id: e.user_id });

        let sendRes = null;

        // 7. 第一重：<=9张，直发
        if (imgBuffers.length <= 9) {
            let directMsg = [...msgData];
            for (let buf of imgBuffers) directMsg.push(segment.image(buf));
            sendRes = await e.reply(directMsg).catch(() => null);
        }

        // 8. 第二重：>9张，或直发失败 -> 合并转发
        if (!sendRes || sendRes.message_id === undefined) {
            let initialMsg = [...msgData];
            for (let buf of imgBuffers) initialMsg.push(segment.image(buf));
            
            let forwardMsg = await (e.isGroup ? e.group.makeForwardMsg([makeNode(initialMsg)]) : e.friend.makeForwardMsg([makeNode(initialMsg)]));
            sendRes = await e.reply(forwardMsg).catch(() => null);
        }

        // 9. 第三重：翻转兜底
        if (!sendRes || sendRes.message_id === undefined) {
            await e.reply("图片触发风控拦截，正在尝试水平翻转后重发...", true, { recallMsg: 0 });
            
            let retryMsg = [...msgData];
            let flipSuccess = false;
            for (let buf of imgBuffers) {
                const flippedBuffer = await FlipImage(buf);
                if (flippedBuffer) {
                    retryMsg.push(segment.image(flippedBuffer));
                    flipSuccess = true;
                }
            }

            if (flipSuccess) {
                let retryForward = await (e.isGroup ? e.group.makeForwardMsg([makeNode(retryMsg)]) : e.friend.makeForwardMsg([makeNode(retryMsg)]));
                sendRes = await e.reply(retryForward).catch(() => null);
            }
        }

        // 10. 第四重：直链兜底
        if (!sendRes || sendRes.message_id === undefined) {
            let linkMsg = [...msgData, `\n图片经过多次尝试最终发送失败，请点击备用链接查看：\n${fallbackUrls.join("\n")}`];
            let linkForward = await (e.isGroup ? e.group.makeForwardMsg([makeNode(linkMsg)]) : e.friend.makeForwardMsg([makeNode(linkMsg)]));
            sendRes = await e.reply(linkForward).catch(() => null);
        }

        // 11. 撤回控制
        const recallConfig = this.getConfig();
        if (recallConfig.recall && sendRes && sendRes.message_id) {
            setTimeout(() => {
                e.isGroup ? e.group.recallMsg(sendRes.message_id) : e.friend.recallMsg(sendRes.message_id);
            }, recallConfig.time);
        }
    }
}