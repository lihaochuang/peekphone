# PeekPhone Electron App — 实现评审

PeekPhone 把已跑通的 Python 原型（`screencapture`+多 provider 调用+局域网看图）重写成常驻 Electron 托盘 App，技术栈、模块分解、安全模型全部落在 design.md 锁定的边界内。LLM 层双格式+重试、手机服务 latest-only+token 鉴权+防穿越、无内置凭证、无隐身/反检测代码，七个硬性检查项逐一命中。coder 的 verification.md 给出了真图（抽样 3983 色，非黑）、模型回复原文、curl 200/403、103MB dmg 装跑的完整证据，可信。

Watch for: 无阻塞项。一个 NIT —— verification.md 的截图走的是 `screencapture` 首选路径（本机已持屏幕录制权限），没有强制制造黑帧来实跑 `desktopCapturer` 降级分支；降级代码已 code-review 过，属 design §13.1 已声明的待实测点，不阻塞。

**Verdict**: APPROVED

## High-level view

LLM 层（`llm.js`）逐函数对应原型 `llm.py`：`resolveProvider` 拼 `/v1/messages`（anthropic）或 `/chat/completions`（openai），`buildPayload` 两格式分流，`tryProvider` 用内置 fetch + `AbortSignal.timeout`，RETRY_STATUS=[408,429,500,502,503,504] 内退避重试、权限类状态码直接 break，全失败抛聚合 `ModelError`。凭证只从传入 config 读，不打印 Authorization。

手机服务（`server.js`+`store.js`+`page.js`）照搬原型契约：监听 `0.0.0.0`，每请求现读 `config.getToken()`（不缓存，保证重置即时生效），`timingSafeEqual` 等长常量时间比较，缺/错 token 一律 403。`/img` 路由靠 `store.resolveImagePath` 白名单文件名 + realpath 边界双重挡穿越。页面 `setInterval(tick,2000)` 轮询 `/latest`，key 变即 reload，只渲染最新一条。

凭证面干净：仓库默认 provider 的 base_url/api_key/model 全空，token 默认空、运行时 `crypto.randomBytes(18).base64url` 生成。git grep 全仓库无 `sk-`/Bearer/KiroAdmin key/反代地址。.gitignore 拦 node_modules/dist/out/config.json/history/prompts/webhook.txt。

交互面完整：三套通用定位提示词（default/code/data，非原型答题器）、默认热键 ⌘⌥P、托盘五项菜单、设置 UI 含「测试识别（真截屏+真调模型）」按钮、二维码（`QRCode.toDataURL`）、首启一次性安全提示（`noticeAcknowledged` 门控）。

打包/CI：electron-builder 产 mac dmg（x64+arm64）、win nsis；GitHub Actions matrix macos-latest+windows-latest，tag 触发 Release。README 诚实声明未签名、Windows/arm64 包仅 CI 构建未本机实测、Gatekeeper/SmartScreen 绕过指引。

反检测面：无。grep 无 `setContentProtection`/`skipTaskbar`/stealth/invisible/click-through。`app.dock.hide()` + `LSUIElement:true` 是常规纯托盘行为，design 已明确区分，非隐身。

<details>
<summary>Issues (1)</summary>

1. **降级分支未实跑验证（NIT，不阻塞）** — verification.md 的截图证据走 `screencapture` 首选路径成功，未强制黑帧触发 `desktopCapturer` 降级；降级代码已评审，属 design §13.1 声明的待对应平台/场景实测点。后续可在无屏幕录制权限的打包 `.app` 上补一次实测。

</details>

<details>
<summary>Details</summary>

### 1. LLM 双格式 + 重试（item 1）✓

`llm.js` 的 `buildPayload` 对 `anthropic_messages` 发 `content:[{type:'text'},{type:'image',source:{type:'base64',media_type,data}}]` + `anthropic-version` 头；对 `openai_chat` 发 `image_url:{url:'data:<mediaType>;base64,...'}`、无 anthropic 头，两分支 model/max_tokens 取值一致，与 design §6 完全对齐。`tryProvider` 的重试语义正确：非 2xx 读 body 前 500 字记录，状态码不在 RETRY_STATUS 即 break（权限/模型未关联重试无意义），网络异常/超时/TypeError 归可重试，空文本按失败 break，退避 `min(2**(attempt-1),8)` 秒。`extract` 用防御式取值（NIT-1），畸形 body 返回空而非误入重试。

### 2. 手机服务契约（item 2）✓

`server.js` 监听 `0.0.0.0:<port>`，`authed()` 现读 token 不缓存、长度不等直接否、`timingSafeEqual` 比较，缺/错返回 `403 需要带 ?t=<token> 访问`。`/latest` 返回 `{key:latestKey()}` 带 `Cache-Control:no-store`，`latestKey` = `name|state`，pending→done 也变 key 触发刷新。`page.js` `setInterval(tick,2000)` + `document.hidden` 跳过 + visibilitychange 回前台立拉，只渲染最新一条。

