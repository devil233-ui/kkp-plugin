import plugin from '../../../lib/plugins/plugin.js';
import axios from 'axios';
import fs from 'fs';
import YAML from 'yaml';
import { pid, user, keyValue } from '../config/api.js';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);
const pythonCommand = process.platform === 'win32' ? 'python' : 'python3';

export class PixivArtistWorksFetcher extends plugin {
    constructor() {
        super({
            name: 'p站画师id获取图片',
            dsc: 'p站画师id获取图片',
            event: 'message',
            priority: 50,
            rule: [
                {
                    reg: '^#来(\\d+)张(\\d+)作品$',
                    fnc: 'processLatestArtistWorks'
                },
                {
                    reg: '^#?随机(\\d+)张(\\d+)作品$',
                    fnc: 'processRandomArtistWorks'
                }
            ]
        });
    }

    getRecallConfig() {
        const path = './plugins/kkp-plugin/config/recall.yaml';
        const fileContents = fs.readFileSync(path, 'utf8');
        return YAML.parse(fileContents);
    }

    async fetchArtistDetails(artistId) {
        try {
            const response = await axios.get(user(artistId));
            return response.data;
        } catch (error) {
            throw error;
        }
    }

    async fetchWorkDetails(pidValue) {
        try {
            const response = await axios.get(pid(pidValue));
            return response.data;
        } catch (error) {
            throw error;
        }
    }

    async modifyImageWithPython(imageBuffer, imageName) {
        const tempImagePath = `./temp_${imageName}.jpg`;

        // Save image buffer to temporary file
        fs.writeFileSync(tempImagePath, imageBuffer);

        try {
            const { stdout } = await execFileAsync(pythonCommand, ['./plugins/kkp-plugin/modify_image.py', tempImagePath]);
            const modifiedImagePath = stdout.trim();
            const modifiedImageBuffer = fs.readFileSync(modifiedImagePath);

            // Clean up temporary files
            fs.unlinkSync(tempImagePath);
            fs.unlinkSync(modifiedImagePath);

            return modifiedImageBuffer;
        } catch (error) {
            fs.unlinkSync(tempImagePath);
            throw error;
        }
    }

    async processLatestArtistWorks(e) {
        await this._processArtistWorks(e, false);
    }

    async processRandomArtistWorks(e) {
        await this._processArtistWorks(e, true);
    }

    async _processArtistWorks(e, isRandom) {
        if (!e.isGroup) return;
        const match = e.msg.match(isRandom ? /^#?随机(\d+)张(\d+)作品$/ : /^#来(\d+)张(\d+)作品$/);
        if (!match) return;

        const num = parseInt(match[1]);
        const artistId = match[2];

        if (num > 30) {
            await e.reply('一次最多看30张哦');
            return;
        }

        try {
            const artistData = await this.fetchArtistDetails(artistId);

            if (!artistData || artistData.error) {
                await e.reply('请输入正确的画师id');
                return;
            }

            let workIDs;
            const allWorkIDs = Object.keys(artistData.body.illusts).reverse();

            if (isRandom) {
                workIDs = this.shuffleArray(allWorkIDs).slice(0, num);
            } else {
                workIDs = allWorkIDs.slice(0, num);
            }

            const workDetailsPromises = workIDs.map(workId => this.fetchWorkDetails(workId));
            const workDetailsList = await Promise.all(workDetailsPromises);

            await this.sendCombinedWorkDetails(e, workDetailsList);

        } catch (error) {
            await e.reply(`发生错误：${error.toString()}`);
        }
    }

    async sendCombinedWorkDetails(e, workDetailsList) {

        const combinedMsgData = [];
        const combinedImageBuffers = [];

        for (const details of workDetailsList) {
            const body = details.body;
            const imageUrls = Object.values(body.urls).map(url => `${url}?key=${keyValue}`);

            const tagList = body.tags.tags.map(tagObj => tagObj.tag);

            const msgData = [
                `id：${body.illustId}\n`,
                `画师：${body.userName}（${body.userId}）\n`,
                `是否ai：${body.aiType === 0 ? '否' : '是'}\n`,
                `标题：${body.illustTitle}\n`,
                `上传时间：${body.createDate}\n`,
                `喜欢数：${body.likeCount}\n`,
                `收藏数：${body.bookmarkCount}\n`,
                `观看数：${body.viewCount}\n`,
                `tag：${tagList.join(", ")}\n`
            ];

            combinedMsgData.push(...msgData);

            // 使用 Promise.all 并发获取图片数据并进行修改
            const imageDataPromises = imageUrls.map(async (imageUrl, index) => {
                const imageDataResponse = await axios.get(imageUrl, { responseType: 'arraybuffer' });
                return this.modifyImageWithPython(imageDataResponse.data, `image_${index}`);
            });

            const modifiedImageBuffers = await Promise.all(imageDataPromises);
            combinedImageBuffers.push(...modifiedImageBuffers);
        }

        // 创建 segment 对象
        const segmentList = combinedMsgData.concat(combinedImageBuffers.map(buffer => segment.image(buffer)));

        const forwardMsg = e.isGroup 
        ? await e.group.makeForwardMsg([{ message: segmentList }]) 
        : await e.friend.makeForwardMsg([{ message: segmentList }]);

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

    shuffleArray(array) {
        for (let i = array.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [array[i], array[j]] = [array[j], array[i]];
        }
        return array;
    }
}
