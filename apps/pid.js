import plugin from "../../../lib/plugins/plugin.js";
import axios from "axios";
import fs from "fs";
import YAML from "yaml";
import crypto from "crypto";
import { pid as pidAPI } from "../config/api.js";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);
const pythonCommand = process.platform === "win32" ? "python" : "python3";

export class PixivImageFetcher extends plugin {
    constructor() {
        super({
            name: "获取p站图",
            dsc: "获取p站图",
            event: "message",
            priority: 500,
            rule: [
                {
                    reg: "^#?pid(\\d+)$",
                    fnc: "processPixivImages"
                }
            ]
        });
    }

    getRecallConfig() {
        const path = "./plugins/kkp-plugin/config/recall.yaml";
        const fileContents = fs.readFileSync(path, "utf8");
        return YAML.parse(fileContents);
    }

    //async 函数中，await 失败时的错误本来就会自动向上层抛出，所以你写的这层 try/catch 是完全多余的脱裤子放屁操作
    async fetchImageDetails(url) {
        const response = await axios.get(url);
        return response.data;
    }

    async modifyImageWithPython(imageBuffer, imageName) {
        const tempImagePath = `./plugins/kkp-plugin/temp/temp_${imageName}.jpg`;

        fs.writeFileSync(tempImagePath, imageBuffer);

        try {
            const { stdout } = await execFileAsync(pythonCommand, [ "./plugins/kkp-plugin/modify_image.py", tempImagePath ]);
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

    async processPixivImages(e) {
        try {
            const matchedPid = e.msg.match(/^#?pid(\d+)$/)[1];
            const url = `${pidAPI(matchedPid)}`;
            await this.sendPixivDetails(e, url);
        } catch (error) {
            await e.reply(`发生错误：${error.toString()}`);
        }
    }

    async sendPixivDetails(e, url) {
        const details = await this.fetchImageDetails(url);

        if (!details || !details.body) {
            throw new Error("请输入正确的pid");
        }

        const body = details.body;
        const imageUrls = Object.values(body.urls).map(url => `${url}`);
        const tagList = body.tags.tags.map(tagObj => tagObj.tag);
        const date = new Date(body.createDate);
        const utc8Date = new Date(date.getTime() + 8 * 60 * 60 * 1000);
        const formattedTime = `${utc8Date.getUTCFullYear()}-${String(utc8Date.getUTCMonth() + 1).padStart(2, "0")}-${String(utc8Date.getUTCDate()).padStart(2, "0")} ${String(utc8Date.getUTCHours()).padStart(2, "0")}:${String(utc8Date.getUTCMinutes()).padStart(2, "0")}:${String(utc8Date.getUTCSeconds()).padStart(2, "0")}`;
        const imageDataPromises = imageUrls.map(async(imageUrl, index) => {
            const imageDataResponse = await axios.get(imageUrl, { responseType: "arraybuffer" });
            return this.modifyImageWithPython(imageDataResponse.data, `image_${index}`);
        });

        const modifiedImageBuffers = await Promise.all(imageDataPromises);

        const msgData = [
            `id：${body.illustId}\n`,
            `画师：${body.userName}（${body.userId}）\n`,
            `是否ai：${body.aiType === 2 ? "是" : "否"}\n`,
            `标题：${body.illustTitle}\n`,
            `上传时间：${formattedTime}\n`,
            `♥：${body.likeCount}\n`,
            `😊：${body.bookmarkCount}\n`,
            `👁：${body.viewCount}\n`,
            `tag：${tagList.join(", ")}\n`,
        ].concat(modifiedImageBuffers.map(buffer => segment.image(buffer)));

        const msgList = [
            {
                message: msgData,
                nickname: e.user_id.toString(),
                user_id: e.user_id,
            }
        ];

        const forwardMsg = e.isGroup
            ? await e.group.makeForwardMsg(msgList)
            : await e.friend.makeForwardMsg(msgList);

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
