# PeekPhone v0.2 实现计划

> 迭代对象：已发布的 v0.1.0 Electron 桌面 App（本目录即 git 仓库，有 v0.1.0 tag，remote lihaochuang/peekphone）。
> 设计蓝本 `.agents/tasks/design.md` 已 APPROVED，**不重做设计**；本计划只覆盖 v0.2 的七个工作项。
> 所有路径均在 `/Users/harry/诺亚方舟/任务档案/20261021_PeekPhone桌面App` 下（下文简写为仓库根）。
> 实现期每条验证结果写进 `.agents/tasks/verification.md`（追加「v0.2」小节，不覆盖 v0.1 证据）。

## 设计决策（本计划新做的判断，逐条附理由）

- **URL 版本段判定（item 1）**：在 `llm.js` 抽一个 `joinUrl(base, format)` 纯函数统一两种格式的拼接。判定规则：`base` 去掉尾部 `/` 后，若已以版本段结尾（正则 `/(v\d+|compatible-mode\/v\d+)$/i`，覆盖 `/v1`、`/v4`、`.../compatible-mode/v1`）则 openai 接 `/chat/completions`、anthropic 接 `/messages`；否则 openai 接 `/v1/chat/completions`、anthropic 接 `/v1/messages`。理由：兼容自带版本前缀（智谱 `/api/paas/v4`、百炼 `/compatible-mode/v1`）与不带前缀（`localhost:3001`、`api.openai.com`）两种现实，且同时修掉 anthropic 自带 `/v1` 时重复成 `/v1/v1/messages` 的隐患。
- **流式解析（item 2/3）**：用 Node 内置能力解析 SSE（按 `\n\n` 切事件、逐行读 `data:`），不引任何库。`stream` 为 per-provider 布尔开关，默认 `false`（兼容现状、兼容不支持流的本机反代）。流式请求失败（非 2xx、解析异常、无增量）优雅回退到现有非流式 `tryProvider` 重试一次。理由：任务硬约束——开 stream 不能把原本能用的反代弄挂。
- **图标落点（item 4）**：按任务 verbatim 放 `assets/`。生成的 `assets/icon.icns`/`assets/icon.ico`/`assets/icon.png` + `assets/tray/` 挂进 `package.json` 的 `build.mac.icon`/`build.win.icon` 与 `tray.js` 的 `iconPath()`；源 SVG + 生成脚本放 `assets/icon-src/`。旧的 `build/icon.*` 与 `build/tray/*` 被取代，删除以免二义。理由：v0.2 任务是本次权威指令，明确要求 assets/；churn 很小且显式。
- **赞助图走静态白名单（item 5）**：在 `server.js` 加一条 `GET /sponsor` 路由，读 `assets/sponsor-wechat.jpg` 返回，沿用现有 `?t=` 鉴权；不 base64 内联进 HTML。理由：任务明确不要把 144KB 图内联，且要走现有鉴权。
- **不重构、不扩范围**：只动七项涉及的文件，其余 v0.1 文件不碰。

## 实现项（按依赖顺序；每项做完仓库都可构建/启动）

- [ ] 1. 版本号与仓库卫生：`package.json` 的 `version` 升到 `0.2.0`；把已存在但未入库的 `assets/sponsor-wechat.jpg` `git add`（用户本人收款码，入库 OK）；确认 `.gitignore` 不误伤 `assets/`。
      Files: 仓库根 `package.json`、`.gitignore`、`assets/sponsor-wechat.jpg`
      Verify: `node -e "console.log(require('./package.json').version)"` 输出 `0.2.0`；`git status --short assets/` 显示 sponsor 图已暂存。

- [ ] 2. 修 OpenAI 路径 `/v1` bug（item 1，必修）：在 `src/main/llm.js` 新增 `joinUrl(base, format)`（按上方「URL 版本段判定」实现，带注释说明两种 case），`resolveProvider` 改用它；anthropic 侧一并处理自带 `/v1` 重复问题。保持其余逻辑不变。
      Files: `src/main/llm.js`
      Verify: `node -e` 直调 `require('./src/main/llm.js')` 暴露的 `resolveProvider`，断言：base `http://localhost:3001`+openai→`http://localhost:3001/v1/chat/completions`；`https://open.bigmodel.cn/api/paas/v4`+openai→`.../v4/chat/completions`；`.../compatible-mode/v1`+openai→`.../v1/chat/completions`；base 不带前缀+anthropic→`/v1/messages`；base 自带 `/v1`+anthropic→不重复。全部通过。（`resolveProvider` 已在 `module.exports`。）

