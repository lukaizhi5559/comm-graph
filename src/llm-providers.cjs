'use strict';

/**
 * llm-providers.cjs — Backend-routed LLM provider for comms-graph
 *
 * All LLM calls are routed through thinkdrop-backend's HTTP API:
 *   POST /api/llm         — non-streaming (returns full text)
 *   POST /api/llm/stream  — streaming SSE (returns chunks + done event)
 *
 * The backend handles provider selection, circuit breakers, model fallback,
 * catalog discovery, and free-premium/paid chain escalation. comms-graph
 * no longer makes direct provider API calls.
 *
 * API (unchanged from previous version — callers don't need changes):
 *   ask(messages, opts)      → Promise<{ text: string, provider: string }>
 *   askEarly(messages, opts) → Promise<{ firstSentence: string, fullText: string, provider: string }>
 *   buildMessages(userText, systemPrompt) → messages[]
 */

const http = require('http');
const logger = require('./logger.cjs');

const DEFAULT_MAX_TOKENS  = 150;
const DEFAULT_TEMPERATURE = 0.7;
const DEFAULT_TIMEOUT_MS  = 12000;

// ── Backend URL ────────────────────────────────────────────────────────────────
const BACKEND_BASE = (process.env.BACKEND_LLM_URL || 'http://localhost:4000/api/llm').replace(/\/$/, '');
const BACKEND_HOST = BACKEND_BASE.replace(/^https?:\/\//, '').split(':')[0] || 'localhost';
const BACKEND_PORT_MATCH = BACKEND_BASE.match(/:(\d+)\//);
const BACKEND_PORT = BACKEND_PORT_MATCH ? parseInt(BACKEND_PORT_MATCH[1], 10) : 4000;
const BACKEND_PATH = BACKEND_BASE.replace(/^https?:\/\/[^/]+/, '') || '/api/llm';
const BACKEND_API_KEY = process.env.STATEGRAPH_API_KEY || '';

// ── Messages → { systemPrompt, prompt } ────────────────────────────────────────
function _extractFromMessages(messages) {
  const systemMsgs = messages.filter(m => m.role === 'system');
  const userMsgs   = messages.filter(m => m.role !== 'system');
  const systemPrompt = systemMsgs.map(m => m.content).join('\n\n');
  const prompt = userMsgs.map(m => m.content).join('\n\n');
  return { systemPrompt, prompt };
}

// ── Non-streaming request ──────────────────────────────────────────────────────
function _postLLM(body, timeoutMs) {
  return new Promise((resolve) => {
    const jsonBody = JSON.stringify(body);
    const headers = {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(jsonBody),
    };
    if (BACKEND_API_KEY) headers['Authorization'] = 'Bearer ' + BACKEND_API_KEY;

    const req = http.request({
      hostname: BACKEND_HOST,
      port: BACKEND_PORT,
      path: BACKEND_PATH,
      method: 'POST',
      headers,
      timeout: timeoutMs,
    }, (res) => {
      let raw = '';
      res.on('data', c => { raw += c; });
      res.on('end', () => {
        if (res.statusCode >= 400) {
          logger.warn('[LLM] Backend HTTP error', { status: res.statusCode, preview: raw.substring(0, 200) });
          resolve(null);
          return;
        }
        try {
          const parsed = JSON.parse(raw);
          if (parsed.ok && parsed.data) {
            resolve({ text: parsed.data.text || '', provider: parsed.data.provider || 'backend', time: parsed.data.processingTime });
          } else {
            logger.warn('[LLM] Backend returned ok=false', { error: parsed.error });
            resolve(null);
          }
        } catch (err) {
          logger.warn('[LLM] Backend response parse failed', { error: err.message });
          resolve(null);
        }
      });
      res.on('error', () => resolve(null));
    });
    req.on('error', (err) => {
      logger.warn('[LLM] Backend request error', { error: err.message });
      resolve(null);
    });
    req.on('timeout', () => {
      req.destroy();
      logger.warn('[LLM] Backend request timeout', { timeoutMs });
      resolve(null);
    });
    req.write(jsonBody);
    req.end();
  });
}

// ── Streaming request (SSE) ────────────────────────────────────────────────────
function _streamLLM(body, timeoutMs, onChunk) {
  return new Promise((resolve) => {
    const jsonBody = JSON.stringify(body);
    const headers = {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(jsonBody),
    };
    if (BACKEND_API_KEY) headers['Authorization'] = 'Bearer ' + BACKEND_API_KEY;

    let fullText = '';
    let provider = 'backend';
    let settled = false;

    const done = (finalProvider) => {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        resolve({ fullText: fullText.trim(), provider: finalProvider || provider });
      }
    };

    const timeout = setTimeout(() => {
      logger.warn('[LLM] Backend stream timeout', { timeoutMs, chars: fullText.length });
      req.destroy();
      done();
    }, timeoutMs);

    const req = http.request({
      hostname: BACKEND_HOST,
      port: BACKEND_PORT,
      path: BACKEND_PATH + '/stream',
      method: 'POST',
      headers,
      timeout: timeoutMs,
    }, (res) => {
      let buffer = '';
      res.on('data', (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop(); // keep incomplete line

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) continue;
          const json = trimmed.slice(5).trim();
          if (!json) continue;
          try {
            const parsed = JSON.parse(json);
            if (parsed.done) {
              done(parsed.provider || provider);
              return;
            }
            if (parsed.error) {
              logger.warn('[LLM] Backend stream error event', { error: parsed.error });
              done();
              return;
            }
            if (parsed.text) {
              fullText += parsed.text;
              if (parsed.provider) provider = parsed.provider;
              if (onChunk) onChunk(parsed.text);
            }
          } catch (_) {}
        }
      });
      res.on('end', () => done());
      res.on('error', () => done());
    });
    req.on('error', (err) => {
      logger.warn('[LLM] Backend stream request error', { error: err.message });
      clearTimeout(timeout);
      done();
    });
    req.on('timeout', () => {
      req.destroy();
      logger.warn('[LLM] Backend stream socket timeout', { timeoutMs });
      clearTimeout(timeout);
      done();
    });
    req.write(jsonBody);
    req.end();
  });
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Ask the backend LLM (non-streaming). Tries the backend's resilient chain.
 * @param {Array} messages  - [{role, content}, ...]
 * @param {Object} opts     - { maxTokens, temperature, timeoutMs, taskType }
 * @returns {Promise<{ text: string, provider: string }>}
 */
