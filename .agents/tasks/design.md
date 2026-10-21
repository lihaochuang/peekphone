# PeekPhone（截图问AI）桌面 App — 技术设计

> 目标仓库：`/Users/harry/诺亚方舟/任务档案/20261021_PeekPhone桌面App`（已 git init，无 remote）
> 原型来源：`/Users/harry/诺亚方舟/任务档案/20261021_截图问AI`（Python，已实测跑通，移植参照）
> 本文档是实现期唯一蓝本，技术栈锁定，架构决策已定，不把任何未决选择留给 coder。

## 1. 概览

PeekPhone 是一个跨平台（macOS / Windows）Electron 桌面 App。核心链路：用户按全局快捷键 → App 静默全屏截图 → 压成长边 1200 的 JPEG → 用用户自己配置的多模态大模型按选定提示词分析 → 把结果推到本机局域网 HTTP 服务，手机扫码或输本地 URL 在浏览器里看"最新一条"分析，页面每 2 秒轮询自动刷新。

它把 Python 原型（`peek.py` + `llm.py` + `serve.py` + `prompts/`）重写成一个常驻的 Electron 托盘 App：原来靠「快捷指令 / Automator 绑键 + 手动起 serve.py」的那套外部编排，全部收进 App 自身。App 启动即起本地服务、注册全局快捷键、常驻托盘，不再依赖系统快捷指令沙盒（用户之前截图失败的根因就是快捷指令沙盒 + 终端未授屏幕录制；原生 App 自己持有屏幕录制权限后可稳定截图）。

目标是开源到 GitHub：别人下载 installer → 在设置里填自己的模型 key → 扫码连手机即可用。因此设计里**绝不内置任何模型 key、不内置钉钉、不内置用户的 KiroAdmin 反代**；默认配置全部留空占位。

产品边界上，钉钉推送通道整条废弃（原型里一直被 40096 凭证问题卡住，用户已明确"直接忽略，手机页面够用"）；隐身 / 活动监视器隐藏 / 录屏不可见 / 点击穿透这类反检测方向，用户明确否决，不做。

**产品定位（回应 index-3「GitHub 查重、别做重复」与 index-4 对 InterviewCoder 的对比）**：PeekPhone = **本地局域网 + 自带模型 key + 无隐身**的个人截图分析助手。它与 GitHub 上一类「截图问 AI」项目的差异点、也是故意的收敛：(1) 结果走**本机局域网 HTTP + token**推到手机浏览器看，不做云中转/账号体系；(2) 不内置任何 key，用户填自己的多模态模型；(3) **明确不做隐身/反检测**——index-4 提到的 InterviewCoder 那套"活动监视器不可见、录屏不可见、点击穿透"正是本产品划清界线、坚决不做的方向（既是安全/合规考量，也是和那类"面试作弊器"的本质区分）。这一定位结论写进 README「与同类项目的差异」小节，作为开源后的产品说明；它不改变任何技术契约，纯为落地定位，不阻塞编码。

**与原型的关系一句话**：业务逻辑（多 provider 调用 + 重试、两种请求格式、长边 1200 JPEG 压缩、只显示最新一条 + 2 秒轮询 + 三态 + token 鉴权 + 防穿越的手机页面）逐一照搬；承载方式从"脚本 + 外部编排 + 钉钉"换成"Electron 常驻 App + 托盘 + 设置 UI"。


## 2. 技术栈（锁定，不得更改）

| 关注点 | 选型 | 说明 |
|---|---|---|
| 运行时 / 框架 | Electron | 本机 Node v24.17.0、npm 11.13 就绪。**不引入 Rust / Tauri。** |
| Electron 版本 | `electron@^33`（最新稳定大版本，内置 Node 20 级 API + Chromium 130+） | 锁 `^33`，实现期用 `npm i -D electron@33` 落实际小版本到 lockfile |
| 全局快捷键 | Electron `globalShortcut` | 默认 `CommandOrControl+Alt+P`（mac 显示 ⌘⌥P / win Ctrl+Alt+P），设置里可改 |
| 截图 | macOS 走系统 `screencapture` 二进制；Windows 走 Electron `desktopCapturer`+`screen` | 决策与验证见 §5。这是真实 App 进程，拿到屏幕录制权限后可截真图 |
| 图片压缩 | macOS `sips`（系统自带）；Windows 用 Electron 自带的 `nativeImage.resize()` + JPEG 编码 | 不引 sharp/imagemagick 这类带原生编译的重依赖，见 §5/§6 |
| 本地 HTTP 服务 | Node 内置 `http` 模块 | **不引任何第三方 web 框架**（不 express/koa/fastify） |
| 二维码 | `qrcode`（npm，纯 JS，无原生依赖） | 生成 data URI 在设置窗口里显示 |
| HTTP 客户端（调模型） | Node 内置 `fetch`（Node 18+ 全局可用，Electron 33 的 Node 具备） | 不引 axios/node-fetch |
| 托盘 | Electron `Tray` + `Menu` | 见 §10 |
| 打包 | `electron-builder` | mac `.dmg`、Windows `.exe`（NSIS）。见 §11 |
| CI | GitHub Actions（macos + windows runner） | 见 §11 |

运行时第三方依赖只有一个：`qrcode`。`electron` 与 `electron-builder` 是 devDependencies。坚持"能用内置就用内置"，减少开源后他人构建的失败面，也减少供应链面。


## 3. 项目结构

