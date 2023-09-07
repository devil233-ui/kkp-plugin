import plugin from '../../../lib/plugins/plugin.js';
import axios from 'axios';
import { segment } from "icqq";
import { pid, setu, keyValue } from '../config/api.js';

export class SetuImageFetcher extends plugin {
    constructor() {
        super({
            name: 'Setu Image Fetcher',
            dsc: '通过tag搜索蛇图',
            event: 'message',
            priority: '50',
            rule: [
                {
                    reg: '^#来(\\d+)张(.*?)图$',
                    fnc: 'processSetuImagesWithR18'
                },
                {
                    reg: '^来(\\d+)张(.*?)图$',
                    fnc: 'processSetuImagesWithoutR18'
                }
            ]
        });
    }

    async fetchSetuImages(tag, num, r18) {
        const apiUrl = setu(tag, num, r18);
        try {
            const response = await axios.get(apiUrl);
            return response.data.data;
        } catch (error) {
            if (error.response && error.response.status === 403) {
                throw new Error("暂无权使用");
            }
            return null;
        }
    }

    async fetchPixivImageDetails(pidValue) {
        const url = `${pid(pidValue)}&key=${keyValue}`;
        try {
            const response = await axios.get(url);
            return response.data;
        } catch (error) {
            if (error.response && error.response.status === 403) {
                throw new Error("暂无权使用");
            }
            return null;
        }
    }

    async processSetuImagesWithR18(e) {
        return this._processSetuImages(e, 1);
    }

    async processSetuImagesWithoutR18(e) {
        return this._processSetuImages(e, 0);
    }

    async _processSetuImages(e, r18) {
		if (!e.isGroup) return;
        const [, numStr, tag] = e.msg.match(this.rule.find(rule => e.msg.match(rule.reg)).reg);
        const num = parseInt(numStr);

        if (num > 5) {
            await e.reply("一次只能看5张哦");
            return;
        }

        try {
            const imageDetailsList = await this.fetchSetuImages(tag, num, r18);

            if (!imageDetailsList || imageDetailsList.length === 0) {
                await e.reply("无搜索结果");
                return;
            }

            for (const imageDetails of imageDetailsList) {
                const pixivDetails = await this.fetchPixivImageDetails(imageDetails.pid);
                if (pixivDetails && pixivDetails.body) {
                    await this.sendPixivDetails(e, pixivDetails.body);
                }
            }
        } catch (error) {
            if (error.message === "暂无权使用") {
                await e.reply("暂无权使用");
            }
        }
    }

    async sendPixivDetails(e, body) {
		if (!e.isGroup) return;
        const imageUrls = Object.values(body.urls).map(url => `${url}?key=${keyValue}`); // 在URL后添加key

        const tagList = body.tags.tags.map(tagObj => tagObj.tag);

        const msgData = [
            `id：${body.illustId}\n`,
            `画师：${body.userName}（${body.userId}）\n`,
            `是否ai：${body.aiType === 0 ? '否' : '是'}\n`,
            `标题：${body.illustTitle}\n`,
            `上传时间：${body.createDate}\n`, 
            `喜欢数：${body.likeCount}\n`,
            `收藏数：${body.bookmarkCount}\n`,
            `观看数：${body.viewCount}\n`, 
            `tag：${tagList.join(", ")}\n`
        ];

        const msgList = {
            message: msgData.concat(imageUrls.map(url => segment.image(url))),
            nickname: e.user_id.toString(),
            user_id: e.user_id
        };

        const forwardMsg = await e.group.makeForwardMsg(msgList);
        let forwardMsg_json = forwardMsg.data;

        if (typeof(forwardMsg_json) === 'object') {
            if (forwardMsg_json.app === 'com.tencent.multimsg' && forwardMsg_json.meta?.detail) {
                let detail = forwardMsg_json.meta.detail;
                let resid = detail.resid;
                let fileName = detail.uniseq;
                let preview = '';
                for (let val of detail.news) {
                    preview += `<title color="#777777" size="26">${val.text}</title>`;
                }
                forwardMsg.data = `<?xml version="1.0" encoding="utf-8"?><msg brief="[聊天记录]" m_fileName="${fileName}" action="viewMultiMsg" tSum="1" flag="3" m_resid="${resid}" serviceID="35" m_fileSize="0"><item layout="1"><title color="#000000" size="34">转发的聊天记录</title>${preview}<hr></hr><summary color="#808080" size="26">${detail.summary}</summary></item><source name="聊天记录"></source></msg>`;
                forwardMsg.type = 'xml';
                forwardMsg.id = 35;

                const sentMessage = await e.reply(forwardMsg);
                setTimeout(() => {
                    e.group.recallMsg(sentMessage.message_id);
                }, 30000);
            }
        }
    }
}
