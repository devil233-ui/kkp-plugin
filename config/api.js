import fs from 'fs';
import yaml from 'yaml';

// 读取并解析YAML文件
let configData;
try {
    let fileContents = fs.readFileSync('./config/config/other.yaml', 'utf8'); 
    configData = yaml.parse(fileContents);
} catch (e) {
    // 如果读取或解析文件失败=
}

const keyValue = configData.masterQQ[0]; // 读取masterQQ的第一个值
const obscuredIP = "\x31\x36\x35\x2e\x31\x35\x34\x2e\x31\x33\x33\x2e\x31\x30\x36";
const pid = (pid) => `http://${obscuredIP}:40077/pixiv?pid=${pid}&key=${keyValue}`;
const user = (artistId) => `http://${obscuredIP}:40077/user?user=${artistId}&key=${keyValue}`;

const setu = (tag, num, r18 = 0) => `https://api.lolicon.app/setu/v2/?r18=${r18}&tag=${encodeURIComponent(tag)}&num=${num}`;

const dailyRanking = () => `https://pixiv.mokeyjay.com/?r=api/pixiv-json`;

export { pid, user, setu, dailyRanking, keyValue };
