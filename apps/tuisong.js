import plugin from '../../../lib/plugins/plugin.js';
import schedule from "node-schedule";
import { dingyue, keyValue, pid } from '../config/api.js';
import fetch from 'node-fetch';
import yaml from 'yaml';
import fs from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);
const pythonCommand = process.platform === 'win32' ? 'python' : 'python3';

export class kkp extends plugin {
    constructor() {
        super({
            name: 'KKP帮助',
            dsc: 'KKP帮助',
            event: 'message',
            priority: '50',
            rule: [
                {
                    reg: '^#?kkp帮助$',
                    fnc: 'sendKKPImage',
                }
            ]
        });
    }

    async sendKKPImage() {
        const imagePath =  './plugins/kkp-plugin/config/kkp.jpg';
        let msg = [
            segment.image(`file://${imagePath}`),
        ];
        this.e.reply(msg);
        return true;
    }

    async fetchImage(url) {
        try {
            const response = await fetch(url);
            const buffer = await response.buffer();
            return buffer;
        } catch (error) {
            console.error(`Error fetching image: ${error}`);
            return null;
        }
    }

    async modifyImageWithPython(imageBuffer, imageName) {
        const tempImagePath = `./plugins/kkp-plugin/temp/temp_${imageName}.jpg`;

        fs.writeFileSync(tempImagePath, imageBuffer);

        try {
            const { stdout } = await execFileAsync(pythonCommand, ['./plugins/kkp-plugin/modify_image.py', tempImagePath]);
            const modifiedImagePath = stdout.trim();
            const modifiedImageBuffer = fs.readFileSync(modifiedImagePath);

            fs.unlinkSync(tempImagePath);
            fs.unlinkSync(modifiedImagePath);

            return modifiedImageBuffer;
        } catch (error) {
            fs.unlinkSync(tempImagePath);
            throw error;
        }
    }
}

// 重新加载dingyue.yaml的定时任务，每10分钟执行一次
let data;
schedule.scheduleJob('*/10 * * * *', () => {
    const fileContents = fs.readFileSync('./plugins/kkp-plugin/config/dingyue.yaml', 'utf8');
    data = yaml.parse(fileContents);
});

// 主定时任务，每4小时执行一次，但引入随机延迟
schedule.scheduleJob('0 */2 * * *', async () => {
    // 引入1到60秒的随机延迟
    const randomDelay = Math.floor(Math.random() * 60 * 60 * 1000);  // in milliseconds

    setTimeout(async () => {
        try {
            const response = await fetch(dingyue(), {
                method: 'POST',
                body: JSON.stringify({
                    key: keyValue,
                    user: Object.keys(data).flatMap(groupId => Object.keys(data[groupId].artists))
                }),
                headers: { 'Content-Type': 'application/json' }
            });

            const responseData = await response.json();

            if (responseData && responseData.response) {
                for (let groupId in data) {
                    if (data[groupId].pushEnabled) {
                        for (let artistId in data[groupId].artists) {
                            const newWorks = responseData.response[artistId];
                            if (newWorks && newWorks.length) {
                                const group = Bot.pickGroup(groupId);
                                
                                // 为每一个新作品ID获取图片链接并发送
                                for (let workId of newWorks.slice(0, 3)) {  // 仅处理前3个作品ID
                                    const imgUrlResponse = await fetch(pid(workId));
                                    const imgData = await imgUrlResponse.json();
                                    if (imgData && imgData.body && imgData.body.urls) {
                                        const tagList = imgData.body.tags.tags.map(tag => tag.tag);
                                        const infoMsg = [
                                            `爷爷，您关注的画师：${imgData.body.userName}（${imgData.body.userId}）更新了`,
                                            `pid：${imgData.body.illustId}`,
                                            `是否ai：${imgData.body.aiType === 0 ? '否' : '是'}`,
                                            `标题：${imgData.body.illustTitle}`,
                                            `上传时间：${imgData.body.createDate}`,
                                            `♥：${imgData.body.likeCount},😊：${imgData.body.bookmarkCount},👁：${imgData.body.viewCount}`,
                                            `tag：${tagList.join(", ")}`
                                        ].join("\n");

                                        let message = [infoMsg];

                                        for (let urlKey in imgData.body.urls) {
                                            const imageUrl = `${imgData.body.urls[urlKey]}`;
                                            const imageBuffer = await this.fetchImage(imageUrl);

                                            if (imageBuffer) {
                                                const modifiedImageBuffer = await this.modifyImageWithPython(imageBuffer, `image_${workId}_${urlKey}`);
                                                message.push(segment.image(`base64://${modifiedImageBuffer.toString('base64')}`));
                                            }
                                        }
                                        
                                        group.sendMsg(message);
                                        await new Promise(res => setTimeout(res, 10000));
                                    }
                                }
                            }
                        }
                    }
                }
            } else {
                console.error('请求API失败');
            }
        } catch (error) {
            console.error('请求API时发生错误:', error);
        }
    }, randomDelay);
});
