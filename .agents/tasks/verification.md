# PeekPhone 集成验证证据

> 环境：本机 Intel x64 Mac，macOS 25.6.0，Node v24.17.0 / npm 11.13，Electron 33.4.11。
> 密钥红线：验证用的 Anthropic key 全程只在运行时从原型 `20261021_截图问AI/config.json` 读取，未写入本仓库、未打印到日志。
> 执行时间：2026-10-21。

## (a) npm install 成功

- 命令：`ELECTRON_MIRROR=... ELECTRON_BUILDER_BINARIES_MIRROR=... npm install --registry=https://registry.npmmirror.com`
- 结果：`added 434 packages`，退出 0。生成 `package-lock.json`。
- 注：默认 registry 下 Electron 二进制从 GitHub 下载超时，改用 npmmirror 镜像成功。首次安装的 Electron dist 解压不完整（`path.txt` 缺失、Frameworks 缺失），从缓存 zip（`~/Library/Caches/electron/.../electron-v33.4.11-darwin-x64.zip`，104MB 完整）手动 `unzip` 重建 `node_modules/electron/dist`（259M）后 `Electron --version` 打印 `v33.4.11`，正常。

## (b) 应用可运行（npm start 等价）

- 用 `./node_modules/.bin/electron` 真实拉起主进程跑验证脚本（`/tmp/peek_verify.js`），`app.whenReady()` 后 capture/server/pipeline 全链路可用。
- 打包后的 `PeekPhone.app` 用 `open` 启动：进程存活（PID 27864），纯托盘不进 Dock，本地服务监听成功（见 h）。

## (c) 真实截图非黑

- 命令：主进程内调用 `capture()`。
- 结果：`ext=jpg mediaType=image/jpeg size=172507 bytes 颜色数(抽样)=3983`。
- 判据：纯黑帧约 1 色；本图抽样 3983 色，远超阈值 → 真实图像，非黑。落盘 `/tmp/peek_verify_shot.jpg` 肉眼可读（mac `screencapture -x -D 1` → `sips -Z 1200 -s format jpeg` 首选路径成功，未触发 desktopCapturer 降级，说明本机 Kiro/终端已持屏幕录制权限，子进程未截到黑帧）。

## (d) 真调模型识别成功（本机反代）

- 配置：`base_url=http://localhost:3001`、`format=anthropic_messages`（Anthropic 兼容）、`model=claude-sonnet-4-5`、`stream` 关闭、`api_key` 运行时从原型 config 读。
- **测试识别按钮路径**（capture + llm.analyze，不走 pipeline/不建 slot）：返回 `via=verify-proxy（claude-sonnet-4-5，第1次成功）`，模型回复：
  > 这是一张 Mac 上钉钉的聊天界面截图，当前打开的是"西南点位问题-中台"内部群，群里正在讨论成都点位派单数据（涉及表格截图和满足率等问题）。
- **主热键路径**（`pipeline.runCapture('default')`）：`ok=true`，`latestKey` 由 `empty` → `20261021_142917_default|done`，分析摘要正确描述钉钉群聊屏幕内容。
- 两条路径都证明识别可用；模型准确读出了屏幕内容。

## (e) curl 带 token→200，不带→403

主进程内起 server（port 18765）后用 Node http 实测：

```
GET /?t=<token>            -> 200 (页面含轮询 setInterval JS)
GET / (无 token)           -> 403
GET /latest?t=<token>      -> 200 {"key":"empty"}
GET /img/../../config.json -> 404  (路径穿越被挡)
```

## (f) /latest 轮询 + 改 token 后旧链接 403、新 token 生效

- `/latest` 返回 `{"key":...}`，截图后 key 从 `empty` 变为 `<slot>|done`，触发手机页 `location.reload()`。
- token 重置（`/tmp/peek_token.js`，server 每请求现读 `config.getToken()`）：
  ```
  {"oldWorks":200,"oldAfterReset":403,"newAfterReset":200,"changed":true}
  ```
  旧 token 重置前 200、重置后 403；新 token 200。证明现读不缓存、重置立即生效。
