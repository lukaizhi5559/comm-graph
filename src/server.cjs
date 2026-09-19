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
const { sanitizeContext } = require('./refusal.cjs');
const { execute: generalQuick } = require('./nodes/generalQuick.cjs');
const { execute: memoryQuick } = require('./nodes/memoryQuick.cjs');
const { execute: memoryStore } = require('./nodes/memoryStore.cjs');
const { execute: statusCheck } = require('./nodes/statusCheck.cjs');
const { execute: controlSignal } = require('./nodes/controlSignal.cjs');
const { execute: handoff, complete: handoffComplete, remove: handoffRemove } = require('./handoff.cjs');
const { getHandoffPhrase, getHandoffPhraseForIntent, getCommandAutomatePhrase } = require('./handoffPhrases.cjs');
const intentGuesser = require('./intentGuesser.cjs');
const taskJournal = require('./taskJournal.cjs');
const agentLock = require('./agentLock.cjs');

// ── Thought engine prompt producer ─────────────────────────────────────────────
// Fire-and-forget POST of each user prompt to personality-service so the
// Thought/Trigger engine can accumulate prompt-derived thoughts.
const PERSONALITY_PORT = parseInt(process.env.PERSONALITY_SERVICE_PORT || '3012', 10);
function _notifyThoughtEngine(type, info) {
  try {
    const body = JSON.stringify({
      version: 'mcp.v1', service: 'personality-service', action: 'thought.input',
      payload: { type, ...info }, requestId: 'cg_th_' + Date.now(),
    });
    const req = http.request({
      hostname: '127.0.0.1', port: PERSONALITY_PORT, path: '/thought.input',
      method: 'POST', timeout: 3000,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => res.resume());
    req.on('error', () => {});
    req.on('timeout', () => req.destroy());
    req.write(body);
    req.end();
  } catch (_) {}
}

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

// Feed task completions into the thought engine as 'queue' inputs — the engine
// gains awareness of its own dispatched work and can correlate artifacts back.
taskJournal.setOnTerminal((task) => {
  _notifyThoughtEngine('queue', {
    taskId: task.id,
    status: task.status,
    text: `Task ${task.status}: ${task.prompt}`,
    result: typeof task.result === 'string' ? task.result.slice(0, 500) : null,
  });
});
agentLock.setLockBroadcast((lockState) => {
  const msg = JSON.stringify({ type: 'locks:update', locks: lockState });
  for (const res of _clients) {
    try { res.write(`data: ${msg}\n\n`); } catch (_) {}
  }
});

// ── Conversation context (recent turns for classification) ──────────────────────
const _conversationHistory = [];
const MAX_HISTORY = 6;

function _addTurn(userText, assistantText, intent) {
  _conversationHistory.push({
    user: userText.substring(0, 200),
    assistant: (assistantText || '').substring(0, 200),
    intent, ts: Date.now(),
  });
  if (_conversationHistory.length > MAX_HISTORY) _conversationHistory.shift();
}

function _formatContext() {
  return _conversationHistory
    .slice(-3)
    .map(t => `User: ${t.user}\nAssistant: ${t.assistant || ''}`)
    .join('\n');
}

// ── Conversation-service history fetch (parallel, with timeout) ──────────────
// Fetches recent conversation turns (user + assistant) from the conversation-service
// so comms-graph has real context awareness like the main stategraph.
// Falls back to the in-memory _conversationHistory if the service is unreachable.
const CONVERSATION_SERVICE_PORT = parseInt(process.env.CONVERSATION_SERVICE_PORT || '3004', 10);
const CONV_API_KEY = process.env.MCP_CONVERSATION_API_KEY || process.env.MCP_API_KEY || '';

// Detect an explicit "new conversation" request so we can force a fresh session.
function _isForceNew(text) {
  const t = (text || '').toLowerCase().trim();
  if (!t) return false;
  const phrases = [
    'new conversation', 'start fresh', 'start a new conversation',
    'new chat', 'start new chat', 'clear conversation', 'forget this conversation',
  ];
  return phrases.some(p => t === p || t.startsWith(p + ' ') || t.includes(p));
}

// Fetch the formatted message list for a session.
// Returns { sessionId, history } — history is null if the fetch fails.
function _listSessionMessages(sessionId) {
  return new Promise((resolve) => {
    const listBody = JSON.stringify({
      version: 'mcp.v1',
      service: 'conversation',
      action: 'message.list',
      payload: { sessionId, limit: 16, direction: 'DESC' },
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
            .slice(0, 12)
            .reverse()
            .map(m => `${m.sender === 'user' ? 'User' : 'Assistant'}: ${(m.text || m.content || '').substring(0, 200)}`)
            .join('\n');
          resolve({ sessionId, history: formatted || null });
        } catch (_) { resolve({ sessionId, history: null }); }
      });
    });
    listReq.on('error', () => resolve({ sessionId, history: null }));
    listReq.on('timeout', () => { listReq.destroy(); resolve({ sessionId, history: null }); });
    listReq.write(listBody);
    listReq.end();
  });
}