```
20261021_PeekPhone桌面App/
├── package.json                 # name/version/scripts/build(electron-builder 配置)/deps
├── package-lock.json            # 提交进仓库
├── .gitignore                   # node_modules / dist / out / 运行时配置 / 截图历史
├── README.md                    # 安装、填 key、扫码、「与同类项目的差异」定位小节、已知限制、Gatekeeper/SmartScreen 说明
├── LICENSE                      # MIT
├── .github/
│   └── workflows/
│       └── build.yml            # macos+windows 构建，artifact 上传，tag 触发 Release
├── build/                       # 打包用静态资源（图标），非运行时
│   ├── icon.icns                # mac App 图标
│   ├── icon.ico                 # win App 图标
│   └── tray/                    # 托盘图标（见 §10：mac 用 Template png，win 用 ico/png）
│       ├── trayTemplate.png
│       ├── trayTemplate@2x.png
│       └── tray.ico
├── src/
│   ├── main/                    # 主进程（Node 环境）
│   │   ├── main.js              # 入口：app 生命周期、单实例锁、启动服务/托盘/快捷键
│   │   ├── config.js            # 配置读写（userData 下 config.json），默认值、token 生成
│   │   ├── capture.js           # 截图：平台分支 + 压缩，产出 JPEG Buffer
│   │   ├── llm.js               # 多 provider 调用 + 重试 + 两种请求格式（移植 llm.py）
│   │   ├── pipeline.js          # 编排：截图→压缩→落盘 slot(pending)→调模型→写 done/error
│   │   ├── server.js            # 本地 http 服务（移植 serve.py），token 鉴权、/latest、/img
│   │   ├── page.js              # 手机页面 HTML 模板（移植 serve.py 的 PAGE），导出渲染函数
│   │   ├── store.js             # 分析历史 slot 的落盘/读取/清理（移植 history/ 逻辑）
│   │   ├── tray.js              # 托盘图标 + 菜单
│   │   ├── shortcut.js          # globalShortcut 注册/重注册
│   │   ├── windows.js           # 创建/管理设置窗口 BrowserWindow
│   │   ├── ipc.js               # 主进程侧 ipcMain 处理器（设置 UI ↔ 主进程）
│   │   ├── net.js               # 取局域网 IP（移植 lan_ip），组装手机 URL
│   │   └── prompts.js           # 内置默认提示词常量 + 用户自定义提示词读写
│   ├── preload/
│   │   └── preload.js           # contextBridge 暴露受限 API 给设置 UI
│   └── renderer/                # 设置 UI（Chromium 环境，纯 HTML/CSS/JS，无框架）
│       ├── settings.html
│       ├── settings.css
│       └── settings.js
└── .agents/
    └── tasks/
        └── design.md            # 本文件
```

说明：手机页面（`page.js`）和设置 UI（`renderer/`）是两个完全独立的前端。手机页面是主进程用字符串模板拼出来、经本地 http 服务吐给手机浏览器的（照搬 serve.py 的做法，无需打包进 renderer）；设置 UI 是 Electron `BrowserWindow` 加载的本地页面，通过 preload + IPC 和主进程通信。两者不要混。


## 4. 模块分解（逐文件职责）

**`src/main/main.js`** — 应用入口。`app.requestSingleInstanceLock()` 保证单实例（第二次启动直接退出，避免抢端口/快捷键）。`app.whenReady()` 后依次：加载配置（config.js）→ 启动本地服务（server.js）→ 注册全局快捷键（shortcut.js）→ 建托盘（tray.js）→ 首次启动弹一次性安全提示（见 §10）。macOS 上 `app.dock.hide()`（纯托盘 App 不在 Dock 显示，但**不隐藏进程、不做任何反检测**，这只是常规托盘 App 行为）。监听 `will-quit` 时 `globalShortcut.unregisterAll()` 并关服务。不在所有窗口关闭时退出（`window-all-closed` 不 quit，托盘常驻）。

**`src/main/config.js`** — 配置的唯一读写入口。路径 `app.getPath('userData')/config.json`。首次无文件时写入默认配置（见 §8），并生成随机 `server.token`。提供 `get()` / `update(patch)` / `getToken()`。写文件时 `chmod 0o600`（Windows 上 chmod 无效果但无害）。配置包含模型 provider、快捷键、端口、token、当前提示词、开机自启开关、首次提示已读标记、历史保留天数、压缩参数。

**`src/main/capture.js`** — `capture()` 返回 `{ buffer, mediaType, ext }`，三者随真实格式联动：正常路径 `mediaType:'image/jpeg'` + `ext:'jpg'`；仅当 mac `sips` 压缩失败走 PNG 兜底时为 `mediaType:'image/png'` + `ext:'png'`（兜底细节见 §5）。平台分支见 §5。内部负责压到长边 1200、JPEG 质量 ~70。失败抛带原因的 Error（含"检查屏幕录制权限"提示），由 pipeline 捕获并落 error。**契约铁律**：`mediaType` 与 `ext` 必须与 `buffer` 的真实字节格式一致——`mediaType` 会原样进 llm payload 的 `media_type`/`data:<mediaType>;base64`（标错会被 provider 400），`ext` 决定 store 落盘文件名（`shot.jpg`/`shot.png`，/img 白名单依赖它），二者不得写死。

**`src/main/llm.js`** — 移植 `llm.py`。见 §6。导出 `analyze(imageBuffer, mediaType, prompt, config)` → `{ text, raw, via }`，全失败抛 `ModelError`（聚合每个 provider 的错误全文）。

**`src/main/pipeline.js`** — 一次完整"截图问 AI"的编排，移植 `peek.py main()` 去掉钉钉。流程：确定提示词名与文本 → 在 store 里建 slot（先写 pending）→ 立刻刷新 `/latest` key（手机先看到"分析中"和截图）→ `{buffer, mediaType, ext} = capture()` → `store.saveImage(slot, buffer, ext)`（按 ext 落 `shot.jpg`/`shot.png`）→ `llm.analyze(buffer, mediaType, ...)`（mediaType 透传）→ 成功写 `analysis`、失败写 `error` → 触发历史清理。任一步失败都落 error 态（手机页面显示"这次没拿到分析"+原因），并用 Electron `Notification` 弹桌面通知，不静默。导出 `runCapture(promptName)`。

**并发保护**：pipeline 持一个模块级 `inFlight` 布尔。`runCapture` 入口若 `inFlight===true`（上一张还在截/压/调模型），直接弹通知"正在处理上一张截图，稍等"并 return，不排队、不并发截第二张（避免两次截图抢同一局域网端口写、也避免手机页面 latest 来回跳）。`finally` 里复位 `inFlight=false`，确保异常后不会卡死。**历史清理**：`store.purge(keepDays)` 在 App 启动时跑一次、每次 `runCapture` 成功建 slot 后再跑一次（照搬原型"每次截图 purge"），无需定时器。

**`src/main/server.js`** — 移植 `serve.py` 的 `Handler`。Node `http.createServer`，监听 `0.0.0.0:<port>`。路由：`/`（页面）、`/latest`（轮询 key）、`/img/<slot>/<file>`（图片，防穿越）。每个请求校验 `?t=<token>`，用 `crypto.timingSafeEqual` 做等长比较（对应 py 的 `hmac.compare_digest`），无/错 token 返回 403。**token 每个请求现读 `config.getToken()`，不在 server 启动时缓存**（原型 `serve.py` 把 token 缓存在 `Handler.token`，桌面 App 有"重置 token"按钮，缓存会让重置不生效——必须现读，才能让旧链接立刻 403）。server 导出 `start()` / `stop()` / `restart(port)` 供端口变更时重启监听（见 §7）。见 §7、§9。

