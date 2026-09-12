'use strict';

/**
 * server.cjs — comms-graph HTTP server
 *
 * The single front door for all ThinkDrop voice AND text interaction.
 *
 * Pipeline: translate-in → personality → classify → execute → translate-out
 *
 * Endpoints:
 *   POST /comms.process   — main entry point (text or voice transcript in → response out)
 *   POST /comms.status    — get task status summary
 *   POST /comms.complete  — main.js notifies task completion (releases agent lock)
 *   POST /comms.progress  — main.js sends task progress updates
 *   POST /comms.remove    — main.js removes a task from the journal
 *   POST /comms.signal    — main.js acknowledges a control signal
 *   GET  /health          — health check
 *   GET  /tasks           — get all tasks (for UI)
 *   GET  /locks           — get agent lock state (for UI)
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const logger = require('./logger.cjs');

// ── Load .env ──────────────────────────────────────────────────────────────────
try {
  require('dotenv').config({ path: path.join(__dirname, '../.env') });
} catch (_) {
  // dotenv not installed — env vars must be set externally
}

const PORT = parseInt(process.env.PORT || '3015', 10);

// ── Module imports ──────────────────────────────────────────────────────────────
const { toEnglish, fromEnglish, normalizeLanguage } = require('./translate.cjs');
const { buildSystemPrompt, fetchOverlay, fetchMoodContext } = require('./persona.cjs');
const { classify, INTENTS } = require('./classify.cjs');
const { execute: generalQuick } = require('./nodes/generalQuick.cjs');
const { execute: memoryQuick } = require('./nodes/memoryQuick.cjs');
const { execute: statusCheck } = require('./nodes/statusCheck.cjs');
const { execute: controlSignal } = require('./nodes/controlSignal.cjs');
const { execute: handoff, complete: handoffComplete } = require('./handoff.cjs');
const { getHandoffPhrase, getRandomHandoffPhrase } = require('./handoffPhrases.cjs');
const taskJournal = require('./taskJournal.cjs');
const agentLock = require('./agentLock.cjs');

// ── HTTP helpers ────────────────────────────────────────────────────────────────
function _readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', c => { raw += c; if (raw.length > 1e6) req.destroy(); });
    req.on('end', () => {
      try { resolve(JSON.parse(raw) || {}); }
      catch (_) { resolve({}); }
    });
    req.on('error', () => resolve({}));
  });
}

function _send(res, status, body) {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(json),
  });
  res.end(json);
}

// ── Broadcast task updates to connected clients (main.js) ──────────────────────
const _clients = new Set();

function _broadcastTasks() {
  const tasks = taskJournal.getAllTasks();
  const msg = JSON.stringify({ type: 'tasks:update', tasks });
  for (const res of _clients) {
    try { res.write(`data: ${msg}\n\n`); } catch (_) {}
  }
}

taskJournal.setBroadcast(_broadcastTasks);
agentLock.setLockBroadcast((lockState) => {
  const msg = JSON.stringify({ type: 'locks:update', locks: lockState });
  for (const res of _clients) {
    try { res.write(`data: ${msg}\n\n`); } catch (_) {}
  }
});

// ── Conversation context (recent turns for classification) ──────────────────────
const _conversationHistory = [];
const MAX_HISTORY = 6;

function _addTurn(userText, intent) {
  _conversationHistory.push({ text: userText.substring(0, 200), intent, ts: Date.now() });
  if (_conversationHistory.length > MAX_HISTORY) _conversationHistory.shift();
}

function _formatContext() {
  return _conversationHistory
    .slice(-3)
    .map(t => `User: ${t.text}`)
    .join('\n');
}

// ── Conversation-service history fetch (parallel, with timeout) ──────────────
// Fetches recent conversation turns (user + assistant) from the conversation-service
// so comms-graph has real context awareness like the main stategraph.
// Falls back to the in-memory _conversationHistory if the service is unreachable.
const CONVERSATION_SERVICE_PORT = parseInt(process.env.CONVERSATION_SERVICE_PORT || '3004', 10);
const CONV_API_KEY = process.env.MCP_CONVERSATION_API_KEY || process.env.MCP_API_KEY || '';

function _fetchConversationHistory() {
  return new Promise((resolve) => {
    const body = JSON.stringify({
      version: 'mcp.v1',
      service: 'conversation',
      action: 'session.route',
      payload: { text: '' },
      requestId: 'cg_conv_' + Date.now(),
    });
    const headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) };
    if (CONV_API_KEY) headers['Authorization'] = 'Bearer ' + CONV_API_KEY;

    const req = http.request({
      hostname: '127.0.0.1',
      port: CONVERSATION_SERVICE_PORT,
      path: '/session.route',
      method: 'POST',
      headers,
      timeout: 1500,
    }, (res) => {
      let raw = '';
      res.on('data', c => { raw += c; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(raw);
          const sessionId = (parsed.data || parsed)?.sessionId;
          if (!sessionId) return resolve(null);
          // Now fetch the message list for this session
          const listBody = JSON.stringify({
            version: 'mcp.v1',
            service: 'conversation',
            action: 'message.list',
            payload: { sessionId, limit: 8, direction: 'DESC' },
            requestId: 'cg_conv_list_' + Date.now(),
          });
          const listHeaders = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(listBody) };
          if (CONV_API_KEY) listHeaders['Authorization'] = 'Bearer ' + CONV_API_KEY;
          const listReq = http.request({
            hostname: '127.0.0.1',
            port: CONVERSATION_SERVICE_PORT,
            path: '/message.list',
            method: 'POST',
            headers: listHeaders,
            timeout: 1500,
          }, (listRes) => {
            let listRaw = '';
            listRes.on('data', c => { listRaw += c; });
            listRes.on('end', () => {
              try {
                const listParsed = JSON.parse(listRaw);
                const messages = (listParsed.data || listParsed)?.messages || [];
                // Format as "User: ... \n Assistant: ..." (last 6, reversed to chronological)
                const formatted = messages
                  .filter(m => m.sender !== 'system')
                  .slice(0, 6)
                  .reverse()
                  .map(m => `${m.sender === 'user' ? 'User' : 'Assistant'}: ${(m.text || m.content || '').substring(0, 200)}`)
                  .join('\n');
                resolve(formatted || null);
              } catch (_) { resolve(null); }
            });
          });
          listReq.on('error', () => resolve(null));
          listReq.on('timeout', () => { listReq.destroy(); resolve(null); });
          listReq.write(listBody);
          listReq.end();
        } catch (_) { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.write(body);
    req.end();
  });
}

// ── Main pipeline ───────────────────────────────────────────────────────────────
/**
 * Process a user message through the full comms-graph pipeline.
 *
 * @param {Object} args
 * @param {string} args.text       - User input (any language)
 * @param {string} [args.language]  - Detected language (from STT or text input)
 * @param {string} [args.source]    - 'voice' or 'text'
 * @param {string} [args.speakerProfile] - Speaker profile block (from voice-service)
 * @param {boolean} [args.isResemble] - Whether Resemble TTS is active
 * @returns {Promise<Object>} response with text, intent, metadata
 */
