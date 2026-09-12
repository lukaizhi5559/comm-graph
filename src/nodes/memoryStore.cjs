'use strict';

/**
 * memoryStore.cjs — Intent 5: general memory storage
 *
 * Stores general memories, notes, appointments, and events that are NOT
 * personal profile facts. Uses the user-memory-service's memory.store
 * endpoint (semantic memory with embeddings), NOT profile.set.
 *
 * Target response time: <1.5s (single HTTP call + embedding generation)
 */

const http = require('http');
const logger = require('../logger.cjs');

const MEMORY_PORT = parseInt(process.env.MEMORY_SERVICE_PORT || '3001', 10);
const MEM_API_KEY = process.env.MCP_USER_MEMORY_API_KEY || process.env.USER_MEMORY_API_KEY || process.env.MCP_API_KEY || '';

/**
 * Store a general memory in the user-memory-service.
 * @param {string} text - The memory text to store
 * @returns {Promise<boolean>} true if stored successfully
 */
function _storeGeneralMemory(text) {
  return new Promise((resolve) => {
    const body = JSON.stringify({
      version: 'mcp.v1',
      service: 'user-memory',
      action: 'memory.store',
      payload: {
        text,
        metadata: { source: 'comms_graph', type: 'general_memory' },
      },
      requestId: 'cg_memstore_' + Date.now(),
    });
    const headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) };
    if (MEM_API_KEY) headers['Authorization'] = 'Bearer ' + MEM_API_KEY;

    const req = http.request({
      hostname: '127.0.0.1',
      port: MEMORY_PORT,
      path: '/memory.store',
      method: 'POST',
      headers,
      timeout: 5000,
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
 * @param {string} [conversationContext] - Recent conversation turns
 * @returns {Promise<{ text: string, fullText: string, metadata: Object }>}
 */
async function execute(englishText, systemPrompt, conversationContext) {
  logger.info('[MemoryStore] Storing general memory', { textPreview: englishText.substring(0, 60) });

  const ok = await _storeGeneralMemory(englishText);

  if (ok) {
    const response = `Got it — I'll remember that. 📝`;
    logger.info('[MemoryStore] Stored successfully');
    return {
      text: response,
      fullText: response,
      metadata: { source: 'memory_store', intent: 5 },
    };
  }

  // Store failed — handoff to stategraph which has a more robust store path
  logger.warn('[MemoryStore] Store failed, handing off');
  return {
    text: "Let me save that for you — one moment.",
    fullText: "Let me save that for you — one moment.",
    metadata: { source: 'memory_store_failed', intent: 5, shouldHandoff: true },
  };
}

module.exports = { execute };