**`src/main/page.js`** — 手机页面 HTML。逐字移植 serve.py 的 `PAGE` 模板与 `pretty()`、三态文案、2 秒轮询 JS、深浅色、只显示最新一条。导出 `renderPage(item, token)` 和 `renderEmpty()`。

**`src/main/store.js`** — 分析历史。移植 `history/<时间戳>_<提示词>/` 结构：每个 slot 一个目录，含 `shot.jpg`、`analysis.md`（done）、`error.txt`（error）；无 analysis/error 即 pending。路径放 `app.getPath('userData')/history/`。提供 `newSlot(name)`、`saveImage(slot, buffer, ext)`（ext 为 `'jpg'`/`'png'`，落 `shot.<ext>`）、`saveAnalysis`、`saveError`、`latest()`、`latestKey()`、`readSlot`（按 §7 先找 `shot.jpg` 再找 `shot.png`，与原型 `read_slot` 一致）、`purge(keepDays)`、`resolveImagePath(slot, file)`（带 realpath 边界校验，供 server 防穿越）。

**`src/main/tray.js`** — 托盘图标 + 菜单，见 §10。

**`src/main/shortcut.js`** — `register(accelerator, handler)` / `reregister(newAccelerator)`。注册失败（被占用/非法）返回 false，由设置 UI 提示用户换键。

**`src/main/windows.js`** — 设置窗口的创建与复用（已存在则 focus，不重复开）。`BrowserWindow` 开 `contextIsolation:true`、`nodeIntegration:false`、加载 `preload.js`。

**`src/main/ipc.js`** — 注册所有 `ipcMain.handle`：读配置、写配置、列提示词、存提示词、测试识别（真截屏+真调模型返回回复）、改快捷键、取手机 URL+二维码 data URI、设置开机自启、标记首次提示已读。

**`src/main/net.js`** — `lanIP()`：优先用 Node `os.networkInterfaces()` 找非内部 IPv4（替代 py 里 `ipconfig getifaddr en0`，跨平台）。`phoneURL(ip, port, token)` 组 URL。

**`src/main/prompts.js`** — 内置三套默认提示词文本常量（见 §11）+ 用户自定义提示词目录（`userData/prompts/`）读写。首次启动把三套默认写进该目录（可被用户编辑）。

**`src/preload/preload.js`** — `contextBridge.exposeInMainWorld('api', {...})`，把上面 IPC 封成 Promise 函数给设置 UI 调。只暴露白名单方法，不暴露 `ipcRenderer` 原件。

**`src/renderer/settings.{html,css,js}`** — 设置界面，见 §10。纯原生，无前端框架。


## 5. 截图方案决策（desktopCapturer vs screencapture）

**决策：平台分流。macOS 用系统 `screencapture` 二进制截图 + `sips` 压缩；Windows 用 Electron `desktopCapturer` + `nativeImage` 压缩。**

理由：

- 原型在 macOS 上用 `screencapture -x -D 1` 已实测稳定拿到 2880×1800 真图，这是已验证的路径，照搬风险最低。原生 App 持有屏幕录制权限后，`screencapture` 不再受快捷指令沙盒限制（用户之前失败的根因就是沙盒 + 未授权，不是 `screencapture` 本身的问题）。`sips -Z 1200 -s format jpeg` 同样系统自带、已验证压到 ~127KB。
- `desktopCapturer` 在 macOS 上拿整屏需要走 `getUserMedia`/`thumbnailSize` 的路子，分辨率受 thumbnail 尺寸限制，拿原生满分辨率较绕；且同样需要屏幕录制权限，并不比 `screencapture` 省权限。既然 mac 有现成已验证的二进制，就不绕。
- Windows 没有 `screencapture`/`sips`。`desktopCapturer` 是 Electron 官方跨平台截屏 API，Windows 上成熟。配合 `screen.getPrimaryDisplay()` 的 `size`×`scaleFactor` 把 `thumbnailSize` 设成真实像素尺寸，取 `nativeImage`，再 `resize({width/height})` 到长边 1200、`toJPEG(70)` 得到 Buffer。全程 Electron 内置，无需外部二进制、无需 sips。

`capture.js` 对外只暴露一个 `capture()`，返回 `{ buffer, mediaType, ext }`（§4 契约），平台差异封在内部：

```
capture():
  if darwin:
    buf = captureMacScreencapture()        // 首选路径
    if buf is null:                         // 子进程拿不到真图（权限归属问题，见下）
       buf = captureViaDesktopCapturer()    // 降级：与 win 同一路径
       if buf is null:
          throw '截图失败：screencapture 与 desktopCapturer 均未取得屏幕内容，' +
                '检查 系统设置>隐私与安全性>屏幕录制 是否放行本 App'
    return buf                              // {buffer, mediaType, ext}
  else (win):
    return captureViaDesktopCapturer()      // 失败则 throw 同上

captureMacScreencapture():                  // 返回 {buffer,mediaType,ext} 或 null
  tmp = tmpdir/peek_<rand>.png
  run `screencapture -x -D 1 <tmp>`         // 静默、无快门、主屏
  若 returncode!=0 或文件空 -> 删临时文件, return null   // 交给上层降级，不直接 throw
  run `sips -Z 1200 -s format jpeg -s formatOptions 70 <tmp> --out <tmp.jpg>`
  若 sips 成功 -> buf=读 <tmp.jpg>; 删临时文件; return {buffer:buf, mediaType:'image/jpeg', ext:'jpg'}
  若 sips 失败 -> buf=读原 <tmp>;   删临时文件; return {buffer:buf, mediaType:'image/png',  ext:'png'}  // PNG 兜底，格式如实标注

captureViaDesktopCapturer():                // 返回 {buffer,mediaType,ext} 或 null
  sources = desktopCapturer.getSources({types:['screen'], thumbnailSize: 主屏真实像素})
  若无 source 或 thumbnail.isEmpty() -> return null
  img = 主屏 source.thumbnail (nativeImage)
  jpeg = img.resize(长边1200).toJPEG(70)
  return {buffer:jpeg, mediaType:'image/jpeg', ext:'jpg'}
```