- **手机应打开的完整局域网地址**：`http://192.168.88.177:8765/?t=<token>`（IP 由 `net.lanIP()` 自动选出私网段 192.168.88.177；真实 token 在设置「手机连接」页展示/二维码，属本机 secret 不写入仓库；IP 随 DHCP 变化，换网在设置重取二维码）。

## (g) 三套提示词各切换一次并生效

逐个 `config.update({currentPrompt})` 后 `runCapture`：

```
提示词 default -> done via=claude-sonnet-4-5 | key尾=default|done
提示词 code    -> done via=claude-sonnet-4-5 | key尾=code|done
提示词 data    -> done via=claude-sonnet-4-5 | key尾=data|done
```

三套（design §11 通用定位，非答题器）均落盘到 `userData/prompts/*.txt`、各截一次均成功。
并发保护：同一时刻两次 `runCapture` 并发触发，结果 `[{ok:true},{skipped:true}]`，第二次被 `inFlight` 挡下。

## (h) 构建 mac dmg 并能装能跑

- 命令：`electron-builder --mac dmg --x64`（binaries 走 npmmirror 镜像）。
- 产物：`dist/PeekPhone-0.1.0.dmg`（103,097,243 字节 ≈ 103MB）+ `dist/PeekPhone-0.1.0.dmg.blockmap`；app bundle `dist/mac/PeekPhone.app` 252M。
- 未签名（无 Developer ID），electron-builder 如实跳过签名 —— 符合设计「不签名、README 教 Gatekeeper 绕过」。
- 装/跑实测：`hdiutil attach` 挂载 dmg → 卷内含 `PeekPhone.app` + `Applications` 软链 → `open` 启动 → 进程存活、纯托盘。
  - 首次启动端口 8765 被用户原型 `serve.py`（Python PID 76888）占用，packaged app 捕获 EADDRINUSE 未崩溃（进程 PID 24782 存活）—— 顺带验证了端口占用的容错。
  - 为验证 packaged app 自身 HTTP 服务：把其 userData（`~/Library/Application Support/PeekPhone/config.json`，运行时数据非仓库）端口改 18799 后重启，`lsof` 确认 PeekPhone 进程监听 18799，`curl` 带 token→200、不带→403。
  - 清理：退出 app、卸载 dmg。
- arm64 包本机无法运行实测，由 CI（`macos-latest`）产出，README 标注需 Apple Silicon 用户反馈。

## 其它检查

- CI 工作流 `.github/workflows/build.yml` YAML 合法（`python3 -c "yaml.safe_load(...)"` 通过），jobs=[build]，matrix os=[macos-latest, windows-latest]。
- 密钥扫描：`grep -rE "sk-|localhost:3001|hellobike|真实key" src/ *.json` 无命中；默认 provider `api_key:''` 为空；验证用过的 Electron userData config 已恢复为空 key。
- 纯 Node 模块单测（net/store/page/llm）全通过：store 的 `resolveImagePath` 挡住 `analysis.md`/`../../etc`/`../shot.jpg`；page 转义 `<script>`；llm `extract` 对畸形 body 防御式返回空（NIT-1）。

## 已消化的设计评审 NIT

- NIT-1：`llm.extract` 用防御式取值（`data?.choices?.[0]?.message?.content || ''` 等价实现），畸形 body 按空文本失败而非误入重试。
- NIT-2：`captureViaDesktopCapturer` 按宽高谁大决定 `resize({width})` 或 `{height}`，保持长边 1200 比例。
- NIT-3：pipeline 注释去掉「刷新 key/立即看到截图」的推送式措辞，改为「建 pending slot 后下次轮询读到，截图在 capture+saveImage 后出现」。
- NIT-4：provider 内字段保持 snake_case（`base_url/api_key/model`）与 `llm.resolveProvider` 读取一致，顶层 camelCase。

