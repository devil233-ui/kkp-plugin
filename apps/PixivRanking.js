import plugin from '../../../lib/plugins/plugin.js';
import axios from 'axios';

export class DailyRankingFetcher extends plugin {
    constructor() {
        super({
            name: 'Pixiv Daily Ranking Fetcher',
            dsc: '获取Pixiv每日排行榜并展示前20个结果',
            event: 'message',
            priority: '50',
            rule: [
                {
                    reg: '^#?每日排行$',
                    fnc: 'fetchDailyRanking'
                }
            ]
        });
    }

    async fetchDailyRankingData() {
        const apiUrl = 'https://pixiv.mokeyjay.com/?r=api/pixiv-json';
        try {
            const response = await axios.get(apiUrl);
            return response.data.data;
        } catch (error) {
            console.error(`获取每日排行数据时出错: ${error.message}`);
            return [];
        }
    }

    async fetchDailyRanking(e) {
		if (!e.isGroup) return;
        const rankingData = await this.fetchDailyRankingData();
        if (!rankingData.length) {
            await e.reply("无法获取每日排行数据");
            return;
        }

        // 获取前30个数据
        const top30 = rankingData.slice(0, 30);

        const allMessages = [];

        for (const item of top30) {
            const msgData = [
                `id：${item.id}`,
                `画师：${item.user_name}（${item.user_id}）`,
                `标题：${item.title}`,
                `tag：${item.tags.join(", ")}`,
            ];

            allMessages.push({
                message: msgData.join("\n") + "\n" + segment.image(item.url).toString(),
                nickname: e.user_id.toString(),
                user_id: e.user_id
            });
        }

        const forwardMsg = await e.group.makeForwardMsg(allMessages);
        await e.reply(forwardMsg);
    }
}
