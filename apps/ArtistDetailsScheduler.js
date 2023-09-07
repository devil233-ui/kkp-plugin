import plugin from '../../../lib/plugins/plugin.js';
import fs from 'fs';
import YAML from 'yaml';
import schedule from "node-schedule";
import { ArtistDetails } from './ArtistDetails.js';

export class ArtistDetailsScheduler extends plugin {
    constructor() {
        super({
            name: 'p站推送',
            dsc: 'p站推送',
            event: 'message.group',
            priority: 50,
            rule: [
                {
                    reg: '^#开启p推送$',
                    fnc: 'enablePush'
                },
                {
                    reg: '^#关闭p推送$',
                    fnc: 'disablePush'
                }
            ]
        });

        // 定时任务，每4小时执行一次
        schedule.scheduleJob('0 */4 * * *', async () => {
            const groupIds = this.getGroupIds();
            if (groupIds.length === 0) return;

            const artistDetails = new ArtistDetails();
            await artistDetails.processArtist();
        });
    }

    getGroupIds() {
        const path = './plugins/kkp-plugin/config/group.yaml';
        if (!fs.existsSync(path)) return [];
        
        const fileContents = fs.readFileSync(path, 'utf8');
        return YAML.parse(fileContents).groups || [];
    }

    saveGroupIds(groupIds) {
        const path = './plugins/kkp-plugin/config/group.yaml';
        const yamlString = YAML.stringify({ groups: groupIds });
        fs.writeFileSync(path, yamlString, 'utf8');
    }

    async enablePush(e) {
        const groupId = e.group_id;

        let groupIds = this.getGroupIds();
        if (!groupIds.includes(groupId)) {
            groupIds.push(groupId);
            this.saveGroupIds(groupIds);
            await e.reply('已开启p推送。');
        } else {
            await e.reply('已经开启了p推送。');
        }
    }

    async disablePush(e) {
        const groupId = e.group_id;

        let groupIds = this.getGroupIds();
        if (groupIds.includes(groupId)) {
            groupIds = groupIds.filter(id => id !== groupId);
            this.saveGroupIds(groupIds);
            await e.reply('已关闭p推送。');
        } else {
            await e.reply('尚未开启p推送，无需关闭。');
        }
    }
}