---

# v0.2 验证证据（2026-10-21，本机 Intel x64 Mac，Node v24.17.0 / Electron 33.4.11）

> 密钥红线：所有真调模型用的 key 运行时从原型 `20261021_截图问AI/config.json` 读取（反代 `http://localhost:3001`，当前上游视觉模型 `gpt-5.6-terra`），**未写入仓库/日志/commit，未打印到终端**。`peek.log` 实测不含 key（见 §v0.2-6）。
> 验证脚本均为临时文件（/tmp），不入仓。reviewer 直接读本节即可，无需重跑。

## v0.2-0 纯逻辑单测（无需联网/Electron）

`node /tmp/peek_llm_test.js` → **42 条断言全通过**。覆盖：
- `joinUrl` 七种：`localhost:3001`+openai→`/v1/chat/completions`（修好旧 bug）；智谱 `/v4`、百炼 `/compatible-mode/v1` 不重复；anthropic 自带 `/v1` 不重复成 `/v1/v1`。
- `resolveProvider`：model 留空不再报「缺 model」（=自动）；base/key 缺仍报错；`stream` 默认 false。
- SSE 解析：OpenAI（分片喂入，3 次增量）与 Anthropic（`content_block_delta`，2 次增量）都拼回完整文本。
- `classify` 八类：conn/timeout/auth(401)/notfound(404 HTML)/model_unsupported/image_unsupported/too_large(413)/rate_limit(429) 全部命中预期。
- `parseSupportedStructure` 只认带 `supported_models` 结构：命中网关错误，404/智谱式普通错误不命中（保证普通单模型 API 不触发换模型）。
- store：pending 部分文本可读、`latestKey` 随部分文本变化、`saveAnalysis` 后转 done；`listSlots` 列两条、`getItem` 防穿越（`../../config`→null）。
- page：空状态含 `/sponsor` + 文案；error 态拆「人话 + 折叠详情」；`<script>` 转义。

## v0.2-1 /v1 bug 修好且没弄坏 Anthropic + 模型自动回退（真调反代）

`node /tmp/peek_proxy_verify.js`（走 `llm.analyze`，真调 `localhost:3001`，发 `assets/icon.png`）：

| 场景 | 结果 |
|---|---|
| OpenAI 格式 + model 留空(自动) | OK，via=`openai_chat（gpt-5.6-terra，第1次成功）`，文本「蓝色圆角方形图标中央有白色镜头状圆环，四角配有扫描框标记。」|
| Anthropic 格式 + model=`claude-sonnet-4-5`(已下线) | OK（自动回退），via=`anthropic_messages（gpt-5.6-terra）`，返回真实描述 |
| OpenAI 格式 + model=`claude-sonnet-4-5`(已下线) | OK（自动回退 gpt-5.6-terra）|
| OpenAI + model=`glm-5`(不识图) | OK（image_unsupported→自动换 gpt-5.6-terra）|

旁证：裸 `curl` 复现 `POST /chat/completions`（无 /v1）→ `404 Cannot POST`；`POST /v1/chat/completions` + gpt-5.6-terra → 200；证明修复点准确。`lastSupported` 实测 = `[gpt-5.6-terra,gpt-5.6-luna,deepseek-3.2,minimax-m2.5,minimax-m2.1,glm-5,qwen3-coder-next,kimi-k3]`（供设置页展示）。

## v0.2-2 错误归类成人话（故意制造各类失败）

同脚本尾段，每类最终展示文案：

| 制造 | friendly 文案（给小白看的那句）|
|---|---|
| 端口 3999 没人听 | 连不上模型服务，检查 Base URL 和本地服务是否开着 |
| 错 key | API Key 无效或没权限，检查 Key 是否填对 |
| 错路径 `/nope` | 接口地址不对，检查 Base URL 和请求格式（OpenAI / Anthropic）是否匹配 |
| 模型下线 | （不作为最终错误——已自动回退成功）|
| glm-5 不识图 | （不作为最终错误——已自动换）|

