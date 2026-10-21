'use strict';
// 模型调用层。移植 llm.py，去掉 env/钉钉读取，用 Node 内置 fetch。
// 导出 analyze(imageBuffer, mediaType, prompt, config) -> {text, raw, via}；全失败抛 ModelError（聚合每 provider 错误）。
// 凭证只从传入 config 读，绝不打印 Authorization 头。

const RETRY_STATUS = [408, 429, 500, 502, 503, 504];

class ModelError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ModelError';
  }
}

// 拼接请求 URL，兼容两种现实：
//   case A：base 已自带版本段（智谱 https://open.bigmodel.cn/api/paas/v4、
//           百炼 https://dashscope.aliyuncs.com/compatible-mode/v1）——只接端点路径，
//           否则会拼成 /v4/v1/chat/completions、/v1/v1/messages 这类重复。
//   case B：base 不带版本段（http://localhost:3001 反代、https://api.openai.com）——
//           必须补 /v1，否则 openai 端点变成 POST /chat/completions → 404（v0.1 的 bug）。
// 判定：去掉尾斜杠后，若以 /v{数字} 或 /compatible-mode/v{数字} 结尾即视为已带版本段。
function joinUrl(base, format) {
  const clean = String(base || '').replace(/\/+$/, '');
  const hasVersion = /\/(?:v\d+|compatible-mode\/v\d+)$/i.test(clean);
  const endpoint =
    format === 'anthropic_messages' ? '/messages' : '/chat/completions';
  return clean + (hasVersion ? endpoint : '/v1' + endpoint);
}

// 默认模型优先级「候选池」：偏向已知支持视觉的名字。实际可用集合以运行时 supported_models 为准。
const DEFAULT_MODEL_PRIORITY = [
  'gpt-5.6-terra',
  'gpt-5.6-luna',
  'kimi-k3',
  'gpt-4o',
  'qwen-vl-max',
  'qwen-vl-plus',
  'glm-4v',
  'glm-4.5v',
];

// provider 内部字段保持 snake_case（base_url/api_key/model/timeout/retries），与原型一致。
// model 留空 = 「自动」（运行时解析可用视觉模型），非必填；base/key 仍必填。
function resolveProvider(p) {
  const base = (p.base_url || '').replace(/\/+$/, '');
  const model = p.model || '';
  const token = p.api_key || '';
  if (!(base && token)) {
    const missing = [];
    if (!base) missing.push('base_url');
    if (!token) missing.push('key');
    throw new ModelError((p.name || '未命名') + ' 配置不全，缺 ' + missing.join('/'));
  }
  const format = p.format || 'anthropic_messages';
  const url = joinUrl(base, format);
  return {
    name: p.name || format,
    format,
    url,
    model, // 可能为 ''（自动）
    token,
    timeout: parseInt(p.timeout, 10) || 120,
    retries: parseInt(p.retries, 10) || 3,
    stream: p.stream === true, // 默认关；仅 per-provider 显式开启
  };
}

// ---- 错误归类层：把底层错误翻译成「原因 + 怎么办」的中文短句 ----
// 识别多模型网关的「模型不可用」结构：body 带 error.supported_models 数组，
// 或 message 含 supported_models / 不支持模型。只有这种结构才触发自动换模型（单模型 API 不会命中）。
function parseSupportedStructure(bodyText) {
  let data = null;
  try {
    data = JSON.parse(bodyText);
  } catch (e) {
    return null;
  }
  const err = (data && data.error) || data || {};
  const supported = Array.isArray(err.supported_models) ? err.supported_models : null;
  const msg = String(err.message || err.msg || '');
  if (supported || /supported_models|不支持模型/i.test(msg)) {
    return { supported_models: supported || [], default_model: err.default_model || null };
  }
  return null;
}

