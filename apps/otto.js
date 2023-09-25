import plugin from '../../../lib/plugins/plugin.js';
import axios from 'axios';
import querystring from 'querystring';

export class OttoVoice extends plugin {
    constructor() {
        super({
            name: 'Otto语音插件',
            event: 'message',
            priority: 500,
            rule: [
                {
                    reg: /^#?otto(.+)$|^电棍(.+)$/i,
                    fnc: 'handleOtto'
                }
            ]
        });
    }

    async handleOtto(e) {
        const match = e.msg.match(/^#?otto(.+)$|^电棍(.+)$/i);
        if (!match) return;

        const content = (match[1] || match[2]).trim();
        const sanitizedContent = content.replace(/[^\u4e00-\u9fa5]/g, '').substr(0, 50);

        if (!sanitizedContent) {
            return;
        }

        try {
            // 使用querystring模块将请求体转换为x-www-form-urlencoded格式
            const data = querystring.stringify({ text: sanitizedContent });

            const response = await axios.post('http://165.154.133.106:8989/make', data, {
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'User-Agent': 'PostmanRuntime/7.33.0',
                    'Accept': '*/*',
                    'Accept-Encoding': 'gzip, deflate, br'
                }
            });

            if (response.data && response.data.id) {
                const audioUrl = `http://165.154.133.106:8990/${response.data.id}.wav`;
                e.reply(segment.record(audioUrl, 0, false));
            } else {
                e.reply("出错了，请稍后再试。");
            }
        } catch (err) {
            e.reply("哇奥");
            console.error(err);
        }
    }
}
