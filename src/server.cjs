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
  // Root .env fallback (override:false — comms-graph/.env wins) so service API
  // keys like MCP_WEB_SEARCH_API_KEY resolve without duplicating them here.
  require('dotenv').config({ path: path.join(__dirname, '../../.env'), override: false });
} catch (_) {
  // dotenv not installed — env vars must be set externally
}

const PORT = parseInt(process.env.PORT || '3015', 10);

// ── Module imports ──────────────────────────────────────────────────────────────
const { toEnglish, fromEnglish, normalizeLanguage } = require('./translate.cjs');
const { buildSystemPrompt, fetchOverlay, fetchMoodContext } = require('./persona.cjs');
const { classify, INTENTS, GRAPH_ONLY_INTENTS } = require('./classify.cjs');
const { sanitizeContext, isRoutingPromise, stripRoutingPromises } = require('./refusal.cjs');
const { FILE_REF_TAG_LINE_RE, ATTACHMENT_TAG_RE, LIVE_PAGE_REF_RE, isLocalFileEdit, NAMED_APP_RE } = require('../../shared/text-patterns.cjs');
const { computeTurnFacts } = require('../../shared/turn-facts.cjs');
const { replaceVocalizationTags, createVocalizationMapper } = require('../../shared/vocalization-tags.cjs');
const { execute: generalQuick } = require('./nodes/generalQuick.cjs');
const webSearchExpress = require('./nodes/webSearchExpress.cjs');
const { execute: memoryStore } = require('./nodes/memoryStore.cjs');
const planningNode = require('./nodes/planning.cjs');
const { execute: statusCheck } = require('./nodes/statusCheck.cjs');
const { execute: controlSignal } = require('./nodes/controlSignal.cjs');
const screenNode = require('./nodes/screen.cjs');
const { execute: handoff, complete: handoffComplete, remove: handoffRemove, startRetrySweep: startHandoffRetrySweep } = require('./handoff.cjs');
const { getHandoffPhrase, getHandoffPhraseForIntent, getCommandAutomatePhrase } = require('./handoffPhrases.cjs');
const intentGuesser = require('./intentGuesser.cjs');
const { isPlanAnswerShape, shouldPinGate, shouldCaptureShortReply } = require('./planReply.cjs');
const { needsAmbientCtx: _needsAmbientCtx, screenContext: _screenContext } = require('./screen-context.cjs');
const taskJournal = require('./taskJournal.cjs');
const artifactReferent = require('./artifactReferent.cjs');
const agentLock = require('./agentLock.cjs');
const { classifyRoute, canSkipCapabilityGate, serializeDecision, LANE_BY_INTENT } = require('./route-decision.cjs');
const { askEarly } = require('./llm-providers.cjs');

// ── Guardian/trigger rules — entry guard + passphrase-gated management ───────
// The canonical matcher lives in command-service skill-helpers so every
// service (stategraph preflight, executeCommand, monitorService) shares ONE
// rules file. Evaluated after classify, before any lane dispatch — covers
// web-search, general_quick, planning AND handoff uniformly.
let _rulesMod = null;
try { _rulesMod = require('../../mcp-services/command-service/src/skill-helpers/rules.cjs'); } catch (_) {}
// A `then.ask` hit stashes the blocked prompt here; `guardian allow <pass>`
// verifies and re-processes it with the rule bypassed once.
let _pendingGuardian = null; // {ruleId, args}

function _guardianReply(text, extra = {}) {
  return { text, intent: 1, intentName: 'guardian', metadata: { source: 'guardian', ...extra } };
}

async function _guardianCommand(text, args) {
  if (!_rulesMod) return _guardianReply('Guardian rules are unavailable (rules module missing).');
  const rest = text.trim().replace(/^guardian\s+/i, '').split(/\s+/);
  const cmd = (rest.shift() || '').toLowerCase();

  if (cmd === 'allow') {
    const pass = rest.join(' ');
    if (!_pendingGuardian) return _guardianReply('Nothing is waiting on a guardian passphrase.');
    if (!_rulesMod.verifyPassphrase(pass)) return _guardianReply('Wrong passphrase — the rule stays in force.');
    const stash = _pendingGuardian;
    _pendingGuardian = null;
    const result = await processMessage({ ...stash.args, _guardianBypass: stash.ruleId });
    return { ...result, guardianBypassed: stash.ruleId };
  }
  if (cmd === 'passphrase' || (cmd === 'set' && rest[0] === 'passphrase')) {
    const words = cmd === 'set' ? rest.slice(1) : rest;
    const r = _rulesMod.setPassphrase(words[0] || '', { confirmExisting: words[1] || null });
    return _guardianReply(r.ok ? 'Guardian passphrase set.' : `Could not set passphrase: ${r.error}.`);
  }
  if (cmd === 'list' || cmd === 'rules' || cmd === 'recall') {
    if (_rulesMod.hasPassphrase() && !_rulesMod.verifyPassphrase(rest.join(' '))) {
      return _guardianReply('Passphrase required — say: guardian list <passphrase>');
    }
    const rules = _rulesMod.listRules();
    if (!rules.length) return _guardianReply('No guardian rules configured.');
    return _guardianReply(rules.map((r, i) =>
      `${i + 1}. [${r.enabled ? 'on' : 'off'}] ${r.id} — when ${JSON.stringify(r.when)} → ${JSON.stringify(r.then)}`
    ).join('\n'));
  }
  if (cmd === 'add') {
    // The first token is a passphrase only when one is configured — otherwise
    // it belongs to the payload (JSON or natural language).
    const pass = _rulesMod.hasPassphrase() ? (rest.shift() || '') : '';
    if (_rulesMod.hasPassphrase() && !_rulesMod.verifyPassphrase(pass)) {
      return _guardianReply('Passphrase required — say: guardian add <passphrase> <rule JSON>');
    }
    try {
      const r = _rulesMod.addRule(JSON.parse(rest.join(' ')));
      return _guardianReply(r.ok ? `Rule "${r.rule.id}" added.` : `Rule not added: ${r.error}`);
    } catch (e) {
      // Not JSON — treat the remainder as natural-language rule phrasing.
      // Already passphrase-authed above, so the confirm needs no pass again.
      const draft = await _parseRuleNl(rest.join(' '));
      if (!draft) return _guardianReply(`Could not parse rule JSON: ${e.message}`);
      _pendingRule = { rule: draft, authed: true };
      return _guardianReply(
        `Here's the rule I understood:\n  ${_describeRule(draft)}\n` +
        'Say "rule confirm" to set it, or "rule cancel" to drop it.'
      );
    }
  }
  if (cmd === 'delete' || cmd === 'remove' || cmd === 'enable' || cmd === 'disable') {
    const [id, ...pw] = rest;
    if (!id) return _guardianReply(`Usage: guardian ${cmd} <rule-id> <passphrase>`);
    if (_rulesMod.hasPassphrase() && !_rulesMod.verifyPassphrase(pw.join(' '))) {
      return _guardianReply(`Passphrase required — say: guardian ${cmd} ${id} <passphrase>`);
    }
    const r = (cmd === 'delete' || cmd === 'remove') ? _rulesMod.removeRule(id) : _rulesMod.setRuleEnabled(id, cmd === 'enable');
    return _guardianReply(r.ok ? `Rule "${id}" ${cmd === 'enable' ? 'enabled' : cmd === 'disable' ? 'disabled' : 'deleted'}.` : `Failed: ${r.error}`);
  }
  return _guardianReply('Guardian commands: guardian passphrase <new> [current] · guardian list <passphrase> · guardian add <passphrase> <json> · guardian enable|disable|delete <id> <passphrase> · guardian allow <passphrase>');
}

// ── Natural-language rule authoring — plan-confirmed ─────────────────────────
// Conditional trigger phrasing ("if I go to X, email Y", "next time I visit
// this site show an emoji") is detected deterministically, parsed into a draft
// rule by ONE bounded LLM call, echoed in English, and committed only on an
// explicit "rule confirm" — passphrase-gated when one is set. Match/fire paths
// contain no model; the model appears only at authoring.
let _pendingRule = null; // {rule, authed}

// Visit-verb alternation shared by the condition↔action patterns — covers the
// common phrasings observed missing the lane ("goto" one-word, "look at",
// "watch", "join a call").
const _RULE_VISIT = '(?:go(?:es)?\\s*(?:to|on)|goto|visits?|opens?|uses?|comes?\\s+to|lands?\\s+on|navigates?\\s+to|browses?|looks?\\s+at|watch(?:es|ing)?|listen(?:s|ing)?\\s+to|plays?|joins?|records?)';
const _RULE_PHRASE_RES = [
  // condition → action ("if/whenever/next time … goes to/visits/opens … send/show/…")
  new RegExp(`\\b(?:if|whenever|every\\s+time|each\\s+time|next\\s+time|when)\\b[\\s\\S]{0,160}?\\b${_RULE_VISIT}\\b[\\s\\S]{0,200}?\\b(?:send|email|notify|show|warn|block|alert|tell|remind|display|text|ping|let\\s+me\\s+know)`, 'i'),
  // action → condition ("email me when I visit X")
  new RegExp(`\\b(?:send|email|notify|show|warn|alert|tell|remind|display|text|ping|let\\s+me\\s+know)\\b[\\s\\S]{0,160}?\\b(?:when|whenever|every\\s+time|next\\s+time)\\b[\\s\\S]{0,160}?\\b${_RULE_VISIT}`, 'i'),
  // explicit opener — "set/create/make/add a rule that if…": the word "rule"
  // plus a conditional marker is anchored enough to fire the (non-destructive)
  // authoring lane.
  /\b(?:set|create|make|add)\s+(?:a\s+|an\s+|the\s+|me\s+a\s+)?rules?\b[\s\S]{0,120}?\b(?:if|when|whenever|every\s+time|each\s+time|next\s+time)\b/i,
];
const _isRulePhrase = (t) => _RULE_PHRASE_RES.some((re) => re.test(t));
// Weak markers — not enough to enter the lane alone, but worth a semantic
// verdict (AGENTS.md: lexical candidates → confirmJudgment for lane overrides).
const _RULE_WEAK_RE = /\brules?\b|\bevery\s+time\b|\bwhenever\b|\beach\s+time\b|\bnext\s+time\b|\b(?:alert|remind|notify|tell|warn|ping)\s+me\s+when\b/i;

const MEMORY_PORT = parseInt(process.env.MEMORY_SERVICE_PORT || '3001', 10);

// Live focused-window context for "this site/app/file" references.
async function _fetchActiveAppContext() {
  try {
    const res = await fetch(`http://127.0.0.1:${MEMORY_PORT}/memory.getActiveAppContext`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestId: 'cg_rule_' + Date.now() }),
      signal: AbortSignal.timeout(4000),
    });
    const j = await res.json();
    return j?.data?.app || null;
  } catch (_) {
    return null;
  }
}