// 归类：从具体到笼统，命中即停。exc 为 fetch 抛出的网络异常（无 HTTP 响应），否则传 status+body。
function classify(status, bodyText, exc) {
  if (exc) {
    const code = (exc.cause && exc.cause.code) || exc.code || '';
    const m = (exc.message || '') + ' ' + code + ' ' + (exc.name || '');
    if (exc.name === 'TimeoutError' || /timeout|ETIMEDOUT|超时/i.test(m)) return 'timeout';
    if (/ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH|refused|连接|fetch failed/i.test(m))
      return 'conn';
    return 'other';
  }
  let data = null;
  try {
    data = JSON.parse(bodyText);
  } catch (e) {
    /* 非 JSON（如 404 的 HTML），靠 status + 文本关键词判断 */
  }
  const err = (data && data.error) || data || {};
  const msg = String(err.message || err.msg || bodyText || '');
  const supported = Array.isArray(err.supported_models) ? err.supported_models : null;

  if (status === 401 || status === 403 || /invalid api key|unauthorized|无权|鉴权/i.test(msg))
    return 'auth';
  if (status === 404 || /cannot (post|get)|not found/i.test(msg)) return 'notfound';
  if (supported || /supported_models|不支持模型|not supported/i.test(msg)) return 'model_unsupported';
  if (/doesn't support|does not support|不支持图片|image|vision/i.test(msg))
    return 'image_unsupported';
  if (status === 413 || /too large|payload too|过大/i.test(msg)) return 'too_large';
  if (status === 429 || /rate limit|too many requests|频繁|限流/i.test(msg)) return 'rate_limit';
  return 'other';
}

// 人话文案（原因 + 怎么办）。model_unsupported / image_unsupported 带模型名与可用清单。
function friendlyText(kind, modelName, supported) {
  switch (kind) {
    case 'conn':
      return '连不上模型服务，检查 Base URL 和本地服务是否开着';
    case 'timeout':
      return '模型响应超时，可能网络慢或图太大，稍后重试';
    case 'auth':
      return 'API Key 无效或没权限，检查 Key 是否填对';
    case 'notfound':
      return '接口地址不对，检查 Base URL 和请求格式（OpenAI / Anthropic）是否匹配';
    case 'model_unsupported':
      return (
        '模型「' +
        (modelName || '?') +
        '」不可用' +
        (supported && supported.length ? '，可用：' + supported.join('、') : '')
      );
    case 'image_unsupported':
      return '模型「' + (modelName || '?') + '」不能识别图片';
    case 'too_large':
      return '截图太大，调低设置里的压缩长边或质量';
    case 'rate_limit':
      return '请求太频繁，稍等再试';
    default:
      return '';
  }
}

// 造一个带 kind/friendly/detail 的 ModelError。'other' 兜底给简短 message + 「（点开看详情）」。
function makeError(kind, modelName, supported, detail, status) {
  let friendly = friendlyText(kind, modelName, supported);
  if (!friendly) {
    const short = String(detail || '').split('\n')[0].slice(0, 120);
    friendly = (short || '调用失败') + '（点开看详情）';
  }
  const e = new ModelError(friendly);
  e.kind = kind;
  e.friendly = friendly;
  e.detail = String(detail || '');
  if (supported) e.supported_models = supported;
  if (status) e.status = status;
  return e;
}

function buildPayload(spec, prompt, imageB64, mediaType, maxTokens) {
  let body, headers;
  if (spec.format === 'anthropic_messages') {
    body = {
      model: spec.model,
      max_tokens: maxTokens,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            { type: 'image', source: { type: 'base64', media_type: mediaType, data: imageB64 } },
          ],
        },
      ],
    };
    headers = {
      Authorization: 'Bearer ' + spec.token,
      'Content-Type': 'application/json',
      'anthropic-version': '2023-06-01',
    };
  } else {
    body = {
      model: spec.model,
      max_tokens: maxTokens,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            { type: 'image_url', image_url: { url: 'data:' + mediaType + ';base64,' + imageB64 } },
          ],
        },
      ],
    };
    headers = { Authorization: 'Bearer ' + spec.token, 'Content-Type': 'application/json' };
  }
  return { body, headers };
}

