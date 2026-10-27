如果你使用的是icqq+miao-yunzai，更推荐用[icqq版](https://gitee.com/dungeonmaster/kkp-plugin-icqq)（极大减少冻结封号概率）

安装
```
git clone https://github.com/devil233-ui/kkp-plugin.git ./plugins/kkp-plugin/
```
安装依赖
```
pnpm add axios -w
```

图片直发体积上限可在`config/config.yaml`中调整，单位为MiB，未配置时默认20：

```yaml
max_image_size_mb: 20
```

超过上限的图片会直接按文件发送；未超过上限但被QQ富媒体接口明确拒绝时，也会自动降级为文件。

为了防止风控，所以得安装python来处理图片

安装python依赖
```
pip install -i https://pypi.tuna.tsinghua.edu.cn/simple pillow
```
doker内安装（trss安装的崽）
```
docker exec -it TRSS_AllBot /bin/bash
```
```
pacman -S python-pillow
```

## 动图（ugoira）渲染

插件把 pixiv 动图转成 GIF 的渲染服务已内置在本插件目录：`ugoira_server.mjs`（零第三方依赖，只需系统有 `ffmpeg` 和 `unzip`），默认监听 `127.0.0.1:3008`，与 `config/config.yaml` 里的 `ugoira_api` 对应。

用 pm2 守护启动：

```
pm2 start ./plugins/kkp-plugin/ugoira_server.mjs --name ugoira-local
pm2 save
```

- 渲染串行执行（同一时间只处理一张动图），超时上限 60 秒
- 只监听回环地址 127.0.0.1，不暴露公网
- 固定 540px 全帧率渲染，不做压缩降级；超过 `max_image_size_mb` 上限时插件会自动转成文件发送
- 如果你想用别的渲染服务，把 `ugoira_api` 改成对应地址即可，接口协议为 `POST {pid, access_token}` → `{status:"success", data:<base64 gif>}`

## ✨ 功能    欢迎加群1030860570
![输入图片说明](https://foruda.gitee.com/images/1717359187534988738/93d70d05_11990909.png "屏幕截图")
