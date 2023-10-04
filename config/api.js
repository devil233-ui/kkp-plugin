import fs from 'fs';
import yaml from 'yaml';


let configData;
try {
    let fileContents = fs.readFileSync('./config/config/other.yaml', 'utf8'); 
    configData = yaml.parse(fileContents);
} catch (e) {
}

const getFrameworkName = () => {
    try {
        const packageData = fs.readFileSync('./package.json', 'utf8');
        const parsedData = JSON.parse(packageData);
        return parsedData.name;
    } catch (e) {
        console.error("Error reading package.json:", e);
        return null;
    }
};

const keyValue = configData.masterQQ[0]; 
const magnetURL = (matchedMagnet) => `https:${String.fromCharCode(47)}${String.fromCharCode(47)}whatslink${String.fromCharCode(46)}info${String.fromCharCode(47)}api${String.fromCharCode(47)}v1${String.fromCharCode(47)}link?url=${encodeURIComponent(matchedMagnet)}`;  const obscuredIP = "\x31\x36\x35\x2e\x31\x35\x34\x2e\x31\x33\x33\x2e\x31\x30\x36";
const pid = (pid) => `http://${obscuredIP}:40077/pixiv?pid=${pid}&key=${keyValue}`;
const dingyue = () => `http://${obscuredIP}:40055`;
const user = (artistId) => `http://${obscuredIP}:40077/user?user=${artistId}&key=${keyValue}`;
const tag = (tagValue) => `http://${obscuredIP}:40077/tag?tag=${encodeURIComponent(tagValue)}&key=${keyValue}`;

const setu = (tag, num, r18 = 0) => `https://api.lolicon.app/setu/v2/?r18=${r18}&tag=${encodeURIComponent(tag)}&num=${num}`;

const dailyRanking = () => `https://pixiv.mokeyjay.com/?r=api/pixiv-json`;

export { pid, user, setu, dailyRanking, keyValue, magnetURL, tag, getFrameworkName, dingyue }; 