const _RULE_PARSE_SYS = [
  'Convert the user\'s conditional rule request into ONE JSON object. Output ONLY JSON, no prose.',
  'Schema: {"when":{...},"then":{...},"fireOnce":false,"cooldownMs":60000,"seam":"observation"}',
  'when keys — use only what the sentence implies:',
  '  hostMatch: bare domain ("tiktok.com"), urlMatch: URL substring or "re:<regex>",',
  '  appName: exact app name, fileMatch: file path/name substring or "re:<regex>",',
  '  titleMatch: window-title regex, ocrMatch: regex over on-screen text,',
  '  promptMatch: regex over future requests (guard-style rules)',
  'then.action: "block" (prevent), "ask" (require passphrase), "notify" (screen note),',
  '  "show_card" (screen display — add "kind":"emoji" + "emoji":"😄" + "durationMs":4000 for emoji),',
  '  "enqueue_task" (run a task — "prompt" is the literal task instruction; may use {{host}}/{{url}}/{{appName}} slots)',
  'Rules:',
  '- "send/email/notify someone" → enqueue_task with a complete prompt ("send an email to X saying \'Y\'")',
  '- "show emoji/icon on screen" → show_card with kind emoji',
  '- "block/don\'t allow/restrict" → block; "next time"/"once" → fireOnce:true',
  '- site/app/file rules → seam "observation"; prompt/request rules → seam "entry" or omit',
].join('\n');

const _WHEN_KEYS = ['hostMatch', 'urlMatch', 'appName', 'fileMatch', 'titleMatch', 'ocrMatch', 'promptMatch', 'service', 'intent', 'entities', 'varMatch'];
const _THEN_KEYS = ['action', 'title', 'body', 'msg', 'reason', 'prompt', 'kind', 'emoji', 'durationMs', 'mood', 'severity', 'deterministicPlan', 'agentId'];

// Observation matchers — presence of any of these means the rule watches the
// ambient monitor, so a model-emitted promptMatch would AND-poison it (the
// observation ctx has prompt:'' and it could never fire).
const _OBS_WHEN_KEYS = new Set(['hostMatch', 'urlMatch', 'appName', 'fileMatch', 'titleMatch', 'ocrMatch']);
// Emoji words → glyphs for "show a happy emoji" phrasing.
const _EMOJI_WORDS = { happy: '😄', smile: '😊', sad: '😢', heart: '❤️', party: '🎉', star: '⭐', warning: '⚠️', angry: '😠', laugh: '😂', thumbs: '👍', fire: '🔥', cat: '🐱', dog: '🐶' };

function _sanitizeRuleDraft(p, text) {
  const when = {};
  for (const k of _WHEN_KEYS) if (p.when && p.when[k] !== undefined) when[k] = p.when[k];
  if (!Object.keys(when).length) return null;
  // Observation rules can't also gate on promptMatch — the monitor ctx has no
  // prompt field and the AND would never fire.
  if (Object.keys(when).some((k) => _OBS_WHEN_KEYS.has(k))) delete when.promptMatch;
  const then = {};
  for (const k of _THEN_KEYS) if (p.then && p.then[k] !== undefined) then[k] = p.then[k];
  if (!then.action) then.action = then.prompt ? 'enqueue_task' : 'notify';
  // Emoji phrasing coerces a display action into the emoji kind — the screen
  // contract renders it centered + auto-dismissed; model word choice isn't
  // trusted for this.
  if (/emoji|emoticon/i.test(text || '') && (then.action === 'show_card' || then.action === 'notify')) {
    const word = (String(text).match(/\b(\w+)\s+emoji\b/i) || [])[1] || '';
    then.action = 'show_card';
    then.kind = 'emoji';
    then.emoji = then.emoji || _EMOJI_WORDS[word.toLowerCase()] || '😄';
    if (typeof then.durationMs !== 'number') then.durationMs = 4000;
  }
  const rule = { when, then };
  // "next time"/"once" phrasing forces fireOnce — deterministic, not modeled.
  if (p.fireOnce === true || /\bnext\s+time\b|\bjust\s+once\b|\bonly\s+once\b/i.test(text || '')) rule.fireOnce = true;
  if (typeof p.cooldownMs === 'number' && p.cooldownMs >= 0) rule.cooldownMs = p.cooldownMs;
  if (p.seam) rule.seam = p.seam;
  return rule;
}

async function _parseRuleNl(text) {
  try {
    const r = await askEarly(
      [{ role: 'system', content: _RULE_PARSE_SYS }, { role: 'user', content: text }],
      { maxTokens: 400, temperature: 0, taskType: 'classification' },
    );
    const raw = r.fullText || r.firstSentence || '';
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) return null;
    return _sanitizeRuleDraft(JSON.parse(m[0]), text);
  } catch (_) {
    return null;
  }
}

function _describeRule(rule) {
  const w = rule.when || {};
  const conds = [];
  if (w.hostMatch) conds.push(`host is ${w.hostMatch}`);
  if (w.urlMatch) conds.push(`URL contains ${w.urlMatch}`);
  if (w.appName) conds.push(`app is ${w.appName}`);
  if (w.fileMatch) conds.push(`file matches ${w.fileMatch}`);
  if (w.titleMatch) conds.push(`title matches /${w.titleMatch}/`);
  if (w.ocrMatch) conds.push(`screen text matches /${w.ocrMatch}/`);
  if (w.promptMatch) conds.push(`prompts match /${w.promptMatch}/`);
  const t = rule.then || {};
  let act;
  switch (t.action) {
    case 'enqueue_task': act = `run "${t.prompt}"`; break;
    case 'block': act = `block it${t.reason ? ` (${t.reason})` : ''}`; break;
    case 'ask': act = 'require the guardian passphrase first'; break;
    case 'show_card': act = t.kind === 'emoji' ? `show ${t.emoji || 'an emoji'} on screen` : `show a card${t.title ? ` "${t.title}"` : ''}`; break;
    default: act = `notify${t.title ? ` "${t.title}"` : ''}`;
  }
  const firing = rule.fireOnce
    ? 'fires once'
    : `fires every match${rule.cooldownMs ? ` (${Math.round(rule.cooldownMs / 1000)}s cooldown)` : ' (60s cooldown)'}`;
  return `when ${conds.join(' and ') || 'matched'} → ${act} — ${firing}`;
}

async function _authorRule(text) {
  const [draft, ctx] = await Promise.all([
    _parseRuleNl(text),
    /\b(?:this|the)\s+(?:site|page|app|file|tab|window)\b/i.test(text) ? _fetchActiveAppContext() : Promise.resolve(null),
  ]);
  if (!draft) {
    return _guardianReply(
      'I couldn\'t turn that into a rule — try "guardian add <pass> {json}", or rephrase ' +
      '(e.g. "if I go to example.com, show a happy emoji").'
    );
  }
  // "this site/app/file" — seed the matcher from the live focused window.
  if (ctx) {
    if (ctx.url) draft.when.urlMatch = ctx.url;
    else if (ctx.appName && !draft.when.appName) draft.when.appName = ctx.appName;
    if (ctx.filePath && /\bfile\b/i.test(text)) draft.when.fileMatch = ctx.filePath;
  }
  const needsPass = _rulesMod.hasPassphrase();
  _pendingRule = { rule: draft, authed: false };
  return _guardianReply(
    `Here's the rule I understood:\n  ${_describeRule(draft)}\n` +
    `Say "rule confirm${needsPass ? ' <passphrase>' : ''}" to set it, or "rule cancel" to drop it.`
  );
}
const _decision = require('./decision.cjs');

// ── Thought engine prompt producer ─────────────────────────────────────────────
// Fire-and-forget POST of each user prompt to personality-service so the
// Thought/Trigger engine can accumulate prompt-derived thoughts.
const PERSONALITY_PORT = parseInt(process.env.PERSONALITY_SERVICE_PORT || '3012', 10);
const MAIN_PORT = parseInt(process.env.THINKDROP_MAIN_PORT || '3010', 10);