多屏：mac 固定主屏（`-D 1`，与原型一致）；win 取 `getPrimaryDisplay` 对应的 source。README 注明"只截主屏，副屏内容请先拖到主屏"。

**mac 降级链（已决契约，不留给 coder 临场判断）**：首选 `screencapture` 子进程（原型已验证能产 2880×1800 真图）；**若 §13.1 实测打包 `.app` 的 `screencapture` 子进程拿不到真图（返回空/黑帧，根因见下），mac 自动回退到 `captureViaDesktopCapturer()`——与 Windows 同一条进程内路径，分辨率受 `thumbnailSize` 限制、best-effort**；两条都取不到才 throw 并由 README 诚实标注"该 macOS 版本不支持"。为什么必须有这条兜底：macOS TCC 的屏幕录制权限按**可执行体 / responsible process** 归属，`.app` fork 出的独立 `/usr/sbin/screencapture` 二进制的权限归属跨 macOS 版本行为不一致，存在"父 App 已授权但子进程仍截到纯桌面/黑帧"的已知情形；而 `desktopCapturer` 是**进程内** API，TCC 归属干净地落在 App 本身，正是现成的 plan B。`capture.js` 实现时判定"screencapture 取到真图"的标准：returncode==0、文件非空、且 JPEG/PNG 解码后非全黑（可用 nativeImage 读像素做一次廉价的全黑检测），任一不满足即视作 null 触发降级。

**必须在实现期验证的点（见 §13 汇总）**：

1. 本机（Intel Mac）给打包后的 `.app` 授予屏幕录制权限后，`screencapture -x` 能否截到真实非黑图（而不是空/黑帧）。**这是首选路径，优先验证；但即便不通产品也不会垮——已有 `desktopCapturer` 降级兜底（§5 降级链）。** 验证方式：`npm run dev` 或打包后运行，首次触发截图时系统应弹屏幕录制授权；授权并重启 App 后再截，检查 JPEG 非空且肉眼可读。若 `screencapture` 子进程取到黑帧，确认自动降级到 `desktopCapturer` 后能出真图。
2. macOS 屏幕录制权限的授予对象是"这个 App"而非 Terminal——开发期（`electron .` 由终端拉起）授权对象可能是 Electron/Terminal，打包后变成 PeekPhone.app，**权限需重新授予一次**。README 和首启提示都要讲清。
3. Windows 的 `desktopCapturer` 全屏截图分辨率与清晰度在 CI 产物里无法本机验证（本机是 Mac），只能靠有 Windows 的使用者实测，README 诚实标注"Windows 截图路径由 CI 编译保证能构建，清晰度需使用者反馈"。


## 6. LLM 层 Node 移植（`src/main/llm.js`）

逐函数对应 `llm.py`，去掉 env 文件读取（原型从 `/Users/harry/诺亚方舟/env` 读凭证——那是用户私有，**不移植**；key 改为从 config 里读，用户在设置 UI 填）。

导出 `analyze(imageBuffer, mediaType, prompt, config)`：

1. `imageB64 = imageBuffer.toString('base64')`。`maxTokens = config.maxTokens ?? 1500`。
2. 遍历 `config.providers` 中 `enabled` 的项，按顺序试；返回第一个成功的 `{ text, raw, via }`。
3. 全失败抛 `ModelError`，message 聚合每个 provider 的完整错误（照搬 py 的"把每个 provider 错误一起抛"，便于用户在"测试识别"里定位）。

`resolveProvider(p)` → `{ name, format, url, model, token, timeout, retries }`：

- `format` 两种：`anthropic_messages` 和 `openai_chat`（py 里非 anthropic 即走 openai 分支）。
- URL 拼接照搬：`anthropic_messages` → `base_url + '/v1/messages'`；`openai_chat` → `base_url + '/chat/completions'`。`base_url` 末尾 `/` 去掉。
- `token` 直接取 `p.api_key`（不再支持 `token_from_env_file`/`api_key_env`，那些是原型为复用 env 文件设计的，桌面 App 不需要）。
- `base_url`/`model`/`token` 任一为空 → 抛"配置不全，缺 X"，跳过该 provider。
- `timeout` 默认 120s，`retries` 默认 3（原型注释说网关偶发连接重置，2–5 次重试是真实必需，保留）。

`buildPayload(spec, prompt, imageB64, mediaType, maxTokens)` → `{ body, headers }`，两种格式与 py 完全一致：

- **anthropic_messages**：body `{model, max_tokens, messages:[{role:'user', content:[{type:'text',text:prompt},{type:'image',source:{type:'base64',media_type:mediaType,data:imageB64}}]}]}`；headers `Authorization: Bearer <token>`、`Content-Type: application/json`、`anthropic-version: 2023-06-01`。
- **openai_chat**：body `{model, max_tokens, messages:[{role:'user', content:[{type:'text',text:prompt},{type:'image_url',image_url:{url:'data:<mediaType>;base64,<imageB64>'}}]}]}`——`model`/`max_tokens` 与 anthropic 分支取值相同（同 §8 的 provider.model 与 config.maxTokens），**仅 `content` 块结构（`image_url` vs `image`）与 headers（无 `anthropic-version`）不同**；headers `Authorization: Bearer <token>`、`Content-Type: application/json`。

`extract(spec, data)`：anthropic 取 `data.content[]` 中 `type==='text'` 的 text 拼接；openai 取 `data.choices[0].message.content`。空文本视为失败（py 里 `返回没有文本` 抛错）。

`tryProvider(spec, ...)` 重试逻辑用 `fetch`：

- `RETRY_STATUS = [408,429,500,502,503,504]`。
- 循环 `attempt` 1..retries：`fetch(url,{method:'POST',headers,body,signal:AbortSignal.timeout(timeout*1000)})`。
- HTTP 非 2xx：读 body 前 500 字记录；状态码不在 RETRY_STATUS（如 400/401/403 权限类）→ `break`，不再重试（py 同逻辑："权限/模型未关联这类错，重试一百次也一样"）。
- 网络异常 / 超时 / 连接重置（fetch reject、`AbortError`、`TypeError` 等）→ 记录，继续重试。
- JSON 解析失败 → 记录。
- 重试间隔指数退避 `min(2**(attempt-1), 8)` 秒（照搬）。
- 全部 attempt 用尽抛带 provider 名 + model + url + 每次错误的 `ModelError`。