// Route the current message through the smart session router and fetch recent
// history for the routed session. Replaces the old `session.getActive` flow,
// which always returned the same long-lived active session regardless of topic.
// Returns { sessionId, history } or null on failure.
// When pinnedSessionId is set (task recall / "Continue Thread"), routing is
// skipped entirely — the session is authoritative regardless of topic drift.
function _fetchConversationHistory(userText, pinnedSessionId = null) {
  if (pinnedSessionId) {
    return _listSessionMessages(pinnedSessionId);
  }
  return new Promise((resolve) => {
    const forceNew = _isForceNew(userText);
    const routeBody = JSON.stringify({
      version: 'mcp.v1',
      service: 'conversation',
      action: 'session.route',
      payload: { text: userText || '', forceNew },
      requestId: 'cg_route_' + Date.now(),
    });
    const headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(routeBody) };
    if (CONV_API_KEY) headers['Authorization'] = 'Bearer ' + CONV_API_KEY;

    const req = http.request({
      hostname: '127.0.0.1',
      port: CONVERSATION_SERVICE_PORT,
      path: '/session.route',
      method: 'POST',
      headers,
      timeout: 2000,
    }, (res) => {
      let raw = '';
      res.on('data', c => { raw += c; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(raw);
          const sessionId = (parsed.data || parsed)?.sessionId;
          if (!sessionId) return resolve(null);
          // Now fetch the message list for the routed session
          _listSessionMessages(sessionId).then(resolve);
        } catch (_) { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.write(routeBody);
    req.end();
  });
}

// ── Log conversation turn to conversation-service (fire-and-forget) ────────────
// Logs both user and assistant messages so follow-up prompts have full context.
// Mirrors the stategraph's logConversation.js pattern. Only called for quick
// intents (general_quick, memory_quick, memory_store) — handoff intents are
// logged by the stategraph's logConversation node.
function _logConversationTurn(userText, assistantText, intentName, preRoutedSessionId) {
  if (!CONV_API_KEY) return; // no key — skip silently
  const ts = new Date().toISOString();
  const _post = (action, payload) => {
    const body = JSON.stringify({
      version: 'mcp.v1', service: 'conversation', action, payload,
      requestId: 'cg_log_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
    });
    const headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) };
    if (CONV_API_KEY) headers['Authorization'] = 'Bearer ' + CONV_API_KEY;
    const req = http.request({
      hostname: '127.0.0.1', port: CONVERSATION_SERVICE_PORT,
      path: '/' + action, method: 'POST', headers, timeout: 2000,
    }, () => {});
    req.on('error', () => {});
    req.on('timeout', () => req.destroy());
    req.write(body);
    req.end();
  };
  // If we already routed during history fetch, reuse that sessionId — do NOT
  // route again (a second route call could rotate the session a second time).
  if (preRoutedSessionId) {
    _post('message.add', { sessionId: preRoutedSessionId, text: userText, sender: 'user', metadata: { source: 'comms-graph', intent: intentName, timestamp: ts } });
    if (assistantText) {
      _post('message.add', { sessionId: preRoutedSessionId, text: assistantText, sender: 'assistant', metadata: { source: 'comms-graph', intent: intentName, timestamp: ts } });
    }
    return;
  }
  // Fallback: route then log (used only when history fetch failed/unavailable)
  const routeBody = JSON.stringify({
    version: 'mcp.v1', service: 'conversation', action: 'session.route',
    payload: { text: userText },
    requestId: 'cg_route_' + Date.now(),
  });
  const routeHeaders = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(routeBody) };
  if (CONV_API_KEY) routeHeaders['Authorization'] = 'Bearer ' + CONV_API_KEY;
  const routeReq = http.request({
    hostname: '127.0.0.1', port: CONVERSATION_SERVICE_PORT,
    path: '/session.route', method: 'POST', headers: routeHeaders, timeout: 2000,
  }, (res) => {
    let raw = '';
    res.on('data', c => { raw += c; });
    res.on('end', () => {
      try {
        const parsed = JSON.parse(raw);
        const sessionId = (parsed.data || parsed)?.sessionId;
        if (!sessionId) return;
        _post('message.add', { sessionId, text: userText, sender: 'user', metadata: { source: 'comms-graph', intent: intentName, timestamp: ts } });
        if (assistantText) {
          _post('message.add', { sessionId, text: assistantText, sender: 'assistant', metadata: { source: 'comms-graph', intent: intentName, timestamp: ts } });
        }
      } catch (_) {}
    });
  });
  routeReq.on('error', () => {});
  routeReq.on('timeout', () => routeReq.destroy());
  routeReq.write(routeBody);
  routeReq.end();
}