async function ask(messages, opts = {}) {
  const resolvedOpts = {
    maxTokens:   opts.maxTokens   || DEFAULT_MAX_TOKENS,
    temperature: opts.temperature !== undefined ? opts.temperature : DEFAULT_TEMPERATURE,
    timeoutMs:   opts.timeoutMs   || DEFAULT_TIMEOUT_MS,
    taskType:    opts.taskType    || 'conversational',
  };

  const { systemPrompt, prompt } = _extractFromMessages(messages);
  if (!prompt) return { text: '', provider: 'none' };

  const body = {
    prompt,
    systemPrompt: systemPrompt || undefined,
    options: {
      maxTokens: resolvedOpts.maxTokens,
      temperature: resolvedOpts.temperature,
      taskType: resolvedOpts.taskType,
    },
  };

  const result = await _postLLM(body, resolvedOpts.timeoutMs);
  if (result && result.text) {
    logger.info('[LLM] Backend response', { provider: result.provider, chars: result.text.length, ms: result.time });
    return { text: result.text, provider: result.provider };
  }

  logger.error('[LLM] Backend call failed — no response');
  return { text: '', provider: 'none' };
}

/**
 * Ask the backend LLM with streaming and resolve as soon as the first sentence
 * is complete. Returns { firstSentence, fullText, provider }.
 * @param {Array} messages  - [{role, content}, ...]
 * @param {Object} opts     - { maxTokens, temperature, timeoutMs, taskType }
 * @returns {Promise<{ firstSentence: string, fullText: string, provider: string }>}
 */
async function askEarly(messages, opts = {}) {
  const resolvedOpts = {
    maxTokens:   opts.maxTokens   || DEFAULT_MAX_TOKENS,
    temperature: opts.temperature !== undefined ? opts.temperature : DEFAULT_TEMPERATURE,
    timeoutMs:   opts.timeoutMs   || DEFAULT_TIMEOUT_MS,
    taskType:    opts.taskType    || 'conversational',
  };

  const { systemPrompt, prompt } = _extractFromMessages(messages);
  if (!prompt) return { firstSentence: '', fullText: '', provider: 'none' };

  const body = {
    prompt,
    systemPrompt: systemPrompt || undefined,
    options: {
      maxTokens: resolvedOpts.maxTokens,
      temperature: resolvedOpts.temperature,
      taskType: resolvedOpts.taskType,
    },
  };

  let accumulated = '';
  let firstSentence = '';
  let earlyResolved = false;

  const checkEarly = () => {
    if (earlyResolved) return;
    // First "real" sentence boundary: ≥5 chars, terminator followed by
    // whitespace + a non-lowercase char (lowercase continuation = mid-sentence,
    // e.g. "e.g. you..."), and not preceded by a short title-case word
    // (Mr./Dr./Jr./Jan.-style abbreviations). Mid-token dots ("Three.js",
    // "v1.2", "3.14") and chunk boundaries ending in "." are skipped.
    const match = accumulated.match(/^[\s\S]{5,}?(?<![A-Z][a-z]{1,3})[.?!](?=\s+[^a-z])/);
    if (match && match[0].trim().length > 4) {
      firstSentence = match[0].trim();
      earlyResolved = true;
    }
  };

  const result = await _streamLLM(body, resolvedOpts.timeoutMs, (chunk) => {
    accumulated += chunk;
    checkEarly();
  });

  // Re-check with full text — end-of-string also counts as a boundary here
  const fullText = result.fullText;
  if (!earlyResolved) {
    const match = fullText.match(/^[\s\S]{5,}?(?<![A-Z][a-z]{1,3})[.?!](?=\s+[^a-z]|$)/);
    firstSentence = (match && match[0].trim().length > 4) ? match[0].trim() : fullText.trim();
  }

  const fs = firstSentence || fullText.trim();
  logger.info('[LLM] askEarly complete', { provider: result.provider, firstSentenceLen: fs.length, fullTextLen: fullText.length });

  return { firstSentence: fs, fullText, provider: result.provider };
}

/**
 * Convenience: build messages array from a simple prompt + system prompt.
 */
function buildMessages(userText, systemPrompt, conversationContext) {
  const msgs = [];
  if (systemPrompt && systemPrompt.trim()) msgs.push({ role: 'system', content: systemPrompt.trim() });
  // Inject conversation history so the LLM can reference prior context
  if (conversationContext && conversationContext.trim()) {
    msgs.push({ role: 'system', content: `=== RECENT CONVERSATION ===\n${conversationContext}\n=== END CONVERSATION ===\nUse this context to understand references in the user's message.` });
  }
  msgs.push({ role: 'user', content: userText });
  return msgs;
}

module.exports = { ask, askEarly, buildMessages };
