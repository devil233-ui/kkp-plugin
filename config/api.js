const magnetURL = (matchedMagnet) => `https:${String.fromCharCode(47)}${String.fromCharCode(47)}whatslink${String.fromCharCode(46)}info${String.fromCharCode(47)}api${String.fromCharCode(47)}v1${String.fromCharCode(47)}link?url=${encodeURIComponent(matchedMagnet)}`; 

const pid = (pid) => `https://pid.kkndp.cn/pixiv?pid=${pid}`;
const dingyue = () => `https://user.kkndp.cn`;
const user = (artistId) => `https://pid.kkndp.cn/user?user=${artistId}`;
const tag = (tagValue) => `https://pid.kkndp.cn/tag?tag=${encodeURIComponent(tagValue)}`;


export { pid, user, magnetURL, tag, dingyue }; 