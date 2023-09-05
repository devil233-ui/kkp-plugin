import plugin from '../../../lib/plugins/plugin.js';
import axios from 'axios';
import fs from 'fs';
import YAML from 'yaml';
import path from 'path';
import { user } from '../config/api.js';

export class ArtistSubscription extends plugin {
    constructor() {
        super({
            name: '订阅画师',
            dsc: '订阅画师',
            event: 'message',
            priority: '500',
            rule: [
                {
                    reg: '^#订阅画师(\\d+)$',
                    fnc: 'subscribeArtist'
                },
                {
                    reg: '^#取消订阅(\\d+)$',
                    fnc: 'unsubscribeArtist'
                },
                {
                    reg: '^#订阅列表$',
                    fnc: 'listSubscribedArtists'
                }
            ]
        });
    }

    ensureDirectoryExistence(filePath) {
        const dirname = path.dirname(filePath);
        if (!fs.existsSync(dirname)) {
            this.ensureDirectoryExistence(dirname);
            fs.mkdirSync(dirname);
        }
    }

    loadArtists() {
        const filePath = './plugins/kkp-plugin/config/Artist.yaml';

        if (!fs.existsSync(filePath)) {
            return {};
        }

        const fileContents = fs.readFileSync(filePath, 'utf8');
        return YAML.parse(fileContents).artists || {};
    }

    saveArtists(artists) {
        const filePath = './plugins/kkp-plugin/config/Artist.yaml';
        this.ensureDirectoryExistence(filePath);

        const yamlContent = YAML.stringify({ artists });
        fs.writeFileSync(filePath, yamlContent, 'utf8');
    }

    async subscribeArtist(e) {
        if (!e.isGroup) return;  

        const msg = e.msg.trim();
        const matches = msg.match(/^#订阅画师(\d+)$/);
        const artistId = matches ? matches[1] : null;

        if (!artistId) return;

        let artistName;
        try {
            const response = await axios.get(user(artistId));
            if (response.data.error) {
                await e.reply("该画师id不存在");
                return;
            }
            artistName = response.data.body.pickup[0]?.userName;
        } catch (err) {
            if (err.response && err.response.status === 403) {
                await e.reply("暂无权使用");
                return;
            }
            await e.reply("检查画师ID时发生错误，请稍后重试");
            return;
        }

        const artists = this.loadArtists();

        if (artists[artistId]) {
            await e.reply(`已经订阅了${artistId}`);
            return;
        }

        artists[artistId] = artistName;
        this.saveArtists(artists);

        await e.reply(`成功订阅画师${artistId}（${artistName}）`);
    }

    async unsubscribeArtist(e) {
        if (!e.isGroup) return;  

        const msg = e.msg.trim();
        const matches = msg.match(/^#取消订阅(\\d+)$/);
        const artistId = matches ? matches[1] : null;
        if (!artistId) return;

        const artists = this.loadArtists();

        if (!artists[artistId]) {
            await e.reply(`还未订阅${artistId}哦`);
            return;
        }

        delete artists[artistId];
        this.saveArtists(artists);

        await e.reply(`成功取消订阅${artistId}`);
    }

    async listSubscribedArtists(e) {
        if (!e.isGroup) return;  

        const artists = this.loadArtists();

        if (Object.keys(artists).length === 0) {
            await e.reply("当前没有订阅任何画师");
            return;
        }

        let response = "订阅列表：\n";
        for (const [artistId, artistName] of Object.entries(artists)) {
            response += `${artistName}  ${artistId}\n`;
        }

        await e.reply(response);
    }
}
