import plugin from "../../../lib/plugins/plugin.js";
import axios from "axios";
import fs from "fs";
import YAML from "yaml";
import { pid, tag as fetchTag } from "../config/api.js";
import { FlipImage } from "./flip.js"; // 彻底干掉 Python，引入我们原生的纯 JS 翻转

export class SetuImageFetcher extends plugin {
    constructor() {
        super({
            name: "Setu Image Fetch",
            dsc: "通过tag搜索图",
            event: "message",
            priority: 500,
            rule: [
                {
                    reg: "^#?来(\\d+)张(.*?)图$",
                    fnc: "_processSetuImages"
                }
            ]
        });
    }

    getConfig() {
        const path = "./plugins/kkp-plugin/config/config.yaml";
        if (!fs.existsSync(path)) return { "recall": false, "time": 60000, "max_images": 40 };
        return YAML.parse(fs.readFileSync(path, "utf8")) || {};
    }

    async fetchPixivImageDetails(pidValue) {
        const apiUrl = pid(pidValue);
        try {
            const response = await axios.get(apiUrl);
            return response.data;
        } catch (error) {
            return null;
        }
    }

    async fetchTagSearchResults(tagValue) {
        const config = this.getConfig();
        const mode = config.mode || "all";
        const order = config.order || "popular_d";
        const apiUrl = `${fetchTag(tagValue)}&mode=${mode}&order=${order}`;
        
        try {
            const response = await axios.get(apiUrl);
            return response.data.body.data.map(item => item.id);
        } catch (error) {
            return [];
        }
    }

    getRandomIds(ids, count) {
        const shuffled = ids.sort(() => 0.5 - Math.random());
        return shuffled.slice(0, count);
    }

    async _processSetuImages(e) {
        const [ , numStr, tag ] = e.msg.match(this.rule.find(rule => e.msg.match(rule.reg)).reg);
        const num = parseInt(numStr);

        if (num > 30) {
            await e.reply("你想冲死吗？");
            return;
        }

        const idsList = await this.fetchTagSearchResults(tag);
        if (!idsList || idsList.length === 0) {
            await e.reply("没有这种图啊，涩批！");
            return;
        }

        const selectedPids = this.getRandomIds(idsList, num);
        await e.reply("图片PID获取完毕，正在高速下载与处理中，请稍候...");

        // 智能提取你自己的反代域名
        let myProxyDomain = "i.pximg.net";
        try { myProxyDomain = new URL(pid("1")).hostname; } catch (err) {}

        let forwardNodes = [];
        let flipNodes = [];
        let linkNodes = [];

        // 放弃 Promise.all 轰炸，改为 for 循环，保护服务器内存
        for (let i = 0; i < selectedPids.length; i++) {
            const details = await this.fetchPixivImageDetails(selectedPids[i]);
            if (!details || !details.body) continue;

            const body = details.body;
            const imageUrls = Object.values(body.urls).map(url => `${url}`);
            const tagList = body.tags.tags.map(tagObj => tagObj.tag);

            let buffers = [];
            let fallbackUrls = [];

            // 核心机制：双保险下载
            for (let rawUrl of imageUrls) {
                const proxyUrl = rawUrl.replace("i.pximg.net", myProxyDomain);
                const backupUrl = rawUrl.replace("i.pximg.net", "pixiv.manbomanbo.asia");
                fallbackUrls.push(backupUrl);

                try {
                    const imgRes = await axios.get(proxyUrl, { responseType: "arraybuffer", timeout: 10000 });
                    buffers.push(imgRes.data);
                } catch (err1) {
                    try {
                        const imgRes2 = await axios.get(backupUrl, { responseType: "arraybuffer", timeout: 15000 });
                        buffers.push(imgRes2.data);
                    } catch (err2) {
                        // 都失败则跳过该图
                    }
                }
            }

            if (buffers.length === 0) continue;

            // 格式统一为最新的紧凑版
            const msgData = [
                `id：https://www.pixiv.net/artworks/${body.illustId}\n`,
                `画师：${body.userName}（${body.userId}）\n`,
                `是否ai：${body.aiType === 2 ? "是" : "否"}\n`,
                `标题：${body.illustTitle}\n`,
                `上传时间：${body.createDate}\n`,
                `♥：${body.likeCount}；😊：${body.bookmarkCount}；👁：${body.viewCount}\n`,
                `tag：${tagList.join(", ")}\n`
            ];

            const nodeTemplate = (content) => ({ message: content, nickname: e.user_id.toString(), user_id: e.user_id });

            // 准备第一重原图 Node
            forwardNodes.push(nodeTemplate([...msgData, ...buffers.map(b => segment.image(b))]));

            // 准备直链兜底 Node
            linkNodes.push(nodeTemplate([...msgData, `\n图片加载失败，请看备用直链：\n${fallbackUrls.join("\n")}`]));

            // 准备翻转兜底 Node（提前在内存中洗掉 MD5）
            let flippedBuffers = [];
            for (let b of buffers) {
                const flipped = await FlipImage(b);
                if (flipped) flippedBuffers.push(flipped);
            }
            if (flippedBuffers.length > 0) {
                flipNodes.push(nodeTemplate([...msgData, ...flippedBuffers.map(b => segment.image(b))]));
            }
        }

        if (forwardNodes.length === 0) {
            return e.reply("全部获取失败，节点可能挂了。");
        }

        let sendRes = null;

        // 第一重：直接发送原图图包合集
        let forwardMsg = await (e.isGroup ? e.group.makeForwardMsg(forwardNodes) : e.friend.makeForwardMsg(forwardNodes));
        sendRes = await e.reply(forwardMsg).catch(() => null);

        // 第二重：风控拦截则直接发送洗好 MD5 的翻转图包
        if (!sendRes || sendRes.message_id === undefined) {
            await e.reply("原图合集触发风控，正在尝试纯 JS 翻转后重发...", true, { recallMsg: 0 });
            let flipMsg = await (e.isGroup ? e.group.makeForwardMsg(flipNodes) : e.friend.makeForwardMsg(flipNodes));
            sendRes = await e.reply(flipMsg).catch(() => null);
        }

        // 第三重：最高级拦截，无奈交出直链
        if (!sendRes || sendRes.message_id === undefined) {
            let linkMsg = await (e.isGroup ? e.group.makeForwardMsg(linkNodes) : e.friend.makeForwardMsg(linkNodes));
            sendRes = await e.reply(linkMsg).catch(() => null);
        }

        const config = this.getConfig();
        if (config.recall && sendRes && sendRes.message_id) {
            setTimeout(() => {
                e.isGroup ? e.group.recallMsg(sendRes.message_id) : e.friend.recallMsg(sendRes.message_id);
            }, config.time);
        }
    }
}