async function processMessage(args) {
  const startTime = Date.now();
  const { text, language, source = 'text', speakerProfile, isResemble } = args;

  if (!text || !text.trim()) {
    return {
      text: 'I didn\'t catch that.',
      intent: 1,
      intentName: 'general_quick',
      metadata: { source: 'empty_input', latencyMs: 0 },
    };
  }

  logger.info('[Process] Start', {
    source, language: language || 'auto',
    textPreview: text.substring(0, 80),
  });

  // ── Step 1: Translate to English (deterministic, no LLM for language check) ──
  // Run translation, persona fetch, and conversation-service history fetch in parallel
  // for maximum speed. Conversation history fetch has a 1500ms timeout and falls back
  // to the in-memory history if the service is unreachable.
  const [translateResult, convHistory] = await Promise.all([
    toEnglish({ text, language }),
    _fetchConversationHistory(),
  ]);
  const { englishText, originalText, detectedLanguage, wasTranslated } = translateResult;

  logger.info('[Process] Translated', {
    wasTranslated, detectedLanguage,
    englishPreview: englishText.substring(0, 80),
    hasConvHistory: !!convHistory,
  });

  // ── Step 2: Fetch personality overlay + build system prompt ───────────────────
  const systemPrompt = await buildSystemPrompt({
    language: detectedLanguage,
    speakerProfile,
    isResemble,
  });

  // ── Step 3: Classify intent (force-prompt, numbered) ───────────────────────────
  // Use conversation-service history if available, otherwise fall back to in-memory
  const context = convHistory || _formatContext();
  const { intent, intentName, confidence, source: classifySource } =
    await classify(englishText, context);

  logger.info('[Process] Classified', {
    intent, intentName, confidence, classifySource,
  });

  // ── Step 4: Execute based on intent ───────────────────────────────────────────
  let result;

  switch (intent) {
    case 0: { // handoff
      const handoffResult = await handoff({
        englishPrompt: englishText,
        source,
        originalPrompt: originalText,
      });

      // Use intent-specific handoff phrase (no more "routing to ThinkDrop")
      // For parked tasks, add a note about waiting for the agent.
      const basePhrase = getHandoffPhrase(intentName, englishText);
      const handoffText = handoffResult.parked
        ? `${basePhrase} I'll start on that as soon as the current task finishes.`
        : basePhrase;

      result = {
        text: handoffText,
        fullText: handoffText,
        metadata: {
          source: 'handoff',
          intent: 0,
          taskId: handoffResult.taskId,
          agentId: handoffResult.agentId,
          parked: handoffResult.parked,
          waitingBehind: handoffResult.waitingBehind,
        },
      };
      break;
    }

    case 1: { // general_quick
      result = await generalQuick(englishText, systemPrompt, context);
      // If generalQuick couldn't answer (LLM failed), handoff to main state graph
      if (result.metadata.shouldHandoff) {
        const handoffResult = await handoff({
          englishPrompt: englishText,
          source,
          originalPrompt: originalText,
        });
        const basePhrase = getHandoffPhrase(intentName, englishText);
        const handoffText = handoffResult.parked
          ? `${basePhrase} I'll start on that as soon as the current task finishes.`
          : basePhrase;
        result = {
          text: handoffText,
          fullText: handoffText,
          metadata: {
            ...result.metadata,
            source: 'general_quick_handoff',
            intent: 0,
            taskId: handoffResult.taskId,
            agentId: handoffResult.agentId,
            parked: handoffResult.parked,
          },
        };
      }
      break;
    }

    case 2: { // memory_quick
      result = await memoryQuick(englishText, systemPrompt, context);
      // If memory_quick couldn't find a match, handoff instead
      if (result.metadata.shouldHandoff) {
        const handoffResult = await handoff({
          englishPrompt: englishText,
          source,
          originalPrompt: originalText,
        });
        const basePhrase = getHandoffPhrase(intentName, englishText);
        const handoffText = handoffResult.parked
          ? `${basePhrase} I'll start on that as soon as the current task finishes.`
          : basePhrase;
        result = {
          text: handoffText,
          fullText: handoffText,
          metadata: {
            ...result.metadata,
            source: 'memory_quick_handoff',
            taskId: handoffResult.taskId,
            agentId: handoffResult.agentId,
          },
        };
      }
      break;
    }

    case 3: { // status_check
      result = await statusCheck(englishText, systemPrompt);
      break;
    }

    case 4: { // control_signal
      result = await controlSignal(englishText, systemPrompt);
      break;
    }

    default: {
      // Unknown intent — default to general_quick
      result = await generalQuick(englishText, systemPrompt, context);
    }
  }

  // ── Step 5: Translate response back to user's language (if non-English) ──────
  let finalText = result.text;
  if (wasTranslated && detectedLanguage !== 'en') {
    try {
      finalText = await fromEnglish(result.text, detectedLanguage);
      logger.info('[Process] Translated response back', {
        to: detectedLanguage,
        preview: finalText.substring(0, 80),
      });
    } catch (err) {
      logger.warn('[Process] Response translation failed, using English', { error: err.message });
    }
  }

  // ── Record conversation turn ──────────────────────────────────────────────────
  _addTurn(englishText, intent);

  const latencyMs = Date.now() - startTime;
  logger.info('[Process] Complete', {
    intent, intentName, latencyMs,
    wasTranslated, detectedLanguage,
  });

  return {
    text: finalText,
    fullText: result.fullText,
    intent,
    intentName,
    detectedLanguage,
    wasTranslated,
    metadata: { ...result.metadata, latencyMs },
  };
}

