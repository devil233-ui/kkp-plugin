import plugin from '../../../lib/plugins/plugin.js';

const _path = process.cwd();

export class kkp extends plugin {
    constructor() {
        super({
            name: 'KKP帮助',
            dsc: 'KKP帮助',
            event: 'message',
            priority: '50',
            rule: [
                {
                    reg: '^#?kkp帮助$',
                    fnc: 'sendKKPImage',
                }
            ]
        });
    }

    async sendKKPImage() {
        const imagePath = _path + '/plugins/kkp-plugin/config/kkp.jpg';
		let msg = [
			segment.image(`file://${imagePath}`),
		];
        this.e.reply(msg);
        return true;
    }
}
