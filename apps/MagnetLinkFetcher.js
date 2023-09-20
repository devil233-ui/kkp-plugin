import plugin from '../../../lib/plugins/plugin.js';
import sharp from 'sharp';
import puppeteer from 'puppeteer';
import fs from 'fs';
import YAML from 'yaml';
import { magnetURL, getFrameworkName } from '../config/api.js';

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
			args: ['--no-sandbox', '--disable-setuid-sandbox']
		});
	}

    async fetchWithPuppeteer(url) {
        const browser = await this._launchBrowser();
        const page = await browser.newPage();

        await page.setExtraHTTPHeaders({
            'Accept': 'application/json, text/plain, */*',
            'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8,en-GB;q=0.7,en-US;q=0.6',
            'Referer': 'https://whatslink.info/',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Safari/537.36 Edg/116.0.1938.69'
        });
        
        await page.goto(url, { waitUntil: 'networkidle0' });

        if (this.frameworkName === 'miao-yunzai') {
            // 如果框架名为miao-yunzai，从HTML中筛选JSON
            const jsonContent = await page.$eval('div[hidden="true"]', div => div.textContent);
            await browser.close();
            return JSON.parse(jsonContent);
        } else {
            // 否则直接解析JSON
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
			'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Safari/537.36 Edg/116.0.1938.69'
		});

		const response = await page.goto(imageUrl, { waitUntil: 'networkidle0' });
		const buffer = await response.buffer();
		await browser.close();
		return buffer;
	}

    async compressImage(imageUrl) {
        const inputImage = await this.fetchImageWithPuppeteer(imageUrl);
        return sharp(inputImage)
            .jpeg({ quality: 90 })
            .toBuffer();
    }

    async processMagnetLink(e) {
        if (!e.isGroup) return;

        try {
            const matchedMagnet = e.msg.match(/^#验车(magnet:.+)$/)[1];
            const url = magnetURL(matchedMagnet);
			
            const response = await this.fetchWithPuppeteer(url);

            if (response && response.error === "") {
                const data = response;

                const msgData = [
                    `文件名字：${data.name}\n`,
                    `文件类型：${data.file_type}\n`,
                    `文件数量：${data.count}\n`,
                    `文件大小：${(data.size / 1e9).toFixed(1)}g\n`
                ];

                let screenshotData;
                if (data.screenshots) {
                    const compressedScreenshots = await Promise.all(
                        data.screenshots.map(async s => {
                            const compressedBuffer = await this.compressImage(s.screenshot);
                            return segment.image(compressedBuffer);
                        })
                    );
                    screenshotData = compressedScreenshots;
                } else {
                    screenshotData = ['该磁力无视频文件'];
                }

                const msgList = {
                    message: msgData.concat(screenshotData),
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

						const Message = await e.reply(forwardMsg);
						
						const recallConfig = this.getRecallConfig();
						if (recallConfig.recall) {
							setTimeout(() => {
								e.group.recallMsg(Message.message_id);
							}, recallConfig.time);
						}
                    }
                }
            } else {
                await e.reply('查询失败。');
            }
        } catch (error) {
            await e.reply(`查询错误：${error.toString()}`);
        }
    }
}
