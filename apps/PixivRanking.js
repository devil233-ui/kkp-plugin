import plugin from '../../../lib/plugins/plugin.js';
import axios from 'axios';
import fs from 'fs';
import YAML from 'yaml';
import { pid, keyValue } from '../config/api.js';

export class DailyRankingFetcher extends plugin {
    constructor() {
        super({
            name: 'Daily Ranking Fetch',
            dsc: '每日排行',
            event: 'message',
            priority: '500',
            rule: [
                {
                    reg: '^#?每日排行$',
                    fnc: '_processDailyRanking'
                }
            ]
        });
    }

    getRecallConfig() {
        const path = './plugins/kkp-plugin/config/recall.yaml';
        const fileContents = fs.readFileSync(path, 'utf8');
        return YAML.parse(fileContents);
    }

    async fetchDailyRankingArtworks() {
        const apiUrl = 'http://165.154.69.4:40005/';
        try {
            const response = await axios.get(apiUrl);
            return response.data.artwork_ids.slice(0, 30);
        } catch (error) {
            return null;
        }
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

    async _processDailyRanking(e) {
        const artworkIds = await this.fetchDailyRankingArtworks();

        if (!artworkIds || artworkIds.length === 0) {
            await e.reply("每日排行数据获取失败！");
            return;
        }

        const tasks = artworkIds.map(pid => this.fetchPixivImageDetails(pid));
        const imageMessages = [];

        for (const task of tasks) {
            const pixivDetails = await task;
            if (pixivDetails && pixivDetails.body) {
                const imageUrls = Object.values(pixivDetails.body.urls).map(url => `${url}?key=${keyValue}`);
                const tagList = pixivDetails.body.tags.tags.map(tagObj => tagObj.tag);
                const msgData = [
                    `id：${pixivDetails.body.illustId}\n`,
                    `画师：${pixivDetails.body.userName}（${pixivDetails.body.userId}）\n`,
                    `是否ai：${pixivDetails.body.aiType === 0 ? '否' : '是'}\n`,
                    `标题：${pixivDetails.body.illustTitle}\n`,
                    `上传时间：${pixivDetails.body.createDate}\n`,
                    `♥：${pixivDetails.body.likeCount}`,
                    `😊：${pixivDetails.body.bookmarkCount}`,
                    `👁：${pixivDetails.body.viewCount}\n`,
                    `tag：${tagList.join(", ")}\n`
                ];
                const msgList = {
                    message: msgData.concat(imageUrls.map(url => segment.image(url))),
                    nickname: e.user_id.toString(),
                    user_id: e.user_id
                };
                imageMessages.push(msgList);
            }
        }

        if (imageMessages.length > 0) {
            const forwardMsg = await e.group.makeForwardMsg(imageMessages);
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
					
                    let summaryTitle = `给你kkp吧`;

                    forwardMsg.data = forwardMsg.data
                        .replace('<?xml version="1.0" encoding="utf-8"?>', '<?xml version="1.0" encoding="UTF-8"?>')
                        .replace(/%n/g, '')
                        .replace(/<title color="#777777" size="26">(.+?)<\/title>/g, '___')
                        .replace(/___+/, `<title color="#777777" size="26">${summaryTitle}</title>`);

                    const recallConfig = this.getRecallConfig();

                    const sentMessage = await e.reply(forwardMsg);
                    if (recallConfig.recall) {
                        setTimeout(() => {
                            e.group.recallMsg(sentMessage.message_id);
                        }, recallConfig.time);
                    }
                }
            }
        }
    }
}