// Fire-and-forget POST to a main-process endpoint (plan triggers, events).
function _postMain(path, payload) {
  try {
    fetch(`http://127.0.0.1:${MAIN_PORT}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload || {}),
      signal: AbortSignal.timeout(5000),
    }).catch(() => {});
  } catch (_) {}
}

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

// ── Loop-back escalation handling ──────────────────────────────────────────────
// 'needs_plan'/'plan_update' completions re-enter the planning lane. Settle
// contract: EVERY outcome resolves something — a runnable plan posts
// /plan.run; anything else (scrubbed reply, zero tasks, timeout, throw) posts
// /plan.fail so the held run + queue card terminalize instead of spinning
// forever (observed: task_d8b8de8c — 40min "Generating skill plan…").
const _LOOPBACK_MAX_ATTEMPTS = 2;      // needs_plan replans per plan/task
const _LOOPBACK_TIMEOUT_MS = 240000;   // escalated turns run ~70s; 4min headroom
const _loopBackAttempts = new Map();   // key planId||taskId → needs_plan count

async function _handleLoopBack(body) {
  const _lbTask = taskJournal.getTask(body.taskId);
  let _lb = {};
  try { _lb = JSON.parse(body.result || '{}'); } catch (_) {}
  const _lbPlanId = _lbTask?.planMeta?.planId || _lb.planId || null;
  // A needs_plan escalation from a plan-bound task = "this plan can't run as
  // written" — revise the SAME plan (like plan_update) so startPlan resumes
  // the held run. forceNewPlan is only for non-plan tasks that escalated.
  const _isRevise = !!_lbPlanId;
  const _lbText = _isRevise
    ? (body.status === 'plan_update'
      ? `[Execution feedback — revise THIS plan in place]\nReason: ${_lb.reason || 'unspecified'}\nProposed change: ${_lb.proposal || 'see reason'}\n${_lb.gatheredContext?.length ? `Known: ${JSON.stringify(_lb.gatheredContext).slice(0, 600)}` : ''}`
      : `[Execution feedback — revise THIS plan in place]\nReason: ${_lb.reason || 'unspecified'}\nA task in this plan could not run as written — revise the plan so it executes with available capabilities (re-pin the failing task to a dispatchable skill, fix its steps, or add the missing onboarding step).\nFailing task: ${String(_lb.seedPrompt || _lbTask?.prompt || '').replace(/\s*\[Runtime readiness:[^\]]*\]/g, '')}`)
    : (_lb.seedPrompt || _lbTask?.prompt || '');
  const _lbSession = body.sessionId || _lbTask?.sessionId || _lastSessionId || null;
  const _attemptKey = _lbPlanId || body.taskId;

  const _settleFail = (why) => {
    _loopBackAttempts.delete(_attemptKey);
    logger.warn('[Server] Loop-back settling as failure', { taskId: body.taskId, planId: _lbPlanId, why });
    _postMain('/plan.fail', { planId: _lbPlanId, taskId: body.taskId, reason: why });
  };

  // Loop guard — a plan that keeps escalating needs_plan cannot be compiled
  // into something runnable; fail it instead of ping-ponging run→escalate.
  // The count is LIFETIME per plan (not cleared on /plan.run) — a replan that
  // produced a runnable-but-broken plan still ping-pongs back here otherwise.
  if (body.status === 'needs_plan') {
    const n = (_loopBackAttempts.get(_attemptKey) || 0) + 1;
    _loopBackAttempts.set(_attemptKey, n);
    if (n > _LOOPBACK_MAX_ATTEMPTS) {
      _loopBackAttempts.delete(_attemptKey);
      logger.warn('[Server] Loop-back escalation cap reached', { taskId: body.taskId, planId: _lbPlanId, attempts: n });
      _settleFail(`planning could not produce a runnable plan after ${n - 1} attempt(s) — last: ${_lb.reason || 'unspecified'}`);
      return;
    }
  }

  logger.info(`[Server] Loop-back ${body.status} → planning lane`, {
    taskId: body.taskId, planId: _lbPlanId, revise: _isRevise,
    reason: _lb.reason || null,
  });

  let lbResult = null, lbErr = null;
  try {
    lbResult = await Promise.race([
      planningNode.execute({
        englishText: _lbText,
        sessionId: _lbSession,
        planning: _isRevise
          ? { active: true, planId: _lbPlanId, revise: true, escalated: true, addRefs: _lb.addRefs }
          : { active: true, escalated: true, forceNewPlan: true, refs: _lb.refs },
      }),
      new Promise((_, rej) => setTimeout(() => rej(new Error(`loop-back planning timeout (${_LOOPBACK_TIMEOUT_MS}ms)`)), _LOOPBACK_TIMEOUT_MS)),
    ]);
  } catch (err) { lbErr = err; }

  const md = lbResult?.metadata || {};
  if (!lbErr && md.runPlan && md.planFile) {
    // Escalated plans auto-run — main's plan-check fires autoStart once every
    // checklist item clears (auth/Approval gates still hold). Attempt count is
    // deliberately NOT cleared — the cap is lifetime per plan (see above).
    _postMain('/plan.run', { planId: md.planId, planFile: md.planFile, escalated: true });
    return;
  }
  if (!lbErr && _lb.reason === 'no_skill_coverage' && _lbText) {
    // User declined/abandoned planning for a coverage miss — re-dispatch the
    // same request with _allowPlannerFallback so stategraph's coverage gate
    // lets the bounded planner handle it ("just run it").
    _loopBackAttempts.delete(_attemptKey);
    logger.info('[Server] no_skill_coverage planning exited without plan — re-dispatching with planner fallback', { taskId: body.taskId });
    handoff({
      englishPrompt: _lbText,
      source: _lbTask?.source || 'text',
      sessionId: _lbSession,
      guessedIntent: _lbTask?.guessedIntent || null,
      allowPlannerFallback: true,
    }).catch(err => logger.warn('[Server] planner-fallback re-dispatch failed', { error: err?.message }));
    return;
  }
  // The escalated turn produced no runnable plan. If it left a NEW drafting
  // stub (≠ the plan being revised), mark it failed so it doesn't linger.
  if (!lbErr && md.planId && md.planId !== _lbPlanId) {
    try {
      const planFormat = require('../../shared/plan-format.cjs');
      const os = require('os');
      const f = md.planFile || path.join(os.homedir(), '.thinkdrop', 'plans', `${md.planId}.md`);
      if (fs.existsSync(f)) {
        fs.writeFileSync(f, planFormat.updateFrontmatterStatus(fs.readFileSync(f, 'utf8'), 'failed'), 'utf8');
      }
    } catch (_) {}
  }
  _settleFail(lbErr
    ? `planning failed: ${String(lbErr.message || lbErr).slice(0, 200)}`
    : `planning produced no runnable plan (${_lb.reason || 'escalated'})`);
}

// ── Capability-gap guard ──────────────────────────────────────────────────────
// Cheap read-only call into command-service /capability.search. Decides whether
// a handoff-bound prompt should pin a ready agent or divert to planning.
const COMMAND_PORT = parseInt(process.env.COMMAND_SERVICE_PORT || '3007', 10);
const SETUP_PHRASE_RE = /\b(connect|set ?up|link|sync|install|pair|integrate)\b[^.\n]{0,60}\b(to|with|my)\b/i;
const AMBIGUOUS_CAST_RE = /\b(cast|mirror|stream)\b[^.\n]{0,40}\b(app|screen|window|desktop|overlay)\b/i;
// QA-shaped prompts that a veto demoted to handoff (intent 0) must not be
// capability-gated into planning — a question needs an answer, not a setup
// plan. Action intents (command_automate etc.) still run the gate.
const _GATE_SKIP_INTENTS = new Set(['web_search', 'general_knowledge', 'memory_retrieve', 'status_check']);

// ── Capability-gap guard ────────────────────────────────────────────────────
// Three-layer routing, mirrored inside command-service:
//   1. /capability.search — mechanical retrieval (generous recall; never the
//      decision itself — a substring match can no longer become a pin).
//   2. /capability.select-best — ONE bounded temp-0 LLM pick over the
//      retrieved fact table ({pick, fit:exact|partial|none, reason}).
//   3. decideGate (server-side) — pure mapping from VERIFIED FACTS:
//      exact+ready→pin, exact+unready→needs_setup, partial→clarify,
//      none→infer/stategraph, selector-failure→ASKING (never lexical pin).
let _decideGate = null;
function _loadDecideGate() {
  if (_decideGate) return _decideGate;
  try { _decideGate = require('../../shared/capability-index.cjs').decideGate; } catch (_) { _decideGate = () => 'fallback'; }
  return _decideGate;
}

// Materialize an unregistered pick (platform affordance, infer-installed
// tool, cli-registry provider) into a draft agent descriptor so
// resolveAgent's registered-check can bind the pin. Returns the agentId
// to pin, or null when materialization failed.
async function _materializePin(candidateId) {
  try {
    const res = await fetch(`http://127.0.0.1:${COMMAND_PORT}/capability.select`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: candidateId }),
      signal: AbortSignal.timeout(4000),
    });
    const r = await res.json();
    return r?.ok && r.agentId ? r.agentId : null;
  } catch (_) {
    return null;
  }
}

// GhostLayer deliverables — charts/effects/scenes painted onto the screen are
// native screen.display output, not external-service capability gaps. The
// stategraph's screenOutput detection owns these; the gate must not divert
// them into setup planning (e.g. "create a pie chart" → chartjs candidates).
const SCREEN_OUTPUT_RE = /\b(?:pie|bar|line|donut)\s*chart|\bcharts?\s+(?:up|of|showing)\b|on\s+(?:my|the)\s+screen|make\s+it\s+rain|emoji\s+rain|fireworks|slideshow|slide\s*show|\b3d\s+(?:model|scene)\b|\borbit\b/i;

// Local file-system chores — moving/copying/organizing files between local
// folders uses native fs tools; there is no service to pick.
const LOCAL_FS_RE = /\b(?:move|copy|rename|organize|sort|delete|archive)\b[^.\n]{0,60}\b(?:files?|folders?|directories)\b|\b(?:files?|folders?)\s+in\s+(?:my\s+)?(?:downloads|desktop|documents|home)\b/i;

// Unresolved recipient — "text my wife", "call my mom" — no usable contact
// info in the text. Planning asks for it AFTER the user picks a route.
const MISSING_INFO_RE = /\b(?:text|message|msg|email|e-mail|call|phone|send|tell|notify|ping|dm|facetime|whatsapp)\s+my\s+(?:wife|husband|spouse|partner|fianc[ée]e?|mom|dad|mother|father|parents?|sister|brother|siblings?|son|daughter|kids?|boss|coworker|colleague|landlord|doctor|dentist|lawyer|accountant|neighbor|roommate|girlfriend|boyfriend|friend|family|team)\b/i;

// (Selector 'none' is authoritative — a named-site scrape that lexically
// matches service tokens, e.g. "not my own calendar" on a church prompt,
// must NOT be pulled into the options lane by a regex.)

let _mergeRouteOptions = null;
function _loadMerge() {
  if (!_mergeRouteOptions) {
    try { _mergeRouteOptions = require('../../shared/capability-index.cjs').mergeRouteOptions; }
    catch (_) { _mergeRouteOptions = (r) => (r || []).slice(0, 8); }
  }
  return _mergeRouteOptions;
}

// Cached /ext.status probe — the ThinkDrop Chrome extension is the zero-setup
// authenticated path into the user's real browser. The gate must know it is
// available before offering integration-setup options for named sites.
let _extCache = { at: 0, connected: false };
async function _extConnected() {
  if (Date.now() - _extCache.at < 15000) return _extCache.connected;
  try {
    const r = await fetch(`http://127.0.0.1:${COMMAND_PORT}/ext.status`, { signal: AbortSignal.timeout(400) });
    const j = await r.json();
    _extCache = { at: Date.now(), connected: !!j?.connected };
  } catch (_) { _extCache.at = Date.now(); /* keep last verdict */ }
  return _extCache.connected;
}

// Named-app + navigation verb — the user explicitly chose the browser surface
// ("goto gmail", "open amazon", "visit youtube"). That's a browser task, not
// a service-integration gap — it must reach the browser agents, never nylas/
// MCP setup planning. Unconditional: public sites need no auth even when the
// extension is disconnected (engine path reports needsAuth for the rest).
const _BROWSER_NAV_VERB_RE = /\b(?:goto|go\s+to|open|visit|navigate|browse|launch|pull\s+up|bring\s+up|log\s*in|sign\s*in)\b/i;

// A capability.search hit is "ready" when installed with low setup friction —
// the same test the options-extras filter uses.
function _hasReadyResult(results) {
  return (results || []).some(r => r && r.installed !== false && (r.friction ?? 9) <= 2);
}

