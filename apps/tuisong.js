import plugin from '../../../lib/plugins/plugin.js';
import schedule from "node-schedule";
import { dingyue, keyValue, pid } from '../config/api.js';
import fetch from 'node-fetch';
import yaml from 'yaml';
import fs from 'fs';

export class kkp extends plugin {
    constructor() {
        super({
            name: 'KKP推送与帮助',
            dsc: 'KKP帮助及手动触发推送',
            event: 'message',
            priority: '50',
            rule: [
                {
                    reg: '^#?kkp帮助$',
                    fnc: 'sendKKPImage',
                },
                {
                    // 新增强制推送指令，仅限主人执行
                    reg: '^#?强制推送p$',
                    fnc: 'forcePush',
                    permission: 'master'
                }
            ]
        });
    }

    async sendKKPImage() {
        const imagePath = './plugins/kkp-plugin/config/kkp.jpg';
        let msg = [segment.image(`file://${imagePath}`)];
        this.e.reply(msg);
        return true;
    }

    // 新增：手动触发推送的方法
    async forcePush(e) {
        await e.reply("正在手动检查订阅更新...");
        const result = await this.executePushLogic(true); 
        
        if (result === "empty") {
            await e.reply("检查完毕：您订阅的所有画师目前均无新作品更新。");
        } else if (result === "error") {
            await e.reply("检查失败：接口异常或无返回，请查看控制台日志。");
        } else if (result === "success") {
            await e.reply("手动检查及推送任务执行完毕！");
        }
    }

    // 将原有的推送逻辑封装为可复用的函数
    async executePushLogic(isManual = false) {
        try {
            const filePath = './plugins/kkp-plugin/config/dingyue.yaml';
            if (!fs.existsSync(filePath)) return "error";
            const data = yaml.parse(fs.readFileSync(filePath, 'utf8'));

            const bodyData = {
                key: keyValue,
                user: Object.keys(data).flatMap(groupId => Object.keys(data[groupId].artists))
            };

            const response = await fetch(dingyue(), {
                method: 'POST',
                body: JSON.stringify(bodyData),
                headers: { 'Content-Type': 'application/json' }
            });

            const responseData = await response.json();
            
            if (isManual) {
                logger.mark(`[kkp-plugin] 推送接口原始响应：${JSON.stringify(responseData)}`);
            }

            if (!responseData || !responseData.response) {
                return "error";
            }

            // 提取所有画师的更新数组，检查是否全部为空
            const isAllEmpty = Object.values(responseData.response).every(arr => Array.isArray(arr) && arr.length === 0);
            if (isAllEmpty) {
                return "empty";
            }

            for (let groupId in data) {
                if (data[groupId].pushEnabled) {
                    for (let artistId in data[groupId].artists) {
                        const newWorks = responseData.response[artistId];
                            if (newWorks && newWorks.length) {
                                // --- 新增：打印发现更新的日志 ---
                                logger.mark(`[kkp-plugin] 匹配到群 ${groupId} 订阅的画师 ${artistId} 有新作品：${newWorks.join(', ')}`);
                                
                                const group = Bot.pickGroup(groupId);
                                // 为每一个新作品ID获取图片链接并发送
                                for (let workId of newWorks.slice(0, 3)) {  // 仅处理前3个作品ID
                                    try {
                                        const imgUrlResponse = await fetch(pid(workId));
                                        const imgData = await imgUrlResponse.json();
                                        if (imgData && imgData.body && imgData.body.urls) {
                                            const tagList = imgData.body.tags.tags.map(tag => tag.tag);
                                            const infoMsg = [
                                                `爷爷，您关注的画师：${imgData.body.userName}（${imgData.body.userId}）更新了`,
                                                `pid：${imgData.body.illustId}`,
                                                `是否ai：${imgData.body.aiType === 2 ? '是' : '否'}`,
                                                `标题：${imgData.body.illustTitle}`,
                                                `上传时间：${imgData.body.createDate}`,
                                                `♥：${imgData.body.likeCount},😊：${imgData.body.bookmarkCount},👁：${imgData.body.viewCount}`,
                                                `tag：${tagList.join(", ")}`
                                            ].join("\n");

                                            let message = [infoMsg];
                                            for (let urlKey in imgData.body.urls) {
                                                const imageUrl = `${imgData.body.urls[urlKey]}`;
                                                message.push(segment.image(imageUrl));
                                            }
                                            
                                            group.sendMsg(message);
                                            await new Promise(res => setTimeout(res, 10000));
                                        } else {
                                            // --- 新增：详情接口异常报错 ---
                                            logger.error(`[kkp-plugin] 作品 ${workId} 的图片详情获取失败，接口可能已失效：${JSON.stringify(imgData)}`);
                                        }
                                    } catch (err) {
                                        // --- 新增：请求报错日志 ---
                                        logger.error(`[kkp-plugin] 请求作品 ${workId} 时发生错误: ${err.message}`);
                                    }
                                }
                            }
                    }
                }
            }
            return "success";
        } catch (error) {
            logger.error(`[kkp-plugin] 推送逻辑执行报错: ${error}`);
            return "error";
        }
    }
}

// 修改定时任务：改为调用类内部的方法（或保持现状，但建议统一逻辑）
schedule.scheduleJob('0 */2 * * *', async () => {
    const randomDelay = Math.floor(Math.random() * 60 * 60 * 1000);
    setTimeout(() => {
        new kkp().executePushLogic();
    }, randomDelay);
});