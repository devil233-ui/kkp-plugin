import plugin from "../../../lib/plugins/plugin.js";
import axios from "axios";
import fs from "fs";
import YAML from "yaml";
import { pid as pidAPI } from "../config/api.js";
import { FlipImage } from "./flip.js"; // 引入咱们自己的纯 JS 翻转工具

export class PixivImageFetcher extends plugin {
    constructor() {
        super({
            name: "获取p站图",
            dsc: "获取p站图(重构版)",
            event: "message",
            priority: 500,
            rule: [
                { reg: "#?pid\\s*\\d+|pixiv\\.net\\/(?:\\w+\\/)?(?:artworks|i)\\/\\d+", fnc: "processPixivImages" }
            ]
        });
    }

    getRecallConfig() {
        const path = "./plugins/kkp-plugin/config/recall.yaml";
        if (!fs.existsSync(path)) return { "recall": false, "time": 60000 };
        return YAML.parse(fs.readFileSync(path, "utf8")) || {};
    }

    async processPixivImages(e) {
        try {
            let matchedPid = null;
            // 彻底去除开头和结尾的限制，允许链接或指令前后带有任何文字
            const pidMatch = e.msg.match(/#?pid\s*(\d+)/i);
            const urlMatch = e.msg.match(/pixiv\.net\/(?:\w+\/)?(?:artworks|i)\/(\d+)/i);

            if (pidMatch) {
                matchedPid = pidMatch[1];
            } else if (urlMatch) {
                matchedPid = urlMatch[1];
            }

            if (!matchedPid) return false;

            const url = `${pidAPI(matchedPid)}`;
            await this.sendPixivDetails(e, url);
        } catch (error) {
            await e.reply(`发生错误：${error.message}`);
        }
    }

    async sendPixivDetails(e, url) {
        const response = await axios.get(url).catch(() => null);
        if (!response || !response.data || !response.data.body) {
            throw new Error("请输入正确的 PID 或作品已被删除");
        }

        const body = response.data.body;
        // 修复 Bug：精准提取原图。如果是第三方 API 异形结构，兜底取第一个
        let targetImageUrl = body.urls.original || body.urls.large || body.urls.regular;
        if (!targetImageUrl) targetImageUrl = Object.values(body.urls)[0];

        const tagList = body.tags.tags.map(tagObj => tagObj.tag);
        
        const date = new Date(body.createDate);
        const utc8Date = new Date(date.getTime() + 8 * 60 * 60 * 1000);
        const formattedTime = `${utc8Date.getUTCFullYear()}-${String(utc8Date.getUTCMonth() + 1).padStart(2, "0")}-${String(utc8Date.getUTCDate()).padStart(2, "0")} ${String(utc8Date.getUTCHours()).padStart(2, "0")}:${String(utc8Date.getUTCMinutes()).padStart(2, "0")}:${String(utc8Date.getUTCSeconds()).padStart(2, "0")}`;

        const msgData = [
            `https://www.pixiv.net/artworks/${body.illustId}\n`,
            `画师：${body.userName}（${body.userId}）\n`,
            `是否ai：${body.aiType === 2 ? "是" : "否"}\n`,
            `标题：${body.illustTitle}\n`,
            `上传时间：${formattedTime}\n`,
            `♥：${body.likeCount}\n`,
            `😊：${body.bookmarkCount}\n`,
            `👁：${body.viewCount}\n`,
            `tag：${tagList.join(", ")}\n`
        ];

        // 1. 下载图片到内存
        let imgBuffer = null;
        try {
            // 【核心修复】完全还原旧版代码最原始的 axios 请求，去除画蛇添足的 Referer！
            const imgRes = await axios.get(targetImageUrl, { responseType: "arraybuffer" });
            imgBuffer = imgRes.data;
        } catch (err) {
            logger.error(`[kkp-plugin] pid 搜图下载失败: ${err.message}`);
            return e.reply(`图片下载失败：${err.message}`);
        }

        // 辅助函数：构造伪造的合并转发节点
        const makeNode = (content) => ({
            message: content,
            nickname: Bot.nickname,
            user_id: Bot.uin
        });

        // 2. 第一次尝试发送（合并转发直发原图）
        let initialMsg = [...msgData, segment.image(imgBuffer)];
        let forwardMsg = await (e.isGroup ? e.group.makeForwardMsg([makeNode(initialMsg)]) : e.friend.makeForwardMsg([makeNode(initialMsg)]));
        
        let sendRes = await e.reply(forwardMsg);

        // 3. 如果第一次发送被吞，触发翻转逻辑
        if (!sendRes || sendRes.message_id === undefined) {
            await e.reply("图片原图发送失败，正在尝试水平翻转后重发...", true, { recallMsg: 0 });
            
            const flippedBuffer = await FlipImage(imgBuffer);
            if (flippedBuffer) {
                let retryMsg = [...msgData, segment.image(flippedBuffer)];
                let retryForward = await (e.isGroup ? e.group.makeForwardMsg([makeNode(retryMsg)]) : e.friend.makeForwardMsg([makeNode(retryMsg)]));
                sendRes = await e.reply(retryForward);
            }

            // 4. 如果翻转后还是被吞，发直链兜底
            if (!sendRes || sendRes.message_id === undefined) {
                let linkMsg = [...msgData, `\n\n图片最终发送失败，请点击链接查看：\n${targetImageUrl}`];
                let linkForward = await (e.isGroup ? e.group.makeForwardMsg([makeNode(linkMsg)]) : e.friend.makeForwardMsg([makeNode(linkMsg)]));
                sendRes = await e.reply(linkForward);
            }
        }

        // 处理撤回
        const recallConfig = this.getRecallConfig();
        if (recallConfig.recall && sendRes && sendRes.message_id) {
            setTimeout(() => {
                e.isGroup ? e.group.recallMsg(sendRes.message_id) : e.friend.recallMsg(sendRes.message_id);
            }, recallConfig.time);
        }
    }
}