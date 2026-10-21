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

// provider 内部字段保持 snake_case（base_url/api_key/model/timeout/retries），与原型一致。
function resolveProvider(p) {
  const base = (p.base_url || '').replace(/\/+$/, '');
  const model = p.model || '';
  const token = p.api_key || '';
  if (!(base && model && token)) {
    const missing = [];
    if (!base) missing.push('base_url');
    if (!model) missing.push('model');
    if (!token) missing.push('key');
    throw new ModelError((p.name || '未命名') + ' 配置不全，缺 ' + missing.join('/'));
  }
  const format = p.format || 'anthropic_messages';
  const url = base + (format === 'anthropic_messages' ? '/v1/messages' : '/chat/completions');
  return {
    name: p.name || format,
    format,
    url,
    model,
    token,
    timeout: parseInt(p.timeout, 10) || 120,
    retries: parseInt(p.retries, 10) || 3,
  };
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

async function tryProvider(spec, prompt, imageB64, mediaType, maxTokens) {
  const { body, headers } = buildPayload(spec, prompt, imageB64, mediaType, maxTokens);
  const requestBody = JSON.stringify(body);
  const errors = [];
  for (let attempt = 1; attempt <= spec.retries; attempt++) {
    try {
      const res = await fetch(spec.url, {
        method: 'POST',
        headers,
        body: requestBody,
        signal: AbortSignal.timeout(spec.timeout * 1000),
      });
      if (!res.ok) {
        const detail = (await res.text().catch(() => '')).slice(0, 500);
        errors.push('第' + attempt + '次 HTTP ' + res.status + ': ' + detail);
        if (!RETRY_STATUS.includes(res.status)) break; // 权限/模型未关联这类错，重试无意义
      } else {
        let data;
        try {
          data = JSON.parse(await res.text());
        } catch (e) {
          errors.push('第' + attempt + '次 返回不是 JSON: ' + e.message);
          data = null;
        }
        if (data !== null) {
          const text = extract(spec, data);
          if (text) return { text, raw: data, attempt };
          errors.push('第' + attempt + '次 返回没有文本: ' + JSON.stringify(data).slice(0, 400));
          break; // 空文本视为失败，不重试（body 正常只是没内容，重试一样）
        }
      }
    } catch (error) {
      // fetch reject / AbortError(超时) / TypeError(连接重置) 全归可重试（对应 py 的 URLError/OSError 分支）
      errors.push('第' + attempt + '次 ' + (error.name || 'Error') + ': ' + error.message);
    }
    if (attempt < spec.retries) {
      await new Promise((r) => setTimeout(r, Math.min(2 ** (attempt - 1), 8) * 1000));
    }
  }
  throw new ModelError(
    spec.name + '（' + spec.model + ' / ' + spec.url + '）失败：\n  ' + errors.join('\n  ')
  );
}

async function analyze(imageBuffer, mediaType, prompt, config) {
  const imageB64 = imageBuffer.toString('base64');
  const maxTokens = parseInt(config.maxTokens, 10) || 1500;
  const failures = [];
  for (const provider of config.providers || []) {
    if (!provider.enabled) continue;
    let spec;
    try {
      spec = resolveProvider(provider);
    } catch (error) {
      failures.push(String(error.message));
      continue;
    }
    try {
      const { text, raw, attempt } = await tryProvider(spec, prompt, imageB64, mediaType, maxTokens);
      return { text, raw, via: spec.name + '（' + spec.model + '，第' + attempt + '次成功）' };
    } catch (error) {
      failures.push(String(error.message));
    }
  }
  throw new ModelError('所有模型通道都没通：\n' + failures.join('\n'));
}

module.exports = { analyze, ModelError, resolveProvider, buildPayload, extract };
