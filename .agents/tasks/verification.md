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