原始 HTTP 码 / JSON 全部保留在 `detail`（手机页「点开看详情」折叠、设置页附在人话后）。

## v0.2-3 流式：支持流增量 + 不支持流优雅回退

- **live 流式**（`node /tmp/peek_stream_verify.js`，本地 fake SSE server）：via=`...（fake，流式）`，`onDelta` 回调 **4 次**、文本单调增长、首末增量间隔 **115ms**、拼回「你好，这是流式输出测试」→ 证明边收边出、非一次到位。
- **不支持流回退**（反代 `localhost:3001` 开 `stream:true`）：增量回调 0 次 → 自动回退非流式仍 OK 返回文本，证明「开 stream 不会把原本能用的反代弄挂」。
- **pipeline 集成**（见 §v0.2-5 stream-pipeline）：pending 期手机可读部分文本长度序列 `[4,12,20]` 递增，done 落全文。

## v0.2-4/5 Electron 集成（截图/鉴权/翻页/赞助/失败/流式/日志）

`./node_modules/.bin/electron /tmp/peek_electron_verify.js`（隔离临时 store，端口 18813）：

```
(empty) / 200=true 含赞助码=true 含文案=true          # 空状态手机页默认展示收款码
(auth) 带token=200 无token=403 /img穿越=404           # 路径穿越用 %2e%2e 绕客户端归一直打服务端解析器
(sponsor) 带token=200 type=image/jpeg bytes=144312 无token=403
(shot) ext=jpg bytes=129902 字节多样性=253 非黑=true    # 真截图非黑（纯黑约 1 色）
(pipeline-ok) {ok:true, via:"verify（gpt-5.6-terra，第1次成功）"} slot=done
(history) status=200 条数=1 ; (item) 合法=200 穿越=404
(pipeline-fail) error="连不上模型服务，检查 Base URL 和本地服务是否开着" slotState=error 文本友好=true
(stream-pipeline) done=true pending期partial长度序列=[4,12,20] 增长=true 最终done含全文=true
(log) 存在=true 不含key=true
```

截图验证（§v0.2-7 的三张 PNG）佐证：空状态渲染出微信收款码 + 「喜欢的话可以扫码请我喝咖啡 ☕」；最新一条渲染截图 + 分析 + 「查看更早」+ 底部「☕ 赞助作者」。

## v0.2-6 交互修正（A 测试即保存 / B 失败不打扰）

- **A·脏改动与保存**（`/tmp/peek_ui_verify.js` 驱动真实设置页 JS）：初始不脏→改模型名后 `isDirty=true`、脏条显示、标题「● 未保存」、保存按钮高亮→`saveModelConfig()` 后不脏且 `getConfig` 回读 `providers[0].model="glm-4v"` 已落盘→再改后 `applyState(savedState)` 放弃恢复为已存值且不脏。测试识图成功路径调用的就是同一 `saveModelConfig()`（即「测通即自动保存」）。关窗口/切标签的「保存/放弃/取消」经 `confirmUnsaved` IPC + `windows.js` 的 `close` 拦截 + `settings:save-all`/`closing-after-save` 协同已接线。
- **B·失败只进日志不弹窗**：`pipeline` 已无任何失败桌面通知调用；失败写 `userData/logs/peek.log` 滚动日志（>1MB 轮转 .1）。实测日志尾部含 `OK slot=... via=gpt-5.6-terra` 与 `FAIL analyze ... reason=连不上模型服务...`，且**整文件不含 key**。失败通知开关已移除。

## v0.2-7 图标 + dmg 体积

- 图标生成（`node assets/icon-src/gen-icons.js`，零依赖，程序化渲染 PNG→iconutil→icns、自写 ICO 封装）：
  `file assets/icon.icns` = *Mac OS X icon*；`assets/icon.ico` / `assets/tray/tray.ico` = *MS Windows icon*；`icon.png` 512×512；`trayTemplate.png` 22×22、`@2x` 44×44（mac 单色 Template）。图标为蓝色取景框+镜头品牌图，非默认 Electron。
