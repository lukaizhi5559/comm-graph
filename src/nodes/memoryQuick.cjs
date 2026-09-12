'use strict';

/**
 * memoryQuick.cjs — Intent 2: quick personal fact recall
 *
 * Handles quick profile/fact lookups: name, favorite color, email, job, age.
 * Uses LLM-based attribute detection (no brittle regex) — mirrors the
 * stategraph's `_llmDetectPersonalAttribute` approach in retrieveMemory.js.
 * Queries the user-memory-service (port 3001) for profile data, with
 * semantic memory.search as a fallback for attributes not in the profile store.
 *
 * Target response time: <2s (LLM classify + memory service call + LLM naturalization)
 */

const http = require('http');
const logger = require('../logger.cjs');
const { ask, buildMessages } = require('../llm-providers.cjs');

const MEMORY_PORT = parseInt(process.env.MEMORY_SERVICE_PORT || '3001', 10);
const MEM_API_KEY = process.env.MCP_USER_MEMORY_API_KEY || process.env.USER_MEMORY_API_KEY || process.env.MCP_API_KEY || '';

// ── Personal attributes (mirrors stategraph retrieveMemory.js) ─────────────────
// LLM returns a single index (0-11) corresponding to an attribute.
const ATTRIBUTES = [
  'name', 'email', 'phone', 'birthday', 'location', 'timezone',
  'company', 'occupation', 'github', 'username', 'address', 'language',
];

// Map attribute → self: namespace keys (matching personalProfile.js SELF_FIELD_MAP)
// Order matters — try the most specific first.
const ATTRIBUTE_PROFILE_KEYS = {
  name:      ['self:name', 'self:first_name'],
  email:     ['self:email'],
  phone:     ['self:phone'],
  birthday:  ['self:birthday'],
  location:  ['self:location'],
  timezone:  ['self:timezone'],
  company:   ['self:company', 'self:occupation'],
  occupation: ['self:occupation', 'self:company'],
  github:    ['self:github'],
  username:  ['self:username'],
  address:   ['self:address', 'self:work_address'],
  language:  ['self:language'],
};

// Attributes NOT in the profile store — use semantic memory.search only
const SEMANTIC_ONLY_ATTRIBUTES = new Set([
  'favorite_color', 'age', 'job',
]);

// ── Fact-store patterns (explicit provision — deterministic, keep regex) ──────
// Maps explicit "my X is Y" statements to self: namespace keys
const FACT_STORE_PATTERNS = [
  { pattern: /\bmy\s+name\s+is\s+([^\.\,!?]+)/i, key: 'self:name', label: 'name' },
  { pattern: /\bmy\s+favorite\s+color\s+is\s+([^\.\,!?]+)/i, key: 'favorite_color', label: 'favorite color' },
  { pattern: /\bmy\s+(email|e-mail)\s+is\s+([^\.\,!?]+)/i, key: 'self:email', label: 'email' },
  { pattern: /\bmy\s+(phone\s+number|number)\s+is\s+([^\.\,!?]+)/i, key: 'self:phone', label: 'phone number' },
  { pattern: /\bmy\s+(job|occupation|profession)\s+is\s+([^\.\,!?]+)/i, key: 'self:occupation', label: 'job' },
  { pattern: /\bmy\s+birthday\s+is\s+([^\.\,!?]+)/i, key: 'self:birthday', label: 'birthday' },
  { pattern: /\bi\s+(live|work)\s+in\s+([^\.\,!?]+)/i, key: 'self:location', label: 'location' },
  { pattern: /\bremember\s+(?:that\s+)?my\s+([a-z\s]+?)\s+is\s+([^\.\,!?]+)/i, key: null, label: null },
];

/**
 * Detect an explicit fact-provision statement.
 * @param {string} englishText
 * @returns {{ key: string, label: string, value: string }|null}
 */