// ── HTTP server ────────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  // ── SSE stream for task/lock updates ──────────────────────────────────────────
  if (req.url === '/events' && req.method === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });
    res.write('data: {"type":"connected"}\n\n');
    _clients.add(res);
    req.on('close', () => _clients.delete(res));
    return;
  }

  // ── Health check ──────────────────────────────────────────────────────────────
  if (req.url === '/health' && req.method === 'GET') {
    return _send(res, 200, {
      ok: true,
      service: 'comms-graph',
      port: PORT,
      tasks: taskJournal.getActiveTasks().length,
      locks: agentLock.getLockState().locks.length,
    });
  }

  // ── Get all tasks (for UI) ────────────────────────────────────────────────────
  if (req.url === '/tasks' && req.method === 'GET') {
    return _send(res, 200, { tasks: taskJournal.getAllTasks() });
  }

  // ── Get agent lock state (for UI) ─────────────────────────────────────────────
  if (req.url === '/locks' && req.method === 'GET') {
    return _send(res, 200, agentLock.getLockState());
  }

  // ── Main entry: process a message ────────────────────────────────────────────
  if (req.url === '/comms.process' && req.method === 'POST') {
    const body = await _readBody(req);
    if (!body.text) {
      return _send(res, 400, { error: 'text is required' });
    }
    try {
      const result = await processMessage(body);
      return _send(res, 200, { ok: true, data: result });
    } catch (err) {
      logger.error('[Server] processMessage error', { error: err.message, stack: err.stack });
      return _send(res, 500, { error: 'Internal error', message: err.message });
    }
  }

  // ── Task status summary ───────────────────────────────────────────────────────
  if (req.url === '/comms.status' && req.method === 'POST') {
    const body = await _readBody(req);
    const summary = taskJournal.formatStatusSummary(body.agentId);
    return _send(res, 200, { ok: true, summary, tasks: taskJournal.getActiveTasks() });
  }

  // ── Task completion notification (from main.js) ───────────────────────────────
  if (req.url === '/comms.complete' && req.method === 'POST') {
    const body = await _readBody(req);
    if (!body.taskId) {
      return _send(res, 400, { error: 'taskId is required' });
    }
    handoffComplete(body.taskId, body.agentId, body.status || 'done', body.result);
    return _send(res, 200, { ok: true });
  }

  // ── Task progress update (from main.js) ───────────────────────────────────────
  if (req.url === '/comms.progress' && req.method === 'POST') {
    const body = await _readBody(req);
    if (!body.taskId) {
      return _send(res, 400, { error: 'taskId is required' });
    }
    taskJournal.updateProgress(body.taskId, body.progress || {});
    if (body.agentId) {
      agentLock.heartbeat(body.agentId, body.taskId);
    }
    return _send(res, 200, { ok: true });
  }

  // ── Control signal acknowledgment (from main.js) ───────────────────────────────
  if (req.url === '/comms.signal' && req.method === 'POST') {
    const body = await _readBody(req);
    logger.info('[Server] Signal ack', { signalType: body.signalType, taskId: body.taskId });
    return _send(res, 200, { ok: true });
  }

  // ── Task removal (from main.js) ────────────────────────────────────────────────
  if (req.url === '/comms.remove' && req.method === 'POST') {
    const body = await _readBody(req);
    if (!body.taskId) {
      return _send(res, 400, { error: 'taskId is required' });
    }
    const ok = handoff.remove(body.taskId);
    return _send(res, ok ? 200 : 404, { ok });
  }

  // ── 404 ────────────────────────────────────────────────────────────────────────
  _send(res, 404, { error: 'Not found', url: req.url, method: req.method });
});

// ── Start ──────────────────────────────────────────────────────────────────────
server.listen(PORT, '127.0.0.1', () => {
  logger.info(`[Server] comms-graph listening on http://127.0.0.1:${PORT}`, {
    env: process.env.NODE_ENV || 'development',
    personalityPort: process.env.PERSONALITY_SERVICE_PORT || '3012',
    memoryPort: process.env.MEMORY_SERVICE_PORT || '3001',
    mainPort: process.env.THINKDROP_MAIN_PORT || '3010',
  });
});

// ── Graceful shutdown ───────────────────────────────────────────────────────────
function _shutdown(signal) {
  logger.info('[Server] Shutting down', { signal });
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
}

process.on('SIGTERM', () => _shutdown('SIGTERM'));
process.on('SIGINT', () => _shutdown('SIGINT'));

module.exports = { server, processMessage };
