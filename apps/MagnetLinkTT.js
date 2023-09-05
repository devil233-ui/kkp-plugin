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
                priority: '770',
                rule: [
                    {
                        reg: '^#?磁力搜(.*)$',
                        fnc: 'processMagnetLink'
                    },
                ]
            }
        )
    }

    async processMagnetLink(e) {
    let match = e.msg.match(/^#?磁力搜\s*(\S+)?$/);
    if (!match) {
        return;
    }

    const userInput = match[1];

    const url = `https://www.cll47.top/main-search-kw-${encodeURIComponent(userInput)}-1.html`;

    const browser = await puppeteer.launch({
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    try {
        const page = await browser.newPage();
        await page.goto(url, { waitUntil: 'load', timeout: 7000 });
        await page.waitForTimeout(2000);

        const titleElements = await page.$$eval('.item-title > h3', titles => titles.map(title => title.innerText));
        const magnetLinks = await page.$$eval('.item-bar > span > a[href^="magnet:"]', links => links.map(link => link.href));
        const addedTimes = await page.$$eval('.item-bar > span:contains("创建时间")', spans => spans.map(span => span.innerText.split('：')[1]));
        const sizes = await page.$$eval('.item-bar > span > b.cpill.yellow-pill', sizes => sizes.map(size => size.innerText));
        const heats = await page.$$eval('.item-bar > span:contains("热度")', spans => spans.map(span => span.innerText.split('：')[1]));

        let results = [];
        for (let i = 0; i < titleElements.length; i++) {
            results.push({
                user_id: e.user_id,
                nickname: e.user_id.toString(),
                message: `${titleElements[i]}\n\n${magnetLinks[i]}\n\n创建时间：${addedTimes[i]}\n文件大小：${sizes[i]}\n热度：${heats[i]}`
            });
        }
        
        const forwardMsg = await e.group.makeForwardMsg(results);
        const sentMessage = await this.reply(forwardMsg);
        setTimeout(() => {
            e.group.recallMsg(sentMessage.message_id);
        }, 100000);
        await browser.close();
    }
    catch (error) {
        console.log(`在URL ${url} 上出现错误：${error.toString()}`);
        await browser.close();
    }
}
