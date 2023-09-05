import { segment } from "icqq";
import plugin from '../../../lib/plugins/plugin.js'
import https from 'https';

export class DailyDogLick extends plugin {
    constructor() {
        super(
            {
                name: '舔狗日记',
                desc: '舔狗',
                event: 'message',
                priority: '50',
                rule: [
                    {
                        reg: '^舔狗日记$',
                        fnc: 'processDiary'
                    }
                ]
            }
        )
    }

    getDateTime() {
        let date = new Date();

        let month = date.getMonth() + 1;
        let day = date.getDate();
        let weekday = date.getDay();

        let weekdays = ["星期天", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"];

        return `${month}月${day}日，${weekdays[weekday]}`;
    }

    getTextFromAPI() {
        return new Promise((resolve, reject) => {
            https.get('https://api.oick.cn/dog/api.php', (resp) => {
                let data = '';

                resp.on('data', (chunk) => {
                    data += chunk;
                });

                resp.on('end', () => {
                    resolve(data);
                });

            }).on("error", (err) => {
                reject(err);
            });
        });
    }

    async processDiary(e) {
        let match = e.msg.match(/^舔狗日记$/);

        if (!match) {
            return;
        }

        try {
            const textFromAPI = await this.getTextFromAPI();
            const dateTime = this.getDateTime();

            const diaryToSend = `${dateTime}\n${textFromAPI}`;

            await this.reply(diaryToSend);
        }
        catch (error) {
            console.log(error);
            await this.reply(`发生错误：${error.toString()}`);
        }
    }
}
