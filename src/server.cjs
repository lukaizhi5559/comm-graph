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
const planningNode = require('./nodes/planning.cjs');
const { execute: statusCheck } = require('./nodes/statusCheck.cjs');
const { execute: controlSignal } = require('./nodes/controlSignal.cjs');
const { execute: handoff, complete: handoffComplete, remove: handoffRemove, startRetrySweep: startHandoffRetrySweep } = require('./handoff.cjs');
const { getHandoffPhrase, getHandoffPhraseForIntent, getCommandAutomatePhrase } = require('./handoffPhrases.cjs');
const intentGuesser = require('./intentGuesser.cjs');
const { needsAmbientCtx: _needsAmbientCtx, screenContext: _screenContext } = require('./screen-context.cjs');
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

// ── Capability-gap guard ──────────────────────────────────────────────────────
// Cheap read-only call into command-service /capability.search. Decides whether
// a handoff-bound prompt should pin a ready agent or divert to planning.
const COMMAND_PORT = parseInt(process.env.COMMAND_SERVICE_PORT || '3007', 10);
const SETUP_PHRASE_RE = /\b(connect|set ?up|link|sync|install|pair|integrate)\b[^.\n]{0,60}\b(to|with|my)\b/i;
const AMBIGUOUS_CAST_RE = /\b(cast|mirror|stream)\b[^.\n]{0,40}\b(app|screen|window|desktop|overlay)\b/i;

// Connector verbs name the TARGET, not the action — "connect to my chromecast"
// doesn't say cast/scan/play. When a ready agent matches but no action verb
// maps to its declared capabilities, clarify intent in planning instead of
// pinning blindly. Delegated to shared/capability-index.cjs verbFit().
let _verbFit = null;
function _loadVerbFit() {
  if (_verbFit) return _verbFit;
  try { _verbFit = require('../../shared/capability-index.cjs').verbFit; } catch (_) { _verbFit = () => 'clarify'; }
  return _verbFit;
}

async function _capabilityGate(text) {
  try {
    // "cast/mirror <app|screen|overlay>" is ambiguous (media-cast vs window
    // mirroring) — always clarify in planning even when a cast agent exists.
    if (AMBIGUOUS_CAST_RE.test(text)) return { planning: 'capability_gap' };

    // Screen-referring prompts ("use this on my screen to…") resolve their
    // target from live screen context — OCR text + active app — so the gate
    // sees "nylas" rather than just "this". Additive enrichment only.
    let query = text;
    let screenCtx = null;
    if (_needsAmbientCtx(text)) {
      screenCtx = await _screenContext().catch(() => null);
      if (screenCtx) {
        query = `${text} ${[screenCtx.appName, screenCtx.host, screenCtx.title].filter(Boolean).join(' ')}`;
      }
    }

    const res = await fetch(`http://127.0.0.1:${COMMAND_PORT}/capability.search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, limit: 5 }),
      signal: AbortSignal.timeout(2000),
    });
    // Weak single-token noise (score 1) isn't evidence — e.g. "set calendar
    // event" substring-matching catt's set_volume. Require a distinctive
    // match (≥2) for a hit to pin or count.
    const hits = ((await res.json())?.results || []).filter(h => (h.matchScore || 0) >= 2);
    const ready = hits.find(h => /\.agent$/.test(h.id) && h.installed && h.friction <= 1);
    if (ready) {
      // Specific action that maps to the tool's capabilities → pin and run.
      // Connector-only phrasing ("connect to X") → planning clarifies intent.
      const fit = _loadVerbFit()(text, ready);
      if (fit === 'pin') return { pin: ready.id };
      return { planning: 'capability_clarify', hints: [ready, ...hits.filter(h => h.id !== ready.id)].slice(0, 5), screenCtx };
    }
    if (hits.length) return { planning: 'capability_needs_setup', hints: hits.slice(0, 5), screenCtx };

    // ── Semantic fallback ──────────────────────────────────────────────────
    // Keyword search missed — vocabulary gap, not necessarily a capability
    // gap. LLM proposes candidate tools; command-service mechanically
    // verifies each (which/npm view/brew/seed/--version). Only verified
    // candidates reach planning. Unregistered tools always clarify — pinning
    // requires a registered descriptor for resolveAgent to bind.
    const inf = await fetch(`http://127.0.0.1:${COMMAND_PORT}/capability.infer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, screenText: screenCtx?.ocrText || null }),
      signal: AbortSignal.timeout(25000),
    }).then(r => r.json()).catch(() => null);
    const inferred = inf?.candidates || [];
    if (inferred.length) return { planning: 'capability_needs_setup', hints: inferred.slice(0, 5), screenCtx };

    if (SETUP_PHRASE_RE.test(text)) return { planning: 'capability_gap' };
    return null;
  } catch (_) {
    return null; // fail-open — never block a prompt on the gate
  }
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