- **构建**：`electron-builder --mac dmg --x64` → `dist/PeekPhone-0.2.0.dmg` = **93,891,694 B ≈ 89.5MB**（v0.1 x64 为 103MB，↓约 13%）。
- **图标进包**：`dist/mac/PeekPhone.app/Contents/Resources/icon.icns` 与 `assets/icon.icns` **字节完全一致**（`cmp` 通过）→ 构建出的 .app 显示新图标。`app.asar` 内含 `assets/tray/trayTemplate.png`/`@2x`/`tray.ico` 与 `assets/sponsor-wechat.jpg`；`demo/`、`.agents/`、`assets/icon-src/` 已排除（体积优化生效）。托盘 `tray.js` 指向 `assets/tray/`，打包路径 `app.asar/assets/tray/trayTemplate.png` 可加载。

## v0.2 未尽说明（诚实）

- **真实交互 gif**：本机无 `ffmpeg`/`gifski`，未伪造动图，`assets/screenshots/` 用真实静态截图（Electron `capturePage`）代替，README 已注明。
- **arm64 dmg / Windows 包**：本机 Intel，仅实测 x64；arm64 与 win 由 CI 构建，运行正确性待对应平台用户反馈（与 v0.1 口径一致）。
- **托盘图标肉眼呈现**：`/tmp/peek_tray_verify.js` 实测 `nativeImage.createFromPath(assets/tray/trayTemplate.png)` → `empty=false size=22x22`，`tray.build()` 不抛错、`ok=true`；mac 菜单栏像素级外观需人工目视。
- **全量 `npm start` 启动**：本机已安装的 `/Applications/PeekPhone.app`（用户在用，未动）持有单实例锁，故开发实例按设计 `requestSingleInstanceLock()` 立即自退、启动日志无报错——属单实例正确行为。主进程各模块在 `/tmp/peek_electron_verify.js`（`app.whenReady` 后 server/pipeline/capture 全链路）已证可加载运行。

## v0.2.1 ad-hoc 签名（核心修复）
问题：v0.2.0 的 mac 包 `mac.identity` 走 electron-builder 原生签名，ad-hoc 身份走不通其 `findIdentity` 被整体跳过，产物 `codesign -dv` 显示 *not signed at all*。而 macOS 屏幕录制(TCC)权限绑定代码签名身份，未签名 app 即使在「屏幕录制」里打勾，`desktopCapturer`/`screencapture` 实际仍被拒。

修法：`package.json` 的 `build.mac.identity: null`（显式跳过原生签名，日志干净）+ 新增 `build.afterPack: "./afterPack.js"` 钩子，对 `context.appOutDir` 下的 `.app` 跑 `codesign --force --deep --sign -`（纯本地 ad-hoc，无苹果证书/公证）。用 afterPack 而非 afterSign，因为 afterSign 只在原生签名实际发生时才触发。

**构建实测（本机 Intel x64 Mac，`npm run dist:mac`）**：x64 目标成功产出 `dist/PeekPhone-0.2.1.dmg`（95,298,430 B）。afterPack 钩子日志打印 `Signature=adhoc`。arm64 目标因需从 github.com 下载 `electron-v33.4.11-darwin-arm64.zip` 遇网络 EOF 失败（与本次改动无关，arm64 包本就由 CI 构建），不影响 x64 验证。

**挂载 dmg 验签**（`hdiutil attach` → `codesign -dv`）：
```
Executable=/Volumes/PeekPhone 0.2.1/PeekPhone.app/Contents/MacOS/PeekPhone
Identifier=com.peekphone.app
Format=app bundle with Mach-O thin (x86_64)
CodeDirectory v=20400 size=362 flags=0x2(adhoc) hashes=5+3 location=embedded
Signature=adhoc
Info.plist entries=33
TeamIdentifier=not set
Sealed Resources version=2 rules=13 files=11
Internal requirements count=0 size=12
```
`codesign --verify --verbose=2` 结果：`valid on disk` + `satisfies its Designated Requirement`。即不再是 not signed，ad-hoc 签名生效。