返回 `via` 字符串照搬格式：`'<name>（<model>，第<attempt>次成功）'`。

**与 py 的唯一行为差异**：Node `fetch` 的连接重置会以 reject（`TypeError: fetch failed` + cause）形式出现，对应 py 里 `URLError/ConnectionError/OSError` 分支，归入"可重试"。实现时 catch 住所有非 HTTP 响应异常都当可重试。这点在"测试识别"按钮里顺带验证（真调一次模型）。


## 7. 手机服务器 Node 移植（`src/main/server.js` + `page.js` + `store.js`）

**交互行为逐条照搬 serve.py，不做改动**（用户只想看最新一条 + 自动刷新，这套已实测好用）：

- 监听 `0.0.0.0:<port>`（默认 8765，可在设置改）。用 Node `http.createServer`。
- 每个请求先校验 `?t=<token>`。缺/错 → 403 纯文本 `403 需要带 ?t=<token> 访问`。比较用 `crypto.timingSafeEqual`（两边 Buffer 等长才比，长度不等直接判否，等价 py 的 `hmac.compare_digest`）。
- 路由：
  - `GET /latest?t=` → JSON `{key: latestKey()}`，`Cache-Control: no-store`。`latestKey()` = `'<slotName>|<state>'`，无记录返回 `'empty'`（带 state 保证 pending→done 也触发前端刷新）。
  - `GET /img/<slot>/<file>?t=` → 图片。只允许 `file ∈ {shot.jpg, shot.png}`，slot 名不含 `/`、不以 `.` 开头；`path.resolve` 后必须仍在 `history/` 目录内（realpath 边界校验），否则 404。其余文件名一律 404（既防 `../` 穿越，也不暴露 analysis.md/push.json 之类）。
  - `GET /?t=` → 页面。
- 页面（`page.js`）：只渲染最新一条，含截图卡片 + 分析文本卡片；三态文案 `{done:'自动刷新中', pending:'分析中', error:'出错了'}`；标题用 `pretty(slotName)`（`20261021_125058_default` → `12:50:58 · default`）；顶部常驻状态条带呼吸点；深浅色自适应；前端 JS 每 2 秒 `fetch('/latest')`，key 变化就 `location.reload()`，`document.hidden` 时跳过轮询，`visibilitychange` 回前台立即拉一次。所有注入页面的文本做 HTML 转义（照搬 `html.escape`，Node 侧自己写个 escape）。token 注入页面脚本和图片 URL（JSON 序列化）。
- `store.js` 的 slot 结构、`latest()`（按目录名倒序取第一个）、`readSlot()`（analysis 存在→done / error 存在→error / 否则 pending）全照搬。

**`net.js` 取局域网 IP**：py 用 `ipconfig getifaddr en0`（仅 mac）。跨平台改用 Node `os.networkInterfaces()`：遍历找 `family==='IPv4' && !internal` 的地址，优先非 `169.254.*`（APIPA）、优先 `192.168.*`/`10.*`/`172.16-31.*` 私网段；取第一个。取不到退回 `127.0.0.1`。不做 `.local`/mDNS 那条（原型实测本机 mDNS 被网络拦、解析不了，且跨平台不稳）——手机页面 URL **只用 IP 那条**，二维码也编码 IP URL。README 注明 IP 随 DHCP 变化，换网络后在设置里重新看二维码。

**端口占用**：server 启动若 `EADDRINUSE`，捕获后弹桌面通知提示用户在设置里换端口，App 不崩。`restart(port)` 换端口时先 `server.close()` 再在新端口 `listen`；若新端口也占用，保留旧 server 不动（不要把能用的服务关掉换到一个起不来的端口）并回 UI 报错让用户另选。

**设置变更的运行时生效（逐项明确，不留"重启 App 才生效"的隐式假设）**：

| 改了什么 | 生效方式 | 旧状态处理 |
|---|---|---|
| 端口 | `server.restart(newPort)` | 旧端口 `close`，手机需用新 URL/二维码重连 |
| 重置 token | 立即生效（token 现读，无需重启 server） | 旧链接下次请求即 403 |
| 快捷键 | `shortcut.reregister()`（先 unregister 旧、再 register 新） | 注册失败回滚旧键并 UI 提示 |
| 提示词内容 | 每次截图现读文件，保存即生效 | 无需任何重启 |
| provider / key / maxTokens / 压缩参数 | 下次 `runCapture` 现读 config | 无需重启 |
| 开机自启 | `app.setLoginItemSettings` 立即写入 | — |

即"改任何设置都不需要退出重开 App"，这是从脚本+外部编排收进常驻 App 后应得的体验，必须落实。


## 8. 配置存储模型

位置：`app.getPath('userData')/config.json`（mac `~/Library/Application Support/PeekPhone/`，win `%APPDATA%/PeekPhone/`）。**永不进仓库**（.gitignore 只拦运行时目录即可，因为它本就在 userData，不在项目树内；但仍在 README 说明）。首次启动由 config.js 写默认值并生成随机 token。

默认配置形状（开源仓库里**没有**这个文件，它是运行时生成的；下面是默认值，key/base_url/model 全空占位）：

```json
{
  "providers": [
    {
      "name": "我的模型",
      "enabled": true,
      "format": "openai_chat",
      "base_url": "",
      "api_key": "",
      "model": "",
      "timeout": 120,
      "retries": 3
    }
  ],
  "maxTokens": 1500,
  "shrinkLongEdge": 1200,
  "jpegQuality": 70,
  "keepDays": 7,
  "hotkey": "CommandOrControl+Alt+P",
  "currentPrompt": "default",
  "launchAtLogin": false,
  "noticeAcknowledged": false,
  "server": { "port": 8765, "token": "<首次启动随机生成>" }
}
```

`server.token` 用 `crypto.randomBytes(18).toString('base64url')` 生成（等价 py 的 `secrets.token_urlsafe(18)`）。

设置 UI 的模型预设下拉在**写入 config 前**把预设映射成上面的 provider 字段：

