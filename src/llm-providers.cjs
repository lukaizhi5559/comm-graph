'use strict';

/**
 * llm-providers.cjs — Shared LLM provider chain for comms-graph
 *
 * Moved from voice-service. Tries providers in order until one succeeds.
 * Provider order: openai → claude → gemini → grok → mistral → deepseek
 *
 * API:
 *   ask(messages, opts)      → Promise<{ text: string, provider: string }>
 *   askEarly(messages, opts) → Promise<{ firstSentence: string, fullText: string, provider: string }>
 *   buildMessages(userText, systemPrompt) → messages[]
 */

const https = require('https');
const logger = require('./logger.cjs');

const DEFAULT_MAX_TOKENS  = 150;
const DEFAULT_TEMPERATURE = 0.7;
const DEFAULT_TIMEOUT_MS  = 12000;

// ── Shared HTTPS helper ────────────────────────────────────────────────────────
function _post(hostname, path, headers, body, timeoutMs) {
  return new Promise((resolve) => {
    const req = https.request({
      hostname,
      path,
      method: 'POST',
      headers: {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(body),
        ...headers,
      },
      timeout: timeoutMs,
    }, (res) => {
      let raw = '';
      res.on('data', c => { raw += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: raw }));
      res.on('error', () => resolve(null));
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.write(body);
    req.end();
  });
}

function _parseText(raw) {
  try { return JSON.parse(raw); } catch (_) { return null; }
}

// ── Provider implementations ───────────────────────────────────────────────────

async function _tryOpenAI(messages, opts) {
  const apiKey = process.env.OPENAI_API_KEY || '';
  if (!apiKey) return null;
  const body = JSON.stringify({
    model: 'gpt-4o-mini',
    messages,
    max_tokens: opts.maxTokens,
    temperature: opts.temperature,
  });
  const res = await _post('api.openai.com', '/v1/chat/completions',
    { Authorization: 'Bearer ' + apiKey }, body, opts.timeoutMs);
  if (!res || res.status >= 400) return null;
  const parsed = _parseText(res.body);
  const text = parsed && parsed.choices && parsed.choices[0] &&
    parsed.choices[0].message && parsed.choices[0].message.content;
  return text ? text.trim() : null;
}

async function _tryClaude(messages, opts) {
  const apiKey = process.env.ANTHROPIC_API_KEY || '';
  if (!apiKey) return null;
  const systemMsg = messages.find(m => m.role === 'system');
  const chatMsgs  = messages.filter(m => m.role !== 'system');
  const body = JSON.stringify({
    model: 'claude-3-haiku-20240307',
    max_tokens: opts.maxTokens,
    temperature: opts.temperature,
    ...(systemMsg ? { system: systemMsg.content } : {}),
    messages: chatMsgs,
  });
  const res = await _post('api.anthropic.com', '/v1/messages', {
    'x-api-key': apiKey,
    'anthropic-version': '2023-06-01',
  }, body, opts.timeoutMs);
  if (!res || res.status >= 400) return null;
  const parsed = _parseText(res.body);
  const text = parsed && parsed.content && parsed.content[0] && parsed.content[0].text;
  return text ? text.trim() : null;
}

async function _tryGemini(messages, opts) {
  const apiKey = process.env.GEMINI_API_KEY || '';
  if (!apiKey) return null;
  const systemMsg = messages.find(m => m.role === 'system');
  const chatMsgs  = messages.filter(m => m.role !== 'system').map(m => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));
  const body = JSON.stringify({
    contents: chatMsgs,
    generationConfig: { maxOutputTokens: opts.maxTokens, temperature: opts.temperature },
    ...(systemMsg ? { systemInstruction: { parts: [{ text: systemMsg.content }] } } : {}),
  });
  const path = '/v1beta/models/gemini-2.0-flash:generateContent?key=' + apiKey;
  const res = await _post('generativelanguage.googleapis.com', path, {}, body, opts.timeoutMs);
  if (!res || res.status >= 400) return null;
  const parsed = _parseText(res.body);
  const text = parsed && parsed.candidates && parsed.candidates[0] &&
    parsed.candidates[0].content && parsed.candidates[0].content.parts &&
    parsed.candidates[0].content.parts[0] && parsed.candidates[0].content.parts[0].text;
  return text ? text.trim() : null;
}

async function _tryGrok(messages, opts) {
  const apiKey = process.env.GROK_API_KEY || '';
  if (!apiKey) return null;
  const body = JSON.stringify({
    model: 'grok-2-latest',
    messages,
    max_tokens: opts.maxTokens,
    temperature: opts.temperature,
  });
  const res = await _post('api.x.ai', '/v1/chat/completions',
    { Authorization: 'Bearer ' + apiKey }, body, opts.timeoutMs);
  if (!res || res.status >= 400) return null;
  const parsed = _parseText(res.body);
  const text = parsed && parsed.choices && parsed.choices[0] &&
    parsed.choices[0].message && parsed.choices[0].message.content;
  return text ? text.trim() : null;
}

async function _tryMistral(messages, opts) {
  const apiKey = process.env.MISTRAL_API_KEY || '';
  if (!apiKey) return null;
  const body = JSON.stringify({
    model: 'mistral-small-latest',
    messages,
    max_tokens: opts.maxTokens,
    temperature: opts.temperature,
  });
  const res = await _post('api.mistral.ai', '/v1/chat/completions',
    { Authorization: 'Bearer ' + apiKey }, body, opts.timeoutMs);
  if (!res || res.status >= 400) return null;
  const parsed = _parseText(res.body);
  const text = parsed && parsed.choices && parsed.choices[0] &&
    parsed.choices[0].message && parsed.choices[0].message.content;
  return text ? text.trim() : null;
}