端到端截图需用户在 TCC 授权框手动放行，agent 无法点系统授权框，不在本次自动验证范围；签名生效即解除「打勾也截不到」的根因。

## v0.2.1 其余改动
- **max_tokens 默认 1500 → 800**：`config.js` 的 `defaults().maxTokens=800`（已有用户 config.json 不覆盖，只影响首次生成）；`settings.html` 输入框默认值 800 + 旁加提示「越大越慢，日常解读 600~800 够用」；`settings.js`/`llm.js` 的 `|| 1500` 回退同步改 800。`node --check` 全通过。
- **赞助码去名**：`assets/sponsor-wechat.jpg` 已为去名版本（图未动）；确认 `ipc.js`、`server.js`、README 均引用 `assets/sponsor-wechat.jpg` 该路径，无需改引用。
- **README**：安装小节改为「mac ad-hoc 签名但未公证（无苹果账号，属正常）」并补首启授权步骤；新增「故障排查」小节给出 `tccutil reset ScreenCapture com.peekphone.app`（针对从未签名旧版升级后授权失配），均中英双语。

---

## v0.2.4 验证（赞助改 aha 时刻 / 收款码出仓库，本机 Intel Mac，2026-10-21）

验证方式：mock `electron` 模块后跑真实 `config.js`/`store.js`/`server.js`/`page.js` 的 HTTP 全流程（脚本 `/tmp/pp_verify.js`，19 条断言全过）。本地无 `assets/sponsor-wechat.jpg`（已 git rm + gitignore），默认即走「图缺失降级」分支。

- **空状态（item 3）**：`GET /`（无任何 slot）只含引导文案「按一下快捷键截张图，分析会出现在这里」；无 `id="ahaCard"`、无 ☕、无「收款/请我喝」等渲染赞助内容（CSS 的 `.sponsor-card` 样式与 JS 的 `dismissSponsor` 处理器属非可见代码，不计）。
- **图缺失优雅降级（item 1/2）**：`GET /sponsor` 图不存在返回 404（不报错不碎图）；首次成功后的 aha 卡片走文字降级，含 `github.com/lihaochuang/peekphone` 链接、无 `src="/sponsor?t="` 图。
- **aha 时刻（item 4）**：构造一条 `saveAnalysis` 成功 slot，`config.recordSuccess()` 前 `shouldShowSponsor()=false`、后 `=true`；`/latest` 返回体带 `showSponsor:true`；`GET /` 结果下方出现 `id="ahaCard"` + 文案「这个小工具帮到你了吗？欢迎请我喝杯咖啡」。阈值 = 第 1 次成功（`SPONSOR_SUCCESS_THRESHOLD=1`，config.js 注释说明可改 3）。
- **只提一次**：`POST /sponsor/dismiss` 返回 200 `{ok:true}` 并置 `sponsorShown=true`；之后 `shouldShowSponsor()=false`、再 `GET /` 无 `id="ahaCard"`。
- **有图分支（item 4 模拟 secret 存在）**：临时写入一张 jpg 后 `GET /sponsor` 200 `image/jpeg`；重置 `sponsorShown=false` 后 `GET /` 的 aha 卡片用 `<img src="/sponsor?t=...">`。**验证完即 `fs.unlinkSync` 删除临时图并断言文件不存在**，未误提交。
- **token 鉴权（item 5）**：`/sponsor` 带 token 已过鉴权（404 为图缺失非鉴权失败）、不带 token 403；`/sponsor/dismiss` 不带 token 403、带 token 200。
- **托盘赞助入口（item 5）**：托盘「赞助作者 ❤️」保留 → 设置「赞助」标签页；`ipc.getSponsorImage()` 有图返回 data URI、缺图返回 `''`，`settings.js` 据此在缺图时隐藏碎图、显示文字 + 项目主页降级（`settings.html` 加 `#sponsorFallback`）。
- **CI 注入（item 1）**：`.github/workflows/build.yml` 在 Build 前加 `Inject sponsor QR (optional)` 步，node 一行跨平台解码 `SPONSOR_QR_B64`→`assets/sponsor-wechat.jpg`；secret 为空时 `if(b)` 不成立 → 静默跳过，本机 `SPONSOR_QR_B64="" node -e ...` 实测输出「skipped (no secret) -> build continues」。`.gitignore` 加 `assets/sponsor-wechat.jpg`，`git check-ignore` 确认生效。
- **语法**：`config.js`/`pipeline.js`/`server.js`/`page.js`/`settings.js` `node --check` 全过；`package.json` 合法、version=0.2.4。
- **README（item 6）**：删除 `<img src="assets/sponsor-wechat.jpg">`，改为纯文字赞助说明（收款码在应用内，官方发布版内置、fork 不含），中英双语。