| 预设 | format | base_url 预填 | model 预填 | 用户需填 |
|---|---|---|---|---|
| 智谱 GLM-4.6V-Flash（OpenAI 兼容） | `openai_chat` | `https://open.bigmodel.cn/api/paas/v4` | `glm-4v-flash`（实现期核对模型名） | api_key |
| 阿里百炼 qwen-vl（OpenAI 兼容） | `openai_chat` | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `qwen-vl-plus`（实现期核对） | api_key |
| 自定义 OpenAI 兼容 | `openai_chat` | 空 | 空 | base_url/api_key/model |
| 自定义 Anthropic 兼容 | `anthropic_messages` | 空 | 空 | base_url/api_key/model |

预设的 base_url/model 只是默认填充，用户可改。provider 格式与 §6 完全一致，因此预设只是"帮用户少填两个框"。**预设里绝不写任何真实 key。**

提示词存 `userData/prompts/<name>.txt`，首次启动把三套内置默认写进去；之后以文件为准，每次截图现读（照搬 py "改完存盘即生效"）。历史存 `userData/history/`，超 `keepDays` 天自动清理。


## 9. 安全模型

**本地服务 token 鉴权（硬要求）**：
- token 随机生成（`crypto.randomBytes(18).base64url`），存 userData 的 config.json，不进仓库。
- 每个请求（页面、/latest、/img）都校验 `?t=`；无 token → 403；比较用 `timingSafeEqual` 等长常量时间比较。
- 监听 `0.0.0.0`，README 与首启提示都写明："同子网主机可达本服务，token 是唯一防线，别把带 token 的链接转发出去。" 提供"重置 token"按钮（清空后重启服务生成新 token，旧链接立即失效）。
- 服务是明文 HTTP（非 HTTPS），README 注明"同网段抓包可见图片和 token，只在可信网络用"。

**绝不写入任何真实密钥**：
- 仓库默认 provider 的 `api_key`/`base_url`/`model` 全空。用户的模型 key 只在设置 UI 输入，存 userData 的 config.json，**永不进代码、永不进仓库、永不进日志**。
- 日志/桌面通知里出现 provider 错误全文时，只透传上游返回的错误 body（不含我方拼的 Authorization 头）；实现时确保 header 不被打印。
- 不移植原型读 `/Users/harry/诺亚方舟/env` 的逻辑，不复制原型 `config.json` 的任何值，不内置钉钉凭证，不内置 KiroAdmin 反代地址/key。

**`.gitignore`** 至少包含：
```
node_modules/
dist/
out/
build/*.icns  # 若图标由脚本生成则忽略；若手工提供则不忽略（实现期定，默认提交图标）
*.log
.DS_Store
# 运行时数据本就在 userData，不在项目树；此处双保险拦误放项目内的运行产物
/config.json
/history/
/prompts/
/webhook.txt
```

**Electron 加固**：设置窗口 `contextIsolation:true`、`nodeIntegration:false`、`sandbox` 尽量开，只经 preload 白名单 IPC 通信。本地服务不加载任何远程内容。不注册自定义协议处理远程 URL。

**明确不做**：隐身 / 活动监视器隐藏 / 录屏不可见 / 点击穿透等反检测特性，用户已否决，README 里也不提供此类开关。


## 10. 托盘 / 菜单 / 快捷键 / 首启提示 / 二维码 / 设置 UI

**托盘菜单**（`tray.js`，`Tray` + `Menu.buildFromTemplate`）：

- `立即截图（当前提示词：<name>）` → `pipeline.runCapture(config.currentPrompt)`。
- `切换提示词 ▸` 子菜单，列出所有提示词（radio 勾当前），选中即改 `config.currentPrompt`。
- `显示手机二维码` → 打开设置窗口并切到"手机连接"标签（显示二维码 + URL）。
- `打开设置` → 设置窗口。
- `退出` → `app.quit()`。
- 托盘图标：mac 用 `trayTemplate.png`（`@2x`，设 `setTemplateImage(true)`，自动适配深浅色菜单栏）；win 用 `tray.ico`。

**全局快捷键**（`shortcut.js`）：默认 `CommandOrControl+Alt+P`。设置里可改，改时先 `unregister` 旧的再 `register` 新的；注册失败（被占/非法）则回滚到旧值并在 UI 提示。**明确不做纯修饰键双击**（如 ⌘⌘）——Electron `globalShortcut` 不支持单纯修饰键或双击修饰键，README 的"已知限制"里写明，避免用户期待原型里提过的"command+command"。

**首次启动一次性提示**（`main.js`，`config.noticeAcknowledged===false` 时）：用 `dialog.showMessageBox` 弹模态，文案"截图会发送给你配置的第三方 AI 服务，请勿截取敏感或公司内部内容"，带"我知道了"按钮；点确认后写 `noticeAcknowledged:true`，之后永不再弹。首启还顺带在提示里带一句屏幕录制授权指引（mac）。

**二维码**：`ipc.js` 的 `getPhoneConnection` 返回 `{url, qrDataUrl}`。`qrcode.toDataURL('http://<ip>:<port>/?t=<token>')` 生成 PNG data URI，设置 UI `<img>` 直接显示。

**设置 UI（`renderer/`）** 分几块（可用标签或分区）：

1. **模型配置**：预设下拉（§8 四项）→ 选中自动填 format/base_url/model；可编辑 `base_url`/`api_key`/`model`/`format`（provider-format 单选）。`api_key` 输入框用 password 型，可点眼睛切明文。**「测试识别」按钮**：调 IPC `testRecognition` → 主进程真截当前屏 + 真调模型 + 返回回复文本，UI 显示（成功显示模型回复，失败显示聚合错误）。这是用户自检配置是否正确的关键入口。**它不走 pipeline、不建 history slot、不刷新手机 latest**（避免测试把一条临时结果顶到手机页面上），只在内存里 capture→llm.analyze 后把文本回传设置 UI；用的是 UI 当前未保存的草稿配置还是已存配置，取"UI 传入的草稿配置"——这样用户填完没点保存也能先测。测试同样受 §4 pipeline 的 `inFlight` 影响之外独立计一个 `testInFlight` 锁，防止连点并发截图。
2. **提示词管理**：列出 `userData/prompts/*.txt`，三套默认可编辑，可新增（起名 + 内容），可删除自定义的。保存即写文件。
3. **快捷键**：捕获用户按键组合转成 Electron accelerator 字符串，保存时试注册。
4. **手机连接**：二维码 + URL 文本 + 复制按钮 + 重置 token 按钮 + 端口设置。
5. **通用**：开机自启开关（`app.setLoginItemSettings({openAtLogin})`，mac/win 皆支持）、历史保留天数、压缩参数（长边/质量，给默认值即可，高级用户可调）。

