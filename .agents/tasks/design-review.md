# PeekPhone 桌面 App 技术设计评审（第 2 轮）

评审对象：`.agents/tasks/design.md`（已含第 1 轮 CHANGES_REQUESTED 的修订回应「附二」）
对照源：原始用户诉求 + Python 原型 `peek.py` / `llm.py` / `serve.py` / `说明.md`
评审方式：脱离设计上下文，逐条回源码核验，不采信设计的自述。

## 裁决

**APPROVED** — 0 HIGH，0 MEDIUM，4 NIT。

四个重点项逐一核验通过：(1) LLM 双格式+重试与手机页「最新一条/2s 轮询/token-403」逐条照搬原型；(2) 密钥全部排除出仓库、用户 key 落 `app.getPath('userData')/config.json`；(3) electron-builder + GitHub Actions 计划可信且对未签名/CI-only/未实测诚实标注；(4) 无任何隐身/反检测特性。NIT 不阻塞，建议实现期一并消化。

---

## Verified Assumptions（已回源核验为真）

1. **截图方案移植** — 设计 §5 的 mac 路径 `screencapture -x -D 1` + `sips -Z 1200 -s format jpeg -s formatOptions 70` 与 `peek.py` 的 `shoot()`/`shrink()` 完全一致，包括 `-D 1` 固定主屏、sips 失败回退 PNG 并把 media_type 标为 `image/png`（原型 `shrink` 返回 `(source,'image/png')`）。设计 §5 的 PNG 兜底如实标注格式，与原型一致。
2. **LLM 双格式 + 重试** — 设计 §6 与 `llm.py` 逐函数对得上：`RETRY_STATUS=[408,429,500,502,503,504]`、非该集合状态码（400/401/403）`break` 不重试、指数退避 `min(2**(attempt-1),8)`、anthropic `/v1/messages`+`anthropic-version:2023-06-01`、openai `/chat/completions`、两种 content 块结构、`extract` 取值、空文本视为失败、`via='<name>（<model>，第<attempt>次成功）'`、`ModelError` 聚合所有 provider 错误。openai body 的 `model`/`max_tokens`（第 1 轮 NIT-3）已补全且与 anthropic 分支取值一致。
3. **手机页行为** — 设计 §7 与 `serve.py` 对得上：`/latest` 回 `{key}`、`latestKey='<name>|<state>'`、无记录 `empty`、2s 轮询 + `document.hidden` 跳过 + `visibilitychange` 回前台立拉、`crypto.timingSafeEqual` 等长常量时间比较（对应 py `hmac.compare_digest`）、`/img` 仅放 `shot.jpg`/`shot.png` + slot 名不含 `/`/不以 `.` 开头 + realpath 边界校验、403 文案、`pretty()` 解析 `parts[1]` 长度 6 为时分秒、HTML 转义、token 注入页面与图片 URL。`store.latest()` 按目录名倒序取第一、`readSlot` 三态判定均照搬。
4. **token 每请求现读（与原型的刻意差异）** — `serve.py` 把 token 缓存在 `Handler.token`；设计 §7 改为每请求 `config.getToken()`。核验为**正确的刻意改动**：桌面 App 新增「重置 token」按钮，缓存会让重置不生效、旧链接无法立即 403。差异有文档、有理由，非缺陷。
5. **密钥全部出仓库** — 原型从 `/Users/harry/诺亚方舟/env` 读凭证、`config.json` 内含 KiroAdmin 反代 `base_url/api_key`。设计 §6/§8/§9 明确：不移植 env 读取、不复制原型 config 任何值、不内置钉钉、不内置 KiroAdmin；默认 provider 的 `base_url/api_key/model` 全空；用户 key 只在设置 UI 输入、存 userData config.json、`chmod 0o600`、不进代码/仓库/日志；token 用 `crypto.randomBytes(18).toString('base64url')`（等价 py `secrets.token_urlsafe(18)`）。`.gitignore` 双保险拦 `/config.json`、`/history/`、`/prompts/`、`/webhook.txt`。
6. **无隐身/反检测** — 设计 §9/§14 显式列为 Out of Scope（活动监视器隐藏/录屏不可见/点击穿透/无痕），§1 把 index-4 的 InterviewCoder 隐身特性显式收口为「坚决不做」。`LSUIElement:true`/`app.dock.hide()` 仅纯托盘常规行为，设计已明确区分，非反检测。
7. **dmg on Intel 可行性** — 设计 §12/§13.4 称本机 Intel 只验 x64 dmg、arm64 由 CI 产出。electron-builder 在 Intel mac 本地构建 x64 dmg 原生可行；arm64「无法本机验证」指无法**运行**实测（构建本身也能做），表述诚实。
8. **模块间 capture 契约自洽（第 1 轮 MEDIUM-1 修复）** — `capture()` 返回 `{buffer,mediaType,ext}`；pipeline `store.saveImage(slot,buffer,ext)` 落 `shot.<ext>`、`mediaType` 透传 `llm.analyze`；`store.readSlot` 先找 `shot.jpg` 再找 `shot.png`（与 `serve.py read_slot` 一致）。三处引用一致，无悬空。

