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
            `https://lngcqpst.8800481.xyz/search-${userInput}-${fileType}-${orderType}-1.html`,
            `https://dokljqwm.8800483.xyz/search-${userInput}-${fileType}-${orderType}-1.html`,
            `https://dheflfyw.8800485.xyz/search-${userInput}-${fileType}-${orderType}-1.html`
        ];

        const browser = await puppeteer.launch({ 
            args: ['--no-sandbox', '--disable-setuid-sandbox'],
            headless: 'new'
        });
        let page;

        for (let i = 0; i < urls.length; i++) {
            try {
                page = await browser.newPage();
                // 设置用户代理
                await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36 Edg/138.0.0.0');
                
                await page.goto(urls[i], { 
                    waitUntil: 'networkidle2', 
                    timeout: 15000 
                });
                
                // 等待结果容器出现
                await page.waitForSelector('.ssbox', { timeout: 10000 }).catch(() => {
                    console.log('结果容器未找到，可能无结果');
                    return null;
                });

                // 获取所有结果项
                const resultItems = await page.$$('.ssbox');
                if (resultItems.length === 0) {
                    await this.reply('未找到搜索结果，尝试下个链接');
                    await page.close();
                    continue;
                }

                const results = [];
                for (let j = 0; j < Math.min(resultCount, resultItems.length); j++) {
                    const item = resultItems[j];
                    
                    // 提取标题 (移除分类标签)
                    const title = await item.$eval('h3 a', el => {
                        return el.textContent.replace(/^\[[^\]]+\]\s*/, '').trim();
                    });
                    
                    // 提取磁力链接
                    const magnetLink = await item.$eval('.sbar a[href^="magnet:"]', el => el.href);
                    
                    // 提取元数据
                    const addedTime = await item.$eval('.sbar span:nth-child(2) b', el => el.textContent);
                    const size = await item.$eval('.sbar span:nth-child(3) b', el => el.textContent);
                    const recentDownload = await item.$eval('.sbar span:nth-child(4) b', el => el.textContent);
                    const heat = await item.$eval('.sbar span:nth-child(5) b', el => el.textContent);
                    
                    results.push({ 
                        user_id: e.user_id, 
                        nickname: e.user_id, 
                        message: `${title}\n\n${magnetLink}\n\n添加时间：${addedTime}\n大小：${size}\n最近下载：${recentDownload}\n热度：${heat}` 
                    });
                }

                const forwardMsg = await e.group.makeForwardMsg(results);
                await this.reply(forwardMsg);
                await browser.close();
                return;
                
            } catch (error) {
                console.log(`在URL ${urls[i]} 上出现错误：${error.toString()}`);
                if (page && !page.isClosed()) {
                    await page.close();
                }
            }
        }
        
        await this.reply('未找到搜索结果');
        if (browser) {
            await browser.close();
        }
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