设置 UI 纯 HTML/CSS/JS，经 `window.api.*`（preload 暴露）调 IPC，全部 Promise 化。


## 11. 提示词处理（歧义解决）

**发现的事实**：原型 `prompts/` 当前**只剩 `default.txt`**，且其内容已被用户改成"北森测评题目分析专家"的专用答题提示词；`code.txt` 和 `data.txt` 已不存在。但任务要求"三套默认（default/code/data）可编辑 + 可新增"，且 `说明.md §5` 明确记载了三套的**原始通用定位**。

**决策**：桌面 App 内置的三套默认提示词，按 `说明.md §5` 的原始通用定位重建，**不采用**当前被改成答题专用的 `default.txt`：

- `default` — 通用屏幕解读：这屏在干什么 / 关键信息 / 有没有异常 / 下一步 1~3 条具体动作。
- `code` — 代码报错排查：抄关键报错行 / 判根因（栈顶是表象，往下找第一处自己代码的帧）/ 给能直接动手的改法 / 给一条验证命令。
- `data` — 图表数据解读：一句话结论带数字 / 读关键指标 / 找异常（突刺、断崖、为 0、合计对不上）/ 给下钻方向。

理由：这是开源通用工具，默认提示词应是通用的屏幕助手，而非某人的测评答题器；"答题专用"属于用户个性化，用户装好后可自行把 default 改成任意内容（提示词管理支持编辑），不需要把它作为仓库默认。三套默认文本由 coder 按上述定位撰写（简洁的中文系统提示，各几百字），写进 `src/main/prompts.js` 常量，首启落到 `userData/prompts/`。

> 若后续评审认为应保留"答题"场景，可作为"新增提示词"示例写进 README，而不是改默认。此处按"通用工具"定位决策。


## 12. electron-builder + CI 计划

**`package.json` 关键字段**：

```jsonc
{
  "name": "peekphone",
  "productName": "PeekPhone",
  "version": "0.1.0",
  "main": "src/main/main.js",
  "scripts": {
    "start": "electron .",
    "dist": "electron-builder",
    "dist:mac": "electron-builder --mac",
    "dist:win": "electron-builder --win"
  },
  "build": {
    "appId": "com.peekphone.app",
    "files": ["src/**", "build/**", "package.json"],
    "mac": {
      "target": [{ "target": "dmg", "arch": ["x64", "arm64"] }],
      "category": "public.app-category.productivity",
      "icon": "build/icon.icns",
      "extendInfo": {
        "NSScreenCaptureUsageDescription": "PeekPhone 需要屏幕录制权限来截取当前屏幕用于 AI 分析。",
        "LSUIElement": true
      }
    },
    "win": {
      "target": ["nsis"],
      "icon": "build/icon.ico"
    },
    "dmg": { "sign": false }
  },
  "devDependencies": { "electron": "^33", "electron-builder": "^25" },
  "dependencies": { "qrcode": "^1.5" }
}
```

- `LSUIElement:true`：mac 上 App 不在 Dock 显示（纯托盘），这是常规行为，非隐身。
- `NSScreenCaptureUsageDescription`：mac 截图权限用途说明。
- mac target 同时产 `x64` 与 `arm64` 两个 dmg：唯一运行时依赖 `qrcode` 是纯 JS、无原生编译，electron-builder 能跨架构产出，CI 的 `macos-latest`（现为 Apple Silicon/arm64）也会如实产出 arm64 包。**本机是 Intel x64，只能本地验证 x64 dmg 能装能跑；arm64 包由 CI 产出、本机无法验证，README 标注需 Apple Silicon 用户反馈**（功能上 arm64 用户亦可跑 x64 版走 Rosetta 兜底）。

**CI（`.github/workflows/build.yml`）**：

- 触发：push 到 tag `v*` 时构建并发 Release；对 PR/push 到主分支只构建 + 上传 artifact（不发 Release）。
- matrix：`macos-latest` + `windows-latest` 两个 runner。
- 步骤：checkout → `actions/setup-node@v4`（node 20+）→ `npm ci` → `npm run dist`（electron-builder 按 runner 平台产出对应包）→ `actions/upload-artifact` 上传 `dist/*.dmg` / `dist/*.exe`。
- Release：tag 触发时用 `softprops/action-gh-release` 把两平台产物附到 Release。`GITHUB_TOKEN` 由 Actions 自动注入，无需额外 secret（因为不签名、不公证、不上第三方）。
- **不配任何签名/公证 secret**（无 Apple 开发者账号、无 Windows 证书）。

**诚实声明（写进 README + 本设计）**：
- 本机是 Intel x64 Mac。**Windows 包和 Apple Silicon 包无法在本机测试**，只由 CI 编译保证能构建成功，运行正确性需对应平台使用者反馈。
- 安装包未签名、未公证：
  - macOS：首次打开被 Gatekeeper 拦，README 教"右键 → 打开 → 再点打开"，或"系统设置 → 隐私与安全性 → 仍要打开"。
  - Windows：SmartScreen 可能拦，README 教"更多信息 → 仍要运行"。


## 13. 实现期必须验证的假设（逐条，不留未验证假设给 coder）