// NIT-1：防御式取值，缺字段按空文本处理（触发「空文本视为失败」而非误入重试分支）。
function extract(spec, data) {
  if (spec.format === 'anthropic_messages') {
    const content = (data && data.content) || [];
    return content
      .filter((i) => i && i.type === 'text')
      .map((i) => i.text || '')
      .join('\n')
      .trim();
  }
  const content =
    (data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
  return String(content).trim();
}

// ---- 流式（SSE）解析，用 Node 内置能力，不引任何库 ----

// 从单个 SSE 事件块里取出增量文本。两格式分别处理：
//   openai: data 行是 JSON，取 choices[0].delta.content
//   anthropic: data 行是 JSON，type===content_block_delta 时取 delta.text
// 返回 '' 表示该事件无文本增量（ping/其它事件类型/[DONE]）。
function deltaFromEvent(format, eventText) {
  const dataLines = eventText
    .split('\n')
    .filter((l) => l.startsWith('data:'))
    .map((l) => l.slice(5).trim());
  if (!dataLines.length) return '';
  const payload = dataLines.join('\n');
  if (!payload || payload === '[DONE]') return '';
  let data;
  try {
    data = JSON.parse(payload);
  } catch (e) {
    return '';
  }
  if (format === 'anthropic_messages') {
    if (data && data.type === 'content_block_delta' && data.delta) {
      return data.delta.text || '';
    }
    return '';
  }
  const ch = data && data.choices && data.choices[0];
  return (ch && ch.delta && ch.delta.content) || '';
}

// 增量解析器：按 \n\n 切事件（先把 \r\n 归一成 \n），喂进文本片段、吐出增量数组。
// 返回的 push(text) 处理一段文本；末尾 flush() 处理最后一个未以 \n\n 结尾的事件。
function createSSEParser(format) {
  let buffer = '';
  function drain() {
    const out = [];
    let idx;
    while ((idx = buffer.indexOf('\n\n')) >= 0) {
      const ev = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const d = deltaFromEvent(format, ev);
      if (d) out.push(d);
    }
    return out;
  }
  return {
    push(text) {
      buffer += String(text).replace(/\r\n/g, '\n');
      return drain();
    },
    flush() {
      if (!buffer.trim()) {
        buffer = '';
        return [];
      }
      const d = deltaFromEvent(format, buffer);
      buffer = '';
      return d ? [d] : [];
    },
  };
}

// 流式请求：成功返回全文；任何异常（非2xx、无 body、解析不出文本）抛错由 analyze 回退。
async function tryProviderStream(spec, prompt, imageB64, mediaType, maxTokens, onDelta) {
  const { body, headers } = buildPayload(spec, prompt, imageB64, mediaType, maxTokens);
  body.stream = true;
  const res = await fetch(spec.url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(spec.timeout * 1000),
  });
  if (!res.ok) {
    const rawBody = await res.text().catch(() => '');
    const struct = parseSupportedStructure(rawBody);
    const detail = 'HTTP ' + res.status + ': ' + rawBody.slice(0, 500);
    if (struct) {
      const e = makeError('model_unsupported', spec.model, struct.supported_models, detail, res.status);
      e.default_model = struct.default_model;
      throw e;
    }
    throw makeError(classify(res.status, rawBody, null), spec.model, null, detail, res.status);
  }
  if (!res.body) throw makeError('other', spec.model, null, '流式响应无 body');
  const parser = createSSEParser(spec.format);
  const decoder = new TextDecoder();
  let full = '';
  const emit = (deltas) => {
    for (const d of deltas) {
      if (!d) continue;
      full += d;
      if (onDelta) onDelta(d, full);
    }
  };
  // undici 的 res.body 是 web ReadableStream，Node 下可异步迭代，chunk 为 Uint8Array
  for await (const chunk of res.body) {
    const text = typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
    emit(parser.push(text));
  }
  emit(parser.flush());
  full = full.trim();
  if (!full) throw new ModelError('流式未收到任何文本增量');
  return { text: full, raw: null, attempt: 1 };
}

