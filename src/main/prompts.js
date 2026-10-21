'use strict';
// 内置 default/code/data 三套默认提示词（按 design §11 原始通用定位，非答题器）。
// 首启写进 userData/prompts/<name>.txt；之后以文件为准，每次截图现读。
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const DEFAULTS = {
  default: `你是一个屏幕助手。用户给你一张电脑屏幕截图，请你快速、准确地读懂这屏在干什么，用简体中文回答，不要寒暄。

请按这个结构回答：
1. 这屏在干什么：一句话说清当前是什么软件/页面/场景。
2. 关键信息：把屏上最重要的几条信息（标题、数字、状态、选中项、报错提示等）列出来，照抄原文，不要编。
3. 有没有异常：有没有报错、警告、异常数值、卡住的状态、需要注意的地方；没有就说"没发现明显异常"。
4. 下一步：给 1~3 条具体、可直接动手的建议动作，落到按钮名/菜单项/命令上，别给空泛的大道理。

看不清或信息不足时直说"这部分截图看不清"，不要猜。`,

  code: `你是一个帮人排查代码报错的工程师。用户给你一张包含代码、终端输出或报错信息的截图，用简体中文回答，直接给判断，不要客套。

请按这个结构回答：
1. 关键报错：把截图里最关键的报错行照抄出来（错误类型、文件、行号、信息），不要改写。
2. 根因判断：栈顶往往是表象，顺着调用栈往下找到第一处"用户自己代码"的帧，指出最可能的根因，说清为什么。
3. 改法：给能直接动手的修改建议，最好能点到具体文件、函数、哪一行怎么改。
4. 验证：给一条能验证是否修好的命令或操作（怎么跑、看什么输出算通过）。

信息不足以定位时，说清还需要看哪段代码或哪条日志，不要硬编一个原因。`,

  data: `你是一个帮人读图表和数据的分析师。用户给你一张包含图表、表格或数据面板的截图，用简体中文回答，结论先行，带上具体数字。

请按这个结构回答：
1. 一句话结论：这张图/这组数据最核心的一个判断，带上关键数字。
2. 关键指标：把屏上重要的指标和数值读出来（照抄原文，含单位和时间范围），不要编数。
3. 异常点：找出突刺、断崖、为 0、同比/环比大幅变化、合计对不上这类反常的地方；没有就说"未见明显异常"。
4. 下钻方向：给 1~3 条值得进一步看的维度或问题（按哪个维度拆、对比哪段时间、核哪个口径）。

看不清坐标轴、图例或数字时直说，不要臆测具体数值。`,
};

function promptsDir() {
  return path.join(app.getPath('userData'), 'prompts');
}

function seedDefaults() {
  const dir = promptsDir();
  fs.mkdirSync(dir, { recursive: true });
  for (const name of Object.keys(DEFAULTS)) {
    const f = path.join(dir, name + '.txt');
    if (!fs.existsSync(f)) fs.writeFileSync(f, DEFAULTS[name], 'utf8');
  }
}

function list() {
  const dir = promptsDir();
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.txt'))
    .map((f) => f.slice(0, -4))
    .sort();
}

function read(name) {
  const f = path.join(promptsDir(), safe(name) + '.txt');
  if (!fs.existsSync(f)) return null;
  return fs.readFileSync(f, 'utf8');
}

function save(name, text) {
  const dir = promptsDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, safe(name) + '.txt'), String(text), 'utf8');
}

function remove(name) {
  const f = path.join(promptsDir(), safe(name) + '.txt');
  if (fs.existsSync(f)) fs.unlinkSync(f);
}

// 防止提示词名里塞路径分隔符逃出 prompts 目录
function safe(name) {
  const n = String(name).trim();
  if (!n || n.includes('/') || n.includes('\\') || n.startsWith('.')) {
    throw new Error('非法提示词名：' + name);
  }
  return n;
}

module.exports = { seedDefaults, list, read, save, remove, promptsDir, DEFAULTS };
