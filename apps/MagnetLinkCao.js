import plugin from '../../../lib/plugins/plugin.js';
import puppeteer from 'puppeteer';
import axios from 'axios';

export class MagnetLink extends plugin {
    constructor() {
        super({
            name: '磁力草搜索',
            dsc: '磁力草搜索',
            event: 'message',
            priority: '40',
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
        const browser = await puppeteer.launch({
			args: ['--no-sandbox', '--disable-setuid-sandbox']
		});

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
                try {
                    const magnetA = await element.$('a[onclick]');
                    if (!magnetA) continue;

                    const onclickData = await magnetA.evaluate(a => a.getAttribute('onclick'));
                    const match = onclickData.match(/xiangqing\('(\d)','(\w{64})'\)/);

                    if (!match || match[2] === '9999999999999999999999999999999999999999999999999999999999999999') {
                        continue;
                    }

                    const sjk = match[1];
                    const hash = match[2];
                    const response = await axios.post('http://124.220.69.229:3535/ajax.php', {
                        typenum: 4,
                        md5hash: hash,
                        sjk: sjk
                    }, {
                        headers: {
                            'Accept': '*/*',
                            'Accept-Encoding': 'gzip, deflate',
                            'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8,en-GB;q=0.7,en-US;q=0.6',
                            'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
                            'Host': '124.220.69.229:3535',
                            'Origin': 'http://124.220.69.229:3535',
                            'Proxy-Connection': 'keep-alive',
                            'Referer': url,
                            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Safari/537.36 Edg/116.0.1938.81',
                            'X-Requested-With': 'XMLHttpRequest'
                        }
                    });

                    if (response.data.code !== 1) {
                        continue;
                    }

                    const trueMagnetLink = `magnet:?xt=urn:btih:${response.data.info_hash}`;
                    const title = await element.$eval('h1.wdc_dis', el => el.innerText.trim());
                    const details = await element.$eval('h2.wdc_dis', el => el.innerText.replace(/\|/g, '\n').trim());
                    const message = `${title}\n${details}\n\n${trueMagnetLink}`;
                    results.push({ user_id: e.user_id, nickname: e.user_id, message });
                } catch (error) {
                    console.error(`Error when processing a single li element: ${error.toString()}`);
                }
            }

            if (results.length === 0) {
                await this.reply('未找到有效的磁力链接');
            } else {
                const forwardMsg = await e.group.makeForwardMsg(results);
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

					const sentMessage = await e.reply(forwardMsg);
					
				}
			}
            }

        } catch (error) {
            console.error(`在URL ${url} 上出现错误：${error.toString()}`);
            await this.reply(`在URL ${url} 上出现错误：${error.toString()}`);
        } finally {
            await browser.close();
        }
    }
}