async function tryProvider(spec, prompt, imageB64, mediaType, maxTokens) {
  const { body, headers } = buildPayload(spec, prompt, imageB64, mediaType, maxTokens);
  const requestBody = JSON.stringify(body);
  const errors = []; // {kind, detail}
  let firstKind = 'other';
  for (let attempt = 1; attempt <= spec.retries; attempt++) {
    try {
      const res = await fetch(spec.url, {
        method: 'POST',
        headers,
        body: requestBody,
        signal: AbortSignal.timeout(spec.timeout * 1000),
      });
      if (!res.ok) {
        const rawBody = await res.text().catch(() => '');
        const detail = 'HTTP ' + res.status + ': ' + rawBody.slice(0, 500);
        // 模型级错误立即上抛（不重试死模型），交 resolveAndCall 换模型
        const struct = parseSupportedStructure(rawBody);
        if (struct) {
          const e = makeError('model_unsupported', spec.model, struct.supported_models, detail, res.status);
          e.default_model = struct.default_model;
          throw e;
        }
        const kind = classify(res.status, rawBody, null);
        if (kind === 'image_unsupported') throw makeError(kind, spec.model, null, detail, res.status);
        if (errors.length === 0) firstKind = kind;
        errors.push({ kind, detail: '第' + attempt + '次 ' + detail });
        if (!RETRY_STATUS.includes(res.status)) break; // 权限/404 这类，重试无意义
      } else {
        let data;
        try {
          data = JSON.parse(await res.text());
        } catch (e) {
          errors.push({ kind: 'other', detail: '第' + attempt + '次 返回不是 JSON: ' + e.message });
          data = null;
        }
        if (data !== null) {
          const text = extract(spec, data);
          if (text) return { text, raw: data, attempt };
          errors.push({
            kind: 'other',
            detail: '第' + attempt + '次 返回没有文本: ' + JSON.stringify(data).slice(0, 400),
          });
          break; // 空文本视为失败，不重试
        }
      }
    } catch (error) {
      if (error instanceof ModelError && error.kind) throw error; // 已分类的模型级错误直接上抛
      const kind = classify(null, null, error);
      if (errors.length === 0) firstKind = kind;
      errors.push({ kind, detail: '第' + attempt + '次 ' + (error.name || 'Error') + ': ' + error.message });
    }
    if (attempt < spec.retries) {
      await new Promise((r) => setTimeout(r, Math.min(2 ** (attempt - 1), 8) * 1000));
    }
  }
  const detail =
    spec.name + '（' + spec.model + ' / ' + spec.url + '）失败：\n  ' +
    errors.map((e) => e.detail).join('\n  ');
  throw makeError(firstKind, spec.model, null, detail, null);
}

// 对单个确定模型发一次请求（流式优先，流式非模型级失败回退非流式重试一次同模型）。
async function callOnce(spec, prompt, imageB64, mediaType, maxTokens, onDelta) {
  if (spec.stream && typeof onDelta === 'function') {
    try {
      const r = await tryProviderStream(spec, prompt, imageB64, mediaType, maxTokens, onDelta);
      return { text: r.text, raw: r.raw, via: spec.name + '（' + spec.model + '，流式）' };
    } catch (streamErr) {
      // 模型级错误（换模型能解决）直接上抛；端点不支持流等则回退非流式，别用同一死模型瞎回退
      if (streamErr && (streamErr.supported_models || streamErr.kind === 'image_unsupported')) throw streamErr;
    }
  }
  const r = await tryProvider(spec, prompt, imageB64, mediaType, maxTokens);
  return { text: r.text, raw: r.raw, via: spec.name + '（' + spec.model + '，第' + r.attempt + '次成功）' };
}

// 已解析可用模型缓存（内存，主进程常驻）。键 = format|url；值 = 模型名。
// 成功即缓存，后续请求直接用；缓存模型再失败则清缓存重走解析。
const resolvedCache = new Map();
// 最近一次从多模型网关学到的可用清单，供设置页展示（requirement：列出 supported_models）。
let lastSupported = null;

function getLastSupported() {
  return lastSupported;
}

