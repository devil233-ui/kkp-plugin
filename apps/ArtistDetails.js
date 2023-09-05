import plugin from '../../../lib/plugins/plugin.js';
import axios from 'axios';
import fs from 'fs';
import YAML from 'yaml';
import { user } from '../config/api.js';

export class ArtistDetails extends plugin {
    constructor() {
        super({
            name: 'pixiv推送',
            dsc: 'pixiv推送',
            event: 'message',
            priority: '50'
        });
    }

    getArtistIdsAndNames() {
        const path = './plugins/kkp-plugin/config/Artist.yaml';

        if (!fs.existsSync(path)) {
            return {};
        }

        const fileContents = fs.readFileSync(path, 'utf8');
        return YAML.parse(fileContents).artists || {};
    }

    async fetchArtistDetails(artistId) {
        try {
            const response = await axios.get(user(artistId));
            return response.data;
        } catch (error) {
            console.error(`Error fetching artist details: ${error.message}`);
            return null;
        }
    }

    async processArtist() {
        const artists = this.getArtistIdsAndNames();

        if (!Object.keys(artists).length) {
            console.error('未添加画师id');
            return;
        }

        let noNewWorks = []; // 用于保存没有新作品的画师
        let firstTimeArtists = []; // 用于保存首次保存的画师

        for (const artistId in artists) {
            const artistData = await this.fetchArtistDetails(artistId);

            if (!artistData || !artistData.body || !artistData.body.illusts) {
                console.error(`无法获取画师${artistId}的详情`);
                continue; // move to the next artistId
            }

            const oldDataRaw = await redis.get(`artistDetails_${artistId}`);
            const oldData = oldDataRaw ? JSON.parse(oldDataRaw) : null;

            if (!oldData) {
                // 首次保存此画师数据
                firstTimeArtists.push(artists[artistId]);
                await redis.set(`artistDetails_${artistId}`, JSON.stringify(artistData));
                continue; 
            }

            const newWorks = Object.keys(artistData.body.illusts).filter(id => !oldData.body.illusts.hasOwnProperty(id));

            if (newWorks.length > 0) {
                console.log(`画师${artists[artistId]}（${artistId}）的新的作品ID: ${newWorks.join(', ')}`);
            } else {
                noNewWorks.push(artists[artistId]);
            }

            await redis.set(`artistDetails_${artistId}`, JSON.stringify(artistData));
        }

        // 如果有画师没有新作品，打印消息
        if (noNewWorks.length > 0) {
            console.log(`画师${noNewWorks.join('、')}暂无新作品`);
        }

        // 如果有首次保存的画师，打印消息
        if (firstTimeArtists.length > 0) {
            console.log(`已保存画师${firstTimeArtists.join('、')}数据`);
        }
    }
}
