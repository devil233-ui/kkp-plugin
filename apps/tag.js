import plugin from '../../../lib/plugins/plugin.js';
import axios from 'axios';
import fs from 'fs';
import YAML from 'yaml';
import { pid, tag as fetchTag } from '../config/api.js';
import { execFile } from 'child_process';
import path from 'path';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);
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
        const config = this.getRecallConfig();
        const mode = config.mode || 'all';
        const order = config.order || 'popular_d';
        const apiUrl = `${fetchTag(tagValue)}&mode=${mode}&order=${order}`;
        
        const response = await axios.get(apiUrl);
        return response.data.body.data.map(item => item.id);

    }

    getRandomIds(ids, count) {
        const shuffled = ids.sort(() => 0.5 - Math.random());
        return shuffled.slice(0, count);
    }

    async modifyImageWithPython(imageBuffer, imageName) {
        const tempImagePath = `./plugins/kkp-plugin/temp/temp_${Date.now()}_${imageName}.jpg`;
        const cleanUp = () => {
            if (fs.existsSync(tempImagePath)) {
                fs.unlinkSync(tempImagePath);
            }
        };

        try {
            fs.writeFileSync(tempImagePath, imageBuffer);
            const { stdout } = await execFileAsync(pythonCommand, [
                './plugins/kkp-plugin/modify_image.py',
                tempImagePath
            ]);

            const modifiedImagePath = stdout.trim();
            if (!fs.existsSync(modifiedImagePath)) {
                throw new Error('Python处理图片失败');
            }

            const modifiedImageBuffer = fs.readFileSync(modifiedImagePath);
            cleanUp();
            fs.unlinkSync(modifiedImagePath);
            
            return modifiedImageBuffer;
        } catch (error) {
            cleanUp();
            throw error;
        }
    }

    deleteTempFiles() {
        const tempDir = path.resolve('./plugins/kkp-plugin/temp');
        fs.readdir(tempDir, (err, files) => {
            if (err) {
                console.error('读取temp目录失败：', err);
                return;
            }

            files.forEach(file => {
                const filePath = path.join(tempDir, file);
                fs.unlink(filePath, err => {
                    if (err) {
                        console.error(`删除文件失败：${filePath}`, err);
                    }
                });
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

        const imageMessages = await Promise.all(detailsList.map(async (details, index) => {
            if (details && details.body) {
                const imageUrls = Object.values(details.body.urls).map(url => `${url}`);
                const tagList = details.body.tags.tags.map(tagObj => tagObj.tag);
                
                const imageBuffers = await Promise.all(imageUrls.map(async (imageUrl) => {
                    try {
                        const imageDataResponse = await axios.get(imageUrl, { 
                            responseType: 'arraybuffer',
                            maxContentLength: Infinity,
                            maxBodyLength: Infinity
                        });
                        return imageDataResponse.data;
                    } catch (error) {
                        console.error(`下载图片失败: ${imageUrl}`, error);
                        return null;
                    }
                }));

                const validImageBuffers = imageBuffers.filter(buffer => buffer !== null);
                
                const modifiedImageSegments = await Promise.all(validImageBuffers.map(async (buffer, i) => {
                    try {
                        const modifiedBuffer = await this.modifyImageWithPython(buffer, `image_${index}_${i}`);
                        return segment.image(modifiedBuffer);
                    } catch (error) {
                        console.error(`图片处理失败:`, error);
                        return null;
                    }
                }));

                const filteredImageSegments = modifiedImageSegments.filter(segment => segment !== null);
                
                const msgData = [
                    `id：${details.body.illustId}\n`,
                    `画师：${details.body.userName}（${details.body.userId}）\n`,
                    `是否ai：${details.body.aiType === 2? '是' : '否'}\n`,
                    `标题：${details.body.illustTitle}\n`,
                    `上传时间：${details.body.createDate}\n`,
                    `♥：${details.body.likeCount}\n`,
                    `😊：${details.body.bookmarkCount}\n`,
                    `👁：${details.body.viewCount}\n`,
                    `tag：${tagList.join(", ")}\n`,
                    ...filteredImageSegments
                ];

                return {
                    message: msgData,
                    nickname: e.user_id.toString(),
                    user_id: e.user_id,
                };
            }
            return null;
        }));

        const validImageMessages = imageMessages.filter(msg => msg !== null);

        if (validImageMessages.length > 0) {
            try {
                const forwardMsg = e.isGroup 
                    ? await e.group.makeForwardMsg(validImageMessages) 
                    : await e.friend.makeForwardMsg(validImageMessages);

                const recallConfig = this.getRecallConfig();

                const sentMessage = await e.reply(forwardMsg);

                if (recallConfig.recall) {
                    setTimeout(() => {
                        if (e.isGroup) {
                            e.group.recallMsg(sentMessage.message_id);
                        } else {
                            e.friend.recallMsg(sentMessage.message_id);
                        }
                    }, recallConfig.time);
                }

                this.deleteTempFiles();
            } catch (error) {
                console.error('发送消息失败:', error);
                await e.reply('消息发送失败');
            }
        }
    }
}