// 对单个 provider 做「模型自动识别 + 优先级回退」。只在检测到 supported_models 结构时才换模型，
// 普通单模型 API 不触发（其报错不带该结构）→ 按用户填的 model 调用、失败照常抛（经归类层翻译）。
async function resolveAndCall(spec, priority, prompt, imageB64, mediaType, maxTokens, onDelta) {
  const cacheKey = spec.format + '|' + spec.url;
  const manual = !!spec.model; // 用户是否手填了模型
  let autoMode = !manual; // 用户模型遭遇模型级错误后转为 true，开始按优先级回退
  const tried = new Set();
  const excluded = new Set(); // 本次证实不可用（不支持/不识图）
  let supported = null; // 学到的上游可用清单（null 表示还没学到 / 非网关）
  let defaultModel = null;
  const errs = [];
  const MAX_TRIES = 4;

  function pick() {
    // manual：首选用户填的（还没失败时）
    if (manual && spec.model && !tried.has(spec.model) && !excluded.has(spec.model)) return spec.model;
    // auto：缓存优先
    if (autoMode) {
      const c = resolvedCache.get(cacheKey);
      if (c && !tried.has(c) && !excluded.has(c)) return c;
    }
    // 学到 supported 后：priority ∩ supported 按 priority 顺序 → default_model → supported[0]
    if (supported) {
      for (const m of priority) if (supported.includes(m) && !tried.has(m) && !excluded.has(m)) return m;
      if (defaultModel && !tried.has(defaultModel) && !excluded.has(defaultModel)) return defaultModel;
      for (const m of supported) if (!tried.has(m) && !excluded.has(m)) return m;
      return null;
    }
    // 自动模式（含 manual 模型失败后）：用 priority 第一个没试过的当探针
    if (autoMode) for (const m of priority) if (!tried.has(m) && !excluded.has(m)) return m;
    return null;
  }

  for (let i = 0; i < MAX_TRIES; i++) {
    const model = pick();
    if (!model) break;
    tried.add(model);
    const trySpec = Object.assign({}, spec, { model });
    try {
      const r = await callOnce(trySpec, prompt, imageB64, mediaType, maxTokens, onDelta);
      resolvedCache.set(cacheKey, model); // 记住可用视觉模型
      return r;
    } catch (e) {
      errs.push(e);
      if (e && e.supported_models) {
        // 多模型网关：学清单，转自动回退，换下一个
        supported = e.supported_models;
        lastSupported = supported;
        if (e.default_model) defaultModel = e.default_model;
        excluded.add(model);
        autoMode = true;
        if (resolvedCache.get(cacheKey) === model) resolvedCache.delete(cacheKey);
        continue;
      }
      if (e && e.kind === 'image_unsupported') {
        // 该模型不识图（错误里常不带 supported 清单）：剔除并转自动模式按优先级换
        excluded.add(model);
        autoMode = true;
        if (resolvedCache.get(cacheKey) === model) resolvedCache.delete(cacheKey);
        continue;
      }
      // 其它错误（连不上/鉴权/404/超时等）：不是换模型能解决的，直接抛（保留归类）
      throw e;
    }
  }

  // 候选耗尽：给人话聚合错误
  const withSupported = errs.find((e) => e && e.supported_models);
  let friendly;
  if (supported) {
    friendly = '当前服务没有可用于识图的模型，上游可用：' + supported.join('、');
  } else {
    const first = errs[0];
    friendly = (first && first.friendly) || '所有模型都没通';
  }
  const detail = errs.map((e) => (e && e.detail) || String(e && e.message)).join('\n');
  const agg = new ModelError(friendly);
  agg.kind = (withSupported && 'model_unsupported') || (errs[0] && errs[0].kind) || 'other';
  agg.friendly = friendly;
  agg.detail = detail;
  if (supported) agg.supported_models = supported;
  throw agg;
}

// onDelta(delta, full) 可选：provider.stream===true 且传了 onDelta 时走流式；
// 流式对不支持流的端点会优雅回退非流式（见 callOnce），不会把能用的端点弄挂。
// 返回 {text, raw, via}；全失败抛带 .friendly/.detail/.supported_models 的 ModelError。
async function analyze(imageBuffer, mediaType, prompt, config, onDelta) {
  const imageB64 = imageBuffer.toString('base64');
  const maxTokens = parseInt(config.maxTokens, 10) || 800;
  const priority =
    Array.isArray(config.model_priority) && config.model_priority.length
      ? config.model_priority
      : DEFAULT_MODEL_PRIORITY;
  const failures = [];
  let lastErr = null;
  for (const provider of config.providers || []) {
    if (!provider.enabled) continue;
    let spec;
    try {
      spec = resolveProvider(provider);
    } catch (error) {
      lastErr = error;
      failures.push(error);
      continue;
    }
    try {
      return await resolveAndCall(spec, priority, prompt, imageB64, mediaType, maxTokens, onDelta);
    } catch (error) {
      lastErr = error;
      failures.push(error);
    }
  }
  // 单 provider（常态）直接透传其归类错误；多 provider 时取第一个的人话 + 合并详情。
  const enabledCount = (config.providers || []).filter((p) => p.enabled).length;
  if (enabledCount <= 1 && lastErr) throw lastErr;
  const friendly = (failures[0] && failures[0].friendly) || '所有模型通道都没通';
  const agg = new ModelError(friendly);
  agg.kind = (failures[0] && failures[0].kind) || 'other';
  agg.friendly = friendly;
  agg.detail = failures.map((e) => (e && e.detail) || String(e && e.message)).join('\n\n');
  const sup = failures.find((e) => e && e.supported_models);
  if (sup) agg.supported_models = sup.supported_models;
  throw agg;
}

module.exports = {
  analyze,
  ModelError,
  resolveProvider,
  buildPayload,
  extract,
  joinUrl,
  createSSEParser,
  deltaFromEvent,
  tryProviderStream,
  classify,
  friendlyText,
  parseSupportedStructure,
  makeError,
  getLastSupported,
  DEFAULT_MODEL_PRIORITY,
};
