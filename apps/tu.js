import plugin from '../../../lib/plugins/plugin.js';
import axios from 'axios';
import { segment } from "icqq";

export class CosImageFetcher extends plugin {
    constructor() {
        super({
            name: 'p站图',
            dsc: '根据tag搜索p站图',
            event: 'message',
            priority: '70',
            rule: [
                {
                    reg: '^#?2图$',
                    fnc: 'process2Images'
                },
                {
                    reg: '^#?3图$',
                    fnc: 'process3Images'
                }
            ]
        });
    }

    async fetchImage(url) {
        return axios.get(url, {
            responseType: 'arraybuffer',
            maxContentLength: Infinity,
            maxBodyLength: Infinity
        }).then(response => {
            return Buffer.from(response.data, 'binary').toString('base64');
        }).catch(error => {
            return null;
        });
    }

    async process2Images(e) {
    const url = `http://${"\x31\x36\x35\x2e\x31\x35\x34\x2e\x31\x33\x33\x2e\x31\x30\x36"}:50022`;
    await this.sendImages(e, url);
    }

    async process3Images(e) {
    const url = `http://${"\x31\x36\x35\x2e\x31\x35\x34\x2e\x31\x33\x33\x2e\x31\x30\x36"}:50033`;
    await this.sendImages(e, url);
    }

    async sendImages(e, url) {
        if (e.isGroup) {
            let promises = [];
            for (let i = 0; i < 5; i++) {
                promises.push(this.fetchImage(url));
            }

            try {
                let base64Images = await Promise.all(promises);

                let msgList = base64Images.filter(Boolean).map((base64Image, index) => ({
                    message: [`涩批还看 ${index + 1}`, "\n", segment.image(`base64://${base64Image}`)],
                    nickname: e.user_id.toString(),
                    user_id: e.user_id
                }));

                if (msgList.length > 0) {
                    const forwardMsg = await e.group.makeForwardMsg(msgList);
                    let forwardMsg_json = forwardMsg.data;

                    if (typeof (forwardMsg_json) === 'object') {
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

                            let summaryTitle = `涩批还看 1-5`;

                            forwardMsg.data = forwardMsg.data
                                .replace('<?xml version="1.0" encoding="utf-8"?>', '<?xml version="1.0" encoding="UTF-8"?>')
                                .replace(/\n/g, '')
                                .replace(/<title color="#777777" size="26">(.+?)<\/title>/g, '___')
                                .replace(/___+/, `<title color="#777777" size="26">${summaryTitle}</title>`);

                            const sentMessage = await e.reply(forwardMsg);
                            setTimeout(() => {
                                e.group.recallMsg(sentMessage.message_id);
                            }, 30000);
                        }
                    }
                }

            } catch (error) {
                await e.reply(`发生错误：${error.toString()}`);
            }
        } else {
            let promises = [];
            for (let i = 0; i < 5; i++) {
                promises.push(this.fetchImage(url).then(base64Image => {
                    if (base64Image) {
                        return e.reply(segment.image(`base64://${base64Image}`));
                    }
                }));
            }
            await Promise.all(promises);
        }
    }
}
