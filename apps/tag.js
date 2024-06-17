import plugin from '../../../lib/plugins/plugin.js';
import axios from 'axios';
import fs from 'fs';
import YAML from 'yaml';
import { pid, tag as fetchTag } from '../config/api.js';
import { execFile } from 'child_process';

const pythonCommand = process.platform === 'win32' ? 'python' : 'python3';

export class SetuImageFetcher extends plugin {
    constructor() {
        super({
            name: 'Setu Image Fetch',
            dsc: '通过tag搜索图',
            event: 'message',
            priority: 500,
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
        const shuffled = ids.sort(() => 0.5 - Math.random());
        return shuffled.slice(0, count);
    }

    async modifyImageWithPython(imagePath) {
        return new Promise((resolve, reject) => {
            execFile(pythonCommand, ['./plugins/kkp-plugin/modify_image.py', imagePath], (error, stdout, stderr) => {
                if (error) {
                    reject(error);
                } else {
                    resolve(stdout.trim());
                }
            });
        });
    }

    async _processSetuImages(e) {

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
        const detailsPromises = selectedPids.map(pid => this.fetchPixivImageDetails(pid));
        const detailsList = await Promise.all(detailsPromises);

        await e.reply(`图片获取完毕，正在发送中...`);

        const imageMessages = [];
        for (const [index, details] of detailsList.entries()) {
            if (details && details.body) {
                const imageUrls = Object.values(details.body.urls).map(url => `${url}`);
                const tagList = details.body.tags.tags.map(tagObj => tagObj.tag);
                
                const imageDataPromises = imageUrls.map(async (imageUrl) => {
                    const imageDataResponse = await axios.get(imageUrl, { responseType: 'arraybuffer' });
                    return imageDataResponse.data;
                });
                const imageDatas = await Promise.all(imageDataPromises);

                const modifiedImagePaths = [];
                for (const [i, imageData] of imageDatas.entries()) {
                    const imagePath = `./temp_image_${index}_${i}.jpg`;
                    fs.writeFileSync(imagePath, imageData);
                    const modifiedImagePath = await this.modifyImageWithPython(imagePath);
                    modifiedImagePaths.push(modifiedImagePath);
                }

                const msgData = [
                    `id：${details.body.illustId}\n`,
                    `画师：${details.body.userName}（${details.body.userId}）\n`,
                    `是否ai：${details.body.aiType === 0 ? '否' : '是'}\n`,
                    `标题：${details.body.illustTitle}\n`,
                    `上传时间：${details.body.createDate}\n`,
                    `♥：${details.body.likeCount}\n`,
                    `😊：${details.body.bookmarkCount}\n`,
                    `👁：${details.body.viewCount}\n`,
                    `tag：${tagList.join(", ")}\n`,
                    ...modifiedImagePaths.map(imagePath => segment.image(imagePath))
                ];

                const msgList = {
                    message: msgData,
                    nickname: e.user_id.toString(),
                    user_id: e.user_id,
                };
                imageMessages.push(msgList);
            }
        }

        if (imageMessages.length > 0) {
            const forwardMsg = e.isGroup 
            ? await e.group.makeForwardMsg(imageMessages) 
            : await e.friend.makeForwardMsg(imageMessages);

            const recallConfig = this.getRecallConfig();

            const sentMessage = await e.reply(forwardMsg);

            if (recallConfig.recall) {
                setTimeout(() => {
                    e.isGroup 
                        ? e.group.recallMsg(sentMessage.message_id) 
                        : e.friend.recallMsg(sentMessage.message_id);
                }, recallConfig.time);
            }
        }
    }
}