function detectFactStore(englishText) {
  for (const { pattern, key, label } of FACT_STORE_PATTERNS) {
    const m = pattern.exec(englishText);
    if (m) {
      if (key) {
        const value = (m[2] || m[1] || '').trim();
        return { key, label, value };
      } else {
        // Generic "remember my X is Y" — extract key + value from captures
        const rawKey = (m[1] || '').trim().toLowerCase().replace(/\s+/g, '_');
        const v = (m[2] || '').trim();
        if (rawKey && v) {
          // Map common phrases to self: namespace, fall back to self:<key>
          const mappedKey = ATTRIBUTE_PROFILE_KEYS[rawKey]?.[0] || `self:${rawKey}`;
          return { key: mappedKey, label: m[1].trim(), value: v };
        }
      }
    }
  }
  return null;
}

/**
 * Detect an implicit fact-provision statement ("it's red", "it is John")
 * that follows a memory question in conversation context.
 * @param {string} englishText
 * @param {string} [conversationContext]
 * @returns {{ key: string, label: string, value: string }|null}
 */
function detectImplicitFactStore(englishText, conversationContext) {
  // Short elliptical answer: "it's X", "it is X", "that's X"
  const m = /\b(?:it'?s|it\s+is|that'?s|that\s+is)\s+([^\.\,!?]+)/i.exec(englishText);
  if (!m) return null;
  if (!conversationContext) return null;

  // Find the most recent memory question in context to infer the key
  const lines = conversationContext.split('\n').reverse();
  for (const line of lines) {
    const userMatch = /^User:\s+(.+)$/i.exec(line);
    if (!userMatch) continue;
    const prevText = userMatch[1];
    // Use LLM detection on the previous question to infer the attribute
    // (synchronous fallback: check if the previous question mentions a known attribute)
    const prevLower = prevText.toLowerCase();
    for (const [attr, keys] of Object.entries(ATTRIBUTE_PROFILE_KEYS)) {
      if (prevLower.includes(attr) || prevLower.includes(attr.replace('_', ' '))) {
        const value = m[1].trim();
        if (value) return { key: keys[0], label: attr.replace('_', ' '), value };
      }
    }
    // Check semantic-only attributes (favorite_color, age, job)
    if (prevLower.includes('favorite color')) {
      const value = m[1].trim();
      if (value) return { key: 'favorite_color', label: 'favorite color', value };
    }
    if (prevLower.includes('how old')) {
      const value = m[1].trim();
      if (value) return { key: 'age', label: 'age', value };
    }
  }
  return null;
}

// ── LLM-based attribute detection ─────────────────────────────────────────────
/**
 * Use LLM to detect which personal attribute the user is asking about.
 * Mirrors stategraph's `_llmDetectPersonalAttribute` in retrieveMemory.js.
 * Returns attribute name or null.
 * @param {string} englishText
 * @returns {Promise<string|null>}
 */
async function _llmDetectAttribute(englishText) {
  const q = (englishText || '').trim();

  // Quick pre-filter: only run LLM on short messages with possessive pronouns
  if (!/\b(my|your|i)\b/i.test(q) || q.split(/\s+/).length > 15) {
    return null;
  }

  const numberedList = ATTRIBUTES.map((a, i) => `${i}: ${a}`).join('\n');
  const systemPrompt = `You extract personal attributes from short messages. Return ONLY a single number — nothing else:
  -1 = no personal attribute mentioned
  0..11 = the index of the attribute from this list:
${numberedList}`;
  const prompt = `Message: "${q}"\n\nAttribute index (0–11 or -1):`;

  try {
    const { text: raw } = await ask(buildMessages(prompt, systemPrompt), {
      maxTokens: 5,
      temperature: 0,
      timeoutMs: 3000,
      taskType: 'classification',
    });
    if (!raw) return null;
    const numMatch = (raw || '').trim().match(/-?\d+/);
    const idx = numMatch ? parseInt(numMatch[0], 10) : -1;
    if (idx >= 0 && idx < ATTRIBUTES.length) {
      const attr = ATTRIBUTES[idx];
      logger.info('[MemoryQuick] LLM detected attribute', { attribute: attr, index: idx });
      return attr;
    }
    return null;
  } catch (e) {
    logger.debug('[MemoryQuick] LLM attribute detection failed', { error: e.message });
    return null;
  }
}

/**
 * Detect "favorite color" and "age" queries that aren't in the standard
 * ATTRIBUTES list. These need semantic memory.search, not profile.get.
 * @param {string} englishText
 * @returns {string|null} - 'favorite_color', 'age', 'job', or null
 */
