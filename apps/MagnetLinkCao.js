import plugin from "../../../lib/plugins/plugin.js";
import puppeteer from "puppeteer";
import axios from "axios";

const PUPPETEER_CONFIG = {
    args: [ "--no-sandbox", "--disable-setuid-sandbox" ],
};

const DEFAULT_HEADERS = {
    "Accept": "*/*",
    "Accept-Encoding": "gzip, deflate",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8,en-GB;q=0.7,en-US;q=0.6",
    "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
    "Host": "www.cilicao.com", 
    "Origin": "https://www.cilicao.com",
    "Referer": "https://www.cilicao.com/list.php", 
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Edg/124.0.0.0",
    "X-Requested-With": "XMLHttpRequest"
};

export class MagnetLink extends plugin {
    constructor() {
        super({
            name: "磁力草搜索",
            dsc: "磁力草搜索",
            event: "message",
            priority: "40",
            rule: [
{
                reg: "^#?磁力草(.*)$",
                fnc: "MagnetLinkcao"
            }
]
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
                case "热度":
                    orderParam = "&order=fangwen";
                    break;
                case "大小":
                    orderParam = "&order=length";
                    break;
            }
        }
        const url = `https://www.cilicao.cc/list.php?name=${encodeURIComponent(userInput)}&page=1${orderParam}`;

        const browser = await puppeteer.launch(PUPPETEER_CONFIG);
        const page = await browser.newPage();

        try {
            await page.goto(url, { waitUntil: "load", timeout: 7000 });
            const searchResults = await page.$$("li");

            if (!searchResults.length) {
                await this.reply("未找到磁力链接");
                await browser.close();
                return;
            }

            const results = [];

            for (let element of searchResults) {
                try {
                    const magnetA = await element.$("a[onclick]");
                    if (!magnetA) continue;

                    const onclickData = await magnetA.evaluate(a => a.getAttribute("onclick"));
                    const match = onclickData.match(/xiangqing\('(\d)','(\w{64})'\)/);

                    if (!match) continue;

                    const sjk = match[1];
                    const hash = match[2];
                    const response = await axios.post("https://www.cilicao.cc/ajax2.php", {
                        typenum: 4,
                        md5hash: hash,
                        sjk: sjk
                    }, {
                        headers: DEFAULT_HEADERS
                    });

                    if (response.data.code !== 1) {
                        continue;
                    }

                    const trueMagnetLink = `magnet:?xt=urn:btih:${response.data.info_hash}`;
                    const title = await element.$eval("h1.wdc_dis", el => el.innerText.trim());
                    const details = await element.$eval("h2.wdc_dis", el => el.innerText.replace(/\|/g, "\n").trim());
                    const message = `${title}\n${details}\n\n${trueMagnetLink}`;
                    results.push({ user_id: e.user_id, nickname: e.user_id, message });
                } catch (error) {
                    console.error(`Error when processing a single li element: ${error.toString()}`);
                }
            }

            if (results.length === 0) {
                await this.reply("未找到有效的磁力链接");
            } else {
                const forwardMsg = await e.group.makeForwardMsg(results);
                const sentMessage = await e.reply(forwardMsg);
            }

        } catch (error) {
            console.error(`在URL ${url} 上出现错误：${error.toString()}`);
            await this.reply(`在URL ${url} 上出现错误：${error.toString()}`);
        } finally {
            await browser.close();
        }
    }
}