# PeekPhone 实现计划（Implementation Plan）

> 蓝本：`.agents/tasks/design.md`（已评审 APPROVED，技术栈与架构锁定，本计划只排顺序、不重做决策）。
> 原型：`/Users/harry/诺亚方舟/任务档案/20261021_截图问AI`（Python，已跑通，逐函数照搬）。
> 仓库根：`/Users/harry/诺亚方舟/任务档案/20261021_PeekPhone桌面App`（已 git init，无 remote）。
> 运行环境：本机 macOS Intel x64，Node v24.17.0 / npm 11.13。
>
> 顺序原则：先建纯 Node 可单测的模块（net/store/page/llm），再建 Electron 耦合模块与主进程装配，最后打包/CI/文档/集成验证。每一项完成后代码库都能 `npm install` + `npm start` 不崩。
>
> **强制验证证据**：§19 的集成验证清单必须把每条结果写进 `.agents/tasks/verification.md`，reviewer 直接读该文件核验。关键能力项（截图、调模型、手机服务契约）在引入它的步骤里先就地验一次，失败早暴露。
>
> **密钥红线（全程）**：验证时需要的 Anthropic key 只在运行时从原型 `/Users/harry/诺亚方舟/任务档案/20261021_截图问AI/config.json` 读取，**绝不写进本仓库任何文件、config、日志、commit，也不打印到终端**。仓库默认 provider 的 key/base_url/model 一律留空。

## 实现计划

- [ ] 1. 建项目骨架 package.json：name=peekphone、productName=PeekPhone、version=0.1.0、main=src/main/main.js，scripts（start/dist/dist:mac/dist:win 见 design §12），dependencies 只 `qrcode@^1.5`，devDependencies `electron@^33` + `electron-builder@^25`；先放最小 build 字段，§16 再补全。随后 `npm install` 生成并提交 lockfile。
      Files: package.json, package-lock.json
      Verify: `npm install` 退出 0；`npx electron --version` 打印 33.x；`node -e "require('qrcode')"` 无报错。

- [ ] 2. 建 .gitignore（design §9：node_modules/ dist/ out/ *.log .DS_Store 及 /config.json /history/ /prompts/ /webhook.txt 双保险）、LICENSE（MIT，占位版权人 PeekPhone contributors）、build/ 图标占位（icon.icns / icon.ico / tray/trayTemplate.png + @2x + tray.ico，可先用占位图，最终图标实现期补；electron-builder 缺图标会用默认图标，不阻塞构建）。
      Files: .gitignore, LICENSE, build/icon.icns, build/icon.ico, build/tray/trayTemplate.png, build/tray/trayTemplate@2x.png, build/tray/tray.ico
      Verify: `git status --short` 不出现 node_modules/dist；`ls build build/tray` 列出图标文件。

- [ ] 3. 实现 net.js（纯 Node）：`lanIP()` 用 `os.networkInterfaces()` 取 `family==='IPv4' && !internal`，优先 192.168/10/172.16-31 私网段、排除 169.254，取不到退回 127.0.0.1；`phoneURL(ip,port,token)` 组 `http://ip:port/?t=token`。移植 serve.py `lan_ip()`，只用 IP 不用 .local。
      Files: src/main/net.js
      Verify: `node -e "const n=require('./src/main/net');console.log(n.lanIP(), n.phoneURL('1.2.3.4',8765,'tok'))"` 打印本机真实局域网 IP（非 127.0.0.1，除非确无网卡）和拼好的 URL。

