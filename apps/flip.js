import sharp from "sharp";

export async function FlipImage(buffer) {
    try {
        // flop() 是 sharp 的水平翻转方法（左右镜像）
        return await sharp(buffer).flop().toBuffer();
    } catch (error) {
        console.error("[kkp-plugin] 图片翻转失败:", error);
        return null;
    }
}