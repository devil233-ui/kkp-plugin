import fs from "node:fs"
import plugin from "../../lib/plugins/plugin.js"

const files = fs.readdirSync("./plugins/kkp-plugin/apps").filter(file => file.endsWith(".js"))

let ret = []

logger.info("--------PPPPPPPPPPPPPPPPPP-------------");
logger.info("--------PPPPPPPPPPPPPPPPPP-------------");
logger.info("--------PPPPPPPPPPPPPPPPPP-------------");

files.forEach((file) => {
  ret.push(import(`./apps/${file}`))
})

ret = await Promise.allSettled(ret)

let apps = {}
for (let i in files) {
  let name = files[i].replace(".js", "")

  if (ret[i].status != "fulfilled") {
    logger.error(`载入插件错误：${logger.red(name)}`)
    logger.error(ret[i].reason)
    continue
  }
  const App = Object.values(ret[i].value).find(
    exported => typeof exported === "function" && exported.prototype instanceof plugin
  )

  if (!App) {
    logger.debug?.("跳过辅助模块：" + name)
    continue
  }

  apps[name] = App
}
export { apps }