- [ ] 4. 实现 store.js（纯 Node，历史根目录作参数或从 paths 注入以便单测）：移植 serve.py 的 slot 结构与 peek.py 的 purge。导出 newSlot(name)、saveImage(slot,buffer,ext)（落 shot.<ext>）、saveAnalysis、saveError、latest()（目录名倒序取第一个）、latestKey()（'name|state'，无记录 'empty'）、readSlot()（analysis→done / error→error / 否则 pending；找图先 shot.jpg 再 shot.png）、purge(keepDays)、resolveImagePath(slot,file)（只允许 shot.jpg/shot.png，realpath 必须仍在 history 内，否则抛/返回 null）。
      Files: src/main/store.js
      Verify: 临时 node 脚本指向 /tmp 临时 history 根，建一个 pending slot→latestKey 含 '|pending'，写 analysis→readSlot 为 done，resolveImagePath 传 '../../etc/passwd' 或 'analysis.md' 返回 null/拒绝，传 shot.jpg 返回真实路径。断言通过。

- [ ] 5. 实现 page.js（纯 Node）：逐字移植 serve.py 的 PAGE 模板、pretty()（20261021_125058_default→12:50:58 · default）、三态文案（done 自动刷新中 / pending 分析中 / error 出错了）、2 秒轮询 JS（document.hidden 跳过、visibilitychange 回前台立即拉）、深浅色、只显示最新一条、自写 HTML escape。导出 renderPage(item,token) 和 renderEmpty()。token 与 key 经 JSON.stringify 注入脚本，图片 URL 带 ?t=token。
      Files: src/main/page.js
      Verify: `node -e` 调 renderPage 传一个 done item + token，输出 HTML 含 `setInterval`、`/latest`、转义后的标题、`/img/.../shot.jpg?t=`；传含 `<script>` 的文本确认被转义；renderEmpty() 含“按快捷键截一张”。

- [ ] 6. 实现 llm.js（纯 Node，移植 llm.py，去掉 env/钉钉读取）：导出 analyze(imageBuffer, mediaType, prompt, config)→{text,raw,via}。内部 resolveProvider（base_url 去尾斜杠，anthropic_messages→/v1/messages、openai_chat→/chat/completions；token 直取 p.api_key；缺 base_url/model/token 抛“配置不全，缺 X”跳过该 provider；timeout 默认 120、retries 默认 3）、buildPayload（两格式与 design §6 完全一致，openai_chat 的 model/max_tokens 与 anthropic 相同，仅 content 块 image_url vs image 和 anthropic-version 头不同）、extract（anthropic 拼 content 里 type==='text'；openai 取 choices[0].message.content；空文本视为失败）、tryProvider（fetch + AbortSignal.timeout；RETRY_STATUS=[408,429,500,502,503,504]；非重试状态码 break；网络/超时/TypeError 归可重试；指数退避 min(2**(attempt-1),8) 秒；via='<name>（<model>，第<attempt>次成功）'）；全失败抛 ModelError 聚合每 provider 完整错误。日志绝不打印 Authorization 头。
      Files: src/main/llm.js
      Verify: 见 §18 强制项的真实调模型（§10 顺带就地验一次）——用 localhost:3001 反代真调一次返回文本即证明本模块通。本步可先 `node -e "require('./src/main/llm')"` 确认加载无语法错。

- [ ] 7. 实现 config.js（Electron 耦合）：唯一配置读写入口，路径 app.getPath('userData')/config.json。首次无文件写 design §8 默认形状并用 `crypto.randomBytes(18).toString('base64url')` 生成 server.token，写后 chmod 0o600。导出 get()/update(patch)/getToken()。默认 provider 的 base_url/api_key/model 全空。
      Files: src/main/config.js
      Verify: §15 主进程装配后 `npm start`，确认 userData（mac ~/Library/Application Support/PeekPhone/）生成 config.json、含随机 token、权限 600、默认字段齐全。

- [ ] 8. 实现 prompts.js（Electron 耦合）：内置 default/code/data 三套默认提示词常量，按 design §11 原始通用定位撰写（default=通用屏幕解读；code=代码报错排查；data=图表数据解读；各几百字中文，**不采用**原型被改成北森测评答题的 default.txt）。首启把三套写进 userData/prompts/<name>.txt；读写以文件为准，每次截图现读。导出 list()/read(name)/save(name,text)/remove(name)/seedDefaults()。
      Files: src/main/prompts.js
      Verify: §15 启动后确认 userData/prompts/ 生成 default.txt/code.txt/data.txt，内容为通用定位非答题器。

