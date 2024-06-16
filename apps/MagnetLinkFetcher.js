import plugin from '../../../lib/plugins/plugin.js';
import puppeteer from 'puppeteer';
import fs from 'fs';
import YAML from 'yaml';
import { magnetURL, getFrameworkName } from '../config/api.js';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export class MagnetLinkFetcher extends plugin {
    constructor() {
        super({
            name: '磁力查询',
            dsc: '根据磁力链接查询文件信息',
            event: 'message',
            priority: '500',
            rule: [
                {
                    reg: '^#验车(magnet:.+)$',
                    fnc: 'processMagnetLink'
                }
            ]
        });
        this.frameworkName = getFrameworkName();
    }

    getRecallConfig() {
        const path = './plugins/kkp-plugin/config/recall.yaml';
        const fileContents = fs.readFileSync(path, 'utf8');
        return YAML.parse(fileContents);
    }

    async _launchBrowser() {
        return await puppeteer.launch({
            args: ['--no-sandbox', '--disable-setuid-sandbox'],
            ignoreHTTPSErrors: true // 忽略HTTPS错误
        });
    }

    async fetchWithPuppeteer(url) {
        const browser = await this._launchBrowser();
        const page = await browser.newPage();

        await page.setExtraHTTPHeaders({
            'Accept': 'application/json, text/plain, */*',
            'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8,en-GB;q=0.7,en-US;q=0.6',
            'Referer': 'https://whatslink.info/',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0'
        });

        await page.goto(url, { waitUntil: 'networkidle0' });

        try {
            const jsonContent = await page.$eval('div[hidden="true"]', div => div.textContent);
            await browser.close();
            return JSON.parse(jsonContent);
        } catch (error) {
            const responseData = await page.evaluate(() => {
                return JSON.parse(document.body.innerText);
            });
            await browser.close();
            return responseData;
        }
    }

    async fetchImageWithPuppeteer(imageUrl) {
        const browser = await this._launchBrowser();
        const page = await browser.newPage();

        await page.setExtraHTTPHeaders({
            'Accept': 'application/json, text/plain, */*',
            'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8,en-GB;q=0.7,en-US;q=0.6',
            'Referer': 'https://whatslink.info/',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0'
        });

        const response = await page.goto(imageUrl, { waitUntil: 'networkidle0' });
        const buffer = await response.buffer();
        await browser.close();
        return buffer;
    }

    async modifyImageWithPython(imageBuffer, imageName) {
        const tempImagePath = `./temp_${imageName}.jpg`;

        fs.writeFileSync(tempImagePath, imageBuffer);

        try {
            const { stdout } = await execFileAsync('python', ['./plugins/kkp-plugin/modify_image.py', tempImagePath]);
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

    async processMagnetLink(e) {

        try {
            const matchedMagnet = e.msg.match(/^#验车(magnet:.+)$/)[1];
            const url = magnetURL(matchedMagnet);

            const response = await this.fetchWithPuppeteer(url);

            if (response && response.error === "") {
                const data = response;

                const msgData = [
                    `磁力链接：${matchedMagnet}\n\n`,
                    `文件名字：${data.name}\n`,
                    `文件类型：${data.file_type}\n`,
                    `文件数量：${data.count}\n`,
                    `文件大小：${(data.size / 1e9).toFixed(1)}g\n`
                ];

                let screenshotData;
                if (data.screenshots) {
                    const modifiedScreenshots = await Promise.all(
                        data.screenshots.map(async (s, index) => {
                            try {
                                const imageBuffer = await this.fetchImageWithPuppeteer(s.screenshot);
                                const modifiedBuffer = await this.modifyImageWithPython(imageBuffer, `image_${index}`);
                                return modifiedBuffer ? `base64://${modifiedBuffer.toString('base64')}` : null;
                            } catch (error) {
                                console.error(`Error processing screenshot ${index}: ${error}`);
                                return null;
                            }
                        })
                    );
                    screenshotData = modifiedScreenshots.filter(Boolean);
                } else {
                    screenshotData = ['该磁力无视频文件'];
                }

                let msgList = [
                    {
                        message: msgData.join(''),
                        nickname: e.user_id.toString(),
                        user_id: e.user_id
                    }
                ];

                screenshotData.forEach((screenshot, index) => {
                    msgList.push({
                        message: [`截图 ${index + 1}`, "\n", segment.image(screenshot)],
                        nickname: e.user_id.toString(),
                        user_id: e.user_id
                    });
                });

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
            } else {
                await e.reply('查询失败。');
            }
        } catch (error) {
            await e.reply(`查询错误：${error.toString()}`);
        }
    }
}