1. **mac 截图首选路径**：打包后的 `PeekPhone.app` 获得屏幕录制权限后，`screencapture -x -D 1` 子进程能截到真实非黑图。先验证。**若不通不代表产品不成立**——§5 已定降级链：mac 自动回退到 `desktopCapturer`+`nativeImage`（进程内、TCC 归属干净），两条都不通才 README 标注该 macOS 版本不支持。开发期（终端拉起 electron）授权对象可能是 Electron/Terminal，打包后变成 PeekPhone.app 需重新授权——两种形态、以及"子进程截到黑帧时是否正确触发降级"都要实测一遍。
2. **mac 屏幕录制授权触发时机**：首次调用 `screencapture` 时系统是否自动弹授权框，还是需要用户手动去"隐私与安全性"添加。实测确认后把准确指引写进首启提示和 README。
3. **Windows 截图路径**：`desktopCapturer` + `nativeImage.resize().toJPEG()` 能否产出清晰可读的全屏 JPEG、分辨率是否够模型识别。本机无 Windows，只能由 CI 构建 + 使用者反馈，README 诚实标注。
4. **dmg 构建 + 安装 + 运行**：`npm run dist:mac` 在本机 Intel Mac 产出的 `.dmg` 能挂载、能拖装、能启动、托盘出现、快捷键生效、手机页面可访问。这是本机唯一能完整验证的打包产物，必须跑通。
5. **预设模型的 base_url/model 名**：§8 表里智谱/百炼的 base_url 和 model 名需实现期核对各家最新文档（模型名会变），错了用户"测试识别"会报错但不影响架构。
6. **Node fetch 对连接重置的异常形态**：确认 `fetch` 在连接被重置/超时时抛的异常类型，确保都归入"可重试"分支（§6）。用"测试识别"真调一次验证。
7. **`globalShortcut` 默认键不冲突**：`CommandOrControl+Alt+P` 在 mac/win 上是否被系统或常用软件占用；注册返回值要检查，占用时 UI 要能提示换键。
8. **开机自启**：`app.setLoginItemSettings` 在 mac（未签名 App）和 win 上的实际效果，未签名 mac App 的开机自启可能受限，实测确认，不行就在 UI 标注"未签名版本开机自启可能需手动在系统设置里添加"。
9. **局域网 IP 选取**：`os.networkInterfaces()` 在多网卡（VPN、虚拟网卡、Docker）环境下可能选错 IP。实现期在本机验证选出的是真实可被手机访问的那个；必要时在设置 UI 提供"手动选择网卡/IP"下拉作兜底（先按自动选，兜底列为可选增强）。
10. **端口占用**：8765 被占时 `EADDRINUSE` 被捕获、提示换端口、App 不崩——实测。


## 14. 明确不做（Out of Scope）

- **手机 App**：手机只用浏览器看页面，不做原生/小程序客户端。
- **云中转**：仅同一局域网，不做任何公网 relay / 内网穿透 / 隧道。
- **内置模型 key**：不内置任何可用 key，用户必须填自己的。
- **KiroAdmin 反代**：不打包、不内置用户的反代地址/key。
- **Linux 构建**：只做 mac + win。
- **钉钉推送**：整条废弃（`ding.py` 不移植），不做工作通知/群机器人降级。
- **反检测 / 隐身特性**：不做活动监视器隐藏、录屏不可见、点击穿透、无痕运行等任何反检测方向（用户明确否决）。纯托盘不进 Dock 属常规桌面 App 行为，不属此列。
- **纯修饰键双击快捷键**（如 ⌘⌘）：Electron `globalShortcut` 不支持，列为 README 已知限制。
- **手机侧追问**：手机只读看结果，不能对着截图继续对话（要换角度就在电脑换提示词重截）。
- **流式输出**：模型回答整段返回，不做 SSE 流式（原型也未用）。

---

## 附：移植对照速查

| 原型（Python） | 新实现（Node/Electron） | 关系 |
|---|---|---|
| `peek.py main()` | `pipeline.js runCapture()` | 去掉钉钉，其余照搬 |
| `llm.py analyze/_resolve/_payload/_extract/_try_provider` | `llm.js` 同名逻辑 | 去 env 读取，用 fetch，其余逐函数对应 |
| `serve.py Handler/PAGE/pretty/read_slot/latest` | `server.js` + `page.js` + `store.js` | 交互逐条照搬 |
| `serve.py lan_ip()`（`ipconfig getifaddr en0`） | `net.js lanIP()`（`os.networkInterfaces`） | 跨平台重写，只用 IP 不用 .local |
| `peek.py shoot()`（`screencapture`）+ `shrink()`（`sips`） | `capture.js`（mac screencapture+sips / win desktopCapturer+nativeImage） | 平台分流，见 §5 |
| `prompts/*.txt` | `prompts.js` 内置默认 + `userData/prompts/` | 三套按 §11 重建 |
| 从 `env` 读凭证 | 设置 UI 填、存 userData config.json | 不移植 env 读取 |
| `ding.py` 整个 | — | 不移植 |
| 快捷指令/Automator 外部绑键 | `globalShortcut` | 收进 App |
| 手动 `python3 serve.py` | 启动即起服务 | 收进 App |

---

## 附二：对设计评审 findings 的回应（2026-10-21 修订）

评审裁决 CHANGES_REQUESTED（2 MEDIUM + 3 NIT），全部已处理，未回退任何范围、未重新引入隐身/反检测或内置密钥。

- **MEDIUM-1（capture 返回契约与 PNG 兜底自相矛盾）— 已修**。采纳评审建议 (a)：`capture()` 改为返回 `{ buffer, mediaType, ext }`，三者随真实格式联动（JPEG→jpg / sips 失败时 PNG→png）；§4 加「契约铁律」禁止写死；§5 伪代码显式分出 `captureMacScreencapture`（含 PNG 兜底如实标注）与 `captureViaDesktopCapturer`；pipeline 改为 `store.saveImage(slot,buffer,ext)` 落 `shot.<ext>`、`mediaType` 透传 `llm.analyze`；`store.readSlot` 明确先找 `shot.jpg` 再找 `shot.png`，与原型一致。
- **MEDIUM-2（mac 截图命门无兜底）— 已修**。§5 新增「mac 降级链」作为**已决契约**：screencapture 子进程取不到真图（returncode 非 0 / 文件空 / 全黑帧检测）即自动回退 `desktopCapturer`+`nativeImage`（进程内、TCC 归属干净，与 Windows 同路径），两条皆不可用才 README 标注不支持。§13.1「命门/不成立」改写为「首选路径，不通有降级兜底」，并补"黑帧触发降级"的实测项。
- **NIT-1（arm64/universal 承诺与 x64-only 冲突）— 已修**。`build.mac.target` 改为 `arch:["x64","arm64"]`（qrcode 纯 JS 可跨产出），§12 prose 同步对齐为「本机只验 x64、arm64 由 CI 产出需用户反馈」。
- **NIT-2（未回应 GitHub 查重/差异化）— 已修**。§1 新增「产品定位」段，明确本地局域网 + 自带 key + 无隐身的收敛，并把 index-4 对 InterviewCoder 隐身特性的对比显式收口为「坚决不做」；§3 README 结构加「与同类项目的差异」小节。
- **NIT-3（§6 openai_chat body 未列 model/max_tokens）— 已修**。§6 openai_chat 项补全 body 的 `model`/`max_tokens`，并点明「与 anthropic 分支取值相同，仅 content 块与 anthropic-version 头不同」。

