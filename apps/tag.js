import plugin from '../../../lib/plugins/plugin.js';
import axios from 'axios';
import fs from 'fs';
import YAML from 'yaml';
import crypto from 'crypto';
import { pid, keyValue, tag as fetchTag } from '../config/api.js';

export class SetuImageFetcher extends plugin {
    constructor() {
        super({
            name: 'Setu Image Fetch',
            dsc: '通过tag搜索图',
            event: 'message',
            priority: '500',
            rule: [
                {
                    reg: '^#?来(\\d+)张(.*?)图$',
                    fnc: '_processSetuImages'
                }
            ]
        });
    }

    getRecallConfig() {
        const path = './plugins/kkp-plugin/config/recall.yaml';
        const fileContents = fs.readFileSync(path, 'utf8');
        return YAML.parse(fileContents);
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

    async fetchTagSearchResults(tagValue) {
        const apiUrl = fetchTag(tagValue);
        try {
            const response = await axios.get(apiUrl);
            return response.data.body.illustManga.data.map(item => item.id);
        } catch (error) {
            return null;
        }
    }

    getRandomIds(ids, count) {
        const shuffled = ids.sort(() => 0.30 - Math.random());
        return shuffled.slice(0, count);
    }

    async _processSetuImages(e) {
        if (!e.isGroup) return;

        const [, numStr, tag] = e.msg.match(this.rule.find(rule => e.msg.match(rule.reg)).reg);
        const num = parseInt(numStr);

        if (num > 30) {
            await e.reply("你想冲死吗？");
            return;
        }

        const idsList = await this.fetchTagSearchResults(tag);
        if (!idsList || idsList.length === 0) {
            await e.reply("没有这种图啊，涩批！");
            return;
        }
        
        const selectedPids = this.getRandomIds(idsList, num);

        // 使用 Promise.all 并发获取图片详情
        const detailsPromises = selectedPids.map(async (pid) => this.fetchPixivImageDetails(pid));
        const detailsList = await Promise.all(detailsPromises);

        await e.reply(`图片获取完毕，正在发送中...`);

        const imageMessages = [];
        for (const [index, details] of detailsList.entries()) {
            if (details && details.body) {
                const imageUrls = Object.values(details.body.urls).map(url => `${url}?key=${keyValue}`);
                const tagList = details.body.tags.tags.map(tagObj => tagObj.tag);

                // 使用 Promise.all 并发获取图片数据
                const imageDataPromises = imageUrls.map(async (imageUrl) => {
                    const imageDataResponse = await axios.get(imageUrl, { responseType: 'arraybuffer' });
                    return imageDataResponse.data;
                });
                const imageDatas = await Promise.all(imageDataPromises);

                // 重新计算 MD5
                const md5s = imageDatas.map((imageData) => crypto.createHash('md5').update(imageData).digest('hex'));

                const msgData = [
                    `id：${details.body.illustId}\n`,
                    `画师：${details.body.userName}（${details.body.userId}）\n`,
                    `是否ai：${details.body.aiType === 0 ? '否' : '是'}\n`,
                    `标题：${details.body.illustTitle}\n`,
                    `上传时间：${details.body.createDate}\n`,
                    `♥：${details.body.likeCount}`,
                    `😊：${details.body.bookmarkCount}`,
                    `👁：${details.body.viewCount}\n`,
                    `tag：${tagList.join(", ")}\n`,
                    `MD5：${md5s.join(', ')}\n`
                ];

                const msgList = {
                    message: msgData.concat(imageUrls.map((url, i) => segment.image(url, { buffer: imageDatas[i] }))), // 假设segment.image支持接收Buffer参数
                    nickname: e.user_id.toString(),
                    user_id: e.user_id,
                    imageBuffers: imageDatas
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