- [ ] 9. 实现 capture.js（Electron 耦合，design §5 平台分流）：导出 capture()→{buffer,mediaType,ext}，三者随真实格式联动（契约铁律，禁写死）。mac：captureMacScreencapture()（`screencapture -x -D 1` 到临时 png→returncode!=0/空/全黑检测失败则 return null；`sips -Z 1200 -s format jpeg -s formatOptions 70` 成功→{jpeg,'image/jpeg','jpg'}，sips 失败→读原 png {png,'image/png','png'}）；首选返回 null 则降级 captureViaDesktopCapturer()（desktopCapturer getSources thumbnailSize=主屏真实像素→nativeImage.resize(长边1200).toJPEG(70)→{jpeg,'image/jpeg','jpg'}）；两条皆 null 抛含“检查屏幕录制权限”的 Error。win：直接 captureViaDesktopCapturer()。全黑检测用 nativeImage 读像素廉价判定。
      Files: src/main/capture.js
      Verify: §19 强制项真实截图——截一张经 sips/resize 的 JPEG，检查文件非空且非纯黑（比照原型：读像素统计颜色数，纯黑约 1 色，真图数百色以上），肉眼可读。

- [ ] 10. 实现 server.js（Electron 耦合，移植 serve.py Handler）：http.createServer 监听 0.0.0.0:<port>。每请求现读 config.getToken()（**不缓存**，保证重置 token 立即生效），用 crypto.timingSafeEqual 等长比较，缺/错 token→403 纯文本。路由：GET /latest→{key:latestKey()} + Cache-Control:no-store；GET /img/<slot>/<file>→仅 shot.jpg/shot.png、slot 不含 / 不以 . 开头、realpath 在 history 内，否则 404；GET /→page.js 渲染。导出 start()/stop()/restart(port)；EADDRINUSE 捕获不崩，restart 新端口失败时保留旧 server 并回报。
      Files: src/main/server.js
      Verify: §19 强制项手机服务契约（就地先验）——启动后 `curl 'http://127.0.0.1:<port>/?t=<token>'`→200 页面、`curl 'http://127.0.0.1:<port>/'`（无 t）→403、`curl '.../latest?t=<token>'`→JSON key、`curl '.../img/<slot>/../../config.json?t=<token>'`→404。

- [ ] 11. 实现 pipeline.js（Electron 耦合，移植 peek.py main() 去钉钉）：导出 runCapture(promptName)。流程：解析提示词名+现读文本→store.newSlot(先 pending)→刷新 /latest key→capture()→store.saveImage(slot,buffer,ext)→llm.analyze(buffer,mediaType,prompt,config)（mediaType 透传）→成功写 analysis、失败写 error→purge(keepDays)。模块级 inFlight 布尔：入口若 true 弹通知“正在处理上一张，稍等”并 return（不排队不并发），finally 复位。任一步失败落 error 态 + Electron Notification 弹桌面通知不静默。purge 在启动跑一次、每次成功建 slot 后再跑一次。
      Files: src/main/pipeline.js
      Verify: §19 端到端——触发 runCapture，slot 由 pending→done，/latest key 变化，手机页面显示截图+分析；连续两次快速触发第二次被 inFlight 挡下。

- [ ] 12. 实现 shortcut.js + tray.js（Electron 耦合）：shortcut.js 导出 register(accelerator,handler)/reregister(newAccelerator)，注册失败（被占/非法）返回 false。tray.js 用 Tray+Menu.buildFromTemplate 建菜单：立即截图（当前提示词：<name>）→pipeline.runCapture(currentPrompt)、切换提示词 ▸ 子菜单（radio 勾当前，选中改 config.currentPrompt）、显示手机二维码→开设置切手机连接页、打开设置、退出→app.quit()。mac 用 trayTemplate.png 并 setTemplateImage(true)，win 用 tray.ico。
      Files: src/main/shortcut.js, src/main/tray.js
      Verify: §19——`npm start` 后托盘出现，菜单项齐全；按默认热键 ⌘⌥P 触发一次截图链路；切换提示词后托盘“当前提示词”更新。

