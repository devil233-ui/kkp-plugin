import plugin from '../../../lib/plugins/plugin.js';
import puppeteer from 'puppeteer';

export class MagnetLink extends plugin {
    constructor() {
        super({
            name: '磁力草搜索',
            dsc: '磁力草搜索',
            event: 'message',
            priority: '400',
            rule: [{
                reg: '^#?磁力草(.*)$',
                fnc: 'MagnetLinkcao'
            }]
        });
    }

    async MagnetLinkcao(e) {
        if (!e.isGroup) return;
        const match = e.msg.match(/^#?磁力草\s*(\S+)(?:\s+(\S+))?$/);
        if (!match) {
            return;
        }

        const userInput = match[1];
        const sortOrder = match[2];

        let orderParam = "";
        if (sortOrder) {
            switch (sortOrder) {
                case '热度':
                    orderParam = "&order=fangwen";
                    break;
                case '大小':
                    orderParam = "&order=length";
                    break;
            }
        }
        const url = `http://124.220.69.229:3535/list.php/?name=${encodeURIComponent(userInput)}&page=1${orderParam}`;

        const browser = await puppeteer.launch();
        const page = await browser.newPage();

        try {
            await page.goto(url, { waitUntil: 'load', timeout: 7000 });

            const searchResults = await page.$$('li');
            if (!searchResults.length) {
                await this.reply('未找到磁力链接');
                await browser.close();
                return;
            }

            const results = [];
            for (let element of searchResults) {
                const magnetA = await element.$('a[onclick]');
                if (!magnetA) {
                    continue;
                }

                try {
                    const onclickData = await magnetA.evaluate(a => a.getAttribute('onclick'));

                    const match = onclickData.match(/'(\w{64})'/);
                    if (!match) {
                        continue;
                    }
                    const magnetHash = match[1];
                    
                    if (magnetHash === '9999999999999999999999999999999999999999999999999999999999999999') {
                        continue;
                    }

                    const magnetLink = `\n\nmagnet:?xt=urn:btih:${magnetHash}`;

                    const title = await element.$eval('h1.wdc_dis', el => el.innerText.trim());
                    const details = await element.$eval('h2.wdc_dis', el => el.innerText.replace(/\|/g, '\n').trim());

                    const message = `${title}\n${details}\n${magnetLink}`;
                    results.push({ user_id: e.user_id, nickname: e.user_id, message });

                } catch (error) {
                    console.error(`Error when processing an li element: ${error.toString()}`);
                }
            }

            const forwardMsg = await e.group.makeForwardMsg(results);
            await this.reply(forwardMsg);
        } catch (error) {
            console.error(`在URL ${url} 上出现错误：${error.toString()}`);
            await this.reply(`在URL ${url} 上出现错误：${error.toString()}`);
        } finally {
            await browser.close();
        }
    }
}
