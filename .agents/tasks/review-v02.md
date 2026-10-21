# PeekPhone v0.2.0 — /v1 修复、流式、历史翻页、赞助页、图标、体积优化

v0.2 在 v0.1.0 基础上交付了用户点名的七项：修 OpenAI `/v1` 路径 404、手机页历史翻页、per-provider 流式输出、应用图标、dmg 体积优化、双语 README + 截图、空状态默认赞助页。核心逻辑集中在 `llm.js`（URL 拼接 + SSE）、`server.js`/`page.js`/`store.js`（翻页 + 赞助 + 鉴权）、`package.json`（版本 + 打包）。七项全部落地，实机验证证据（`verification.md` v0.2 小节）逐条完整，密钥红线守住。

实现额外带入了计划外的增强（模型自动回退、错误归类成人话、失败改为只写日志不弹窗、测试即保存），都收敛在本就在改的文件内、有防护、有测试，但超出了 `plan-v02.md` 列明的 12 个实现项，且「失败不弹窗」与原 `design.md §9`「失败弹桌面通知不静默」相抵。

Watch for:
- 计划外范围扩张（模型自动回退 + 错误归类 + 失败只记日志 + 测试即保存），非阻塞但应知悉（confirmed）。
- 失败通知从桌面弹窗改为仅写 `peek.log`，与 design §9 相抵（confirmed）。
- `.agents/tasks/` 下残留一张未入库的源二维码图（confirmed，无害）。

**Verdict**: APPROVED

## High-level view

`/v1` 修复抽成了 `joinUrl(base, format)` 纯函数：去尾斜杠后用正则 `/\/(?:v\d+|compatible-mode\/v\d+)$/i` 判断 base 是否已自带版本段，带了只接端点、没带才补 `/v1`。两个分支都有注释（case A 智谱/百炼自带版本，case B localhost 反代/openai 裸域），且 openai 与 anthropic 共用这一函数，顺带修掉了 anthropic 自带 `/v1` 时重复成 `/v1/v1/messages` 的隐患。

流式是 per-provider 开关：`resolveProvider` 里 `stream: p.stream === true`，config 默认 `stream:false`。只有 provider 开了 stream 且调用方传了 `onDelta` 才走 `tryProviderStream`；流式遇到非模型级失败会在 `callOnce` 里回退到非流式 `tryProvider` 一次，保证不支持流的反代不被弄挂。SSE 用 Node 内置 `TextDecoder` + 按 `\n\n` 切事件解析，无第三方库。

`/history`、`/item`、`/sponsor` 三个新路由都排在 `server.js` 的 `authed()` 403 闸之后，复用同一 token 鉴权。`/item` 通过 `store.getItem` → `validSlot` 做防穿越（含分隔符/`.` 开头/解析越界/非目录全挡）。`/sponsor` 读固定白名单常量 `SPONSOR_PATH`（非用户可控路径），返回 `image/jpeg` 字节，不 base64 内联进 HTML。

空状态手机页 `renderEmpty` 默认渲染 `<img src="/sponsor?t=...">` 二维码 + 文案，`renderPage(null)` 直接转 `renderEmpty`。有记录时底部放「查看更早」大按钮（移动端友好）+ 不显眼的「☕ 赞助作者」入口，翻页态暂停 2s 轮询并给「回到最新」。

密钥红线守住：默认 provider `api_key:''`，仓库无 `config.json` 入库，密钥扫描仅命中一处注释里的示例 URL。版本已升 `0.2.0`。无任何隐身/反检测代码，唯一命中是 main.js 里「纯托盘非反检测」的澄清注释。打包图标从 `build/` 迁到 `assets/` 并删除旧文件，`package.json` 收窄 `files` + `compression:maximum` 把 x64 dmg 从 103MB 降到 89.5MB。

<details>
<summary>Issues (3)</summary>

