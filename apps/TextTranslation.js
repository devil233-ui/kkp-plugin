import { segment } from "icqq";
import plugin from '../../../lib/plugins/plugin.js'
import axios from 'axios';

export class TextTranslation extends plugin {
    constructor() {
        super(
            {
                name: '文本翻译',
                dsc: '翻译用户输入的英文',
                event: 'message',
                priority: '49',
                rule: [
                    {
                        reg: '^#?翻译(.+)$',
                        fnc: 'processTranslation'
                    }
                ]
            }
        )
    }

    async processTranslation(e) {
        let match = e.msg.match(/^#?翻译(.+)$/);

        if (!match) {
            return;
        }

        try {
            const sourceText = match[1].trim();
            const url = `https://api.oioweb.cn/api/txt/QQFanyi?sourceText=${encodeURIComponent(sourceText)}`;
            const response = await axios.get(url);
            const data = response.data;

            if (data.code === 200) {
                const translatedText = data.result.targetText;
                await this.reply(translatedText);
            } else {
                await this.reply('翻译失败');
            }

        } catch (error) {
            console.log(error);
            await this.reply(`发生错误：${error.toString()}`);
        }
    }
}