function _detectSemanticAttribute(englishText) {
  const q = englishText.toLowerCase();
  if (/\bfavorite\s+color\b/.test(q)) return 'favorite_color';
  if (/\bhow\s+old\s+am\s+i\b/.test(q)) return 'age';
  if (/\bmy\s+(job|occupation|profession)\b/.test(q)) return 'job';
  return null;
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────
/**
 * Query user-memory-service for a profile fact.
 * @param {string} key - profile key (e.g., 'self:name')
 * @returns {Promise<string|null>} the fact value, or null if not found
 */
function _queryMemory(key) {
  return new Promise((resolve) => {
    const body = JSON.stringify({
      version: 'mcp.v1',
      service: 'user-memory',
      action: 'profile.get',
      payload: { key },
      requestId: 'cg_mem_' + Date.now(),
    });
    const headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) };
    if (MEM_API_KEY) headers['Authorization'] = 'Bearer ' + MEM_API_KEY;

    const req = http.request({
      hostname: '127.0.0.1',
      port: MEMORY_PORT,
      path: '/profile.get',
      method: 'POST',
      headers,
      timeout: 3000,
    }, (res) => {
      let raw = '';
      res.on('data', c => { raw += c; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(raw);
          // profile.get returns data.valueRef (mapped from value_ref by _row())
          // Fall back to legacy data.value / data[key] for compatibility
          const value = parsed?.data?.valueRef || parsed?.data?.value || parsed?.data?.[key] || null;
          resolve(value);
        } catch (_) { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.write(body);
    req.end();
  });
}

/**
 * Try multiple profile keys for an attribute (e.g., self:name then self:first_name).
 * @param {string[]} keys
 * @returns {Promise<string|null>}
 */
async function _queryMemoryKeys(keys) {
  for (const key of keys) {
    const value = await _queryMemory(key);
    if (value) return value;
  }
  return null;
}

/**
 * Semantic memory search — fallback for attributes not in the profile store.
 * @param {string} query
 * @returns {Promise<string|null>}
 */
function _semanticMemorySearch(query) {
  return new Promise((resolve) => {
    const body = JSON.stringify({
      version: 'mcp.v1',
      service: 'user-memory',
      action: 'memory.search',
      payload: { query, limit: 3, minSimilarity: 0.3 },
      requestId: 'cg_memsearch_' + Date.now(),
    });
    const headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) };
    if (MEM_API_KEY) headers['Authorization'] = 'Bearer ' + MEM_API_KEY;

    const req = http.request({
      hostname: '127.0.0.1',
      port: MEMORY_PORT,
      path: '/memory.search',
      method: 'POST',
      headers,
      timeout: 3000,
    }, (res) => {
      let raw = '';
      res.on('data', c => { raw += c; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(raw);
          const results = parsed?.data?.results || parsed?.data || [];
          if (Array.isArray(results) && results.length > 0) {
            // Return the top result's text
            const top = results[0];
            const text = top.text || top.content || top.value || null;
            resolve(text);
          } else {
            resolve(null);
          }
        } catch (_) { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.write(body);
    req.end();
  });
}

/**
 * Store a profile fact in user-memory-service.
 * @param {string} key
 * @param {string} value
 * @returns {Promise<boolean>} true if stored successfully
 */
function _storeMemory(key, value) {
  return new Promise((resolve) => {
    const body = JSON.stringify({
      version: 'mcp.v1',
      service: 'user-memory',
      action: 'profile.set',
      payload: { key, valueRef: String(value) },
      requestId: 'cg_memstore_' + Date.now(),
    });
    const headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) };
    if (MEM_API_KEY) headers['Authorization'] = 'Bearer ' + MEM_API_KEY;

    const req = http.request({
      hostname: '127.0.0.1',
      port: MEMORY_PORT,
      path: '/profile.set',
      method: 'POST',
      headers,
      timeout: 3000,
    }, (res) => {
      let raw = '';
      res.on('data', c => { raw += c; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(raw);
          resolve(parsed?.status === 'ok');
        } catch (_) { resolve(false); }
      });
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.write(body);
    req.end();
  });
}

/**
 * @param {string} englishText  - English user message
 * @param {string} systemPrompt - Full system prompt (persona + personality)
 * @param {string} [conversationContext] - Recent conversation turns for context awareness
 * @returns {Promise<{ text: string, fullText: string, metadata: Object }>}
 */
async function execute(englishText, systemPrompt, conversationContext) {
  // Check for fact-store FIRST — explicit ("my name is X") or implicit ("it's X" after a question)
  const store = detectFactStore(englishText) || detectImplicitFactStore(englishText, conversationContext);

  if (store) {
    logger.info('[MemoryQuick] Storing fact', { key: store.key, valuePreview: store.value.substring(0, 40) });
    const ok = await _storeMemory(store.key, store.value);
    if (ok) {
      const response = `Got it — I'll remember your ${store.label} is ${store.value}. ✅`;
      logger.info('[MemoryQuick] Stored', { key: store.key });
      return {
        text: response,
        fullText: response,
        metadata: { source: 'memory_quick_store', intent: 2, factKey: store.key, factValue: store.value },
      };
    }
    // Store failed — still acknowledge so the user isn't left hanging
    logger.warn('[MemoryQuick] Store failed', { key: store.key });
    const response = `I heard you, but I couldn't save that to memory just now. Try again in a moment?`;
    return {
      text: response,
      fullText: response,
      metadata: { source: 'memory_quick_store_failed', intent: 2, factKey: store.key },
    };
  }

  // ── LLM-based attribute detection ────────────────────────────────────────────
  // Check semantic-only attributes first (favorite_color, age, job) — these
  // aren't in the ATTRIBUTES list and need memory.search instead of profile.get
  const semanticAttr = _detectSemanticAttribute(englishText);
  let attribute = semanticAttr;
  let useSemanticOnly = !!semanticAttr;

  // If not a semantic-only attribute, use LLM detection
  if (!attribute) {
    attribute = await _llmDetectAttribute(englishText);
  }

  if (!attribute) {
    // Not a recognizable quick fact — handoff
    logger.info('[MemoryQuick] No attribute detected, falling back', { text: englishText.substring(0, 60) });
    return {
      text: "Let me check your records — I'll have that for you in a moment.",
      fullText: "Let me check your records — I'll have that for you in a moment.",
      metadata: { source: 'memory_quick_no_match', intent: 2, shouldHandoff: true },
    };
  }

  logger.info('[MemoryQuick] Looking up', { attribute, useSemanticOnly });

  let value = null;
  let source = 'memory_quick';

  // Try profile.get for attributes in the profile store
  if (!useSemanticOnly && ATTRIBUTE_PROFILE_KEYS[attribute]) {
    value = await _queryMemoryKeys(ATTRIBUTE_PROFILE_KEYS[attribute]);
  }

  // Fall back to semantic memory.search if profile.get returned nothing
  if (!value) {
    logger.info('[MemoryQuick] Profile miss, trying semantic search', { attribute });
    value = await _semanticMemorySearch(englishText);
    if (value) source = 'memory_quick_semantic';
  }

  if (!value) {
    // Fact not in memory — respond honestly
    const label = attribute.replace(/_/g, ' ');
    const response = `I don't seem to have your ${label} on record. If you tell me, I'll remember it for next time.`;
    logger.info('[MemoryQuick] Not found', { attribute });
    return {
      text: response,
      fullText: response,
      metadata: { source: 'memory_quick_not_found', intent: 2, factKey: attribute },
    };
  }

  // Naturalize the response through the personality layer
  const label = attribute.replace(/_/g, ' ');
  const naturalizePrompt = `The user asked: "${englishText}"\nTheir ${label} is: ${value}\nRespond naturally in 1-2 sentences as ThinkDrop. No markdown. Be conversational, not robotic.`;
  const messages = buildMessages(naturalizePrompt, systemPrompt, conversationContext);
  const { text: naturalized } = await ask(messages, {
    maxTokens: 100,
    temperature: 0.7,
    timeoutMs: 5000,
  });

  const response = naturalized || `Your ${label} is ${value}.`;

  logger.info('[MemoryQuick] Found', { attribute, source, valuePreview: String(value).substring(0, 40) });

  return {
    text: response,
    fullText: response,
    metadata: { source, intent: 2, factKey: attribute, factValue: value },
  };
}

module.exports = { execute, detectFactStore, detectImplicitFactStore };