1. **计划外范围扩张** — `llm.js` 的模型自动回退（`resolveAndCall`/`model_priority`）、错误归类（`classify`/`friendlyText`）、pipeline 失败改日志、settings 测试即保存，均不在 plan-v02 的 12 项内。非阻塞：收敛在已改文件、有 `supported_models` 结构守护（单模型 API 不触发）、有单测。建议在 plan/说明补记这几项，别让范围悄悄长。
2. **失败通知语义变更** — 分析失败不再弹桌面通知，改为只写 `userData/logs/peek.log` + 手机页 error 态，与 design §9「失败弹桌面通知不静默」相抵。若是刻意 UX 决策，更新 design 对齐；否则属行为回归。
3. **残留未入库源图** — `.agents/tasks/微信图片_20261021154253_115_163.jpg` 未入库遗留在仓库内。无害（不进 diff、不是密钥），清掉或移出仓库树更干净。

</details>

<details>
<summary>Details</summary>

### /v1 path-join：两格式共用、双 case 有注释

`joinUrl` 的判定 `clean + (hasVersion ? endpoint : '/v1' + endpoint)` 对四种真实 base 均正确：`localhost:3001`+openai→`/v1/chat/completions`（修好 v0.1 的 404）、智谱 `/api/paas/v4`→`/v4/chat/completions`、百炼 `/compatible-mode/v1`→不重复、anthropic 裸域→`/v1/messages`、anthropic 自带 `/v1`→不重复成 `/v1/v1`。`verification.md` v0.2-0 的 42 条断言 + v0.2-1 的裸 curl 旁证（`POST /chat/completions`→404、`POST /v1/chat/completions`→200）证实修复点准确。注释明确区分 case A/case B 且覆盖 openai 与 anthropic 两侧，满足评审项 1。

### 流式回退不破非流式反代

`callOnce` 里流式失败的回退逻辑是关键：模型级错误（带 `supported_models` 或 `image_unsupported`）直接上抛给 `resolveAndCall` 换模型，其余（端点不支持流等）落到后面的 `tryProvider` 非流式重试。verification v0.2-3 实测反代 `localhost:3001` 开 `stream:true` 时增量回调 0 次 → 自动回退非流式仍返回文本，正是「开 stream 不把能用的反代弄挂」的硬约束。fake SSE server 侧则 4 次增量、首末间隔 115ms，证明支持流时确实边收边出。

### 历史/赞助路由的鉴权与防穿越

三个新路由全部在 `authed()` 之后，无 token 一律 403（verification v0.2-4 实测带 token 200 / 无 token 403）。`/item?name=../../config`→`validSlot` 因含 `/` 返回 false→404；verification 用 `%2e%2e` 绕过客户端归一直打服务端解析器也仍 404，说明校验在服务端。`/sponsor` 走固定常量路径非用户输入，字节数 144312 与入库图一致，`Content-Type: image/jpeg`，未内联。满足评审项 3。

### latestKey 在流式 pending 期随部分文本变化

`store.latestKey()` 在 pending 态追加 `Buffer.byteLength(item.text)`，使部分文本变长时 key 变化、手机轮询触发刷新。`pipeline.js` 的 `onDelta` 节流 ≥300ms 调 `savePartial`。`DETAIL_SEP` 常量在 pipeline.js 与 page.js 两处字面一致（`\n\n────── 详情 ──────\n`），error 态「人话 + 可折叠详情」拆分依赖它，一致性正确。

</details>

<details>
<summary>File map</summary>

- `src/main/llm.js` — joinUrl、SSE 解析、流式、错误归类、模型自动回退（后两项为计划外增强）
- `src/main/server.js` — 新增 /sponsor、/history、/item 路由（全在鉴权闸后）
- `src/main/store.js` — savePartial、getItem/validSlot、listSlots、latestKey 带部分文本长度
- `src/main/page.js` — 空状态赞助二维码、历史翻页 UI、error 态折叠详情
- `src/main/pipeline.js` — 流式 onDelta 集成、DETAIL_SEP、失败改日志不弹窗
- `src/main/config.js` — provider.stream 默认 false、model_priority 候选池
- `package.json` — version 0.2.0、files 收窄 + compression:maximum、图标指向 assets/
- `assets/**` — 图标（icns/ico/png/tray）、sponsor-wechat.jpg、screenshots；删除旧 `build/**` 图标
- `src/main/ipc.js`/`tray.js`/`windows.js`/`src/renderer/settings.*`/`preload.js` — stream 开关 UI、赞助标签、测试即保存接线
- 完整 diff：`git diff v0.1.0..HEAD`

</details>