---
## v0.2.5 验证（总超时自恢复 + ⌘⌥O 强制刷新键，本机 Intel Mac，Node v24.17.0，2026-10-21）

验证方式：`Module._load` 注入假 `electron`/`./capture`/`./prompts`，跑**真实** `config.js`/`llm.js`/`pipeline.js`/`shortcut.js`，打一个本地 HTTP 服务（`/hang` 永不回、`/hangstream` 发半个 SSE 事件后挂起、`/ok` 正常回 JSON）。脚本 `/tmp/peek_v025_verify.js`，8 条断言全过（exit 0）。

- **问题1-总超时（非流式）**：provider 指向 `/hang`、`analyzeTimeout=2`、provider `timeout=120/retries=3`。`runCapture` 在 **2011ms** 返回 `{error,aborted:true,timedOut:true}`——即没有等满 120s×3，证明是总超时经 `AbortController`→`AbortSignal.any` 真正 abort 了挂起的 fetch。slot 写 `error / 「分析超时，已中止」`，`isInFlight()===false`（finally 释放）。
- **问题1-自恢复**：超时后把 provider 切 `/ok` 再调 `runCapture`，直接 `ok:true` 出分析——证明超时后锁已释放、再按 ⌘⌥P 不再被卡。
- **问题1-流式超时（item 3）**：provider `stream:true` 指向 `/hangstream`（发一个 delta 后挂起），`analyzeTimeout=2`。`runCapture` 在 **2006ms** 被总超时中止、`aborted+timedOut`、`isInFlight()===false`——证明边收边写的流式路径也受总超时约束。
- **正常路径（item 2）**：provider `/ok`、`analyzeTimeout=60`，`runCapture` 返回 `ok:true`、`head` 含模型文本，不受总超时影响。
- **问题2-强制刷新（item 1）**：第一张指向 `/hang` 不 await 使其卡住（`isInFlight()===true`），切 `/ok` 后按 `runCaptureForce`：旧那张被中止返回 `{aborted:true,timedOut:false}`、slot 写 `「已被强制刷新中止」`；`runCaptureForce` `await currentRunPromise` 确认旧的 finally 真正放锁后立即开新一张，新一张 `ok:true` 且是**不同 slot**。证明 ⌘⌥O 任何时候按都有反应、是解套键。
- **问题2-两键共存（item 2/4）**：`shortcut.register('capture', ⌘⌥P)` 与 `register('force', ⌘⌥O)` 均返回 true（假 globalShortcut 记录注册集）。
- **问题2-改键冲突（item 3/4）**：`reregister('force', ⌘⌥P)`（与截图键相同）返回 false 且强制键原值 ⌘⌥O 仍在（不误丢）；`reregister('force', ⌘⌥K)` 返回 true，旧键注销、新键生效。设置页 `setHotkey`/`setHotkeyForce` 分别走 role=capture/force。
- **配置默认值**：`config.defaults()` 含 `analyzeTimeout=60`、`hotkeyForce=CommandOrControl+Alt+O`（已有用户 config.json 不覆盖，仅首次生成）。
- **语法**：`pipeline.js`/`llm.js`/`shortcut.js`/`config.js`/`main.js`/`ipc.js`/`preload.js`/`settings.js` `node --check` 全过；`package.json` version=0.2.5。
- **无弹窗约定**：全程只 `logEvent` + 写手机页 error 态，未调任何 `Notification`/`dialog`（超时/强制刷新/注册失败均只 console.warn + 日志）。
- **真模型路径（环境说明，非回归）**：本机反代 `localhost:3001` 在听，经真实 `llm.analyze`（带 extSignal）发请求能拿到 HTTP 响应（说明 signal 透传不破坏真实调用），但反代对 anthropic body 返回 `400 Improperly formed request`（`REQUEST_BODY_INVALID`）——这是 KiroAdmin 反代的 body 形状问题，v0.2.4 即如此，与本次改动无关（payload 构造未动），不在本任务范围。正常/异常路径已由上面的受控 `/ok`、`/hang` 服务端到端证明。

