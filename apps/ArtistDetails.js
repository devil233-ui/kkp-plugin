import plugin from '../../../lib/plugins/plugin.js';
import axios from 'axios';
import fs from 'fs';
import YAML from 'yaml';
import { segment } from "icqq";
import { pid as pidAPI, user, keyValue } from '../config/api.js';

export class ArtistDetails extends plugin {
    constructor() {
        super({
            name: 'pixiv推送',
            dsc: 'pixiv推送',
            event: 'message',
            priority: '50'
        });
    }

    getArtistIdsAndNames() {
        const path = './plugins/kkp-plugin/config/Artist.yaml';

        if (!fs.existsSync(path)) {
            return {};
        }

        const fileContents = fs.readFileSync(path, 'utf8');
        return YAML.parse(fileContents).artists || {};
    }

    async fetchArtistDetails(artistId) {
        try {
            const response = await axios.get(user(artistId));
            return response.data;
        } catch (error) {
            return null;
        }
    }

    async fetchImageDetails(url) {
        try {
            const response = await axios.get(url);
            return response.data;
        } catch (error) {
            throw error;
        }
    }

    async sendPixivDetails(e, pid) {
        const url = `${pidAPI(pid)}&key=${keyValue}`;
        const details = await this.fetchImageDetails(url);

        if (!details || !details.body) {
            throw new Error("请输入正确的pid");
        }

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
            nickname: 321107534,
            user_id: 321107534
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

                await e.reply(forwardMsg);
            }
        }
    }

    async processArtist() {
        const artists = this.getArtistIdsAndNames();

        if (!Object.keys(artists).length) {
            return;
        }

        for (const artistId in artists) {
            const artistData = await this.fetchArtistDetails(artistId);

            if (!artistData || !artistData.body || !artistData.body.illusts) {
                continue;
            }

            const oldDataRaw = await redis.get(`artistDetails_${artistId}`);
            const oldData = oldDataRaw ? JSON.parse(oldDataRaw) : null;

            if (!oldData) {
                await redis.set(`artistDetails_${artistId}`, JSON.stringify(artistData));
                continue;
            }

            const newWorks = Object.keys(artistData.body.illusts).filter(id => !oldData.body.illusts.hasOwnProperty(id));

            for (const newWork of newWorks) {
                this.sendPixivDetails(e, newWork);
            }

            await redis.set(`artistDetails_${artistId}`, JSON.stringify(artistData));
        }
    }
}
