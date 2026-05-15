import sharp from "sharp";

export async function FlipImage(buffer) {
    try {
        // sharp 中 flip() 是竖直翻转（上下颠倒）
        // flop() 才是水平翻转（左右镜像），千万别用错
        return await sharp(buffer).flip().toBuffer();
    } catch (error) {
        return null;
    }
}