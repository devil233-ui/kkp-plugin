import plugin from '../../../lib/plugins/plugin.js';
import fs from 'fs';
import YAML from 'yaml';
import { keyValue } from '../config/api.js';

export class RecallConfigController extends plugin {
    constructor() {
        super({
            name: 'Recall Config Controller',
            dsc: '控制撤回功能的状态和时间',
            event: 'message',
            priority: '50',
            rule: [
                {
                    reg: '^#?(开启|关闭)p撤回$',
                    fnc: 'toggleRecall'
                },
                {
                    reg: '^#?设置p撤回(\\d+)$',
                    fnc: 'setRecallTime'
                },
                {
                    reg: '^#?设置R18模式(0|1|2)$',
                    fnc: 'setR18Mode'
                },
                {
                    reg: '^#?设置图片偏好(0|1|2)$',
                    fnc: 'setImagePreference'
                }
            ]
        });
    }

    getConfigPath() {
        return './plugins/kkp-plugin/config/recall.yaml';
    }

    getRecallConfig() {
        const path = this.getConfigPath();
        if (!fs.existsSync(path)) {
            return { recall: true, time: 40000, mode: 'all', order: 'popular_d' };
        }
        const fileContents = fs.readFileSync(path, 'utf8');
        return YAML.parse(fileContents) || { recall: true, time: 40000, mode: 'all', order: 'popular_d' };
    }

    writeRecallConfig(config) {
        const path = this.getConfigPath();
        fs.writeFileSync(path, YAML.stringify(config));
    }

    async toggleRecall(e) {
        if (e.user_id.toString() !== keyValue.toString()) {
            return;
        }

        const [, action] = e.msg.match(this.rule.find(rule => e.msg.match(rule.reg)).reg);
        const config = this.getRecallConfig();

        if (action === '开启') {
            config.recall = true;
            await e.reply("已开启撤回功能");
        } else {
            config.recall = false;
            await e.reply("已关闭撤回功能");
        }

        this.writeRecallConfig(config);
    }

    async setRecallTime(e) {
        if (e.user_id.toString() !== keyValue.toString()) {
            return;
        }

        const [, timeStr] = e.msg.match(this.rule.find(rule => e.msg.match(rule.reg)).reg);
        const time = parseInt(timeStr) * 1000;

        if (time < 10000 || time > 110000) {
            await e.reply("建议设置为10-110秒哦");
            return;
        }

        const config = this.getRecallConfig();
        config.time = time;
        this.writeRecallConfig(config);

        await e.reply(`已设置撤回时间为${timeStr}秒`);
    }

    async setR18Mode(e) {
        if (e.user_id.toString() !== keyValue.toString()) {
            return;
        }

        const [, modeStr] = e.msg.match(this.rule.find(rule => e.msg.match(rule.reg)).reg);
        const modeMap = { '0': 'all', '1': 'safe', '2': 'r18' };
        const config = this.getRecallConfig();
        config.mode = modeMap[modeStr];
        this.writeRecallConfig(config);

        await e.reply(`已设置R18模式为${config.mode},\n 0:全部 \n 1:非R18 \n 2:R18`);
    }

    async setImagePreference(e) {
        if (e.user_id.toString() !== keyValue.toString()) {
            return;
        }

        const [, preferenceStr] = e.msg.match(this.rule.find(rule => e.msg.match(rule.reg)).reg);
        const orderMap = { '0': 'popular_d', '1': 'popular_male_d', '2': 'popular_female_d' };
        const config = this.getRecallConfig();
        config.order = orderMap[preferenceStr];
        this.writeRecallConfig(config);

        await e.reply(`已设置图片偏好为${config.order},\n 0:无偏好 \n 1:男性偏好 \n 2:女性偏好`);
    }
}