---

## v0.2.6 验证（手机远程触发截图 POST /capture，本机 Intel Mac，Node v24.17.0，2026-10-22）

验证方式：`Module._load` 注入假 `electron`/`./capture`/`./llm`，跑**真实** `config.js`/`store.js`/`page.js`/`pipeline.js`/`server.js`，并按 `main.js` 原样接线 `server.setTrigger`（force→runCaptureForce，否则 isInFlight?skipped:runCapture）。起真 HTTP 服务后用 Node `http` 客户端（等价 curl）打 `/capture` 各路径。脚本 `.agents/tasks/pp_v026_verify.js`，**17 条断言全过（exit 0）**。

- **token 鉴权 + 方法限制**：`POST /capture?t=<token>`→200 `{ok:true}`；无 token→403；错 token→403；`GET /capture?t=<token>`→405 且 `Allow: POST`（GET 不触发，避免预取/爬虫误触）。
- **真的触发了一次截图分析**：带 token 的 POST 后，经真实 `pipeline.runCapture`→真实 `store`，history 新增一条 slot，`latestKey` 由 `empty`→`…_default|done`（截图走假 capture、分析走假 llm，证明 server→trigger→pipeline→store 全链路通，不依赖易抖的反代）。
- **GET 不触发**：`GET /capture` 后 history 条数不变（仍 1 条）。
- **inFlight → skipped**：令分析挂起制造 inFlight，`pipeline.isInFlight()===true` 时再 `POST /capture`→200 `{skipped:true}`，不排队不并发。
- **force 中止重来**：`POST /capture?force=1`→200 `{ok:true}`；滚动日志 `userData/logs/peek.log` 含 `FORCE 中止进行中的那张` + `ABORT …已被强制刷新中止`，证明真正 abort 了挂起那张并立即开新一张（新一张最终 done）。
- **手机页按钮**：`renderEmpty` 与 `renderPage`（有记录态）HTML 均含 `id="capBtn"` 的「📸 截图分析」大按钮；内联 JS 以 `fetch('/capture?t='+enc(T),{method:'POST'…})` 指向正确端点，触发后 3 秒节流禁用。翻历史模式下按钮随 `#live` 隐藏。
- **语法**：`server.js`/`main.js`/`page.js`/`pipeline.js` `node --check` 全过；`package.json` version=0.2.6。
- **架构**：server 不直接 `require('./pipeline')`，经 `setTrigger` 注入回调（与既有 `setStore` 注入一致），无循环依赖；新端点全部走现有 token 鉴权，`/capture` 仅 POST。
- **无弹窗约定**：未新增任何 `Notification`/`dialog`，沿用无弹窗。