## Unverified / 存疑假设（设计已诚实标注，不阻塞）

这些是真实世界行为，无法在文档评审阶段证实；设计均在 §13 逐条列为实现期必验项，且关键命门有兜底，故不作为阻塞 finding：

- **U1 mac 打包 `.app` 的 `screencapture` 子进程 TCC 归属**（§13.1）：设计称「父 App 已授权但子进程截到黑帧」跨 macOS 版本行为不一致。该说法与业界已知的子进程 TCC 继承问题一致，属合理风险判断；设计给了 `desktopCapturer`（进程内、TCC 归属干净）作为已决降级链（第 1 轮 MEDIUM-2 修复），两条都不通才 README 标注不支持。姿态诚实。
- **U2 Windows `desktopCapturer` 全屏清晰度/分辨率**（§13.3）：本机 Mac 无法验，设计标注由 CI 构建保证 + 使用者反馈。
- **U3 arm64 包运行正确性**（§12/§13.4）：Intel 本机不可运行实测，标注需 Apple Silicon 用户反馈。
- **U4 预设 base_url/model 名**（§8/§13.5）：智谱 `glm-4v-flash`、百炼 `qwen-vl-plus` 等模型名会变，标注实现期核对各家文档。错了用户「测试识别」会报错，不影响架构。
- **U5 未签名 mac 开机自启**（§13.8）：`setLoginItemSettings` 在未签名 App 上可能受限，标注实测否则 UI 提示手动添加。
- **U6 Node `fetch` 连接重置异常形态**（§6/§13.6）：标注用「测试识别」真调一次验证归类为可重试。

均无「把未验证当已验证」的误述，符合诚实标注要求。

---

## Findings

### NIT-1 — openai_chat 的 `extract` 缺少 py 的防御式取值

**位置**：§6 `extract(spec, data)` —「openai 取 `data.choices[0].message.content`」。
**问题**：`llm.py _extract` 对 openai 分支用 `choices = data.get('choices') or [{}]` 再 `choices[0].get('message',{}).get('content') or ''` 做了缺字段保护；设计这句直接写 `data.choices[0].message.content`。若上游返回 200 但 body 畸形（无 `choices` 或空数组），JS 会抛 `TypeError`，而 §6 把 `TypeError` 归入「可重试网络异常」，会被误判为连接问题白重试 3 次再抛，错误信息也不如 py 的「返回没有文本」清晰。
**修法**：明确防御式取值，缺字段按空文本处理（触发「空文本视为失败」而非误入重试分支）：
```
const content = data?.choices?.[0]?.message?.content || '';
```
anthropic 分支同理对 `data.content` 做 `|| []` 保护。

### NIT-2 — `captureViaDesktopCapturer` 的 `resize(长边1200)` 未定维度

**位置**：§5 伪代码 `jpeg = img.resize(长边1200).toJPEG(70)`。
**问题**：`nativeImage.resize({width})` 与 `{height}` 行为不同（只给一维才保持比例）；「长边 1200」需先判断原图宽高谁大再决定传 width 还是 height，否则横竖屏会压错方向。
**修法**：伪代码写清：
```
const {width:w, height:h} = img.getSize();
const opt = w >= h ? {width:1200} : {height:1200};
const jpeg = img.resize(opt).toJPEG(70);
```

### NIT-3 — pipeline 的「立刻刷新 /latest key」措辞像后端推送

**位置**：§4 pipeline「建 slot（先写 pending）→ 立刻刷新 `/latest` key（手机先看到"分析中"和截图）」。
**问题**：`/latest` 是手机 2s 轮询拉取、key 每请求现算，后端没有「刷新 key」这个动作；且该步在 `saveImage` 之前，此刻尚无截图（截图在 `capture→saveImage` 后才出现，pending 带图窗口在其后）。措辞会让 coder 误以为需要先存图或建立推送通道。
**修法**：改为「建 slot（pending 态）后，下一次手机轮询即会读到 pending；截图在 `capture`+`saveImage` 后出现，此后手机显示 pending+截图，直到分析写入转 done」。去掉「刷新 key」「立刻看到截图」的推送式表述。

### NIT-4 — config 字段大小写混用

**位置**：§8 默认配置 —— 顶层用 camelCase（`maxTokens`/`shrinkLongEdge`/`jpegQuality`/`keepDays`），provider 内用 snake_case（`base_url`/`api_key`/`model`/`timeout`/`retries`）。
**问题**：本身无害，但 §6 `resolveProvider` 读的是 `p.api_key`/`p.base_url` 等 snake_case，若实现时顺手把 provider 字段也 camelCase 化会读到 undefined。
**修法**：在 §8 或 §6 加一句约束「provider 对象内部字段保持 snake_case，与 §6 读取一致；顶层配置用 camelCase」，避免 coder 自行统一命名导致读空。

---

## 裁决机制

HIGH=0，MEDIUM=0 → 无阻塞项 → **APPROVED**。4 条 NIT 建议实现期消化，不回退任何范围、不重新引入隐身/反检测或内置密钥。
