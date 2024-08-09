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

        // 使用 Promise.all 并发获取图片详情
        const detailsPromises = artworkIds.map(async (pid) => this.fetchPixivImageDetails(pid));
        const detailsList = await Promise.all(detailsPromises);

        const imageMessages = [];
        for (const [index, details] of detailsList.entries()) {
            if (details && details.body) {
                const imageUrls = Object.values(details.body.urls).map(url => `${url}?key=${keyValue}`);
                const tagList = details.body.tags.tags.map(tagObj => tagObj.tag);
                const msgData = [
                    `id：${details.body.illustId}\n`,
                    `画师：${details.body.userName}（${details.body.userId}）\n`,
                    `是否ai：${details.body.aiType === 0 ? '否' : '是'}\n`,
                    `标题：${details.body.illustTitle}\n`,
                    `上传时间：${details.body.createDate}\n`,
                    `♥：${details.body.likeCount}`,
                    `😊：${details.body.bookmarkCount}`,
                    `👁：${details.body.viewCount}\n`,
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