- [ ] 3. 流式解析 + 回退（item 3 的 llm 层，可单测）：`src/main/llm.js` 增加 SSE 支持。`resolveProvider` 透传 `stream`（默认 false）。新增 `tryProviderStream(spec, ..., onDelta)`：`fetch` 带 `stream:true` body，读 `res.body` 流，用内置逻辑解析 OpenAI `data: {...}`（取 `choices[0].delta.content`）与 Anthropic `content_block_delta`（取 `delta.text`）两种 chunk，边收边 `onDelta(chunk)` 累加；结束返回全文。`analyze` 签名加可选 `onDelta`：当 provider `stream===true` 且传了 `onDelta` 时走流式，失败（非2xx/解析异常/空增量）则记录并**回退调用一次非流式 `tryProvider`**。`config.js` 的默认 provider 形状加 `stream:false`。
      Files: `src/main/llm.js`、`src/main/config.js`
      Verify: `node -e` 单测：喂一段拼好的 OpenAI SSE 文本和一段 Anthropic SSE 文本给解析函数，断言增量拼回完整文本且 `onDelta` 被多次调用；断言 `config.defaults().providers[0].stream===false`。

- [ ] 4. 流式贯通 pipeline/store/手机页（item 3 的集成）：`store.js` 增 `appendAnalysisPartial(slot, text)`（流式期间把当前累计文本写进 slot，使 `readSlot` 在 pending 态也能读到部分文本）；`readSlot` 的 pending 文案在有部分文本时显示部分文本而非「正在分析…」。`pipeline.js` 的 `runCapture` 在 provider 开 stream 时给 `llm.analyze` 传 `onDelta`，回调里节流（≥300ms 或每累计 N 字）写部分文本 + 刷新 latestKey 使 `|pending` 的 key 变化触发手机刷新；done 时照旧写 `analysis.md`。`page.js` 三态（pending/done/error）与部分文本兼容——pending 期逐步显示。latestKey 需在部分文本更新时变化（如加轮次/长度后缀），否则手机不刷新。
      Files: `src/main/store.js`、`src/main/pipeline.js`、`src/main/page.js`
      Verify: `node -e` 驱动一个 fake provider（stream 分多次 onDelta）跑 `runCapture`，断言 slot 内 pending 期部分文本随回调变长、`latestKey()` 随之变化、最终落 `analysis.md` 为 done；不触网。

- [ ] 5. 设置 UI 的 stream 开关（item 3 的 UI）：`settings.html` 模型区加「流式输出（不支持的端点会自动回退）」勾选框；`settings.js` 的 `draftProvider()`/`draftConfig()`/`init()`/保存逻辑带上 `stream`；`ipc.js` 的 `updateConfig`/`mergeDraft`/`testRecognition` 透传 `stream`。保持默认关。
      Files: `src/renderer/settings.html`、`src/renderer/settings.js`、`src/main/ipc.js`
      Verify: `npm start` 起 App（本机 Intel Mac），设置页能勾选 stream 并保存，`~/Library/Application Support/PeekPhone/config.json` 的 provider 出现 `stream:true`；关掉后变 `false`。

- [ ] 6. 手机页历史翻页（item 2）：`store.js` 增 `listSlots()`（倒序 slot 名数组）、`getItem(name)`（= 带边界校验的 `readSlot`，slot 名非法返回 null）。`server.js` 增两个鉴权路由：`GET /history`（JSON 列最新 N 条 slot 名+state）、`GET /item?name=xxx`（JSON 返回该 slot 的 `renderPage` 所需字段），沿用 `?t=` 鉴权，slot 名复用 `resolveImagePath` 同级的防穿越校验。`page.js`：默认仍只渲染最新一条 + 2s 轮询不变；底部加大按钮「查看更早」，点击进入翻页态（移动端友好的大按钮/左右切换，非桌面小链接），翻页态下**暂停 2s 自动刷新**并显示「回到最新」按钮，回到最新后恢复轮询。
      Files: `src/main/store.js`、`src/main/server.js`、`src/main/page.js`
      Verify: `node -e` 起 server + 造 3 条 slot，`curl`：带 token `GET /history`→200 列 3 条；`GET /item?name=<slot>`→200 返回对应文本；无 token→403；`/item?name=../../config` 路径穿越→404/空。页面 HTML 含「查看更早」「回到最新」入口。

