import plugin from '../../../lib/plugins/plugin.js';
import axios from 'axios';
import { segment } from "icqq";
import { pid, user, keyValue } from '../config/api.js';


export class PixivArtistWorksFetcher extends plugin {
    constructor() {
        super({
            name: 'Pixiv Artist Works Fetcher',
            dsc: 'Fetches artist works using Artist ID',
            event: 'message',
            priority: '50',
            rule: [
                {
                    reg: '^#来(\\d+)张(\\d+)作品$',
                    fnc: 'processArtistWorks'
                }
            ]
        });
    }

    async fetchArtistDetails(artistId) {
        try {
            const response = await axios.get(user(artistId));
            return response.data;
        } catch (error) {
            if (error.response && error.response.status === 403) {
                throw new Error("暂无权使用");
            }
            throw error;
        }
    }

    async fetchWorkDetails(pidValue) {
        try {
            const response = await axios.get(pid(pidValue));
            return response.data;
        } catch (error) {
            if (error.response && error.response.status === 403) {
                throw new Error("暂无权使用");
            }
            throw error;
        }
    }

    async processArtistWorks(e) {
		if (!e.isGroup) return;
        const match = e.msg.match(/^#来(\d+)张(\d+)作品$/);
        if (!match) return;

        const num = parseInt(match[1]);
        const artistId = match[2];

        if (num > 5) {
            await e.reply('一次最多看5张哦');
            return;
        }

        try {
            const artistData = await this.fetchArtistDetails(artistId);

            if (!artistData || artistData.error) {
                await e.reply('请输入正确的画师id');
                return;
            }

            const workIDs = Object.keys(artistData.body.illusts).reverse().slice(0, num);  // 取最新的作品ID

            for (const workId of workIDs) {
                const workDetails = await this.fetchWorkDetails(workId);
                if (workDetails && !workDetails.error) {
                    await this.sendWorkDetails(e, workDetails);
                }
            }
        } catch (error) {
            if (error.message === "暂无权使用") {
                await e.reply("暂无权使用");
            }
        }
    }

    async sendWorkDetails(e, details) {
		if (!e.isGroup) return;
        const body = details.body;
        const imageUrls = Object.values(body.urls).map(url => `${url}?key=${keyValue}`);

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