// Last session this process routed to / resolved a task into. Sent as
// hintSessionId on the next session.route so rapid follow-ups (<5 min) stick to
// the prior session via the router's hint fast-path — even when that session
// would otherwise rotate or semantically mismatch an elliptical follow-up.
let _lastSessionId = null;

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
      payload: { text: userText || '', forceNew, hintSessionId: _lastSessionId },
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
  const { text, language, source = 'text', speakerProfile, isResemble, thoughtContext = null, selectedText = null, planning = null, onReplyChunk = null } = args;

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
    hasSelection: !!(selectedText && selectedText.trim()),
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
  if (routedSessionId) _lastSessionId = routedSessionId;
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
  // Highlighted-context tags ("[Highlighted: …]") ride inside the prompt. Strip
  // them for intent classification/guessing — a code- or command-looking blob
  // would otherwise bias the intent toward handoff. They stay in englishText
  // so the answering nodes (and any handoff payload) still see the selection.
  // Exact-string removal via selectedText — a `]` inside the blob would
  // truncate a non-greedy tag regex (observed: captured log lines like "[0]").
  const hasSelectionContext = !!(selectedText && String(selectedText).trim());
  let classifyText = englishText;
  if (hasSelectionContext) {
    for (const chunk of String(selectedText).split('\n').map(s => s.trim()).filter(s => s.length > 2)) {
      classifyText = classifyText.split(chunk).join(' ');
    }
  }
  classifyText = classifyText
    .replace(/\[Highlighted:\s*[^\]]*\]/g, ' ')  // leftover wrappers are whitespace-only
    .replace(/\s{2,}/g, ' ')
    .trim() || englishText;
  // ── Selection fast lane ───────────────────────────────────────────────────
  // A [Highlighted:] blob carries its own referent — the prompt is self-contained
  // QA. Skip classify + the context-blind guards entirely; generalQuick's
  // 0-sentinel self-corrects to shouldHandoff when tools are genuinely needed.
  let intent, intentName, confidence, classifySource;
  let _openPlan = null, _resumePlanId = null;
  if (planning && planning.active === true) {
    // Planning mode pinned by the UI (toggle / continue-plan) — bypass the
    // classifier entirely so "yes", edits, and questions stay in the lane.
    intent = 6;
    intentName = 'planning';
    confidence = 1.0;
    classifySource = 'planning_pinned';
  } else if (hasSelectionContext) {
    intent = 1;
    intentName = 'general_quick';
    confidence = 0.9;
    classifySource = 'selection_fastlane';
  } else {
    // Open-plan fact for the classifier — deterministic resume guard + a
    // "paused plan exists" line in the classify prompt so continuation
    // phrasings route semantically, not just on regex hits.
    _openPlan = planningNode.findOpenPlan(routedSessionId);
    ({ intent, intentName, confidence, source: classifySource, resumePlanId: _resumePlanId } =
      await classify(classifyText, context, { hasSelectionContext, openPlan: _openPlan }));
  }

  // ── Proactive-card reply → always handoff ────────────────────────────────────
  // A prompt carrying thoughtContext is a reply to a proactive card. Quick
  // intents (general_quick et al.) lack the context machinery to resolve it —
  // and "yes" once produced a chatty ack with NO task dispatched. Route it to
  // stategraph where classifyTask can weigh the card against conversation turns.
  if (thoughtContext && intent !== 0 && intent !== 6) {
    logger.info('[Process] thoughtContext present — forcing handoff', {
      was: intentName, thoughtId: thoughtContext.id || null,
    });
    intent = 0;
    intentName = 'handoff';
  }

  // ── Live-page referent → always handoff ─────────────────────────────────
  // "how many products on this page" needs the open browser page via
  // app.agent scan_page — general_quick/web_search can only guess from prior
  // context (right by accident, stale by design). Handoff lets classifyTask
  // resolve the referent against the live activeDocContext.
  // Skipped when a selection supplies the referent — "this on the page" then
  // points at the highlighted text, not the live DOM (generalQuick may still
  // sentinel→handoff if it really needs the page).
  if (intent !== 0 && intent !== 6 && !hasSelectionContext && /\b(?:this|the|current|open)\s+(?:page|tab|site|website)\b|\bon\s+this\s+(?:page|site|website)\b/i.test(classifyText)) {
    logger.info('[Process] live-page referent — forcing handoff', { was: intentName });
    intent = 0;
    intentName = 'handoff';
  }

  // ── Capability-gap guard ──────────────────────────────────────────────────
  // Before handing a prompt to the stategraph, consult the capability index:
  // a ready registered agent gets pinned (deterministic resolution, skips the
  // LLM picker); a goal whose capabilities all need setup — or a setup-flavored
  // prompt with no match — routes to the planning lane so the user clarifies
  // and approves setup BEFORE anything executes.
  let _capPin = null;
  let _capHints = null;
  let _capScreenCtx = null;
  if (intent === 0) {
    const gate = await _capabilityGate(classifyText);
    if (gate?.planning) {
      logger.info('[Process] capability-gap → planning lane', { reason: gate.planning, hints: (gate.hints || []).length });
      intent = 6; intentName = 'planning'; confidence = 0.9;
      classifySource = 'capability_gap';
      _capHints = gate.hints || null;
      _capScreenCtx = gate.screenCtx || null;
    } else if (gate?.pin) {
      logger.info('[Process] capability pin', { agentId: gate.pin });
      _capPin = gate.pin;
    }
  }

  logger.info('[Process] Classified', {
    intent, intentName, confidence, classifySource,
  });

  // ── Thought engine: feed the prompt as a candidate input (fire-and-forget) ────
  // For card replies send the REPLY text only (not the card blob) plus the
  // thoughtId so the engine doesn't re-ingest its own card as a candidate.
  const _replyOnlyText = thoughtContext?.tag
    ? englishText.replace(thoughtContext.tag, '').trim()
    : classifyText;
  _notifyThoughtEngine('prompt', {
    text: _replyOnlyText || englishText,
    sessionId: routedSessionId,
    intentName,
    ...(thoughtContext?.id ? { thoughtId: thoughtContext.id } : {}),
  });

  // ── Step 4: Execute based on intent ───────────────────────────────────────────
  let result;

  // Deterministic log-read fast path — "check the X log / show me the logs"
  // answers from real log data (run visibly in the diagnosis pane) regardless
  // of how the classifier routed the message. Only fires on an explicit
  // "log" mention so normal status/planning turns pass through.
  if (/\blogs?\b/i.test(englishText)) {
    try {
      const { probeLog } = require('./nodes/statusCheck.cjs');
      const lp = await probeLog(englishText);
      if (lp) {
        const response = `Here's ${lp.name}.log:\n\`\`\`\n${lp.out || '(empty)'}\n\`\`\``;
        result = {
          text: response,
          fullText: response,
          metadata: { source: 'log_probe_fast_path', intent, log: lp.name, speakable: false },
        };
      }
    } catch (err) {
      logger.warn('[Server] log probe fast-path failed', { error: err.message });
    }
  }

  // Plan-referent re-route — messages ABOUT a saved plan ("the nylas plan",
  // "no the nylas plan", a choice-card label riding back, "i thought we had a
  // nylas plan") must never become handoff tasks and must land in the lane
  // that can act on them:
  //   - definite selection, not informational → planning (referent-switch
  //     binds the session; status_check would only describe it and the next
  //     "continue" would re-ask forever)
  //   - informational ("thought we had…", "do we have…") → status_check
  //     (_probePlan answers from disk)
  //   - the dismiss sentinel "none of these — start a new plan" → planning
  //     (fresh-draft escape)
  if (!result && (intent === 0 || intent === 1 || intent === 3) && /\bplan\b|none of these/i.test(englishText)) {
    try {
      const sysMap = require('../../shared/system-map.cjs');
      const s = String(englishText || '');
      if (/^none of these\b|\bstart (?:a )?(?:new|fresh) plan\b/i.test(s)) {
        logger.info('[Server] Fresh-plan sentinel → planning lane');
        intent = 6;
        intentName = 'planning';
      } else {
        const refM = s.match(/\bthe\s+([\w][\w .-]{0,40}?)\s+plan\b/i)
          || s.match(/\bplan\s+(?:for|about|on)\s+([\w][\w .-]{1,40})/i)
          || s.match(/\b([\w][\w .-]{0,40}?)\s+plan\b/i);
        const informational = /\b(?:thought|think|remember|had|have|has|was|were|is|are|there|what|which|show|tell|do we|did we|find|search|look|any)\b/i.test(s);
        if (refM && refM[1] && sysMap.findPlans(refM[1].trim()).length) {
          const to = informational ? 3 : 6;
          if (to !== intent) {
            logger.info('[Server] Plan referent re-route', { ref: refM[1].trim(), from: intent, to, informational });
            intent = to;
            intentName = to === 6 ? 'planning' : 'status_check';
          }
        }
      }
    } catch (_) {}
  }

  if (!result) switch (intent) {
    case 0: { // handoff
      // Compute guessedIntent BEFORE handoff() so it's available for task:created
      // (intentGuesser.guess is a pure synchronous regex — ~1ms, no LLM/async)
      const { guessedIntent: _gi0 } = intentGuesser.guess(classifyText, { hasSelectionContext });
      const handoffResult = await handoff({
        englishPrompt: englishText,
        source,
        originalPrompt: originalText,
        guessedIntent: _gi0,
        sessionId: routedSessionId,
        thoughtContext,
        agentId: _capPin || undefined,
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
      result = await generalQuick(englishText, systemPrompt, context, { hasSelectionContext });
      // If generalQuick couldn't answer (LLM failed), handoff to main state graph
      if (result.metadata.shouldHandoff) {
        const { guessedIntent: _gi1 } = intentGuesser.guess(classifyText, { hasSelectionContext });
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
        const { guessedIntent: _gi2 } = intentGuesser.guess(classifyText, { hasSelectionContext });
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

    case 6: { // planning — conversational plan-drafting lane
      result = await planningNode.execute({
        englishText,
        systemPrompt,
        sessionId: routedSessionId,
        planning: {
          active: true,
          // planId precedence: explicit UI pin → resume-guard hit → open plan
          // (skipped for fresh-draft requests so "plan a party" doesn't
          // inherit an unrelated paused plan).
          planId: planning?.planId || _resumePlanId
            || (classifySource === 'planning_phrase_guard' ? null : (_openPlan ? _openPlan.planId : null)),
          name: planning?.name || null,
          startedExplicit: planning?.startedExplicit === true || classifySource === 'planning_pinned',
        },
        source,
        // Planning entered mid-conversation — the routed session's recent
        // turns give the lane the context a fragment prompt is missing.
        conversationContext: convHistory || null,
        // Stream reply prose (translate-back replaces English output, so
        // streaming is disabled for non-English turns).
        onReplyChunk: wasTranslated ? null : onReplyChunk,
        // Capability-gap re-route carried verified candidates — inject them
        // into the planning prompt so <choices> lists real, vetted options.
        capabilityHints: _capHints,
        // Screen context the gate already fetched for ambient prompts — the
        // planning lane opens with eyes instead of asking "what's on screen".
        screenContext: _capScreenCtx,
      });
      // Auto-entered planning (phrase guard / complexity / intent-6 LLM) —
      // surface WHY so the UI shows "moved to planning" rather than silently
      // rerouting the prompt.
      if (classifySource !== 'planning_pinned' && result?.metadata) {
        result.metadata.movedToPlanning = true;
        result.metadata.planningReason = classifySource; // planning_phrase_guard | complexity_guard | force_prompt
      }
      break;
    }

    case 5: { // memory_store
      result = await memoryStore(englishText, systemPrompt, context);
      // If memory_store failed, handoff to main state graph
      if (result.metadata.shouldHandoff) {
        const { guessedIntent: _gi5 } = intentGuesser.guess(classifyText, { hasSelectionContext });
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
      result = await generalQuick(englishText, systemPrompt, context, { hasSelectionContext });
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
  if (intent === 1 || intent === 2 || intent === 5 || intent === 6) {
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

  // ── Clear the journal (test harness) — drops queued/running entries so a
  // restarted corpus run can't replay stale tasks via agent-lock release.
  if (req.url === '/tasks/reset' && req.method === 'POST') {
    taskJournal.clearAll();
    return _send(res, 200, { ok: true });
  }

  // ── Get agent lock state (for UI) ─────────────────────────────────────────────
  if (req.url === '/locks' && req.method === 'GET') {
    return _send(res, 200, agentLock.getLockState());
  }

  // ── Main entry: process a message ────────────────────────────────────────────
  // stream:true → SSE: data:{type:'chunk',text} events as the reply generates,
  // then data:{type:'done',data:{result}}. Otherwise plain JSON as before.
  if (req.url === '/comms.process' && req.method === 'POST') {
    const body = await _readBody(req);
    if (!body.text) {
      return _send(res, 400, { error: 'text is required' });
    }
    const sse = body.stream === true;
    if (sse) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      });
      const emit = (obj) => {
        try { res.write(`data: ${JSON.stringify(obj)}\n\n`); } catch (_) {}
      };
      try {
        const result = await processMessage({
          ...body,
          onReplyChunk: (t) => emit({ type: 'chunk', text: t }),
        });
        emit({ type: 'done', data: { ok: true, data: result } });
      } catch (err) {
        logger.error('[Server] processMessage error', { error: err.message, stack: err.stack });
        emit({ type: 'done', data: { ok: false, error: err.message } });
      }
      res.end();
      return;
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
        // Plan-runner dispatches — carry the plan identity + short-circuit
        // flags so the stategraph executes this task without re-planning.
        planId: body.planId || null,
        planTaskNum: body.planTaskNum || null,
        planTask: body.planTask === true,
        preflightAuthBypass: body.preflightAuthBypass || null,
        // Pre-generated task steps — stategraph adopts them as
        // _deterministicPlan and skips the LLM planning pass.
        deterministicPlan: Array.isArray(body.deterministicPlan) ? body.deterministicPlan : null,
        // Plan-runner pins the canonical agent — lock key = shared session.
        agentId: body.agentId || null,
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
    if (body.sessionId) _lastSessionId = body.sessionId;
    handoffComplete(body.taskId, body.agentId, body.status || 'done', body.result, body.items, body.sessionId || null, body.planFile || null, body.trace || null, body.artifacts || null);
    return _send(res, 200, { ok: true });
  }

  // ── Artifact patch (from main.js) — post-completion updates to a task's ──
  // persisted artifacts, e.g. draft applied flags. Not a status change, so it
  // legitimately works on terminal tasks.
  if (req.url === '/comms.artifacts' && req.method === 'POST') {
    const body = await _readBody(req);
    if (!body.taskId) {
      return _send(res, 400, { error: 'taskId is required' });
    }
    const ok = taskJournal.patchArtifacts(body.taskId, {
      appliedDraftPaths: body.appliedDraftPaths,
    });
    return _send(res, ok ? 200 : 404, { ok });
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

  // ── Plan step-generation retry (from main.js plan-check card) ────────────────
  if (req.url === '/plan.retry-steps' && req.method === 'POST') {
    const body = await _readBody(req);
    const result = planningNode.retrySteps(body.planId, body.taskNum);
    return _send(res, result.ok ? 200 : 400, result);
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
    if (!body.taskId && !body.planId) {
      return _send(res, 400, { error: 'taskId or planId is required' });
    }
    // Plan-scoped cancel: mark EVERY task in the plan cancelled first, THEN
    // remove each — removes can resume a parked sibling on lock release, and
    // the resume path skips tasks already marked cancelled.
    const taskIds = body.planId
      ? taskJournal.getAllTasks()
          .filter((t) => t.planMeta && t.planMeta.planId === body.planId)
          .map((t) => t.id)
      : [body.taskId];
    for (const id of taskIds) {
      taskJournal.updateTask(id, 'cancelled', { error: 'cancelled by user' });
    }
    for (const id of taskIds) {
      try { handoffRemove(id); } catch (_) {}
    }
    return _send(res, 200, { ok: true, cancelled: taskIds.length });
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
  startHandoffRetrySweep();
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