- [ ] 7. 赞助页面（item 5）：`server.js` 加 `GET /sponsor` 路由（鉴权后读 `assets/sponsor-wechat.jpg` 返回 `image/jpeg`，把该绝对路径加进允许的静态白名单，不走 `/img` slot 逻辑）。`page.js`：空状态（无任何截图）默认展示赞助二维码 `<img src="/sponsor?t=...">` + 文案「喜欢的话可以扫码请我喝咖啡」+ 保留「按快捷键截图」提示；有截图后正常显示分析，页面底部加一个不显眼的赞助入口（点开 `/sponsor`）。`tray.js` 菜单加「赞助作者 ❤️」→ 打开设置窗口新「赞助」标签页（或复用手机连接页展示收款码）。`settings.html`/`settings.js`/`preload.js`/`ipc.js`：加赞助标签页，`<img>` 显示 `assets/sponsor-wechat.jpg`（设置窗 CSP 允许 `img-src 'self'`，本地文件用 `file://` 或经 IPC 返回 data URI——择一，优先 IPC 返回 data URI 避免放宽 CSP）。
      Files: `src/main/server.js`、`src/main/page.js`、`src/main/tray.js`、`src/renderer/settings.html`、`src/renderer/settings.js`、`src/preload/preload.js`、`src/main/ipc.js`
      Verify: `node -e` 起 server：带 token `GET /sponsor`→200 且 `Content-Type: image/jpeg`、字节数≈144312；无 token→403。`npm start` 看空状态手机页（`http://<lan>:<port>/?t=`）显示二维码+文案；托盘有「赞助作者 ❤️」项打开赞助页。

- [ ] 8. 应用图标（item 4）：`assets/icon-src/icon.svg` 画品牌图标（主题：截图取景框/相机 + 手机/信号的极简组合，主色蓝 `#0a84ff`）；`assets/icon-src/gen-icons.sh`（或 `.js`）用 `qlmanage`/`sips`/`iconutil` 把 SVG → PNG 多尺寸 → `assets/icon.icns`（iconset 走 iconutil）、`assets/icon.ico`（多尺寸，sips/ImageMagick 缺则用 node 纯 JS ico 打包）、`assets/icon.png`、`assets/tray/trayTemplate.png`+`@2x`（mac 单色 Template）、`assets/tray/tray.ico`。`package.json` 的 `build.mac.icon`→`assets/icon.icns`、`build.win.icon`→`assets/icon.ico`；`tray.js` 的 `iconPath()` 指向 `assets/tray/`。删除被取代的 `build/icon.*`、`build/tray/*`。
      Files: `assets/icon-src/icon.svg`、`assets/icon-src/gen-icons.sh`、`assets/icon.icns`、`assets/icon.ico`、`assets/icon.png`、`assets/tray/*`、仓库根 `package.json`、`src/main/tray.js`；删除 `build/icon.*`、`build/tray/*`
      Verify: 跑生成脚本产出 icns/ico/png（`file assets/icon.icns` 识别为 Apple Icon、`sips -g pixelHeight assets/icon.png` 有尺寸）。`npm run dist:mac` 产出 `.app`，`open dist/mac/PeekPhone.app` 后 Dock/访达显示新图标非默认 Electron；`npm start` 托盘显示新托盘图标（非空白/默认）。结果记入 verification.md。

- [ ] 9. 包体积优化（item 6，只做低风险裁剪）：`package.json` 的 `build` 加 `compression:"maximum"`、确认 `asar:true`、`files` 收窄到必要项（`src/**`、`assets/**` 仅运行时需要的图标+sponsor、`package.json`；排除 `assets/icon-src/`、`demo/`、`.agents/`、截图等非运行时文件）、`electronLanguages:["zh-CN","en-US"]` 裁语言包、`removePackageScripts:true`、`npmRebuild:false`。不做 Tauri 重写。
      Files: 仓库根 `package.json`
      Verify: `npm run dist:mac` 成功产出 `dist/PeekPhone-0.2.0.dmg`，App 能 `open` 启动、托盘出现、手机页可访问（功能不破）；`ls -l dist/*.dmg` 记录新体积，与 v0.1 的 98MB 对比写入 `说明.md`。