async function _capabilityGate(text, opts = {}) {
  try {
    // "cast/mirror <app|screen|overlay>" is ambiguous (media-cast vs window
    // mirroring) — always clarify in planning even when a cast agent exists.
    if (AMBIGUOUS_CAST_RE.test(text)) return { planning: 'capability_gap' };

    // Explicit named-app navigation → handoff → browser agents (extension
    // first, engine fallback). Integration planning is not what "goto X" means.
    if (NAMED_APP_RE.test(text) && _BROWSER_NAV_VERB_RE.test(text)) {
      logger.info('[capability-gate] named-app navigation → browser route (gate skipped)');
      return null;
    }
    const _namedApp = NAMED_APP_RE.test(text);

    // Screen-output deliverables bypass the gate — painting a chart/effect
    // onto the screen needs no external service.
    if (SCREEN_OUTPUT_RE.test(text)) return null;

    // Purely local file chores need no service either — native fs tools.
    if (LOCAL_FS_RE.test(text) && !/\b(?:upload|download|fetch|search|look\s+up)\b/i.test(text)) return null;

    // File-CONTENT edits — "add X to this file", "append to notes.rtf", or an
    // edit verb riding a [File:] chip — are local fs jobs too. Keeps the gate
    // (and its infer call) out of obvious file chores; retrieval's generic-
    // token filter is the deeper fix for the same misroute class.
    if (isLocalFileEdit(text, { hasFileRef: opts.hasFileRef })
        && !/\b(?:upload|download|fetch|search|look\s+up|email|share)\b/i.test(text)) return null;

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

    // ── Explicit-tool pin (tier 1) ────────────────────────────────────────
    // A prompt that names a registered CLI/API/MCP tool ("use nylas to
    // delete it") resolves it deterministically — no search recall or LLM
    // pick needed. Selection order: explicit name > artifact referent >
    // decision-model > remote select-best > planning.
    try {
      const _explicit = artifactReferent.resolveExplicitTool(text);
      if (_explicit) {
        // Non-strong matches (bare token / phrase) are lexical guesses — the
        // decision model confirms the tool fits the prompt's context before
        // it may short-circuit the whole gate.
        let _ok = _explicit.tier === 'strong';
        if (!_ok) {
          let _who = _explicit.agentId;
          try {
            const _desc = require('../../shared/service-map.cjs').describeAgent(_explicit.agentId);
            if (_desc) _who = `${_explicit.agentId} (service "${_desc.service || '?'}", type ${_desc.type || '?'}${_desc.cliTool ? `, drives ${_desc.cliTool}` : ''}${_desc.keywords?.length ? ` — for: ${_desc.keywords.slice(0, 5).join(', ')}` : ''})`;
          } catch (_) {}
          _ok = (await _decision.confirmJudgment({
            site: 'capability-pin',
            question: `A binder wants to route this request to the tool ${_who} because the word "${_explicit.matched}" appears in it. The word may be ordinary vocabulary (e.g. "commit messages" names git output, not the Messages app). Does the request actually intend to invoke that tool/service?`,
            state: String(text || '').slice(0, 800),
          })) === 'YES';
        }
        if (_ok) {
          logger.info('[capability-gate] explicit tool pin', { agentId: _explicit.agentId, matched: _explicit.matched, tier: _explicit.tier });
          return { pin: _explicit.agentId, reason: `explicit-tool:${_explicit.matched}` };
        }
        logger.info('[capability-gate] tool pin vetoed by context', { agentId: _explicit.agentId, matched: _explicit.matched, tier: _explicit.tier });
      }
    } catch (_) {}

    const res = await fetch(`http://127.0.0.1:${COMMAND_PORT}/capability.search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, limit: 10 }),
      signal: AbortSignal.timeout(2000),
    });
    const results = (await res.json())?.results || [];

    // ── Extension-aware fact correction ────────────────────────────────────
    // The index scores browser agents by their Playwright-profile auth state
    // (friction 4-5 = "sign-in may be needed") — it can't see that the
    // ThinkDrop extension's REAL Chrome session is already authenticated.
    // When the extension is connected, correct those facts: browser-session
    // candidates become zero-friction and carry the chrome-extension marker
    // the ext-aware SELECT rules weigh (capability-index.cjs).
    const _extOn = await _extConnected();
    if (_extOn) {
      for (const r of results) {
        if (r && r.authType === 'browser-session') {
          r.friction = 0;
          r.setupSummary = 'ready — real Chrome session (extension connected)';
          r.detail = `chrome-extension — drives the user's real signed-in browser. ${r.detail || ''}`.trim();
        }
      }
    }

    // ── Semantic selection + external discovery (parallel) ─────────────────
    // A capability hit means this is a service task — the user always sees the
    // real options list in planning (installed routes first, discovered
    // CLI/API/MCP second) and picks. select-best still runs: its pick orders
    // the list and flags whether the prompt is missing required details.
    if (results.length) {
      // ── Decision-model select (tier 3) ─────────────────────────────────
      // Local phi4 pick over the search candidates (~50–300ms) before paying
      // the remote select-best call — same local→remote pattern as classify.
      // Confident pick → pin; 'none' → fall through like a no-fit result;
      // anything else → remote select-best runs unchanged.
      try {
        const _dec = require('./decision.cjs');
        if (_dec.decisionEnabled()) {
          const _cands = results.slice(0, 10);
          const _opts = _cands.map(c => `${c.id || c.agentId} — ${String(c.summary || c.detail || c.service || '').slice(0, 100)}`);
          const _dr = await _dec.askDecision([{
            id: 'tool', type: 'choice',
            question: 'Which capability best serves this request? Pick the last option (none) if none fit.',
            options: [..._opts, 'none'],
          }], { state: `Request: ${query}` });
          const _pick = _dr?.answers?.tool;
          if (_pick && _pick.index != null && _pick.index < _cands.length && (_pick.confidence ?? 0) >= 0.55) {
            const _cand = _cands[_pick.index];
            const _pinId = _cand.agentId || (_cand.id && String(_cand.id).endsWith('.agent') ? _cand.id : null);
            // A capability id ('video.ffmpeg') is a route candidate, not an
            // executable agent — pinning it poisons state._pinnedAgentId and
            // vetoes deterministic plans downstream (observed: media_play
            // vetoed by a 'video.ffmpeg' pin). Only registered .agent ids pin.
            if (_pinId) {
              logger.info('[capability-gate] decision-model pin', { agentId: _pinId, conf: _pick.confidence });
              return { pin: _pinId, reason: 'decision-tool' };
            }
            logger.info('[capability-gate] decision-model pick is a capability id, not an agent — routing to select/options', { id: _cand.id, conf: _pick.confidence });
          }
          if (_pick && _pick.index === _cands.length && (_pick.confidence ?? 0) >= 0.55) {
            logger.info('[capability-gate] decision-model: no capability fits — passing through');
            return null;
          }
        }
      } catch (_) { /* decision model unavailable → remote select-best below */ }

      const inferBody = JSON.stringify({ query, screenText: screenCtx?.ocrText || null });
      // select-best awaited immediately; infer runs in background and is only
      // awaited by branches that consume it (options/clarify). The pin path
      // used to block on Promise.all for up to the 25s infer budget.
      const _selP = fetch(`http://127.0.0.1:${COMMAND_PORT}/capability.select-best`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, screenText: screenCtx?.ocrText || null, candidates: results, extConnected: _extOn }),
        signal: AbortSignal.timeout(12000),
      }).then(r => r.json()).catch(() => null);
      const _infP = fetch(`http://127.0.0.1:${COMMAND_PORT}/capability.infer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: inferBody,
        signal: AbortSignal.timeout(25000),
      }).then(r => r.json()).catch(() => null);

      const sel = await _selP;
      const decision = (sel && sel.ok === false) ? 'fallback' : (sel?.decision || 'fallback');
      // Memoized lazy await — pin/early-return paths never pay infer's
      // 25s budget; options/setup branches resolve it once on demand.
      let _inferred = null;
      const _infer = async () => {
        if (_inferred === null) _inferred = (await _infP)?.candidates || [];
        return _inferred;
      };

      // 'none' means the selector saw hits but judged them irrelevant — not a
      // capability task at all (named-site scrapes, weather, chat). Fall
      // through to the stategraph like a no-hit prompt.
      if (decision !== 'none') {
        // Unresolved recipient — "text my wife", "call my mom" — no usable
        // contact info in the text. Planning asks for it AFTER the pick.
        let needsInfo = /(?:\+?\d[\d\s().-]{6,}\d)|@\S+|[\w.+-]+@[\w-]+\.\w+/.test(text)
          ? null
          : (MISSING_INFO_RE.test(text) ? 'recipient' : null);
        // Spec-completeness noul — generalizes the kinship-recipient regex to
        // every required-slot class (time, destination, item, access). Runs
        // only when the regexes found nothing and the gate is already engaged
        // (service/action prompts); biased to complete like the grill — "when
        // in doubt, complete". A missing slot keeps the planning-options flow
        // so the lane asks for it after the route pick. Fail-open to null.
        if (!needsInfo && _decision?.decisionEnabled?.() !== false) {
          try {
            const _specRes = await _decision.askDecision([
              { id: 'spec', type: 'choice',
                question: 'Does this request have enough information to execute? Flag missing ONLY when a required input is absent — no recipient for a send/message, no time for a schedule/reminder, no destination for a nav/book/order, no item for an action on "it". Never flag optional details, preferences, or things resolvable from context or memory. When in doubt, complete.',
                options: ['complete — enough info to act', 'missing — a required detail is absent'] },
              { id: 'slot', type: 'choice',
                question: 'Which required detail is missing (answer only if spec is missing)?',
                options: ['recipient or contact', 'time or date', 'destination or place', 'item or subject', 'credentials or access', 'something else'] },
            ], { state: `prompt: ${String(text || '').slice(0, 300)}\nservice: ${tc?.targetService || 'unknown'}` });
            const _spec = _specRes?.answers?.spec;
            const _missing = _spec?.index === 1 || /^missing/i.test(String(_spec?.answer || ''));
            if (_missing && (_spec?.confidence == null || _spec.confidence >= 0.5)) {
              const _slots = ['recipient', 'time', 'destination', 'item', 'access', 'other'];
              const _slotAns = _specRes.answers?.slot;
              needsInfo = (typeof _slotAns?.index === 'number' ? _slots[_slotAns.index]
                : _slots.find(s => String(_slotAns?.answer || '').toLowerCase().includes(s))) || 'other';
              logger.info(`[capability-gate] specCompleteness → needsInfo=${needsInfo}${typeof _spec?.confidence === 'number' ? ` conf=${_spec.confidence}` : ''}`);
            }
          } catch (e) {
            logger.debug(`[capability-gate] specCompleteness failed — continuing without needsInfo: ${e.message}`);
          }
        }
        // Exact+ready pick and nothing missing → pin the agent and hand off.
        // decideGate only returns 'pin' on fit:exact + verified installed/
        // low-friction, so the options card would be ceremony for a choice
        // that isn't real. needsInfo keeps the options flow — the pick
        // exists but a required detail (recipient) is still uncollected.
        if (shouldPinGate(decision, needsInfo)) {
          const candId = sel?.pick?.id || sel?.pick?.agentId || null;
          // Materialize first — confirms registered picks and converts
          // unregistered ones into a draft descriptor resolveAgent can bind.
          // Bare use of a .agent-suffixed unregistered id would pin a phantom.
          let pinned = candId ? await _materializePin(candId) : null;
          if (!pinned) pinned = sel?.pick?.agentId || null;
          if (pinned) {
            logger.info('[capability-gate] exact ready route → pin + handoff', { agentId: pinned, pick: candId });
            return { pin: pinned, reason: sel?.reason || 'exact+ready' };
          }
          // Materialization failed — fall through to options/clarify so the
          // user still gets a real choice instead of a silent dead-end.
        }
        // The selector's pick + alternatives are the vetted ready pool —
        // raw matchScore is too noisy (generic tokens like "text"/"my"
        // match catt/vscode/pandoc keyword lists). Augment with ready
        // candidates whose keywords/capabilities share a real token with
        // the query — "check my gmail" should still surface nylas
        // (list_emails ~ "mail") even when the selector's alts omit it.
        const qTokens = new Set((String(text).toLowerCase().match(/[a-z]{4,}/g) || [])
          .filter(w => !/^(check|what|tell|show|give|with|that|this|from|into|have|want|need|please|today|tonight|about|when|them|they|there|here|just|also|then|some|more|been|came|know|like|list|read|send|text|call|make|keep)$/.test(w)));
        const overlapsQuery = (r) => {
          const hay = [r.service, r.id, r.tool, ...(r.keywords || []), ...(r.capabilities || [])].filter(Boolean).join(' ').toLowerCase();
          for (const w of qTokens) {
            if (hay.includes(w)) return true;
            // Affixed service words — 'gmail' should match 'list_emails'
            // ('mail'), 'imessage' → 'message'.
            if (w.length >= 5 && (hay.includes(w.slice(1)) || hay.includes(w.slice(0, -1)))) return true;
          }
          return false;
        };
        const pool = [sel?.pick, ...(sel?.alternatives || [])].filter(Boolean);
        const extras = results
          .filter(r => r && r.installed !== false && (r.friction ?? 9) <= 2 && overlapsQuery(r))
          .slice(0, 4);
        const merged = [...pool, ...extras];
        const options = _loadMerge()(
          merged.length ? merged : results.filter(r => (r.matchScore || 0) >= 2),
          await _infer(), sel?.pick);
        if (options.length) {
          // Extension-first for named sites: when nothing on offer is actually
          // ready (all setup/config), the user's real browser can just do the
          // task — asking them to configure an integration is strictly worse
          // than driving the page they named. A ready integration still wins
          // structured ops (send/create/post) through the normal options flow.
          if (_namedApp && !_hasReadyResult(results) && await _extConnected()) {
            logger.info('[capability-gate] named-app task, setup-only options → browser route (extension connected)');
            return null;
          }
          logger.info('[capability-gate] service task → planning options', {
            decision, options: options.length, needsInfo,
          });
          return { planning: 'capability_options', hints: options, needsInfo, recommended: sel?.pick?.id || null, screenCtx };
        }
        // Empty options but selector had a pick — keep old clarify behavior.
        if (decision === 'clarify' || decision === 'needs_setup' || decision === 'fallback') {
          if (_namedApp && await _extConnected()) {
            logger.info('[capability-gate] named-app clarify → browser route (extension connected)');
            return null;
          }
          const hints = sel ? [sel.pick, ...(sel.alternatives || [])].filter(Boolean).slice(0, 5) : results.slice(0, 5);
          if (hints.length) return { planning: 'capability_clarify', hints, screenCtx };
        }
      }
      // 'none' with no service signal — fall through to infer/stategraph
      const _inf = await _infer();
      if (!_inf.length) return null;
      // no-hit path continues below with the already-fetched infer results
      if (_inf.length && !_inf.some(c => c.installed && (c.friction ?? 9) <= 1)) {
        if (_namedApp && await _extConnected()) {
          logger.info('[capability-gate] named-app needs_setup → browser route (extension connected)');
          return null;
        }
        return { planning: 'capability_needs_setup', hints: _inf.slice(0, 5), screenCtx };
      }
      return null;
    }

    // ── Semantic fallback ──────────────────────────────────────────────────
    // Retrieval found nothing — vocabulary gap, not necessarily a capability
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
    // An inferred candidate that's already installed & friction-free means the
    // job is doable right now via core skills (shell.run etc.) — not a setup
    // decision. Only when EVERY candidate needs install/auth is planning's
    // clarify warranted ("ls is installed" ≠ "you need a provider").
    if (inferred.length && !inferred.some(c => c.installed && (c.friction ?? 9) <= 1)) {
      if (_namedApp && await _extConnected()) {
        logger.info('[capability-gate] named-app infer needs_setup → browser route (extension connected)');
        return null;
      }
      return { planning: 'capability_needs_setup', hints: inferred.slice(0, 5), screenCtx };
    }

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
function _logConversationTurn(userText, assistantText, intentName, preRoutedSessionId, searchMeta) {
  if (!CONV_API_KEY) return; // no key — skip silently
  const ts = new Date().toISOString();
  // Search answers carry display metadata — persist it so the feed can
  // rehydrate cards/pills/engine on reload (same job the stategraph's task
  // journal does for handoff answers). data: URI thumbs are 5-10KB each and
  // can't be refetched — strip them; keep http thumbs + all link fields.
  const _searchMd = (() => {
    if (!searchMeta) return {};
    const items = (searchMeta.items || []).map(i => ({
      ...i,
      ...(typeof i.thumbnail === 'string' && i.thumbnail.startsWith('data:') ? { thumbnail: undefined } : {}),
      ...(typeof i.imageUrl === 'string' && i.imageUrl.startsWith('data:') ? { imageUrl: undefined } : {}),
    }));
    return {
      ...(items.length ? { items } : {}),
      ...(searchMeta.sources?.length ? { sources: searchMeta.sources } : {}),
      ...(typeof searchMeta.engine === 'string' && searchMeta.engine ? { engine: searchMeta.engine } : {}),
    };
  })();
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
      _post('message.add', { sessionId: preRoutedSessionId, text: assistantText, sender: 'assistant', metadata: { source: 'comms-graph', intent: intentName, timestamp: ts, ..._searchMd } });
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
          _post('message.add', { sessionId, text: assistantText, sender: 'assistant', metadata: { source: 'comms-graph', intent: intentName, timestamp: ts, ..._searchMd } });
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
  const { text, language, source = 'text', speakerProfile, isResemble, thoughtContext = null, selectedText = null, planning = null } = args;
  let { onReplyChunk = null } = args;

  // Vocalization tags ([sigh], [um], [laugh]…) are Resemble TTS markup —
  // voice turns keep them raw for TTS; text turns get them mapped to emoji
  // before they paint (stream chunks AND the final reply), so the feed never
  // shows the literal tags.
  let _vocMapper = null;
  if (source !== 'voice' && typeof onReplyChunk === 'function') {
    _vocMapper = createVocalizationMapper((t) => onReplyChunk(t));
    onReplyChunk = (t) => _vocMapper.push(t);
  }

  if (!text || !text.trim()) {
    return {
      text: 'I didn\'t catch that.',
      intent: 1,
      intentName: 'general_quick',
      metadata: { source: 'empty_input', latencyMs: 0 },
    };
  }

  // Turn facts BEFORE control lanes — guardian/rule checks read userText,
  // never rawText. Context blobs ([File:]/[Highlighted:]/[Context:]/[Thought:])
  // can carry embedded "if I go to…" phrasing that must not author rules or
  // answer a pending guardian ask (AGENTS.md convention). Markers are
  // language-agnostic so this is safe before translation.
  const preFacts = computeTurnFacts({ rawText: text, selectedText });
  const _userText = (preFacts.userText || '').trim();

  // ── Guardian command lane ─────────────────────────────────────────────────
  // `guardian …` commands are deterministic and bypass classify entirely — a
  // passphrase answer must never be re-blocked by the rule it answers. A stale
  // pending ask clears when a non-guardian prompt arrives.
  if (_pendingGuardian && !/^guardian\s+allow\b/i.test(_userText)) {
    _pendingGuardian = null;
  }
  if (/^guardian\s+/i.test(_userText)) {
    return _guardianCommand(_userText, args);
  }

  // ── Rule authoring lane — plan-confirmed ─────────────────────────────────
  // A pending draft is committed only on explicit "rule confirm" (+passphrase
  // when set); any other prompt abandons it, mirroring the pending-ask stash.
  if (_pendingRule && !/^(?:rule\s+)?(?:confirm|yes|no|cancel)\b/i.test(_userText)) {
    _pendingRule = null;
  }
  if (_pendingRule && /^(?:rule\s+)?(?:confirm|yes)\b/i.test(_userText)) {
    const stash = _pendingRule;
    const pw = _userText.replace(/^(?:rule\s+)?(?:confirm|yes)\s*/i, '');
    if (_rulesMod.hasPassphrase() && !stash.authed && !_rulesMod.verifyPassphrase(pw)) {
      return _guardianReply('Passphrase required — say: rule confirm <passphrase>');
    }
    _pendingRule = null;
    const r = _rulesMod.addRule(stash.rule);
    return _guardianReply(r.ok ? `Rule set: ${_describeRule(r.rule)}` : `Couldn't set the rule: ${r.error}`);
  }
  if (_pendingRule) { // no/cancel after the confirms above
    _pendingRule = null;
    return _guardianReply('Rule cancelled.');
  }
  // Conditional trigger phrasing — "if I go to X, send Y" authors a rule,
  // not a task. Anchored regexes generate candidates and fire the lane;
  // weaker markers get a semantic verdict before overriding classify
  // (AGENTS.md: lexical match overriding a lane needs confirmJudgment).
  if (_rulesMod && _isRulePhrase(_userText)) {
    return _authorRule(_userText);
  }
  if (_rulesMod && _RULE_WEAK_RE.test(_userText)) {
    const verdict = await _decision.confirmJudgment({
      site: 'rule-author',
      question: 'Is the user asking to create a persistent conditional rule (when X happens, do Y)?',
      state: _userText,
    });
    if (verdict === 'YES') return _authorRule(_userText);
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
  // Merge service history with local turns — task results fed back on
  // completion live in _conversationHistory and may never reach the service
  // (no API key in dev), but they carry the actual answers follow-ups need.
  const _localCtx = _formatContext();
  const context = sanitizeContext([convHistory, _localCtx].filter(Boolean).join('\n'));
  // Highlighted-context tags ("[Highlighted: …]") ride inside the prompt. Strip
  // them for intent classification/guessing — a code- or command-looking blob
  // would otherwise bias the intent toward handoff. They stay in englishText
  // so the answering nodes (and any handoff payload) still see the selection.
  // Exact-string removal via selectedText — a `]` inside the blob would
  // truncate a non-greedy tag regex (observed: captured log lines like "[0]").
  const _selLines = String(selectedText || '').split('\n').map(s => s.trim()).filter(s => s.length > 2);
  let classifyText = englishText;
  for (const chunk of _selLines) {
    classifyText = classifyText.split(chunk).join(' ');
  }
  classifyText = classifyText
    .replace(ATTACHMENT_TAG_RE, ' ')  // leftover wrappers are whitespace-only
    .replace(/\s{2,}/g, ' ')
    .trim() || englishText;
  // Turn facts — the single derivation every downstream matcher reads
  // (taskFacts pattern). Control/referent decisions use facts.userText —
  // blob-stripped — never the blob-inclusive englishText.
  const turnFacts = computeTurnFacts({ rawText: englishText, selectedText });
  // [File:]/[Folder:] chips are path POINTERS, not content — generalQuick can't
  // open them, so a selection made only of file refs isn't self-contained QA
  // context; the prompt needs the real classifier's guards (action veto,
  // deictic) and usually the stategraph's file tools. [Context:]/[Thought:]
  // and raw highlight lines DO carry text and still count.
  const hasSelectionContext = turnFacts.hasSelectionContext;
  // ── Selection fast lane ───────────────────────────────────────────────────
  // A [Highlighted:] blob carries its own referent — the prompt is self-contained
  // QA. Skip classify + the context-blind guards entirely; generalQuick's
  // 0-sentinel self-corrects to shouldHandoff when tools are genuinely needed.
  let intent, intentName, confidence, classifySource;
  let _openPlan = null, _resumePlanId = null;
  // Stale-pin escape — a UI pin on a finished plan must not keep trapping
  // new prompts in the lane ("planning mode not being handed off"). The pin
  // releases on run-start/cancel/exit markers, but a plan that reached a
  // terminal state without one can linger. An unresolvable planId is left
  // alone — it may be a fresh draft the pin is about to create.
  let _pinTerminal = false;
  let _releasedEmptyPin = false;
  let _escapedPin = false;
  if (planning && planning.active === true && planning.planId) {
    try {
      const _pinnedSess = planningNode.getPlanSession(planning.planId);
      const _st = String(_pinnedSess?.status || '').toLowerCase();
      _pinTerminal = !!_pinnedSess && ['done', 'failed', 'cancelled'].includes(_st);
      // Empty-draft escape — a pinned plan with ZERO tasks is mid-clarification
      // at best (and a routing flake at worst — observed: a missing-detail
      // misroute created an empty draft whose pin then swallowed every later
      // prompt into "the plan is still empty"). A clearly action-shaped new
      // command releases the pin; answer-shaped short replies stay bound.
      if (!_pinTerminal && _pinnedSess && _st === 'drafting'
          && (!Array.isArray(_pinnedSess.tasks) || _pinnedSess.tasks.length === 0)
          && !/\bplan\b/i.test(String(classifyText || ''))) {
        let _g = null;
        try { _g = intentGuesser.guess(classifyText, { hasSelectionContext }).guessedIntent; } catch (_) {}
        if (_g === 'command_automate' || _g === 'screen_analysis') {
          _pinTerminal = true;
          _releasedEmptyPin = true;
          logger.info('[Process] Releasing pin on empty draft — new action prompt', { planId: planning.planId, guess: _g });
          try { planningNode.releaseSession(routedSessionId); } catch (_) {}
          // Cancel the ghost draft so findOpenPlan/short-reply capture stop
          // treating it as awaiting input (session memory + plan file).
          try { _pinnedSess.status = 'cancelled'; } catch (_) {}
          try {
            if (_pinnedSess.filePath && fs.existsSync(_pinnedSess.filePath)) {
              const planFormat = require('../../shared/plan-format.cjs');
              fs.writeFileSync(_pinnedSess.filePath,
                planFormat.updateFrontmatterStatus(fs.readFileSync(_pinnedSess.filePath, 'utf8'), 'cancelled'));
            }
          } catch (_) {}
        }
      }
    } catch (_) { _pinTerminal = false; }
  }
  // New-topic pin escape — the pin exists to keep answers and short replies
  // bound to a plan's pending question, but a clearly action-shaped NEW task
  // with no plan vocabulary is new work the lane can't serve (observed: a
  // misrouted draft pinned the UI and every later prompt — scrolls, searches,
  // highlight questions — fell into the stale plan for ~17min). Lexical
  // shape alone doesn't justify leaving the lane, so a semantic verdict
  // gates the release (AGENTS.md).
  if (planning && planning.active === true && !_pinTerminal) {
    try {
      const _g = intentGuesser.guess(classifyText, { hasSelectionContext }).guessedIntent;
      const _newTaskShape = (GRAPH_ONLY_INTENTS.has(_g) || _g === 'web_search')
        && turnFacts.wordCount > 6
        && !turnFacts.confirmish && !turnFacts.runish
        && !turnFacts.exitish && !turnFacts.cancelish
        && !(turnFacts.planRef && turnFacts.planRef.meaningful)
        && !/\bplan\b/i.test(turnFacts.userText || classifyText);
      if (_newTaskShape) {
        const _psess = planning.planId ? planningNode.getPlanSession(planning.planId) : null;
        const _planDesc = _psess
          ? `Open plan: "${_psess.title || ''}" tasks: ${(Array.isArray(_psess.tasks) ? _psess.tasks : []).map(t => (t && (t.title || t.name)) || String(t)).join('; ').slice(0, 400)}`
          : 'Open plan: (none found)';
        const _v = await _decision.confirmJudgment({
          site: 'pin-escape',
          question: 'The user is in a plan-drafting lane. Is their message a NEW task unrelated to the open plan (it should leave the lane and run normally) rather than an answer, edit, or question ABOUT the plan?',
          state: `${_planDesc}\nUser message: ${classifyText}`,
        });
        if (_v === 'YES') {
          _pinTerminal = true;
          _escapedPin = true;
          try { planningNode.releaseSession(routedSessionId); } catch (_) {}
          logger.info('[Process] Pin escape — new-topic action prompt released from planning lane', { planId: planning.planId, guess: _g });
        }
      }
    } catch (_) { /* escape check fails open — pin stays */ }
  }
  if (planning && planning.active === true && !_pinTerminal) {
    // Planning mode pinned by the UI (toggle / continue-plan) — bypass the
    // classifier entirely so "yes", edits, and questions stay in the lane.
    intent = 6;
    intentName = 'planning';
    confidence = 1.0;
    classifySource = 'planning_pinned';
  } else if (hasSelectionContext) {
    // Action veto (same shape as classify.cjs's): a highlight answers questions
    // ABOUT text — it cannot run actions. "post this", "add these dates to my
    // calendar" still need the graph even with a selection riding along. The
    // guesser is a free synchronous regex pre-check, no LLM cost.
    const { guessedIntent: _selGuess } = intentGuesser.guess(classifyText, { hasSelectionContext });
    if (GRAPH_ONLY_INTENTS.has(_selGuess)) {
      logger.info('[Process] Selection action veto → handoff', { guessedIntent: _selGuess });
      intent = 0;
      intentName = 'handoff';
      confidence = 0.85;
      classifySource = 'selection_action_veto';
    } else {
      intent = 1;
      intentName = 'general_quick';
      confidence = 0.9;
      classifySource = 'selection_fastlane';
    }
  } else {
    // Open-plan fact for the classifier — deterministic resume guard + a
    // "paused plan exists" line in the classify prompt so continuation
    // phrasings route semantically, not just on regex hits.
    _openPlan = planningNode.findOpenPlan(routedSessionId);

    ({ intent, intentName, confidence, source: classifySource, resumePlanId: _resumePlanId } =
      await classify(classifyText, context, { hasSelectionContext, openPlan: _openPlan }));
  }

  // ── Bogus resume guard ─────────────────────────────────────────────────────
  // The classifier sees the open-plan fact and may "resume" it for a clearly
  // NEW-topic prompt — that merges unrelated tasks into the old plan (observed:
  // a Spotify setup prompt joining the reminders plan). A resume is only
  // honest for continuation-shaped text: an explicit plan reference, a resume
  // verb, or a short reply. A full new-task prompt starts a fresh plan.
  const _t = String(classifyText || '').trim();
  // 'resume' is a verb only with a plan/task object — "build me a new
  // resume" (the document) must not count as continuation-shaped.
  const _resumeish = /\b(?:the|that|this|same|it|my)\s+[\w .-]{0,30}?\s*plan\b|\bresume\s+(?:the\s+|my\s+|that\s+)?(?:plan|task|draft)\b|\b(?:continue|run|start|go\s+ahead|yes|ok|approve|confirm|cancel|exit)\b/i.test(_t)
    || _t.split(/\s+/).length <= 6;
  if (_resumePlanId && intent === 6 && !_resumeish) {
    logger.info('[Process] Dropping classifier resume — new-topic prompt', {
      planId: _resumePlanId, textPreview: _t.slice(0, 60),
    });
    _resumePlanId = null;
  }

  // ── Short reply while a plan awaits input → resume planning ────────────────
  // The UI pin normally keeps replies in the lane, but a bare answer
  // ("555-0134", "Messages") that loses the pin must not dispatch as a new
  // task. Only short, verb-free replies count — a fresh task prompt like
  // "text my wife" still routes on its own merits.
  if (!_resumePlanId && _openPlan && intent !== 6) {
    const _ansText = String(classifyText || '').trim();
    // Answer-shaped only — verb-free phrases, route-option labels, ordinals
    // answer a pending question; a command with an action verb + new target
    // ("goto john 1", "exodus 4 show on my screen") classifies on its own
    // merits. Only a plan bound to THIS session AND actually awaiting input
    // may capture short replies — a mid-run plan (pending tasks, no pending
    // question) must not swallow fresh commands like "pictures of Batman".
    if (shouldCaptureShortReply(_openPlan, _ansText)) {
      intent = 6;
      intentName = 'planning';
      confidence = 0.9;
      classifySource = 'open_plan_reply';
      _resumePlanId = _openPlan.planId;
      logger.info('[Process] Open plan awaiting input — resuming for short reply', {
        planId: _openPlan.planId, reply: _ansText.slice(0, 40),
      });
    }
  }

  // ── Guardian rules — entry guard ──────────────────────────────────────────
  // Evaluated AFTER classification settles and BEFORE any lane dispatches —
  // covers web-search, general_quick, planning, and handoff uniformly, so a
  // blocked prompt can't reach a lane that would serve it. Matching is
  // deterministic (regex/host/eq); `when.category` is the one bounded judgment
  // — the rule's own category vs the prompt.
  if (_rulesMod) {
    try {
      const _guardCtx = { prompt: classifyText || englishText, intent: intentName };
      const _bypass = args._guardianBypass || null;
      const _applyGuard = (rule) => {
        const _act = rule.then?.action || 'block';
        logger.warn('[Process] guardian rule matched at entry', { ruleId: rule.id, action: _act });
        if (_act === 'ask' && _rulesMod.hasPassphrase()) {
          _pendingGuardian = { ruleId: rule.id, args };
          return _guardianReply(
            `That request is restricted by guardian rule "${rule.id}". A passphrase holder can allow it: guardian allow <passphrase>`,
            { ruleId: rule.id, guardianAction: 'ask' }
          );
        }
        return _guardianReply(
          `I can't do that — it's blocked by guardian rule "${rule.id}"${rule.then?.reason ? ` (${rule.then.reason})` : ''}.`,
          { ruleId: rule.id, guardianAction: 'block' }
        );
      };
      const _hits = _rulesMod.evaluate(_guardCtx, 'entry').filter(r => r.id !== _bypass);
      const _guardHit = _hits.find(r => ['block', 'ask'].includes(r?.then?.action));
      if (_guardHit) return _applyGuard(_guardHit);
      // Category rules — `when.category` never matches deterministically; the
      // rule's own category list gets one bounded verdict per prompt.
      for (const _r of _rulesMod.loadRules()) {
        if (!_r.when?.category || _r.id === _bypass || _hits.includes(_r)) continue;
        const _seam = _r.seam || 'any';
        if (_seam !== 'any' && _seam !== 'entry') continue;
        const { category: _cat, ..._rest } = _r.when;
        if (Object.keys(_rest).length && !_rulesMod.whenMatches(_rest, _guardCtx)) continue;
        const _verdict = await askEarly([{
          role: 'user',
          content: `A request says: "${String(classifyText || englishText).slice(0, 400)}". Does it ask for ${_cat} content? Answer yes or no.`,
        }]).catch(() => null);
        const _yesText = typeof _verdict === 'string' ? _verdict : (_verdict?.text || _verdict?.content || '');
        if (/\byes\b/i.test(_yesText)) {
          const _res = _applyGuard({ ..._r, then: { action: 'block', ...(_r.then || {}) } });
          if (_res) return _res;
        }
      }
    } catch (e) {
      logger.warn('[Process] guardian entry eval failed', { error: e.message });
    }
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
  if (intent !== 0 && intent !== 6 && !hasSelectionContext && (LIVE_PAGE_REF_RE.test(classifyText) || /\bthe\s+screen\b/i.test(classifyText))) {
    logger.info('[Process] live-page referent — forcing handoff', { was: intentName });
    intent = 0;
    intentName = 'handoff';
  }

  // ── Artifact-referent resolution ─────────────────────────────────────────
  // "delete that event I just set" mutates the artifact a just-completed task
  // created. Resolve BEFORE RouteDecision so classifyTask sees the concrete
  // referent (title + server-side id) instead of a bare pronoun, and carry
  // the creating agent's identity into the capability gate below — the
  // creator owns the artifact's identity (event ids, file paths).
  let _resolvedText = englishText;
  let _artifactRef = null;
  if (intent === 0) {
    try {
      _artifactRef = artifactReferent.resolve(classifyText, taskJournal.getRecentTasks(25));
      if (_artifactRef) {
        _resolvedText = `${englishText} (Resolved referent — ${_artifactRef.referentDesc})`;
        logger.info('[Process] Artifact referent resolved', {
          agentId: _artifactRef.agentId, sourceTask: _artifactRef.taskId,
        });
      }
    } catch (e) { logger.warn('[Process] artifactReferent failed', { error: e.message }); }
  }

  // ── RouteDecision — the single classification envelope ─────────────────────
  // For handoff-bound prompts, classifyTask (the same schema the execution
  // graph consumes) runs ONCE here at ingress; the decision rides the handoff
  // into state._routeDecision so resolveReferencesV2 consumes it instead of
  // re-classifying — the two layers can no longer disagree about what the
  // prompt is. When the envelope says the prompt isn't a task at all (a
  // question, a memory op), demote to the right lane rather than dispatch a
  // doomed task — this is the "what's the absolute path" → WebSearch-about-
  // "user" bug class. Cheap triage above still covers non-task prompts; this
  // call only ever runs for prompts already bound for the graph, so latency
  // is unchanged (the same call simply moves earlier in the run).
  let _routeDecision = null;
  if (intent === 0) {
    _routeDecision = await classifyRoute(_resolvedText, convHistory);
    const _demoteTo = (_routeDecision && _routeDecision.lane !== 'handoff')
      ? LANE_BY_INTENT[_routeDecision.lane] : undefined;
    if (_demoteTo !== undefined) {
      logger.info('[Process] RouteDecision demotes handoff → ' + _routeDecision.lane, {
        taskType: _routeDecision.taskType, suggestedIntent: _routeDecision.suggestedIntent || null,
      });
      intent = _demoteTo;
      intentName = _routeDecision.lane;
      classifySource = 'route_decision';
    }
  }

  // ── Capability-gap guard ──────────────────────────────────────────────────
  // Before handing a prompt to the stategraph, consult the capability index:
  // a ready registered agent gets pinned (deterministic resolution, skips the
  // LLM picker); a goal whose capabilities all need setup — or a setup-flavored
  // prompt with no match — routes to the planning lane so the user clarifies
  // and approves setup BEFORE anything executes. A RouteDecision whose
  // taskType names no service short-circuits the gate on structure — the
  // regex fast-paths above only remain as latency savers.
  let _capPin = null;
  let _capReason = null;
  let _capHints = null;
  let _capGateReason = null;
  let _capNeedsInfo = null;
  let _capScreenCtx = null;
  let _capRecommended = null;
  if (intent === 0) {
    const { guessedIntent: _gateGuess } = intentGuesser.guess(classifyText, { hasSelectionContext });
    const gate = (_GATE_SKIP_INTENTS.has(_gateGuess) || canSkipCapabilityGate(_routeDecision))
      ? null
      : await _capabilityGate(classifyText, {
        hasFileRef: /\[File:|\[Folder:/i.test(englishText),
      });
    // A resolved artifact referent suppresses the capability-gap reroute —
    // the delete/mutation target is already concrete (journal pin below);
    // planning has nothing left to clarify.
    if (gate?.planning && !_artifactRef) {
      logger.info('[Process] capability-gap → planning lane', { reason: gate.planning, hints: (gate.hints || []).length });
      intent = 6; intentName = 'planning'; confidence = 0.9;
      classifySource = 'capability_gap';
      _capHints = gate.hints || null;
      _capGateReason = gate.planning;
      _capNeedsInfo = gate.needsInfo || null;
      _capScreenCtx = gate.screenCtx || null;
      _capRecommended = gate.recommended || null;
    } else {
      if (gate?.pin) {
        logger.info('[Process] capability pin', { agentId: gate.pin, reason: gate.reason || '' });
        _capPin = gate.pin;
        _capReason = gate.reason || null;
      }
      // No explicit pin from the gate — the journal's creating agent claims
      // the artifact ("delete that event" → the nylas.agent that created it).
      if (!_capPin && _artifactRef) {
        _capPin = _artifactRef.agentId;
        _capReason = `artifact-referent:${_artifactRef.taskId}`;
        logger.info('[Process] artifact-referent pin', { agentId: _capPin, sourceTask: _artifactRef.taskId });
      }
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
  if (turnFacts.logMention) {
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
  if (!result && (intent === 0 || intent === 1 || intent === 3) && /\bplan\b|none of these/i.test(turnFacts.userText)) {
    try {
      const sysMap = require('../../shared/system-map.cjs');
      const s = turnFacts.userText;
      if (/^none of these\b|\bstart (?:a )?(?:new|fresh) plan\b/i.test(s)) {
        logger.info('[Server] Fresh-plan sentinel → planning lane');
        intent = 6;
        intentName = 'planning';
      } else if (turnFacts.planRef && turnFacts.planRef.meaningful) {
        // findPlans fuzzes on ANY token overlap ("my current" bound a "current
        // price" plan on one word) — require a real score before re-routing.
        const hits = sysMap.findPlans(turnFacts.planRef.token).filter(h => (h.score || 0) >= 6);
        if (hits.length) {
          // Question-shaped informational hits can still be "asking about the
          // word" — one semantic verdict before hijacking the lane.
          let _referent = !turnFacts.planRef.informational || !turnFacts.isQuestion;
          if (!_referent) {
            _referent = (await _decision.confirmJudgment({
              site: 'plan-referent',
              question: 'Is this message referring to an actual saved plan, or does the word "plan" just appear inside a question/quoted text?',
              state: String(s || '').slice(0, 800),
            })) !== 'NO'; // model-down keeps today's reroute behavior
          }
          const to = turnFacts.planRef.informational ? 3 : 6;
          if (_referent && to !== intent) {
            logger.info('[Server] Plan referent re-route', { ref: turnFacts.planRef.token, from: intent, to, informational: turnFacts.planRef.informational });
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
        englishPrompt: _resolvedText,
        source,
        originalPrompt: originalText,
        detectedLanguage,
        guessedIntent: _gi0,
        sessionId: routedSessionId,
        thoughtContext,
        agentId: _capPin || undefined,
        capabilityReason: _capReason || undefined,
        routeDecision: serializeDecision(_routeDecision),
        // Session turns fetched at classify — the dispatch-time compile
        // resolves follow-ups ("next chapter 7") against them.
        conversationContext: convHistory || null,
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
      result = await generalQuick(englishText, systemPrompt, context, { hasSelectionContext, originalPrompt: originalText, detectedLanguage, routeDecision: _routeDecision, onReplyChunk });
      // If generalQuick couldn't answer (LLM failed), handoff to main state graph
      if (result.metadata.shouldHandoff) {
        const { guessedIntent: _gi1 } = intentGuesser.guess(classifyText, { hasSelectionContext });
        const handoffResult = await handoff({
          englishPrompt: _resolvedText,
          source,
          originalPrompt: originalText,
          detectedLanguage,
          guessedIntent: _gi1,
          sessionId: routedSessionId,
          routeDecision: serializeDecision(_routeDecision),
          conversationContext: convHistory || null,
        });
        const { phrase: basePhrase, guessedIntent } = await _generateHandoffPhrase(englishText, detectedLanguage, context, _gi1);
        // Preserve the lane's task-specific ack (routing sentences stripped) —
        // "Understood — I'll add placeholders …" beats a generic phrase and is
        // truthful now that the dispatch below is real.
        const head = result.metadata?.handoffAck || basePhrase;
        const handoffText = handoffResult.parked
          ? `${head} I'll start on that as soon as the current task finishes.`
          : head;
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

    case 8: { // web_search — express executor (post-classify, single authority)
      // The classifier assigned web_search; the express lane just EXECUTES —
      // ~1.5s SERP direct to :3002 with the same overlay card contract.
      // Abstain (no renderable results / service down) → real handoff so the
      // stategraph's full web_search lane answers instead.
      try { if (typeof onReplyChunk === 'function') onReplyChunk('\x00SEARCHING\x00google-serp'); } catch (_) {}
      const _er = await webSearchExpress.execute({
        englishText, originalText, detectedLanguage, context, onReplyChunk,
        routeDecision: _routeDecision,
      });
      if (!_er) {
        logger.info('[Process] Search express abstained → handoff');
        const { guessedIntent: _gi8 } = intentGuesser.guess(classifyText, { hasSelectionContext });
        const handoffResult = await handoff({
          englishPrompt: _resolvedText,
          source,
          originalPrompt: originalText,
          detectedLanguage,
          guessedIntent: _gi8,
          sessionId: routedSessionId,
          routeDecision: serializeDecision(_routeDecision),
          conversationContext: convHistory || null,
        });
        const { phrase: basePhrase, guessedIntent } = await _generateHandoffPhrase(englishText, detectedLanguage, context, _gi8);
        const handoffText = handoffResult.parked
          ? `${basePhrase} I'll start on that as soon as the current task finishes.`
          : basePhrase;
        result = {
          text: handoffText,
          fullText: handoffText,
          metadata: {
            source: 'web_search_handoff',
            intent: 0,
            taskId: handoffResult.taskId,
            agentId: handoffResult.agentId,
            parked: handoffResult.parked,
            speakable: false,
            guessedIntent,
          },
        };
      } else {
        logger.info('[Process] Search express answered', {
          items: (_er.metadata?.items || []).length,
          sources: (_er.metadata?.sources || []).length,
        });
        result = {
          text: _er.fullText || _er.text,
          fullText: _er.fullText || _er.text,
          metadata: { ..._er.metadata, intent: 8, intentName: 'web_search', source: 'search_express' },
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
            || (_openPlan && _resumeish && classifySource !== 'planning_phrase_guard' ? _openPlan.planId : null),
          name: planning?.name || null,
          startedExplicit: planning?.startedExplicit === true || classifySource === 'planning_pinned',
          // Capability-gap turns are NEW capability requests — they must not
          // inherit (and mutate) the session's bound finalized plan. planning.cjs
          // honors this by only reusing a bound session that's still drafting.
          // Capability-gap turns are NEW capability requests — same for any
          // non-resume-shaped prompt. Without this the _activePlanId fallback
          // in planning.cjs merges unrelated tasks into the last open plan.
          preferFresh: classifySource === 'capability_gap' || (!_resumeish && !planning?.planId),
          forceNewPlan: !_resumeish && !planning?.planId && classifySource !== 'planning_pinned',
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
        // 'capability_options' — planning shows the verified options list
        // first; 'needsInfo' means a detail (e.g. recipient) must be asked
        // after the user picks a route.
        gateReason: _capGateReason,
        needsInfo: _capNeedsInfo,
        // The selector's own pick — planning marks it RECOMMENDED on the
        // options card instead of defaulting to the first ready option.
        recommended: _capRecommended,
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
      // Plan lifecycle → thought engine — draft-ready / running / blocked
      // states feed continue_plan thoughts so the Brain can nudge a stalled
      // plan without the user re-prompting.
      if (result?.metadata?.planId) {
        const _pmd = result.metadata;
        _notifyThoughtEngine('plan', {
          planId: _pmd.planId, taskNum: null,
          status: _pmd.planStatus || (_pmd.taskCount ? 'draft' : 'empty'),
          prompt: String(_pmd.planTitle || englishText || '').slice(0, 200),
          taskCount: _pmd.taskCount || 0,
        });
      }
      break;
    }

    case 7: { // screen — direct GhostLayer display lane (no stategraph run)
      result = await screenNode.execute({
        englishText,
        conversationContext: convHistory,
        sessionId: routedSessionId,
      });
      // The lane couldn't resolve a payload from context (generative chart/
      // scene asks, fetch-then-display) → real handoff so the stategraph's
      // screenOutput node generates it.
      if (result?.metadata?.shouldHandoff) {
        const { guessedIntent: _gi7 } = intentGuesser.guess(classifyText, { hasSelectionContext });
        const handoffResult = await handoff({
          englishPrompt: _resolvedText,
          source,
          originalPrompt: originalText,
          detectedLanguage,
          guessedIntent: _gi7,
          sessionId: routedSessionId,
          routeDecision: serializeDecision(_routeDecision),
          conversationContext: convHistory || null,
        });
        const { phrase: basePhrase, guessedIntent } = await _generateHandoffPhrase(englishText, detectedLanguage, context, _gi7);
        const handoffText = handoffResult.parked
          ? `${basePhrase} I'll start on that as soon as the current task finishes.`
          : basePhrase;
        result = {
          text: handoffText,
          fullText: handoffText,
          metadata: {
            source: 'screen_handoff',
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

    case 5: { // memory_store
      result = await memoryStore(englishText, systemPrompt, context);
      // If memory_store failed, handoff to main state graph
      if (result.metadata.shouldHandoff) {
        const { guessedIntent: _gi5 } = intentGuesser.guess(classifyText, { hasSelectionContext });
        const handoffResult = await handoff({
          englishPrompt: _resolvedText,
          source,
          originalPrompt: originalText,
          detectedLanguage,
          guessedIntent: _gi5,
          sessionId: routedSessionId,
          routeDecision: serializeDecision(_routeDecision),
          conversationContext: convHistory || null,
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
      result = await generalQuick(englishText, systemPrompt, context, { hasSelectionContext, originalPrompt: originalText, detectedLanguage, routeDecision: _routeDecision, onReplyChunk });
    }
  }

  // Empty-draft/new-topic pin release — the prompt escaped a stale planning
  // pin; tell main.js to unpin the UI (_planningMode → _exitPlanningLane) so
  // the NEXT message classifies normally instead of re-entering planning_pinned.
  if ((_releasedEmptyPin || _escapedPin) && result && result.metadata) {
    result.metadata.exitPlanning = true;
  }

  // ── Routing-promise / unclaimed-sentinel invariant ─────────────────────────
  // A quick lane's reply must be an answer — never prose that PROMISES routing
  // ("Let me route that to ThinkDrop now") while nothing dispatches, and never
  // a handoff phrase whose shouldHandoff flag no case consumed (the default:
  // bucket used to display the phrase and do nothing). Detect either and ACT
  // on it — convert to a real handoff so the words are backed by a task.
  // intent 0 already dispatched; intent 6 has its own marker system.
  if (result && intent !== 0 && intent !== 6 && !result.metadata?.taskId
      && (result.metadata?.shouldHandoff || isRoutingPromise(result.fullText || result.text))) {
    logger.info('[Process] Quick-lane routing promise/unclaimed sentinel → handoff', {
      was: intentName, source: result.metadata?.source || null,
    });
    const { guessedIntent: _giQ } = intentGuesser.guess(classifyText, { hasSelectionContext });
    const handoffResult = await handoff({
      englishPrompt: _resolvedText,
      source,
      originalPrompt: originalText,
      detectedLanguage,
      guessedIntent: _giQ,
      sessionId: routedSessionId,
      thoughtContext,
      routeDecision: serializeDecision(_routeDecision),
      conversationContext: convHistory || null,
    });
    const { phrase: basePhrase, guessedIntent } = await _generateHandoffPhrase(englishText, detectedLanguage, context, _giQ);
    // Keep the lane's task-specific ack minus the routing sentences when one
    // exists — it's true now that the dispatch is real.
    const head = result.metadata?.handoffAck
      || stripRoutingPromises(result.fullText || result.text)
      || basePhrase;
    const handoffText = handoffResult.parked
      ? `${head} I'll start on that as soon as the current task finishes.`
      : head;
    result = {
      text: handoffText,
      fullText: handoffText,
      metadata: {
        ...result.metadata,
        source: `${result.metadata?.source || intentName}_routing_handoff`,
        intent: 0,
        taskId: handoffResult.taskId,
        agentId: handoffResult.agentId,
        parked: handoffResult.parked,
        speakable: false,
        guessedIntent,
      },
    };
  }

  // ── Step 5: Translate response back to user's language (if non-English) ──────
  // Use fullText (the complete answer) not text (the first-sentence preview) —
  // display, translate-back, and conversation history all need the full reply.
  let finalText = result.fullText || result.text;
  if (source !== 'voice') finalText = replaceVocalizationTags(finalText);
  // A localized SERP overview (or a same-language LLM reply) is already in the
  // user's language — a translate-back call would waste an LLM round-trip
  // echoing zh text through an "en→zh" prompt. Script-detectable languages
  // (zh/ja/ko/ar/ru/hi) only; latin languages fall through and translate.
  const _scriptLang = require('./translate.cjs').detectScriptLanguage(finalText || '');
  const _alreadyLocalized = _scriptLang && _scriptLang === detectedLanguage;
  if (wasTranslated && detectedLanguage !== 'en' && finalText && finalText.trim() && !_alreadyLocalized) {
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
  if (intent === 1 || intent === 5 || intent === 6 || intent === 7 || intent === 8) {
    _logConversationTurn(englishText, finalText, intentName, routedSessionId, result?.metadata);
  }

  const latencyMs = Date.now() - startTime;
  logger.info('[Process] Complete', {
    intent, intentName, latencyMs,
    wasTranslated, detectedLanguage,
  });

  // Release any '['-run the stream mapper is still holding (a partial tag at
  // end-of-stream paints literally rather than disappearing).
  if (_vocMapper) _vocMapper.flush();

  return {
    text: finalText,
    fullText: source !== 'voice' ? replaceVocalizationTags(result.fullText) : result.fullText,
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
      // Heartbeat while the turn processes — planning tool rounds emit no
      // reply bytes, and an idle socket trips main's 90s inactivity timeout
      // into a duplicate serial-lane run while comms is still working.
      // Capped at 20 pings (~5min): a truly hung turn goes quiet again so
      // main's timeout can still fire as the escape hatch.
      let _pings = 0;
      const heartbeat = setInterval(() => {
        if (++_pings > 20) { clearInterval(heartbeat); return; }
        emit({ type: 'ping' });
      }, 15000);
      res.on('close', () => clearInterval(heartbeat));
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
      clearInterval(heartbeat);
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
        // Plan-runner dispatches get their own source so run cards don't get
        // bucketed with brain "Thoughts" in the feed — everything else on
        // this endpoint is a proactive thought.
        source: body.planTask === true ? 'plan' : 'proactive',
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
        // Upstream task results — seeded into the child run so cross-task
        // {{synthesisAnswer}}/prior-output refs resolve to real data.
        priorResults: Array.isArray(body.priorResults) ? body.priorResults : null,
        // Context refs — plan frontmatter refs + the plan file itself +
        // per-task refs, carried through to task.agent.
        refs: Array.isArray(body.refs) ? body.refs : null,
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
    // Plan lifecycle → thought engine: a plan-bound task reaching a terminal
    // or blocked status is a signal the Brain may act on (continue_plan).
    {
      const _pt = taskJournal.getTask(body.taskId);
      if (_pt?.planMeta?.planId) {
        _notifyThoughtEngine('plan', {
          planId: _pt.planMeta.planId, taskNum: _pt.planMeta.planTaskNum || null,
          status: body.status || 'done',
          prompt: String(_pt.prompt || '').slice(0, 200),
        });
      }
    }
    // ── Loop-back escalations — a task decided mid-run it needs planning ──
    // 'needs_plan': runtime escalated — plan-bound tasks revise the SAME plan
    //   (the run holds 'revising' and resumes); bare tasks draft a fresh one.
    // 'plan_update': a task.agent inside a plan run pushed a discovery back —
    //   revise the SAME plan file with the proposal, then auto-resume.
    if (body.status === 'needs_plan' || body.status === 'plan_update') {
      _handleLoopBack(body)
        .catch(err => logger.warn('[Server] Loop-back planning failed', { error: err?.message }));
    }
    // Feed the completed task's RESULT back into conversation history. The
    // reply the user saw was only a handoff phrase ("one sec while I search"),
    // so follow-ups like "how long in office" have no real answer to reason
    // over — the quick lane then hallucinates from stale knowledge instead.
    if (body.status === 'done' && body.result) {
      const t = taskJournal.getTask(body.taskId);
      const tPrompt = t?.prompt || null;
      if (tPrompt) {
        const resultText = String(body.result).slice(0, 800);
        _addTurn(tPrompt, resultText, t.intent || 'handoff');
        _logConversationTurn(tPrompt, resultText, t.intent || 'handoff', body.sessionId || t.sessionId || null);
      }
    }
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
    // Heartbeat the run lane (user-facing tasks all hold __run__) and the
    // service-agent lock when the task carries one — either may be the key
    // this task is parked under / holding.
    agentLock.heartbeat(agentLock.RUN_LOCK_KEY, body.taskId);
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

  // ── Planning-mode exit (from main.js) — unbind the session→plan mapping so
  // a follow-up prompt can't silently re-enter the lane on the old plan.
  if (req.url === '/plan.exit' && req.method === 'POST') {
    const body = await _readBody(req);
    planningNode.releaseSession(body.sessionId || null);
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
// COMMS_NO_LISTEN lets tests require processMessage without binding :3015 —
// the real service always listens; only tests set the flag.
if (process.env.COMMS_NO_LISTEN !== '1') {
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
}

module.exports = { server, processMessage, _isRulePhrase, _RULE_WEAK_RE, _authorRule, _handleLoopBack, _loopBackAttempts };