`/img` 防穿越是两层：`resolveImagePath` 先白名单 `file∈{shot.jpg,shot.png}`、拒绝 slot 含 `/`/`\\`/以 `.` 开头，再 `path.resolve` 字符串前缀校验 + `fs.realpathSync` 边界校验，最后确认 isFile。verification 实测 `/img/../../config.json` → 404。

### 3. 无凭证泄漏 + .gitignore（item 3）✓

`config.js` defaults() 的 provider base_url/api_key/model 全空字符串，server.token 默认空、运行时生成。全仓库 git grep `sk-`/`Bearer <token>`/`KiroAdmin`/`a364fca9`/`localhost:3001`/`hellobike` 无命中。.gitignore 覆盖 node_modules/dist/out/*.log/.DS_Store 及 /config.json /history/ /prompts/ /webhook.txt 双保险。build/ 下图标是故意提交的静态资源（design §9「默认提交图标」），非违规。

### 4. 提示词/热键/托盘/设置UI/QR/首启提示（item 4）✓

`prompts.js` 三套 default/code/data 为通用屏幕/代码/数据定位（非原型被改的北森答题器，符合 design §11 决策）。默认热键 `CommandOrControl+Alt+P`（⌘⌥P），config/settings 三处一致。托盘 `buildFromTemplate` 五项齐全（立即截图含当前提示词名/切换提示词子菜单/显示手机二维码/打开设置/退出）。设置 UI 有 `testBtn`「测试识别（真截屏+真调模型）」→ `ipc testRecognition`（草稿配置、不走 pipeline、不建 slot、不刷 latest）。二维码 `QRCode.toDataURL`。首启 `dialog.showMessageBox` 由 `noticeAcknowledged` 门控，确认后写 true。

### 5. electron-builder + CI 诚实声明（item 5）✓

package.json build 配 mac dmg（arch x64+arm64）、win nsis、`LSUIElement:true`、`NSScreenCaptureUsageDescription`、dmg sign:false。`.github/workflows/build.yml` matrix macos-latest+windows-latest，npm ci→npm run dist→upload-artifact，tag 触发 `softprops/action-gh-release@v2`，不配签名 secret。README 第 29/68/71 行诚实标注未签名、Windows/arm64 仅 CI 构建未本机实测需用户反馈、Gatekeeper/SmartScreen 绕过、开机自启未签名受限。

### 6. 无隐身/反检测（item 6）✓

grep 全 src 无 `setContentProtection`/`skipTaskbar`/`setVisibleOnAllWorkspaces`/stealth/invisible/click-through/anti-detect。`page.js` 里 `document.hidden` 两处是轮询暂停优化（design 明文要求），非隐身。`main.js` 的 `app.dock.hide()` + `LSUIElement:true` 是常规纯托盘 App 行为，design §1/§9/§14 多处明确与反检测划清界线。用户在 index-4 明确否决的 InterviewCoder 那套特性，仓库一行都没有。

### 7. 真机验证证据可信（item 7）✓

verification.md 八条 (a)-(h) 俱全且具体：(a) npm install 退 0（含 Electron 镜像重解压的诚实记录）；(c) 真图 size=172507 bytes、抽样 3983 色远超纯黑约 1 色阈值；(d) 两条路径（测试识别 + 主热键）真调模型，回复原文准确描述钉钉群聊屏幕内容；(e)(f) curl 带 token 200 / 不带 403 / 穿越 404 / 重置后旧 token 403 新 token 200；(g) 三套提示词各截一次均 done + 并发第二次被 inFlight 挡；(h) `electron-builder --mac dmg --x64` 产出 103MB dmg，hdiutil 挂载→拖装→open 启动→纯托盘→改端口后 curl 200/403，并顺带验到 EADDRINUSE 不崩。密钥全程运行时从原型 config 读、未落盘。证据与代码一致，可信。

</details>

<details>
<summary>File map</summary>

- `src/main/llm.js` — 双格式+重试模型调用层，无凭证打印
- `src/main/server.js` — 0.0.0.0 http 服务，token 现读、403、/img 防穿越
- `src/main/store.js` — slot 落盘/读取/purge + resolveImagePath 边界校验
- `src/main/page.js` — 手机页面，2s 轮询、三态、HTML 转义
- `src/main/capture.js` — mac screencapture+sips 首选 / desktopCapturer 降级，黑帧检测
- `src/main/config.js` — 配置读写，默认空凭证、运行时生成 token
- `src/main/pipeline.js` / `tray.js` / `shortcut.js` / `windows.js` / `ipc.js` / `net.js` / `prompts.js` / `main.js` — 编排/托盘/热键/窗口/IPC/局域网IP/提示词/入口
- `src/preload/preload.js` — contextBridge 白名单
- `src/renderer/settings.{html,css,js}` — 设置 UI，含测试识别按钮
- `package.json` / `.github/workflows/build.yml` — electron-builder + CI
- `README.md` / `说明.md` / `LICENSE` / `.gitignore` — 文档与忽略规则
- 全量 diff：`git show d15bb11`

</details>