- [ ] 13. 实现 windows.js + preload.js + ipc.js（Electron 耦合）：windows.js 创建/复用设置 BrowserWindow（已开则 focus，contextIsolation:true、nodeIntegration:false、加载 preload）。ipc.js 注册 ipcMain.handle：getConfig/updateConfig/listPrompts/savePrompt(name,text)/removePrompt/testRecognition(draftConfig)/setHotkey/getPhoneConnection（返回 {url,qrDataUrl}，qrcode.toDataURL 生成）/setLoginItem/ackNotice。testRecognition 用 UI 传入的草稿配置、独立 testInFlight 锁、不走 pipeline/不建 slot/不刷新 latest，内存里 capture→llm.analyze 回传文本。preload.js 用 contextBridge.exposeInMainWorld('api',{...}) 只暴露白名单 Promise 方法，不暴露 ipcRenderer 原件。设置变更运行时生效按 design §7 表：端口→server.restart、token→现读即生效、热键→reregister、提示词→现读、provider/key→下次 runCapture 现读、开机自启→setLoginItemSettings。
      Files: src/main/windows.js, src/preload/preload.js, src/main/ipc.js
      Verify: §19——打开设置窗口不报错；window.api 各方法可调；getPhoneConnection 返回可显示的 data URI。

- [ ] 14. 实现设置 UI renderer（纯 HTML/CSS/JS 无框架，design §10）：五区——①模型配置（预设下拉四项→自动填 format/base_url/model，可编辑 base_url/api_key[password+眼睛切明文]/model/format 单选，「测试识别」按钮调 testRecognition 显示模型回复或聚合错误）；②提示词管理（列 userData/prompts/*.txt，三默认可编辑、可新增、可删自定义，保存即写文件）；③快捷键（捕获按键转 accelerator，保存试注册，失败提示换键）；④手机连接（二维码 img + URL 文本 + 复制 + 重置 token + 端口设置）；⑤通用（开机自启开关、历史保留天数、压缩长边/质量）。经 window.api.* 调 IPC 全 Promise 化。
      Files: src/renderer/settings.html, src/renderer/settings.css, src/renderer/settings.js
      Verify: §19——设置界面可开；测试识别真调模型返回文本；切换全部三套提示词；重置 token 后旧链接 403；改端口后 server 重启、新 URL 可访问。

- [ ] 15. 实现 main.js 主进程装配（Electron 耦合）：app.requestSingleInstanceLock() 单实例（第二次启动退出）。app.whenReady() 后依次：config 加载→server.start()→shortcut.register(热键,→runCapture)→tray 建→首启一次性 dialog.showMessageBox（noticeAcknowledged===false 时弹“截图会发送给第三方 AI，勿截敏感/公司内部内容”+mac 屏幕录制授权指引，确认后写 true）。mac app.dock.hide()（纯托盘，非反检测）。will-quit 时 globalShortcut.unregisterAll() + server.stop()。window-all-closed 不 quit（托盘常驻）。启动时 purge 跑一次。
      Files: src/main/main.js
      Verify: `npm start` 全功能启动——托盘出现、热键生效、手机页面可访问、首启提示只弹一次（再启不弹）、config.json/prompts/ 已在 userData 生成。此时 §7/§8/§10 的 Verify 一并成立。

- [ ] 16. 补全 package.json 的 electron-builder build 配置（design §12）：appId=com.peekphone.app；files=[src/**,build/**,package.json]；mac target dmg arch [x64,arm64]、category productivity、icon build/icon.icns、extendInfo（NSScreenCaptureUsageDescription + LSUIElement:true）；win target nsis、icon build/icon.ico；dmg sign:false。随后本机构建一次 mac dmg。
      Files: package.json
      Verify: §19 强制项——`npm run dist:mac` 产出 dist/*.dmg（x64 可本机验），挂载→拖装→启动→托盘出现→热键生效→手机页面可访问。arm64 包本机不验（README 标注需 Apple Silicon 用户反馈）。

- [ ] 17. 建 CI 工作流 .github/workflows/build.yml（design §12）：触发 push tag v* 构建并发 Release、PR/push 主分支只构建+上传 artifact。matrix macos-latest+windows-latest。步骤 checkout→actions/setup-node@v4(node 20+)→npm ci→npm run dist→actions/upload-artifact 传 dist/*.dmg|*.exe。tag 触发用 softprops/action-gh-release 附两平台产物，GITHUB_TOKEN 自动注入，不配任何签名/公证 secret。
      Files: .github/workflows/build.yml
      Verify: 若有 actionlint 则 `actionlint .github/workflows/build.yml` 通过；否则 `node -e "require('js-yaml')"` 不可用时用 `python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/build.yml'))"` 确认 YAML 合法、matrix/steps 结构齐全。

- [ ] 18. 写 README.md（中英双语）+ 工作目录 说明.md：README 含安装、填 key、扫码连手机、「与同类项目的差异」小节（本地局域网+自带 key+无隐身，显式对比并否决 InterviewCoder 那套反检测）、已知限制（不做隐身/反检测、不支持纯修饰键双击如 ⌘⌘、只截主屏、未签名 Gatekeeper/SmartScreen 绕过指引、arm64/Windows 包由 CI 构建需用户反馈）、安全说明（0.0.0.0 监听+token 唯一防线+明文 HTTP 只在可信网络用）、key 存 userData 不进仓库。说明.md 记本任务工作目录背景、与原型关系、如何本地跑。LICENSE 已在 §2。
      Files: README.md, 说明.md
      Verify: `grep -i` 确认 README 含“与同类项目的差异/差异”“已知限制”“屏幕录制/Screen Recording”“token”“Gatekeeper”各节；说明.md 存在且非空。

- [ ] 19. 集成验证并落证据到 .agents/tasks/verification.md（强制，reviewer 直接读）：逐条跑并记录结果——(a) `npm install` 成功；(b) `npm start` 全功能启动；(c) 真实截图非黑（文件大小 + 颜色数统计，纯黑约 1 色 vs 真图数百色+）；(d) 经本机反代 base_url=http://localhost:3001、provider=Anthropic 兼容、model=claude-sonnet-4-5、stream 关、key 运行时从原型 config.json 读（不入仓库/日志）真调模型返回文本；(e) `curl` 带 token→200、不带→403；(f) /latest 轮询 + 改 token 后旧链接 403、新 token 生效；(g) 三套提示词全切换各截一次；(h) `npm run dist:mac` 产出 x64 dmg 能装能跑。每条记命令、输出摘要、通过/失败。密钥全程不落盘不打印。
      Files: .agents/tasks/verification.md
      Verify: verification.md 存在且 (a)-(h) 八条均有证据与结论；任一失败需记录根因与处理（截图首选失败须证明已降级 desktopCapturer 出真图）。

## 已知假设与待实现期核对（design §13，不阻塞编码）

- mac 打包 .app 的 screencapture 子进程能否截真图（TCC 归属跨版本不一），不通走 desktopCapturer 降级——§9/§19 实测。
- 预设智谱/百炼的 base_url 与 model 名需核对各家最新文档（错了用户“测试识别”会报错，不影响架构）。
- Node fetch 连接重置的异常形态确认都归“可重试”（§6），测试识别真调一次验证。
- 默认热键 ⌘⌥P 是否被占用（注册返回值检查，占用提示换键）；未签名 mac App 开机自启可能受限（UI/README 标注）。
- 多网卡（VPN/虚拟网卡/Docker）IP 选取可能偏差，必要时 UI 提供手动选 IP 兜底（可选增强）。
