import plugin from "../../../lib/plugins/plugin.js";
import axios from "axios";
import fs from "fs";
import YAML from "yaml";
import { pid, dailyRanking } from "../config/api.js";
import { execFile } from "child_process";
import path from "path";

const pythonCommand = process.platform === "win32" ? "python" : "python3";

export class DailyRankImageFetcher extends plugin {
    constructor() {
        super({
            name: "Daily Rank Image Fetch",
            dsc: "获取每日排行图片",
            event: "message",
            priority: 500,
            rule: [
                {
                    reg: "^#?每日排行(\\d+)?$",
                    fnc: "_processDailyRank"
                }
            ]
        });
    }

    getRecallConfig() {
        const path = "./plugins/kkp-plugin/config/recall.yaml";
        try {
            if (fs.existsSync(path)) {
                const fileContents = fs.readFileSync(path, "utf8");
                return YAML.parse(fileContents);
            }
        } catch (e) {
            console.error("读取recall配置失败：", e);
        }
        return { recall: false, time: 0 }; // 返回默认配置
    }

    async fetchDailyRankings() {
        // 建议优先尝试 api.js 里的接口，或者保留当前地址进行排查
        // const apiUrl = 'https://pid.kkndp.cn/rank'; 
        const apiUrl = dailyRanking();
        try {
            const response = await axios.get(apiUrl, {
                headers: { "User-Agent": "Yunzai-Bot" },
                timeout: 5000
            });

            // 关键：打印原始返回数据，方便一眼看出结构是否变化
            // logger.mark(`[kkp-plugin] 每日排行接口原始响应：${JSON.stringify(response.data)}`);
            logger.info(apiUrl)

            // 适配 mokeyjay 接口格式：从 data 数组中提取 id
            if (response.data?.data && Array.isArray(response.data.data)) {
                return response.data.data.map(item => item.id);
            }

            // 兼容原有或其他接口格式
            let res = response.data?.rankings || response.data;
            return Array.isArray(res) ? res : [];
        } catch (error) {
            logger.error(`[kkp-plugin] 每日排行接口请求失败：${error.message}`);
            return [];
        }
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

    async modifyImageWithPython(imagePath) {
        return new Promise((resolve, reject) => {
            execFile(pythonCommand, [ "./plugins/kkp-plugin/modify_image.py", imagePath ], (error, stdout, stderr) => {
                if (error) {
                    reject(error);
                } else {
                    resolve(stdout.trim());
                }
            });
        });
    }

    deleteTempFiles() {
        const tempDir = path.resolve("./plugins/kkp-plugin/temp");
        fs.readdir(tempDir, (err, files) => {
            if (err) {
                console.error("读取temp目录失败：", err);
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

    async _processDailyRank(e) {
        const tempDir = "./plugins/kkp-plugin/temp";
        if (!fs.existsSync(tempDir)) {
            fs.mkdirSync(tempDir, { recursive: true });
        }
        const match = e.msg.match(this.rule.find(rule => e.msg.match(rule.reg)).reg);
        const numStr = match[1];
        const num = numStr ? Math.min(parseInt(numStr), 30) : 10;

        const rankings = await this.fetchDailyRankings();
        logger.info(`[kkp-plugin] 正在处理每日排行，获取到 PIDs 数量：${rankings?.length || 0}`);
        if (rankings.length === 0) {
            await e.reply("获取每日排行失败，请稍后再试！");
            return;
        }

        const selectedPids = rankings.slice(0, num);
        const detailsPromises = selectedPids.map(pid => this.fetchPixivImageDetails(pid));
        const detailsList = await Promise.all(detailsPromises);

        await e.reply("图片获取完毕，正在发送中...");

        const imageMessages = await Promise.all(detailsList.map(async(details, index) => {
            if (details && details.body) {
                const imageUrls = [ details.body.urls.regular || Object.values(details.body.urls)[0] ];
                const tagList = details.body.tags.tags.map(tagObj => tagObj.tag);

                const imageDatas = await Promise.all(imageUrls.map(async(imageUrl) => {
                    const imageDataResponse = await axios.get(imageUrl, { responseType: "arraybuffer", maxContentLength: Infinity, maxBodyLength: Infinity });
                    return imageDataResponse.data;
                }));

                const validImageDatas = imageDatas.filter(data => data !== null);

                const modifiedImagePaths = await Promise.all(validImageDatas.map(async(imageData, i) => {
                    const imagePath = `./plugins/kkp-plugin/temp/temp_image_${index}_${i}.jpg`;
                    fs.writeFileSync(imagePath, imageData);
                    const modifiedImagePath = await this.modifyImageWithPython(imagePath);
                    return modifiedImagePath;
                }));

                const msgData = [
                    `id：${details.body.illustId}\n`,
                    `画师：${details.body.userName}（${details.body.userId}）\n`,
                    `是否ai：${details.body.aiType === 2 ? "是" : "否"}\n`,
                    `标题：${details.body.illustTitle}\n`,
                    `上传时间：${details.body.createDate}\n`,
                    `♥：${details.body.likeCount}\n`,
                    `😊：${details.body.bookmarkCount}\n`,
                    `👁：${details.body.viewCount}\n`,
                    `tag：${tagList.join(", ")}\n`,
                    ...modifiedImagePaths.map(imagePath => (global.segment || segment).image(imagePath))
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
            const forwardMsg = e.isGroup
                ? await e.group.makeForwardMsg(validImageMessages)
                : await e.friend.makeForwardMsg(validImageMessages);

            const recallConfig = this.getRecallConfig();

            const sentMessage = await e.reply(forwardMsg);

            if (recallConfig.recall) {
                setTimeout(() => {
                    e.isGroup
                        ? e.group.recallMsg(sentMessage.message_id)
                        : e.friend.recallMsg(sentMessage.message_id);
                }, recallConfig.time);
            }

            this.deleteTempFiles();
        }
    }
}
