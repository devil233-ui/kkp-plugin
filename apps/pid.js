import plugin from '../../../lib/plugins/plugin.js';
import axios from 'axios';
import fs from 'fs';
import YAML from 'yaml';
import crypto from 'crypto';
import { pid as pidAPI, user, keyValue } from '../config/api.js';  

export class PixivImageFetcher extends plugin {
    constructor() {
        super({
            name: '获取p站图',
            dsc: '获取p站图',
            event: 'message',
            priority: '500',
            rule: [
                {
                    reg: '^#?pid(\\d+)$',
                    fnc: 'processPixivImages'
                }
            ]
        });
    }
	
    getRecallConfig() {
    const path = './plugins/kkp-plugin/config/recall.yaml';
    const fileContents = fs.readFileSync(path, 'utf8');
    return YAML.parse(fileContents);
    }

    async fetchImageDetails(url) {
        try {
            const response = await axios.get(url);
            return response.data;
        } catch (error) {
            if (error.response && error.response.status === 403) {
                throw new Error("暂无权使用");
            }
            throw error;
        }
    }

    async processPixivImages(e) {
        try {
            const matchedPid = e.msg.match(/^#?pid(\d+)$/)[1];
            const url = `${pidAPI(matchedPid)}&key=${keyValue}`;  // 在URL后添加key
            await this.sendPixivDetails(e, url);
        } catch (error) {
            if (error.message === "暂无权使用") {
                await e.reply("暂无权使用");
            } else {
                await e.reply(`发生错误：${error.toString()}`);
            }
        }
    }

    async sendPixivDetails(e, url) {
        if (!e.isGroup) return;
        const details = await this.fetchImageDetails(url);
    
        if (!details || !details.body) {
            throw new Error("请输入正确的pid");
        }
    
        const body = details.body;
        const imageUrls = Object.values(body.urls).map(url => `${url}?key=${keyValue}`);
    
        const tagList = body.tags.tags.map(tagObj => tagObj.tag);
    
        // 使用 Promise.all 并发获取图片数据
        const imageDataPromises = imageUrls.map(async (imageUrl) => {
            const imageDataResponse = await axios.get(imageUrl, { responseType: 'arraybuffer' });
            return imageDataResponse.data;
        });
    
        const imageDatas = await Promise.all(imageDataPromises);
    
        // 引入当前时间戳函数
        const { now } = require('perf_hooks');
        // 在处理图像的循环内部：
        for (const [index, details] of detailsList.entries()) {

            // 生成时间戳或nonce
            const nonce = now(); // 用于时间戳
            // const nonce = crypto.randomInt(0, Number.MAX_SAFE_INTEGER); // 用于nonce
    
            // 创建包含nonce和图像数据的缓冲区
            const combinedData = Buffer.concat([Buffer.from(nonce.toString()), imageData]);
    
            // 使用组合数据计算MD5
            const md5 = crypto.createHash('md5').update(combinedData).digest('hex');
            
        }

        const msgData = [
            `id：${body.illustId}\n`,
            `画师：${body.userName}（${body.userId}）\n`,
            `是否ai：${body.aiType === 0 ? '否' : '是'}\n`,
            `标题：${body.illustTitle}\n`,
            `上传时间：${body.createDate}\n`, 
            `喜欢数：${body.likeCount}\n`,
            `收藏数：${body.bookmarkCount}\n`,
            `观看数：${body.viewCount}\n`, 
            `tag：${tagList.join(", ")}\n`, 
            `MD5：${md5.join(', ')}\n`
        ];

        const msgList = {
            message: msgData.concat(imageUrls.map(url => segment.image(url))),
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
				
				let summaryTitle = `给你kkp吧`;

				forwardMsg.data = forwardMsg.data
					.replace('<?xml version="1.0" encoding="utf-8"?>', '<?xml version="1.0" encoding="UTF-8"?>')
					.replace(/\n/g, '')
					.replace(/<title color="#777777" size="26">(.+?)<\/title>/g, '___')
					.replace(/___+/, `<title color="#777777" size="26">${summaryTitle}</title>`);

                const sentMessage = await e.reply(forwardMsg);
				
				const recallConfig = this.getRecallConfig();
				if (recallConfig.recall) {
					setTimeout(() => {
						e.group.recallMsg(sentMessage.message_id);
					}, recallConfig.time);
				}
            }
        }
    }
}