- [ ] 10. 双语 README + 说明.md（item 7 文档部分）：`README.md` 补「赞助 / Sponsor」小节（引用 `assets/sponsor-wechat.jpg`）、新功能（历史翻页、流式、赞助）、v0.2 变更、与同类项目差异（本地局域网+手机第二屏+无隐身，不做 InterviewCoder 反检测）——中英双语。`说明.md` 加 v0.2 小节：七项变更摘要 + 体积优化前后对比（item 9 的数字）。
      Files: 仓库根 `README.md`、`说明.md`
      Verify: `grep -n "赞助\|Sponsor\|流式\|历史" README.md` 命中；`说明.md` 含 v0.2 小节与体积对比行。

- [ ] 11. 演示素材（item 7 素材部分）：`npm start` 把 App 跑起来，真实截取「设置窗口」「手机页面-最新一条」「手机页面-空状态赞助页」存 `assets/screenshots/*.png`，README 引用。gif：本机无 `ffmpeg`/`gifski`——先尝试用 `qlmanage`/系统 `screencapture -v` 等本机工具做简短演示 gif/mp4；做不出真实交互 gif 就用静态截图序列代替，并在收尾诚实说明「本机无 gif 工具链，未伪造动图」（不伪造）。
      Files: `assets/screenshots/*.png`、仓库根 `README.md`、`.agents/tasks/verification.md`
      Verify: `ls assets/screenshots/*.png` 存在真实非黑 PNG（`sips -g pixelWidth` 有尺寸、文件>10KB）；README 引用路径存在。

- [ ] 12. 集成真实验证并写 verification.md（交付契约，最后统一跑）：在本机 Intel Mac 执行下方「真实验证契约」全部条目，逐条把命令+结果写进 `.agents/tasks/verification.md` 的「v0.2」小节。key 运行时从 `/Users/harry/诺亚方舟/任务档案/20261021_截图问AI/config.json` 读，**不写入仓库/日志**。
      Files: `.agents/tasks/verification.md`
      Verify: verification.md「v0.2」小节含下列 7 组证据且结论为通过（或对未通过项诚实说明）。

## 真实验证契约（交付前必须逐条执行，写进 verification.md）

前置：确认本机反代 `http://localhost:3001` 在跑（其 OpenAI 端点 `/v1/chat/completions`、Anthropic 端点 `/v1/messages`）。

1. **起得来**：`npm install` 成功；`npm start` 起 App、托盘出现。
2. **/v1 bug 修好且没弄坏 Anthropic**：对 `base=http://localhost:3001`，OpenAI 格式真调一次（命中 `/v1/chat/completions`）返回文本；Anthropic 格式真调一次（命中 `/v1/messages`）返回文本。两者都通。key 运行时读原型 config，不入仓/日志。
3. **真截图非黑**：触发截图，产物是真图非黑屏（记文件大小 + 抽样颜色数，纯黑约 1 色）。
4. **手机页面鉴权与翻页**：带 token `/`→200、无 token→403、`/img/../../config.json` 路径穿越→404 仍成立；`/history` 列表 + `/item?name=` 翻页接口工作；空状态能看到赞助二维码；`/sponsor` 赞助图带 token→200、无 token→403。
5. **流式**：对支持流的配置（如智谱，或反代若支持）验证增量显示（手机页 pending 期文本逐步变长）；对不支持流的 `localhost:3001` 验证开了 `stream` 也能优雅回退、不挂（最终仍返回文本）。
6. **图标**：构建出的 `.app` 显示新图标不是默认 Electron；托盘显示新托盘图标。
7. **dmg 体积**：`npm run dist:mac` 产出 `dist/PeekPhone-0.2.0.dmg`，记录新体积 vs v0.1 的 98MB。

## 纪律（硬约束，实现期不得违反）

- 不内置任何 key；默认 provider 配置空（含新加的 `stream:false`）；验证用的 key 不落仓库/日志。
- 赞助码图 `assets/sponsor-wechat.jpg` 是用户本人收款码，入库 OK。
- 不做任何隐身/反检测功能。
- 依赖尽量内置；流式用 Node 内置解析 SSE，**不引重库**。运行时第三方依赖仍只有 `qrcode`。
- 版本号升到 `0.2.0`。不碰七项之外的无关文件。
