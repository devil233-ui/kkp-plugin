import { segment } from "icqq";
import plugin from '../../../lib/plugins/plugin.js'
import puppeteer from 'puppeteer';

export class MagnetLink extends plugin {
    constructor() {
        super(
            {
                name: '搜磁力',
                dsc: '获取磁力链接',
                event: 'message',
                priority: '776',
                rule: [
                    {
                        reg: '^#?搜磁力(.*)$',
                        fnc: 'processMagnetLink'
                    },
                    {
                        reg: '^#?磁力帮助$',
                        fnc: 'magnetHelp'
                    }
                ]
            }
        )
    }

    async magnetHelp(e) {
        let helpText = "搜磁力功能帮助：\n"
        helpText += "输入格式：搜磁力 [搜索内容] [文件类型] [排序方式] [结果数量]\n"
        helpText += "文件类型：全部, 影视, 音乐, 图像, 文档, 压缩包, 安装包, 其他\n"
        helpText += "排序方式：相关度, 文件大小, 添加时间, 热度, 最近下载\n"
        helpText += "默认搜索全部文件，相关度排序，返回前10个"
        await this.reply(helpText);
    }

    async processMagnetLink(e) {
        let match = e.msg.match(/^#?搜磁力\s*(\S+)(\s+(\S+))?(\s+(\S+))?(\s+(\d+))?$/);
        if (!match) {
            return;
        }

        const userInput = match[1];
        const fileType = this.fileTypeMap[match[3]] ?? 0;
        const orderType = this.orderTypeMap[match[5]] ?? 0;
        const resultCount = parseInt(match[7]) || 10;

        const urls = [
            `https://clm422.buzz/search-${userInput}-${fileType}-${orderType}-1.html`,
            `https://clm423.buzz/search-${userInput}-${fileType}-${orderType}-1.html`,
            `https://clm424.buzz/search-${userInput}-${fileType}-${orderType}-1.html`,
			`https://clm425.buzz/search-${userInput}-${fileType}-${orderType}-1.html`
        ];

        const browser = await puppeteer.launch();
        let page;

        for (let i = 0; i < urls.length; i++) {
            try {
                page = await browser.newPage();
                await page.goto(urls[i], { waitUntil: 'load', timeout: 7000 });
                await page.waitForTimeout(5000);

                const searchResults = await page.$$('.sbar');
                if (searchResults.length === 0) {
                    await this.reply('搜索失败，正在尝试下个链接');
                    await page.close();
                    continue;
                }

                const titleElements = await page.$$eval('h3 > a', links => links.map(link => link.innerText));
                const matches = await page.$$eval('.sbar', divs => divs.map(div => div.innerHTML));
                
                if (matches) {
                    let results = [];
                    for (let i = 0; i < resultCount && i < matches.length; i++) {
                        let match = matches[i];
                        let title = titleElements[i];
                        let magnetLink = match.match(/magnet:\?xt=[^"]+/)[0];
                        let addedTime = match.match(/添加时间:<b>([^<]+)<\/b>/)[1];
                        let size = match.match(/大小:<b class="cpill yellow-pill">([^<]+)<\/b>/)[1];
                        let recentDownload = match.match(/最近下载:<b>([^<]+)<\/b>/)[1];
                        let heat = match.match(/热度:<b>([^<]+)<\/b>/)[1];
                        results.push({user_id: e.user_id, nickname: e.user_id, message: `${title}\n\n${magnetLink}\n\n添加时间：${addedTime}\n大小：${size}\n最近下载：${recentDownload}\n热度：${heat}`});
                    }
                    const forwardMsg = await e.group.makeForwardMsg(results);
                    const sentMessage = await this.reply(forwardMsg);
                    setTimeout(() => {
                        e.group.recallMsg(sentMessage.message_id);
                    }, 100000);
                    await browser.close();
                    return;
                } else {
                    await this.reply("未找到磁力链接");
                    await page.close();
                    continue;
                }
            }
            catch (error) {
                console.log(`在URL ${urls[i]} 上出现错误：${error.toString()}`);
                await page.close();
                continue;
            }
        }
        await this.reply('所有链接均无搜索结果');
        await browser.close();
    }

    fileTypeMap = {
        '全部': 0,
        '影视': 1,
        '音乐': 2,
        '图像': 3,
        '文档': 4,
        '压缩包': 5,
        '安装包': 6,
        '其他': 7
    };

    orderTypeMap = {
        '相关度': 0,
        '文件大小': 1,
        '添加时间': 2,
        '热度': 3,
        '最近下载': 4
    };
}
