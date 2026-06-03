from flask import Flask, request, jsonify
import requests
import zipfile
import io
import base64
from PIL import Image

app = Flask(__name__)

@app.route('/ugoira', methods=['POST'])
def handle_ugoira():
    try:
        # 1. 直接接收传来的 pid 和鉴权完毕的 access_token
        req_data = request.get_json(force=True)
        pid = req_data.get("pid")
        access_token = req_data.get("access_token")

        if not pid or not access_token:
            return jsonify({"error": "Missing pid or access_token"}), 400

        print(f"INFO: Start rendering PID: {pid} using provided token...")

        # 2. 拿着现成的 Token，直接调用 App 端 API 获取动图元数据
        api_url = f"https://app-api.pixiv.net/v1/ugoira/metadata?illust_id={pid}"
        app_headers = {
            "Authorization": f"Bearer {access_token}",
            "User-Agent": "PixivAndroidApp/5.0.234 (Android 11; Pixel 5)"
        }
        meta_res = requests.get(api_url, headers=app_headers, timeout=10).json()

        if "ugoira_metadata" not in meta_res:
            return jsonify({"error": "Ugoira meta not found or R-18 restricted"}), 404

        frames_info = meta_res["ugoira_metadata"]["frames"]
        
        # 3. 放弃瞎猜，直接使用原生的 medium 压缩包（兼顾预览清晰度与 1c1g 服务器的渲染速度）
        zip_url = meta_res["ugoira_metadata"]["zip_urls"]["medium"]

        # 4. 伪装 App 环境拉取 ZIP，防止被 Pixiv CDN 拦截 (补全 User-Agent)
        dl_headers = {
            "Referer": "https://app-api.pixiv.net/",
            "User-Agent": "PixivAndroidApp/5.0.234 (Android 11; Pixel 5)"
        }
        zip_res = requests.get(zip_url, headers=dl_headers, timeout=15)
        
        if zip_res.status_code != 200:
            print(f"ERROR: Pixiv CDN Denied. HTTP {zip_res.status_code} for URL: {zip_url}")
            return jsonify({"error": f"Failed to download ZIP: HTTP {zip_res.status_code}"}), 502
            
        zip_data = zipfile.ZipFile(io.BytesIO(zip_res.content))

        frames = []
        durations = []
        for frame in frames_info:
            with zip_data.open(frame["file"]) as f:
                img = Image.open(f).convert("RGBA")
                frames.append(img)
            durations.append(frame["delay"])

        out_io = io.BytesIO()
        frames[0].save(
            out_io, format="GIF", save_all=True,
            append_images=frames[1:], duration=durations, loop=0
        )

        # 5. Base64 吐回
        gif_base64 = base64.b64encode(out_io.getvalue()).decode("utf-8")
        return jsonify({"status": "success", "data": gif_base64})

    except Exception as e:
        print(f"ERROR during processing: {str(e)}")
        return jsonify({"error": str(e)}), 500

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=3008)