import plugin from '../../../lib/plugins/plugin.js';
import puppeteer from 'puppeteer';

export class MagnetLink extends plugin {
    constructor() {
        super(
            {
                name: '磁力猫搜索',
                dsc: '磁力猫搜索',
                event: 'message',
                priority: '77',
                rule: [
                    {
                        reg: '^#?磁力猫(.*)$',
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
        if (!e.isGroup) return;
        let helpText = "#搜磁力更改为#磁力猫（内容）和#磁力草（内容）\n\n"
        helpText += "#磁力猫支持搜索格式  #磁力猫[搜索内容] [全部/影视/音乐/图像/文档/压缩包/安装包/其他] [相关度/文件大小/添加时间/热度/最近下载] [结果数量]\n"
        helpText += "如#磁力猫ipx  #磁力猫ipx 全部 热度 20  #磁力猫ipx 影视 添加时间\n\n"
        helpText += "#磁力草支持搜索格式  #磁力草[搜索内容] [热度/大小]\n"
        helpText += "如#磁力草ipx  #磁力草ipx 热度  #磁力草ipx 大小"
        await this.reply(helpText);
    }

    async processMagnetLink(e) {
        if (!e.isGroup) return;
        let match = e.msg.match(/^#?磁力猫\s*(\S+)(\s+(\S+))?(\s+(\S+))?(\s+(\d+))?$/);
        if (!match) {
            return;
        }

        const userInput = match[1];
        const fileType = this.fileTypeMap[match[3]] ?? 0;
        const orderType = this.orderTypeMap[match[5]] ?? 0;
        const resultCount = parseInt(match[7]) || 10;

        const urls = [
            `https://clm434.buzz/search-${userInput}-${fileType}-${orderType}-1.html`,
            `https://clm439.buzz/search-${userInput}-${fileType}-${orderType}-1.html`,
            `https://clm438.buzz/search-${userInput}-${fileType}-${orderType}-1.html`,
            `https://clm429.buzz/search-${userInput}-${fileType}-${orderType}-1.html`
        ];

        const browser = await puppeteer.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox'] });
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
                        results.push({ user_id: e.user_id, nickname: e.user_id, message: `${title}\n\n${magnetLink}\n\n添加时间：${addedTime}\n大小：${size}\n最近下载：${recentDownload}\n热度：${heat}` });
                    }
                    const forwardMsg = await e.group.makeForwardMsg(results);
                    await this.reply(forwardMsg);
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
