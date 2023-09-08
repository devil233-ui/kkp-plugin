import axios from 'axios';
import plugin from '../../../lib/plugins/plugin.js';
import { magnetURL } from '../config/api.js';


export class MagnetLinkFetcher extends plugin {
    constructor() {
        super({
            name: '磁力链接查询',
            dsc: '根据磁力链接查询文件信息并返回',
            event: 'message',
            priority: '500',
            rule: [
                {
                    reg: '^#验车(magnet:.+)$',
                    fnc: 'processMagnetLink'
                }
            ]
        });
    }

    async processMagnetLink(e) {
		if (!e.isGroup) return;
        try {
            const matchedMagnet = e.msg.match(/^#验车(magnet:.+)$/)[1];;
            const url = magnetURL(matchedMagnet);
            const response = await axios.get(url);

            if (response.data && response.data.error === "") {
                const data = response.data;

                const msgData = [
                    `名字：${data.name}\n`,
                    `文件类型：${data.file_type}\n`,
                    `文件数量：${data.count}\n`,
                    `文件大小：${(data.size / 1e9).toFixed(1)}g\n`
                ];

                const msgList = {
                    message: msgData.concat(data.screenshots.map(s => segment.image(s.screenshot))),
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

                        await e.reply(forwardMsg);
                    }
                }
            } else {
                await e.reply('查询失败。');
            }
        } catch (error) {
            await e.reply(`查询错误：${error.toString()}`);
        }
    }
}

