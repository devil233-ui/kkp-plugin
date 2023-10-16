import plugin from '../../../lib/plugins/plugin.js'
import axios from 'axios';

export class BingWallpaper extends plugin {
    constructor() {
        super(
            {
                name: '必应壁纸',
                dsc: '获取必应壁纸并制作成合并转发消息',
                event: 'message',
                priority: '50',
                rule: [
                    {
                        reg: '^#?必应壁纸$',
                        fnc: 'processBingWallpaper'
                    }
                ]
            }
        )
    }

    async processBingWallpaper(e) {
        try {
            const url = `https://api.oioweb.cn/api/bing`;
            const response = await axios.get(url);
            const data = response.data;

            if (data.code === 200) {
                const wallpapers = data.result;
                let msgList = [];

                for (let i = 0; i < wallpapers.length; i++) {
                    const wallpaper = wallpapers[i];
                    const imageUrl = wallpaper.url; 
                    const title = wallpaper.copyright;

                    msgList.push({
                        message: [title, "\n", segment.image(imageUrl)],
                        nickname: e.user_id.toString(),
                        user_id: e.user_id
                    });
                }

                const ForwardMsg = await e.group.makeForwardMsg(msgList);
                await e.reply(ForwardMsg);
            } else {
                await this.reply('获取必应壁纸失败');
            }

        } catch (error) {
            console.log(error);
            await this.reply(`发生错误：${error.toString()}`);
        }
    }
}