// ── Handoff phrase generation helper ──────────────────────────────────────────
/**
 * Generate an intent-aware handoff phrase based on the guessed stategraph intent.
 *
 * - command_automate → LLM generates a "background task" phrase
 * - Other intents → pick from multilingual static pool (handoffPhrases.json)
 * - Regex miss → default generic phrase from the pool
 * - Language not in pool → empty string (no phrase displayed)
 *
 * @param {string} englishText - English translation of user prompt
 * @param {string} detectedLanguage - ISO 639-1 language code
 * @param {string} [conversationContext] - Recent conversation turns
 * @param {string|null} [precomputedIntent] - Pre-computed guessedIntent (avoids recomputing)
 * @returns {Promise<{ phrase: string, guessedIntent: string|null }>}
 */
async function _generateHandoffPhrase(englishText, detectedLanguage, conversationContext, precomputedIntent) {
  // Use pre-computed intent if provided (avoids recomputing the regex), else guess now
  const guessedIntent = precomputedIntent !== undefined
    ? precomputedIntent
    : intentGuesser.guess(englishText).guessedIntent;

  let phrase = '';

  if (guessedIntent === 'command_automate') {
    // LLM-generated phrase for command_automate
    phrase = await getCommandAutomatePhrase(englishText, conversationContext);
  } else {
    // Static multilingual pool for non-command_automate intents
    phrase = getHandoffPhraseForIntent(guessedIntent, detectedLanguage, englishText);
  }

  return { phrase, guessedIntent };
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
  const [translateResult, routeResult] = await Promise.all([
    toEnglish({ text, language }),
    _fetchConversationHistory(text, args.sessionId || null),
  ]);
  const { englishText, originalText, detectedLanguage, wasTranslated } = translateResult;
  // args.sessionId is a pin (task recall) — it wins over semantic routing.
  const routedSessionId = args.sessionId || routeResult?.sessionId || null;
  const convHistory = routeResult?.history || null;

  logger.info('[Process] Translated', {
    wasTranslated, detectedLanguage,
    englishPreview: englishText.substring(0, 80),
    hasConvHistory: !!convHistory,
    routedSessionId,
  });

  // ── Step 2: Fetch personality overlay + build system prompt ───────────────────
  const systemPrompt = await buildSystemPrompt({
    language: detectedLanguage,
    speakerProfile,
    isResemble,
  });

  // ── Step 3: Classify intent (force-prompt, numbered) ───────────────────────────
  // Use conversation-service history if available, otherwise fall back to in-memory
  // Strip canned-refusal Assistant lines left over from pre-fix sessions so
  // models don't mimic the refusal voice (heals already-poisoned history).
  const context = sanitizeContext(convHistory || _formatContext());
  const { intent, intentName, confidence, source: classifySource } =
    await classify(englishText, context);

  logger.info('[Process] Classified', {
    intent, intentName, confidence, classifySource,
  });

  // ── Thought engine: feed the prompt as a candidate input (fire-and-forget) ────
  _notifyThoughtEngine('prompt', { text: englishText, sessionId: routedSessionId, intentName });

  // ── Step 4: Execute based on intent ───────────────────────────────────────────
  let result;

  switch (intent) {
    case 0: { // handoff
      // Compute guessedIntent BEFORE handoff() so it's available for task:created
      // (intentGuesser.guess is a pure synchronous regex — ~1ms, no LLM/async)
      const { guessedIntent: _gi0 } = intentGuesser.guess(englishText);
      const handoffResult = await handoff({
        englishPrompt: englishText,
        source,
        originalPrompt: originalText,
        guessedIntent: _gi0,
        sessionId: routedSessionId,
      });

      // Generate intent-aware handoff phrase (LLM for command_automate, static pool for others)
      const { phrase: basePhrase, guessedIntent } = await _generateHandoffPhrase(englishText, detectedLanguage, context, _gi0);
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
          speakable: false,
          guessedIntent,
        },
      };
      break;
    }

    case 1: { // general_quick
      result = await generalQuick(englishText, systemPrompt, context);
      // If generalQuick couldn't answer (LLM failed), handoff to main state graph
      if (result.metadata.shouldHandoff) {
        const { guessedIntent: _gi1 } = intentGuesser.guess(englishText);
        const handoffResult = await handoff({
          englishPrompt: englishText,
          source,
          originalPrompt: originalText,
          guessedIntent: _gi1,
          sessionId: routedSessionId,
        });
        const { phrase: basePhrase, guessedIntent } = await _generateHandoffPhrase(englishText, detectedLanguage, context, _gi1);
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
            speakable: false,
            guessedIntent,
          },
        };
      }
      break;
    }

    case 2: { // memory_quick
      result = await memoryQuick(englishText, systemPrompt, context);
      // If memory_quick couldn't find a match, handoff instead
      if (result.metadata.shouldHandoff) {
        const { guessedIntent: _gi2 } = intentGuesser.guess(englishText);
        const handoffResult = await handoff({
          englishPrompt: englishText,
          source,
          originalPrompt: originalText,
          guessedIntent: _gi2,
          sessionId: routedSessionId,
        });
        const { phrase: basePhrase, guessedIntent } = await _generateHandoffPhrase(englishText, detectedLanguage, context, _gi2);
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
            speakable: false,
            guessedIntent,
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

    case 5: { // memory_store
      result = await memoryStore(englishText, systemPrompt, context);
      // If memory_store failed, handoff to main state graph
      if (result.metadata.shouldHandoff) {
        const { guessedIntent: _gi5 } = intentGuesser.guess(englishText);
        const handoffResult = await handoff({
          englishPrompt: englishText,
          source,
          originalPrompt: originalText,
          guessedIntent: _gi5,
          sessionId: routedSessionId,
        });
        const { phrase: basePhrase, guessedIntent } = await _generateHandoffPhrase(englishText, detectedLanguage, context, _gi5);
        const handoffText = handoffResult.parked
          ? `${basePhrase} I'll start on that as soon as the current task finishes.`
          : basePhrase;
        result = {
          text: handoffText,
          fullText: handoffText,
          metadata: {
            ...result.metadata,
            source: 'memory_store_handoff',
            taskId: handoffResult.taskId,
            agentId: handoffResult.agentId,
            parked: handoffResult.parked,
            speakable: false,
            guessedIntent,
          },
        };
      }
      break;
    }

    default: {
      // Unknown intent — default to general_quick
      result = await generalQuick(englishText, systemPrompt, context);
    }
  }

  // ── Step 5: Translate response back to user's language (if non-English) ──────
  // Use fullText (the complete answer) not text (the first-sentence preview) —
  // display, translate-back, and conversation history all need the full reply.
  let finalText = result.fullText || result.text;
  if (wasTranslated && detectedLanguage !== 'en' && finalText && finalText.trim()) {
    try {
      finalText = await fromEnglish(finalText, detectedLanguage);
      logger.info('[Process] Translated response back', {
        to: detectedLanguage,
        preview: finalText.substring(0, 80),
      });
    } catch (err) {
      logger.warn('[Process] Response translation failed, using English', { error: err.message });
    }
  }

  // ── Record conversation turn ──────────────────────────────────────────────────
  _addTurn(englishText, finalText, intent);
  // Log to conversation-service for quick intents (handoff is logged by stategraph)
  if (intent === 1 || intent === 2 || intent === 5) {
    _logConversationTurn(englishText, finalText, intentName, routedSessionId);
  }

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
 try {
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

  // ── Proactive work dispatch (from personality-service Thought engine) ────────
  // A triggered 'prompt' action dispatches autonomous work through the normal
  // handoff path (lock check → task journal → main.js stategraph run).
  if (req.url === '/comms.proactive' && req.method === 'POST') {
    const body = await _readBody(req);
    if (!body.prompt) {
      return _send(res, 400, { error: 'prompt is required' });
    }
    try {
      const { guessedIntent } = intentGuesser.guess(body.prompt);
      const result = await handoff({
        englishPrompt: body.prompt,
        source: 'proactive',
        originalPrompt: body.prompt,
        guessedIntent,
        sessionId: body.sessionId || null,
        // Brain-approved thoughts skip the second Queue approval gate.
        userApproved: body.userApproved === true,
      });
      logger.info('[Server] Proactive dispatch', { taskId: result.taskId, thoughtId: body.thoughtId });
      return _send(res, 200, { ok: true, ...result });
    } catch (err) {
      logger.error('[Server] proactive dispatch error', { error: err.message });
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
    handoffComplete(body.taskId, body.agentId, body.status || 'done', body.result, body.items, body.sessionId || null, body.planFile || null);
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
    const ok = handoffRemove(body.taskId);
    return _send(res, ok ? 200 : 404, { ok });
  }

  // ── Task cancel (from main.js) — mark task as cancelled in journal ───────────────
  if (req.url === '/comms.cancel' && req.method === 'POST') {
    const body = await _readBody(req);
    if (!body.taskId) {
      return _send(res, 400, { error: 'taskId is required' });
    }
    const task = taskJournal.getTask(body.taskId);
    if (!task) {
      return _send(res, 404, { ok: false, error: 'task not found' });
    }
    // Release agent lock if held, then mark cancelled
    try { handoffRemove(body.taskId); } catch (_) {}
    taskJournal.updateTask(body.taskId, 'cancelled', { error: 'cancelled by user' });
    return _send(res, 200, { ok: true });
  }

  // ── 404 ────────────────────────────────────────────────────────────────────────
  _send(res, 404, { error: 'Not found', url: req.url, method: req.method });
 } catch (err) {
  logger.error('[Server] Unhandled route error', { url: req.url, error: err?.message });
  if (!res.headersSent && !res.writableEnded) {
    _send(res, 500, { error: 'internal error' });
  }
 }
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