async function _tryDeepSeek(messages, opts) {
  const apiKey = process.env.DEEPSEEK_API_KEY || '';
  if (!apiKey) return null;
  const body = JSON.stringify({
    model: 'deepseek-chat',
    messages,
    max_tokens: opts.maxTokens,
    temperature: opts.temperature,
  });
  const res = await _post('api.deepseek.com', '/v1/chat/completions',
    { Authorization: 'Bearer ' + apiKey }, body, opts.timeoutMs);
  if (!res || res.status >= 400) return null;
  const parsed = _parseText(res.body);
  const text = parsed && parsed.choices && parsed.choices[0] &&
    parsed.choices[0].message && parsed.choices[0].message.content;
  return text ? text.trim() : null;
}

// ── Provider chain ─────────────────────────────────────────────────────────────

const PROVIDERS = [
  { name: 'openai',   fn: _tryOpenAI   },
  { name: 'claude',   fn: _tryClaude   },
  { name: 'gemini',   fn: _tryGemini   },
  { name: 'grok',     fn: _tryGrok     },
  { name: 'mistral',  fn: _tryMistral  },
  { name: 'deepseek', fn: _tryDeepSeek },
];

/**
 * Stream OpenAI and resolve as soon as the first sentence is complete.
 * Returns { firstSentence, fullText, provider } — firstSentence available
 * ~300-500ms after the request starts (vs ~1.5s for full response).
 */
async function askEarly(messages, opts = {}) {
  const apiKey = process.env.OPENAI_API_KEY || '';
  if (!apiKey) {
    const { text, provider } = await ask(messages, opts);
    const match = text.match(/^[^.?!]*[.?!]/);
    const firstSentence = (match && match[0].trim().length > 4) ? match[0].trim() : text.trim();
    return { firstSentence, fullText: text, provider };
  }

  const resolvedOpts = {
    maxTokens:   opts.maxTokens   || DEFAULT_MAX_TOKENS,
    temperature: opts.temperature !== undefined ? opts.temperature : DEFAULT_TEMPERATURE,
    timeoutMs:   opts.timeoutMs   || DEFAULT_TIMEOUT_MS,
  };

  return new Promise((resolve) => {
    const body = JSON.stringify({
      model: 'gpt-4o-mini',
      messages,
      max_tokens: resolvedOpts.maxTokens,
      temperature: resolvedOpts.temperature,
      stream: true,
    });

    let fullText = '';
    let firstSentence = '';
    let earlyResolved = false;
    let settled = false;

    const checkEarly = () => {
      if (earlyResolved) return;
      const match = fullText.match(/^[^.?!]*[.?!]/);
      if (match && match[0].trim().length > 4) {
        firstSentence = match[0].trim();
        earlyResolved = true;
      }
    };

    const done = () => {
      if (!settled) {
        settled = true;
        const fs = firstSentence || fullText.trim() || 'Forgive the delay — no answer came in time.';
        logger.info('[LLM] askEarly complete', { provider: 'openai', firstSentenceLen: fs.length });
        resolve({ firstSentence: fs, fullText: fullText.trim() || fs, provider: 'openai' });
      }
    };

    const timeout = setTimeout(done, resolvedOpts.timeoutMs);

    const req = https.request({
      hostname: 'api.openai.com',
      path: '/v1/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + apiKey,
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: resolvedOpts.timeoutMs,
    }, (res) => {
      res.on('data', (chunk) => {
        const lines = chunk.toString().split('\n');
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) continue;
          const json = trimmed.slice(5).trim();
          if (json === '[DONE]') { clearTimeout(timeout); done(); return; }
          try {
            const parsed = JSON.parse(json);
            const delta = parsed.choices && parsed.choices[0] && parsed.choices[0].delta && parsed.choices[0].delta.content;
            if (delta) { fullText += delta; checkEarly(); }
          } catch (_) {}
        }
      });
      res.on('end', () => { clearTimeout(timeout); done(); });
      res.on('error', () => { clearTimeout(timeout); done(); });
    });
    req.on('error', () => { clearTimeout(timeout); done(); });
    req.on('timeout', () => { req.destroy(); clearTimeout(timeout); done(); });
    req.write(body);
    req.end();
  });
}

/**
 * Ask the LLM chain. Tries each provider in order until one succeeds.
 */
async function ask(messages, opts = {}) {
  const resolvedOpts = {
    maxTokens:   opts.maxTokens   || DEFAULT_MAX_TOKENS,
    temperature: opts.temperature !== undefined ? opts.temperature : DEFAULT_TEMPERATURE,
    timeoutMs:   opts.timeoutMs   || DEFAULT_TIMEOUT_MS,
  };

  for (const { name, fn } of PROVIDERS) {
    try {
      const text = await fn(messages, resolvedOpts);
      if (text) {
        logger.info('[LLM] Provider success', { provider: name, chars: text.length });
        return { text, provider: name };
      }
    } catch (err) {
      logger.warn('[LLM] Provider error', { provider: name, error: err.message });
    }
  }

  logger.error('[LLM] All providers failed');
  return { text: '', provider: 'none' };
}

/**
 * Convenience: build messages array from a simple prompt + system prompt.
 */
function buildMessages(userText, systemPrompt) {
  const msgs = [];
  if (systemPrompt && systemPrompt.trim()) msgs.push({ role: 'system', content: systemPrompt.trim() });
  msgs.push({ role: 'user', content: userText });
  return msgs;
}

module.exports = { ask, askEarly, buildMessages, PROVIDERS };
