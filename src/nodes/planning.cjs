'use strict';

/**
 * planning.cjs — Intent 6: conversational plan-drafting lane
 *
 * Owns the plan-conversation phase of Planning Mode. The user talks back and
 * forth (questions, clarifications, research) while a plan.md draft is built
 * under ~/.thinkdrop/plans/. This lane deliberately does NOT run the
 * stategraph, journal tasks, or command automation — it is a plain LLM loop
 * with two read-only HTTP tools (user-memory + web-search) plus file writes.
 *
 * Execution of a finished plan is a different concern: main.js planRunner
 * parses the Task sections and dispatches each through the normal handoff
 * path (journal → agentLock → handoffRunner → stategraph).
 *
 * LLM protocol (taught via PLANNING_DIRECTIVE):
 *   <tool>memory.search("query")</tool>   → user-memory :3001 /memory.search
 *   <tool>web.search("query")</tool>      → web-search  :3002 /web.search
 *   <tool_results>…</tool_results>        → injected back into the next turn
 *   <plan_update>## Task N — … </plan_update> → replaces the Task sections
 *   <plan_name>dot.syntax.name</plan_name>    → sets frontmatter name
 *   <plan_status>ready</plan_status>          → marks the plan runnable
 *   anything else                          → spoken/shown reply text
 */

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const logger = require('../logger.cjs');
const { ask, askEarly, askStream } = require('../llm-providers.cjs');
const planFormat = require('../../../shared/plan-format.cjs');
const { canonicalAgent } = require('../../../shared/agent-canonical.cjs');
const skillIndex = require('../../../shared/skill-index.cjs');
const skillContracts = require('../../../shared/skill-contracts.cjs');
const serviceMap = require('../../../shared/service-map.cjs');
const sysMap = require('../../../shared/system-map.cjs');
const capIndex = require('../../../shared/capability-index.cjs');
const { PLAN_CONFIRM_RE, PLAN_RUN_RE, PLAN_RUN_NEG_RE } = require('../../../shared/plan-check-phrases.cjs');
const { computeTurnFacts } = require('../../../shared/turn-facts.cjs');
const { extractContextRefs, mergeRefs } = require('../../../shared/context-refs.cjs');
const decision = require('../decision.cjs');

// Tolerant LLM-JSON parse for step generation — repairs unfenced replies,
// dangling commas, unterminated strings and truncated arrays (the last step
// may be partial; callers drop entries that fail the skill check). Same
// cross-module require pattern route-decision.cjs uses for classifyTask.
let _parseLlmJson = null;
try {
  _parseLlmJson = require(path.resolve(__dirname, '../../../stategraph-module/src/utils/parseLlmJson.js')).parseLlmJson;
} catch (_) {}

// ── Paths / services ─────────────────────────────────────────────────────────

function _plansDir() {
  return process.env.THINKDROP_PLANS_DIR
    || path.join(os.homedir(), '.thinkdrop', 'plans');
}

const MEMORY_PORT = parseInt(process.env.MEMORY_SERVICE_PORT || '3001', 10);
const WEB_SEARCH_PORT = parseInt(process.env.WEB_SEARCH_PORT || '3002', 10);
const MAIN_PORT = parseInt(process.env.THINKDROP_MAIN_PORT || '3010', 10);
const MCP_API_KEY = process.env.MCP_USER_MEMORY_API_KEY || process.env.MCP_MEMORY_API_KEY || process.env.MCP_API_KEY || '';
const WS_API_KEY = process.env.MCP_WEB_SEARCH_API_KEY || process.env.MCP_WEBSEARCH_API_KEY || process.env.MCP_API_KEY || '';
if (!WS_API_KEY) {
  // web.search tool calls will 401 without this — surface it once instead of
  // letting the LLM narrate "blocked by authorization" with no root cause.
  logger.warn('[Planning] MCP_WEB_SEARCH_API_KEY not set — web.search tool calls will be rejected (401)');
}
const { needsAmbientCtx, screenContext, memoryCall } = require('../screen-context.cjs');

// ── Plan session state ────────────────────────────────────────────────────────
// In-memory index of plan drafting sessions. The plan.md file is the source of
// truth for content; this map only holds the conversational state (history,
// notes) that doesn't belong in the file. Rebuilt lazily from disk on
// continue-planning requests.

/** @type {Map<string, {planId:string, filePath:string, title:string, description:string, tasks:Array, risks:string[], sessionId:string|null, history:Array}>} */
const _planSessions = new Map();
// conversation sessionId → planId — so a follow-up prompt on the same
// conversation continues the plan without the UI passing planId explicitly.
const _sessionToPlan = new Map();
let _activePlanId = null; // most recently touched plan — UI "continue" fallback

function _newPlanId() {
  return `plan_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

function _planFileName(planId) {
  return `${planId}.md`;
}

function _getOrCreateSession({ planId, sessionId, originalPrompt, conversationContext, refs }) {
  if (planId && _planSessions.has(planId)) return _planSessions.get(planId);

  // Continue from disk when the UI names a plan we haven't seen this process.
  if (planId) {
    const loaded = _loadPlanFromDisk(planId);
    if (loaded) return loaded;
  }

  const id = planId || _newPlanId();
  const filePath = path.join(_plansDir(), _planFileName(id));
  // Fragmentary entry prompts ("school and all 46") make bad titles — prefer
  // the last substantive user turn from the conversation seed.
  const seedUser = (conversationContext || '')
    .split('\n').filter(l => l.startsWith('User:')).pop();
  const titleSource =
    (String(originalPrompt || '').split(/\s+/).filter(Boolean).length < 6 && seedUser)
      ? seedUser.replace(/^User:\s*/, '')
      : originalPrompt;
  const title = _deriveTitle(titleSource);
  const sess = {
    planId: id,
    filePath,
    title,
    description: '',
    tasks: [],
    risks: [],
    sessionId: sessionId || null,
    originalPrompt: originalPrompt || '',
    // Planning often starts mid-conversation ("…and all 46") — the routed
    // session's recent turns give the LLM the context the fragment lacks.
    contextSeed: conversationContext || null,
    history: [],        // [{role, content}]
    status: 'drafting',
    name: null,
    // Context refs carried downstream to every task dispatch — the .md's
    // frontmatter is the durable carrier so a restart re-reads them.
    refs: Array.isArray(refs) && refs.length
      ? refs
      : extractContextRefs(`${originalPrompt || ''}\n${conversationContext || ''}`),
  };
  _planSessions.set(id, sess);
  if (sessionId) _sessionToPlan.set(sessionId, id);
  _activePlanId = id;
  // Write the skeleton immediately so the Plans tab shows the draft the
  // moment planning mode opens — before the first LLM turn finishes.
  _writePlanFile(sess);
  try { sess._diskMtime = fs.statSync(filePath).mtimeMs; } catch (_) {}
  return sess;
}

function _loadPlanFromDisk(planId) {
  try {
    const filePath = path.join(_plansDir(), _planFileName(planId));
    if (!fs.existsSync(filePath)) return null;
    const content = fs.readFileSync(filePath, 'utf8');
    const fm = planFormat.parseFrontmatter(content) || {};
    const titleMatch = content.match(/^# Plan:\s*(.+)$/m);
    const tasks = planFormat.parseTasks(content);
    const risks = _parseRisks(content);
    const sess = {
      planId,
      filePath,
      title: titleMatch ? titleMatch[1].trim() : (fm.name || planId),
      description: _parseDescription(content),
      tasks,
      risks,
      sessionId: fm.plan_session_id || null,
      originalPrompt: fm.original_prompt || '',
      history: [],
      status: fm.status || 'drafting',
      name: fm.name || null,
      refs: planFormat.parseRefs(content),
    };
    _planSessions.set(planId, sess);
    if (sess.sessionId) _sessionToPlan.set(sess.sessionId, planId);
    _activePlanId = planId;
    try { sess._diskMtime = fs.statSync(filePath).mtimeMs; } catch (_) {}
    return sess;
  } catch (err) {
    logger.warn('[Planning] Failed to load plan from disk', { planId, error: err.message });
    return null;
  }
}

/**
 * Re-read the plan file when it changed on disk since the session last saw
 * it — planRunner writes task statuses mid-run, /plan.status heals orphaned
 * markers, the user edits the file, and background stepgen streams steps in.
 * Rendering CURRENT PLAN STATE from the session snapshot let the LLM narrate
 * stale "running" statuses after the run died; this makes each turn see the
 * file as it actually is.
 */
function _refreshSessionFromDisk(sess) {
  try {
    const stat = fs.statSync(sess.filePath);
    if (sess._diskMtime && stat.mtimeMs <= sess._diskMtime) return;
    const content = fs.readFileSync(sess.filePath, 'utf8');
    const fm = planFormat.parseFrontmatter(content) || {};
    const fresh = planFormat.parseTasks(content);
    // Preserve in-memory-only bookkeeping (stepgen dedup state) across the
    // refresh — steps/stepsStatus themselves parse back from the file.
    const prev = new Map((sess.tasks || []).map(t => [t.num, t]));
    for (const t of fresh) {
      const p = prev.get(t.num);
      if (p && p.prompt === t.prompt) {
        if (p._stepsHash != null) t._stepsHash = p._stepsHash;
        if (p._normalized) t._normalized = p._normalized;
        if (p._failedHash != null) t._failedHash = p._failedHash;
      } else if (p && String(t.stepsStatus || '').toLowerCase() === 'failed') {
        // Prompt edited on disk since the failure — a stale 'failed' would
        // suppress regeneration for a prompt that was never attempted.
        t.stepsStatus = null;
      }
    }
    sess.tasks = fresh;
    sess.risks = _parseRisks(content);
    sess.refs = planFormat.parseRefs(content);
    if (fm.status) sess.status = fm.status;
    if (fm.name) sess.name = fm.name;
    sess._diskMtime = stat.mtimeMs;
  } catch (_) {}
}

function _parseRisks(content) {
  const m = String(content).match(/## Risks\n([\s\S]*?)(?=## |$)/);
  if (!m) return [];
  return m[1].split('\n').map(l => l.replace(/^\s*-\s*/, '').trim()).filter(Boolean);
}

function _parseDescription(content) {
  const m = String(content).match(/^# Plan:[^\n]*\n+([\s\S]*?)(?=\n## )/m);
  return m ? m[1].trim() : '';
}

function _deriveTitle(prompt) {
  const words = String(prompt || '').replace(/[^\w\s'-]/g, ' ').split(/\s+/).filter(Boolean);
  const t = words.slice(0, 7).join(' ');
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : 'Untitled plan';
}

// ── Plan file write ───────────────────────────────────────────────────────────

function _writePlanFile(sess) {
  try {
    const dir = _plansDir();
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    let content = planFormat.newPlanContent({
      id: sess.planId,
      title: sess.title,
      description: sess.description,
      originalPrompt: sess.originalPrompt,
      sessionId: sess.sessionId,
      tasks: sess.tasks,
      refs: sess.refs,
    });
    if (sess.name) content = planFormat.setFrontmatterField(content, 'name', sess.name);
    if (sess.status && sess.status !== 'drafting') {
      content = planFormat.updateFrontmatterStatus(content, sess.status);
    }
    if (sess.risks && sess.risks.length) {
      content = content.replace(/## Risks\n\s*$/m, '## Risks\n' + sess.risks.map(r => `- ${r}`).join('\n') + '\n');
    }
    fs.writeFileSync(sess.filePath, content, 'utf8');
    try { sess._diskMtime = fs.statSync(sess.filePath).mtimeMs; } catch (_) {}
    return true;
  } catch (err) {
    logger.error('[Planning] Plan write failed', { planId: sess.planId, error: err.message });
    return false;
  }
}

// ── Background step generation ───────────────────────────────────────────────
// After each plan_update, generate each task's execution steps in the
// background and stream them into plan.md as `**Steps**` fenced JSON. At run
// time planRunner hands them to stategraph as _deterministicPlan, so execution
// skips the LLM planning pass entirely — and the user can read/edit the steps
// before pressing Run.

const _stepGenInFlight = new Set(); // planIds with a gen loop running

function _promptHash(prompt) {
  const s = String(prompt || '');
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}

// Fallback contract used only when the canonical stategraph prompt files
// can't be read (moved/renamed). Kept so step generation can never hard-fail.
const _STEPGEN_FALLBACK = `You are ThinkDrop's execution planner. Convert ONE task
into a concrete step list for the skill runtime. Reply with ONLY a fenced json
block — an array of steps, each {"skill": "...", "args": {...}, "description": "..."}.

Available skills:
- url.first.agent: {url, agentId} — open a specific service/app URL. ONLY use
  this when the task's deliverable lives on a named service AND the URL
  belongs to the TASK AGENTS' service (e.g. task agent google.agent →
  docs.new, sheets.new, calendar event-edit links). NEVER open a service URL
  (docs.new, mail.google.com, amazon.com/...) on a generic browser/web agent
  — it hits a sign-in wall. NEVER use it to "store" research output.
- dom.act: {goal, agentId} — interact with the open page by intent ("set the
  title to X", "click Save"). ANY step taking an agentId arg must carry the
  exact TASK AGENTS value — never invent another agent id.
- turn.loop.agent: {goal, agentId} — multi-step interactive browsing on PUBLIC
  sites (login-free pages only).
- web.agent: {query, agentId} — PRIMARY research tool: open-web
  search/extraction, no sign-in. Use it to gather data, lists, facts, URLs.
- browser.agent / web.crawl: browse/crawl public pages by goal (no sign-in).
- synthesize: {} — final summary step (always last).
- shell.run: {command} — local shell command.
- fs.read: {path} — read a local file (writes go through edit.agent/shell.run).
- doc.read: {path} — extract text from documents (pdf/docx/xlsx/pptx/…) —
  ALWAYS prefer this over shell CLIs like pandoc/pdftotext for documents.
- edit.agent: {goal} — edit project files.
- cli.agent: {tool, args} — a configured CLI.

Rules: 2-8 steps. Deterministic, self-contained, ordered. Research/compile
tasks gather via web.agent/web.crawl and write results to LOCAL files
(edit.agent/shell.run) — a service (Doc/Sheet/email) only appears when the
user named it as the deliverable.

MUTATION DISCIPLINE: a step that changes state MUST carry literal args
resolved NOW — shell.run {cmd, argv:[...]} (e.g. {cmd:"git",
argv:["-C","/abs/repo","commit","-m","msg"]}). NEVER emit cli.agent
task-strings or shell.run goal-strings for a mutating step — those re-plan
at replay. For per-run dynamic content (commit messages, summaries),
compose: synthesize produces the text and {{PREV_OUTPUT}} pipes it into a
literal-argv step. Loops stay INSIDE one step's argv bash script
(for d in /path/*/; do … done) — never emit N steps for N entities.

No commentary — ONLY the json fence.`;

// ── Canonical stepgen prompt ─────────────────────────────────────────────────
// planSkillsV2 and this lane share ONE canon: the stategraph prompt files.
// Core rules + ONE domain appendix picked from the task's registered agent
// type (service-map). The old hand-rolled list produced per-field dom.act
// chains; the browser appendix carries the canonical bundled-goal + verify
// pattern instead.
const _SG_PROMPTS_DIR = path.join(__dirname, '..', '..', '..', 'stategraph-module', 'src', 'prompts');
const _sgPromptCache = new Map();
function _loadSgPrompt(name) {
  if (_sgPromptCache.has(name)) return _sgPromptCache.get(name);
  let text = null;
  try { text = fs.readFileSync(path.join(_SG_PROMPTS_DIR, name), 'utf8'); }
  catch (_) { logger.warn('[Planning] Stepgen canon file unreadable', { name }); }
  _sgPromptCache.set(name, text);
  return text;
}

function _pickStepgenAppendix(task) {
  const agents = task.agents || [];
  // GhostLayer deliverable — screen.display isn't a service-map agent, but the
  // screen appendix is the ONLY canon that knows the scene/chart/deck contract.
  // Without it the LLM falls back to synthesize→save HTML→open-in-browser.
  if (agents.some(a => /^(screen\.display|screen_display)$/.test(String(a)))) {
    return 'plan-skills-screen.md';
  }
  let hasBrowser = false;
  let hasCli = false;
  for (const a of agents) {
    const meta = serviceMap.describeAgent(a);
    if (!meta) continue;
    if (meta.cliTool || meta.type === 'cli' || meta.type === 'mcp' || meta.type === 'local') hasCli = true;
    else if (meta.type === 'browser' || meta.type === 'api') hasBrowser = true;
  }
  // CLI-first: deterministic programmatic agents get the cli appendix even
  // when a task also lists a browser agent (cli/api/mcp > browser priority).
  if (hasCli) return 'plan-skills-cli-first.md';
  if (hasBrowser) return 'plan-skills-browser.md';
  if (/[~\/][\w\-./]+\.(?:md|txt|json|csv|pdf|docx?|xlsx?|py|ts|js)\b/i.test(task.prompt || '')) {
    return 'plan-skills-file.md';
  }
  return null;
}

/** Names of installed MCP servers — mcp.agent steps may target ONLY these. */
function _installedMcpServerNames() {
  try {
    const cfg = JSON.parse(fs.readFileSync(
      path.join(os.homedir(), '.thinkdrop', 'mcp-servers.json'), 'utf8'));
    return Object.keys(cfg.mcpServers || cfg || {});
  } catch (_) { return []; }
}

function _stepgenSystemPrompt(task) {
  const core = _loadSgPrompt('plan-skills-core.md');
  if (!core) return _STEPGEN_FALLBACK;
  const appendixName = _pickStepgenAppendix(task);
  const appendix = appendixName ? _loadSgPrompt(appendixName) : null;
  const mcpNames = _installedMcpServerNames();
  const mcpRule =
    `## MCP constraint\nInstalled MCP servers: ${mcpNames.length ? mcpNames.join(', ') : 'NONE'}. ` +
    'A `mcp.agent` step may ONLY target one of these exact server names — ' +
    'never invent a server (there is no "filesystem" server unless listed). ' +
    'Local file work uses fs.read / doc.read / shell.run / edit.agent.';
  return [
    "You are ThinkDrop's execution planner. Convert ONE task into a concrete step list for the skill runtime.",
    core,
    appendix || '',
    '## Task scope\nYou are planning ONE task from a larger approved plan — emit ONLY the steps this task needs (the surrounding plan handles ordering and dependencies).',
    skillContracts.contractsVocabularyBlock(),
    _appKnowledgeBlock(task),
    mcpRule,
    '## Output contract\nReply with ONLY a fenced json block — an array of steps, each {"skill": "...", "args": {...}, "description": "..."}. Every step taking an agentId arg carries the exact TASK AGENTS value — never invent another agent id. synthesize is always last. No commentary — ONLY the json fence.',
  ].filter(Boolean).join('\n\n');
}

// ── Learned app knowledge → stepgen context ──────────────────────────────────
// The runtime learns per-host UI quirks (appKnowledge.cjs → ~/.thinkdrop/
// app-knowledge/<host>.json) — the compiler reads the same store so authored
// steps reflect what earlier runs discovered (field semantics, recovery
// moves, verified intents). Load lazily + cross-repo like parseLlmJson: the
// module's own relative requires resolve against its own dir.
let _appKnowledge = null, _appKnowledgeTried = false;
function _appKnowledgeMod() {
  if (_appKnowledgeTried) return _appKnowledge;
  _appKnowledgeTried = true;
  try { _appKnowledge = require(path.resolve(__dirname, '../../../mcp-services/command-service/src/skills/lib/appKnowledge.cjs')); }
  catch (_) { _appKnowledge = null; }
  return _appKnowledge;
}

function _appKnowledgeBlock(task) {
  const ak = _appKnowledgeMod();
  if (!ak) return '';
  const seen = new Set();
  const blocks = [];
  for (const a of task.agents || []) {
    const meta = serviceMap.describeAgent(a);
    if (!meta || meta.type !== 'browser') continue;
    let host = '';
    try { host = meta.startUrl ? new URL(meta.startUrl).hostname.replace(/^www\./, '') : ''; } catch (_) {}
    if (!host || seen.has(host)) continue;
    seen.add(host);
    const formatted = ak.loadAndFormat ? ak.loadAndFormat(host, 800) : '';
    const intentUrl = ak.loadIntentUrl ? ak.loadIntentUrl(host, 'create') : null;
    const bits = [formatted, intentUrl && intentUrl.url ? `Known create/deep link: ${intentUrl.url}` : '']
      .filter(Boolean).join('\n');
    if (bits) blocks.push(`### ${host}\n${bits}`);
  }
  return blocks.length
    ? `## Learned app knowledge\nRuntime-discovered knowledge for this task's services — use it when choosing steps, selectors, and deep links:\n${blocks.join('\n\n')}`
    : '';
}

async function _generateTaskSteps(task) {
  // Deterministic fast path — a screen.display scene/3D task needs no LLM
  // stepgen: the code is written at RUNTIME by the synthesize step (full task
  // prompt, full token budget), then referenced via {{synthesisAnswer}}.
  // Asking the stepgen LLM to carry any part of that code/spec inside the
  // plan's JSON fence truncates on every provider cap.
  if ((task.agents || []).some(a => /^(screen\.display|screen_display)$/.test(String(a)))
      && /\b(3d|three\.?js|scene|model|orbit|spin|rotat|webgl|animation)\b/i.test(task.prompt || '')) {
    const spec = task.prompt || task.title || 'the requested scene';
    return [
      {
        skill: 'synthesize',
        args: {
          prompt: `Write the raw JavaScript body of build(THREE, ctx) for this scene: ${spec}\n\n` +
            'The harness provides scene/camera/renderer via ctx, and ctx.controls is a ready ' +
            'OrbitControls instance (drag-orbit + wheel-zoom already wired; call controls.update() ' +
            'each frame if you change damping). Build all geometry procedurally — no imports, ' +
            'fetch, or eval. Return { tick(t) } for per-frame animation. ' +
            'Output ONLY the JavaScript — no markdown fence, no explanation.',
          outputSchema: { type: 'STRING' },
        },
        description: 'Generate the three.js scene body at runtime',
      },
      {
        skill: 'screen.display',
        args: { kind: 'scene', scene: { js: '{{synthesisAnswer}}', libs: ['three'] }, blocking: true },
        description: 'Render the generated scene on the GhostLayer',
      },
    ];
  }
  const agents = (task.agents || []).join(' | ') || 'auto';
  const userMsg =
    `TASK AGENTS: ${agents}\n` +
    `TASK PROMPT: ${task.prompt || task.title}\n` +
    (task.doneWhen ? `DONE WHEN: ${task.doneWhen}\n` : '') +
    `\nEmit the step list now.`;
  try {
    const { text } = await ask([
      { role: 'system', content: _stepgenSystemPrompt(task) },
      { role: 'user', content: userMsg },
    // Scene-step replies carry an inline three.js body — a 900-token cap
    // truncates the fence mid-code and the whole list unparseable.
    ], { maxTokens: 4096, temperature: 0.2, timeoutMs: 45000, taskType: 'planning' });
    let steps = null;
    if (_parseLlmJson) {
      // Multi-attempt parse (fence strip → balanced array → brace repair →
      // jsonrepair). A provider-truncated reply salvages as a partial array —
      // the tail step can carry filler/partial args and is filtered out below.
      steps = _parseLlmJson(text, logger, 'Planning:StepGen');
      if (steps && !Array.isArray(steps) && Array.isArray(steps.steps)) steps = steps.steps;
      if (!Array.isArray(steps)) steps = null;
    } else {
      const m = String(text || '').match(/```(?:json)?\s*\n?([\s\S]*?)```/);
      try { steps = m ? JSON.parse(m[1].trim()) : null; }
      catch (e) {
        logger.warn('[Planning] Step JSON parse failed', { taskNum: task.num, error: e.message });
      }
    }
    if (!Array.isArray(steps) || !steps.length) {
      logger.warn('[Planning] Step generation produced no steps', {
        taskNum: task.num, replyChars: String(text || '').length,
        tail: String(text || '').slice(-200), preview: String(text || '').slice(0, 120),
      });
      return null;
    }
    // Keep well-formed steps; a repair-salvaged tail step (skill:null or cut
    // mid-object) is dropped rather than rejecting the whole list.
    const beforeFilter = steps.length;
    steps = steps.filter(s => s && typeof s.skill === 'string' && s.skill);
    if (!steps.length) {
      logger.warn('[Planning] Step list malformed (missing skill field)', { taskNum: task.num });
      return null;
    }
    if (steps.length < beforeFilter) {
      logger.info('[Planning] Dropped malformed step entries', { taskNum: task.num, kept: steps.length, dropped: beforeFilter - steps.length });
    }
    // Contract check — the stepgen compiles typed steps; validate against the
    // skill contracts so violations surface where they were authored.
    // Structural violations (unknown skill, missing required, bad types)
    // block the plan's cache bridge at save; wildcard flags (cli.agent task /
    // shell.run goal on a mutating step) mark the plan as containing
    // re-planning steps — executable but not deterministic-replayable.
    try {
      const _v = skillContracts.validatePlanSteps(steps);
      if (_v.violations.length) {
        task._contractViolations = _v.violations;
        const structural = _v.violations.filter(x => !x.msg.startsWith('wildcard:'));
        const wildcards = _v.violations.length - structural.length;
        logger.warn('[Planning] Step contract violations', {
          taskNum: task.num, structural: structural.length, wildcards,
          first: _v.violations.slice(0, 3).map(x => `step${x.step}:${x.field}:${x.msg}`),
        });
      }
    } catch (_) {}
    // One normalization rule shared with planRunner's dispatch path:
    // url steps → owning service agent; session-bound steps → task's lane.
    // Async variant — unknown step hosts get one bounded live discovery
    // (redirect-follow → web.search), then persist to learned_domains.
    const norm = await require('../../../shared/plan-steps.cjs')
      .normalizeTaskStepsAsync({ ...task, steps });
    task._normalized = norm; // {steps, agents, services} — consumed by _scheduleStepGen
    return norm.steps;
  } catch (err) {
    logger.warn('[Planning] Step generation failed', { taskNum: task.num, error: err.message });
    return null;
  }
}

function _notifyPlanUpdated(planId) {
  _postJson(MAIN_PORT, '/plan.updated', { planId }, '', 3000);
}

function _scheduleStepGen(sess) {
  if (!sess.tasks.length) return;
  if (_stepGenInFlight.has(sess.planId)) {
    // A loop is already running over the task array captured at start —
    // tasks appended/replaced mid-flight (_applyPlanMarkers swaps sess.tasks
    // wholesale) would never generate and sit 'pending' forever, blocking the
    // plan-check card. Queue one trailing pass instead of dropping it.
    sess._stepGenPending = true;
    return;
  }
  _stepGenInFlight.add(sess.planId);
  _activity(`generating steps for ${sess.tasks.length} task${sess.tasks.length > 1 ? 's' : ''}…`, 'plan');
  setImmediate(async () => {
    try {
      for (const task of sess.tasks) {
        if (Array.isArray(task.steps) && task.steps.length
            && task._stepsHash === _promptHash(task.prompt)) continue;
        // A 'failed' generation is sticky per prompt — the same prompt will
        // almost always fail again (e.g. provider token cap), and each doomed
        // re-attempt holds the check card 'pending' so the run can't start.
        // Regen only happens on a prompt change (stepsStatus reset) or an
        // explicit "Retry generation" (retrySteps clears the status).
        if (String(task.stepsStatus || '').toLowerCase() === 'failed'
            && (!task._failedHash || task._failedHash === _promptHash(task.prompt))) continue;
        const promptAtGen = task.prompt;
        // Bounded retry — a single malformed/unfenced response used to leave
        // the task pending forever. Two attempts, then mark it failed so the
        // plan-check card can surface a retry action instead of hanging.
        let steps = await _generateTaskSteps(task);
        if (!steps) steps = await _generateTaskSteps(task);
        if (!steps) {
          try {
            const onDisk = fs.readFileSync(sess.filePath, 'utf8');
            const diskTask = planFormat.parseTasks(onDisk).find(t => t.num === task.num);
            if (diskTask && diskTask.prompt === promptAtGen) {
              fs.writeFileSync(sess.filePath,
                planFormat.updateTaskStepsStatus(onDisk, task.num, 'failed'), 'utf8');
              const live = sess.tasks.find(t => t.num === task.num);
              if (live) {
                live.stepsStatus = 'failed';
                live._failedHash = _promptHash(promptAtGen);
              }
              _notifyPlanUpdated(sess.planId);
            }
          } catch (err) {
            logger.warn('[Planning] Step-fail status write failed', { taskNum: task.num, error: err.message });
          }
          logger.warn('[Planning] Steps generation exhausted retries', { planId: sess.planId, taskNum: task.num });
          continue;
        }
        // Patch the file IN PLACE — the user may have edited other fields (or
        // this task's prompt) while generation ran. Only write when the
        // on-disk prompt still matches what we generated for.
        try {
          const onDisk = fs.readFileSync(sess.filePath, 'utf8');
          const diskTask = planFormat.parseTasks(onDisk).find(t => t.num === task.num);
          if (diskTask && diskTask.prompt === promptAtGen) {
            const norm = task._normalized;
            let next = planFormat.updateTaskSteps(onDisk, task.num, steps);
            next = planFormat.updateTaskStepsStatus(next, task.num, null);
            // Steps that resolved to a registry service agent (url → docs.new
            // → google.agent) upgrade the task's Agents line so the run lock
            // covers the signed-in session, and re-assess auth so a real
            // sign-in need is named at plan time — not discovered at run.
            if (norm && norm.services.length) {
              next = planFormat.updateTaskAgents(next, task.num, norm.agents);
              try {
                const { assessAgent } = require('../planPreflight.cjs');
                let worst = diskTask.auth;
                const rank = { 'none-required': 0, authed: 1, bypassed: 1, unknown: 2, 'needs sign-in': 3 };
                for (const svc of norm.services) {
                  const a = assessAgent(svc).auth;
                  if ((rank[a] ?? 2) > (rank[worst] ?? 2)) worst = a;
                }
                if (worst !== diskTask.auth) next = planFormat.updateTaskAuth(next, task.num, worst);
                const live0 = sess.tasks.find(t => t.num === task.num);
                if (live0) { live0.agents = norm.agents; live0.auth = worst; }
              } catch (_) {}
            }
            fs.writeFileSync(sess.filePath, next, 'utf8');
            const live = sess.tasks.find(t => t.num === task.num);
            if (live && live.prompt === promptAtGen) {
              live.steps = steps;
              live.stepsStatus = null;
              live._stepsHash = _promptHash(promptAtGen);
              live._failedHash = null;
            }
            _notifyPlanUpdated(sess.planId);
            logger.info('[Planning] Steps generated', { planId: sess.planId, taskNum: task.num, count: steps.length });
          }
        } catch (err) {
          logger.warn('[Planning] Step write-back failed', { planId: sess.planId, taskNum: task.num, error: err.message });
        }
      }
    } finally {
      _stepGenInFlight.delete(sess.planId);
      if (sess._stepGenPending) {
        sess._stepGenPending = false;
        _scheduleStepGen(sess);
      }
    }
  });
}

// ── HTTP tool calls ───────────────────────────────────────────────────────────

function _postJson(port, urlPath, payload, apiKey, timeoutMs) {
  return new Promise((resolve) => {
    const body = JSON.stringify(payload);
    const headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) };
    if (apiKey) headers['Authorization'] = 'Bearer ' + apiKey;
    const req = http.request({
      hostname: '127.0.0.1', port, path: urlPath, method: 'POST', headers, timeout: timeoutMs,
    }, (res) => {
      let raw = '';
      res.on('data', c => { raw += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(raw)); } catch (_) { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.write(body);
    req.end();
  });
}

async function _toolMemorySearch(query) {
  const res = await _postJson(MEMORY_PORT, '/memory.search', {
    version: 'mcp.v1', service: 'user-memory', action: 'memory.search',
    payload: { query, limit: 3, minSimilarity: 0.3 },
    requestId: 'cg_plan_mem_' + Date.now(),
  }, MCP_API_KEY, 4000);
  const results = res?.data?.results || res?.data || [];
  if (!Array.isArray(results) || !results.length) return 'No relevant memories found.';
  // Each line carries [memoryId] so the model can reconcile conflicting facts
  // via memory.update / memory.delete once the user picks the right value.
  return results.map(r => {
    const text = (r.text || r.content || r.value || '');
    return r.id ? `[${r.id}] ${text}` : text;
  }).filter(s => s && s.trim()).slice(0, 3).join('\n');
}

// memory.update("<memoryId>|<corrected text>") — rewrite a stored fact. The
// id comes from a memory.search result's [id] prefix.
async function _toolMemoryUpdate(arg) {
  const pipe = String(arg || '').indexOf('|');
  if (pipe < 1) return 'Usage: memory.update("<memoryId>|<corrected text>") — get the id from a memory.search result.';
  const memoryId = String(arg).slice(0, pipe).trim();
  const text = String(arg).slice(pipe + 1).trim();
  if (!text) return 'Usage: memory.update("<memoryId>|<corrected text>") — the new text is required.';
  const res = await _postJson(MEMORY_PORT, '/memory.update', {
    version: 'mcp.v1', service: 'user-memory', action: 'memory.update',
    payload: { memoryId, updates: { text } },
    context: { userId: 'local_user' },
    requestId: 'cg_plan_memu_' + Date.now(),
  }, MCP_API_KEY, 8000);
  if (res?.status === 'error' || res?.error) {
    return `memory.update failed: ${res?.error?.message || res?.error?.code || res?.message || 'unknown error'}`;
  }
  return `Memory ${memoryId} updated to: "${text}"`;
}

// memory.delete("<memoryId>") — remove a stale/wrong fact by id.
async function _toolMemoryDelete(arg) {
  const memoryId = String(arg || '').trim();
  if (!memoryId) return 'Usage: memory.delete("<memoryId>") — get the id from a memory.search result.';
  const res = await _postJson(MEMORY_PORT, '/memory.delete', {
    version: 'mcp.v1', service: 'user-memory', action: 'memory.delete',
    payload: { memoryId },
    context: { userId: 'local_user' },
    requestId: 'cg_plan_memd_' + Date.now(),
  }, MCP_API_KEY, 8000);
  if (res?.status === 'error' || res?.error) {
    return `memory.delete failed: ${res?.error?.message || res?.error?.code || res?.message || 'unknown error'}`;
  }
  return `Memory ${memoryId} deleted.`;
}

// profile.get("name") — canonical profile-attribute read (self:name etc.).
// memory.search only sees the semantic store; canonical profile.set keys need
// this endpoint. A bare attribute gets the self: prefix tried first.
async function _toolProfileGet(arg) {
  const key = String(arg || '').trim().replace(/\s+/g, '_').toLowerCase();
  if (!key) return 'Usage: profile.get("<attribute>") — e.g. profile.get("name"), profile.get("email").';
  const candidates = key.includes(':') ? [key] : [`self:${key}`, key];
  for (const k of candidates) {
    const res = await _postJson(MEMORY_PORT, '/profile.get', {
      version: 'mcp.v1', service: 'user-memory', action: 'profile.get',
      payload: { key: k },
      requestId: 'cg_plan_pg_' + Date.now(),
    }, MCP_API_KEY, 4000);
    const value = res?.data?.valueRef || res?.data?.value || res?.data?.[k] || null;
    if (value) return `${k} = ${value}`;
  }
  return `No profile value stored for "${key}" — try memory.search for less structured facts.`;
}

// memory.store("fact text") — the CREATE path the lane was missing: a "just
// remember it" choice could only be narrated, never executed (observed:
// "Filing that away for you" — nothing stored).
async function _toolMemoryStore(arg) {
  const text = String(arg || '').trim();
  if (!text) return 'Usage: memory.store("<fact text>") — the fact to remember is required.';
  const res = await _postJson(MEMORY_PORT, '/memory.store', {
    version: 'mcp.v1', service: 'user-memory', action: 'memory.store',
    payload: { text, metadata: { source: 'planning', type: 'general_memory' } },
    context: { userId: 'local_user' },
    requestId: 'cg_plan_ms_' + Date.now(),
  }, MCP_API_KEY, 8000);
  if (res?.status === 'error' || res?.error || res?.status !== 'ok') {
    return `memory.store failed: ${res?.error?.message || res?.error?.code || res?.message || 'memory service unreachable or rejected the store'} — tell the user honestly; do NOT claim it was saved.`;
  }
  return `Stored: ${text}`;
}

// profile.set("name|John") — canonical profile-attribute write (self:name).
// Prefer this for direct user facts ("my email is…"); memory.store for prose.
async function _toolProfileSet(arg) {
  const s = String(arg || '');
  const pipe = s.indexOf('|');
  if (pipe < 1) return 'Usage: profile.set("<attribute>|<value>") — e.g. profile.set("name|John").';
  const attr = s.slice(0, pipe).trim().replace(/\s+/g, '_').toLowerCase();
  const value = s.slice(pipe + 1).trim();
  if (!attr || !value) return 'Usage: profile.set("<attribute>|<value>").';
  const key = attr.includes(':') ? attr : `self:${attr}`;
  const res = await _postJson(MEMORY_PORT, '/profile.set', {
    version: 'mcp.v1', service: 'user-memory', action: 'profile.set',
    payload: { key, value },
    requestId: 'cg_plan_ps_' + Date.now(),
  }, MCP_API_KEY, 5000);
  if (res?.status === 'error' || res?.error) {
    return `profile.set failed: ${res?.error?.message || res?.error?.code || res?.message || 'service error'} — do NOT claim it was saved.`;
  }
  return `Profile stored: ${key} = ${value}`;
}

// episodic.search("query|days") — activity/capture history: what the user was
// watching, reading, doing. THE data behind "what did I watch this week" →
// chart flows — memory.search only sees semantic facts, never captures.
async function _toolEpisodicSearch(arg) {
  const s = String(arg || '');
  const pipe = s.indexOf('|');
  const query = (pipe >= 0 ? s.slice(0, pipe) : s).trim();
  let startDate, endDate;
  if (pipe >= 0) {
    const range = s.slice(pipe + 1).trim();
    const days = parseInt(range, 10);
    if (!isNaN(days) && days > 0) {
      const now = new Date();
      startDate = new Date(now.getTime() - days * 86400000).toISOString().slice(0, 10);
      endDate = now.toISOString().slice(0, 10);
    }
  }
  const res = await _postJson(MEMORY_PORT, '/episodic.search', {
    version: 'mcp.v1', service: 'user-memory', action: 'episodic.search',
    payload: { query: query || 'activity', limit: 10, ...(startDate ? { startDate, endDate } : {}), dedup: true },
    requestId: 'cg_plan_eps_' + Date.now(),
  }, MCP_API_KEY, 8000);
  const results = res?.data?.results || res?.data?.captures || res?.data || [];
  if (!Array.isArray(results) || !results.length) return 'No episodic memories found for that query/period — report that honestly.';
  return results.slice(0, 10).map(r => {
    const when = r.capturedAt || r.created_at || r.timestamp || '';
    const app = r.appName || r.app || '';
    const text = (r.text || r.title || r.windowTitle || r.content || '').replace(/\s+/g, ' ').slice(0, 120);
    return `[${String(when).slice(0, 16)}] ${app ? `${app}: ` : ''}${text}`;
  }).join('\n');
}

// memory.getAppUsageSummary("hours") — per-app usage durations ("how long was
// I in X", "apps I used today/this week") — chart-ready numbers.
async function _toolAppUsage(arg) {
  const hours = Math.min(Math.max(parseInt(String(arg || ''), 10) || 168, 1), 720);
  const res = await _postJson(MEMORY_PORT, '/memory.getAppUsageSummary', {
    version: 'mcp.v1', service: 'user-memory', action: 'memory.getAppUsageSummary',
    payload: { maxAgeHours: hours },
    requestId: 'cg_plan_app_' + Date.now(),
  }, MCP_API_KEY, 6000);
  const rows = res?.data?.apps || res?.data?.summary || res?.data || [];
  if (!Array.isArray(rows) || !rows.length) return 'No app usage recorded for that period.';
  return rows.slice(0, 15).map(r => {
    const app = r.appName || r.app || r.name || '?';
    const dur = r.durationMinutes != null ? `${Math.round(r.durationMinutes)}m`
      : r.minutes != null ? `${Math.round(r.minutes)}m`
      : r.duration != null ? String(r.duration) : '';
    return `${app}: ${dur}`;
  }).join('\n');
}

async function _toolWebSearch(query) {
  const res = await _postJson(WEB_SEARCH_PORT, '/web.search', {
    version: 'mcp.v1', service: 'web-search', action: 'web.search',
    payload: { query, maxResults: 5 },
    requestId: 'cg_plan_ws_' + Date.now(),
    context: { userId: 'local_user' },
  }, WS_API_KEY, 8000);
  if (res?.status === 'error' || res?.error) {
    return `web.search failed: ${res?.error?.code || res?.error?.message || res?.message || 'unknown error'}`;
  }
  const data = res?.data || res;
  const results = data?.results || data?.organic || [];
  if (!Array.isArray(results) || !results.length) {
    return `No web results found.${data?.fallbackReason ? ` (${data.fallbackReason})` : ''}`;
  }
  // A captured AI Overview is the strongest signal — put it first so the
  // planner quotes it instead of synthesizing from snippets.
  const overview = typeof data?.aiOverview === 'string' && data.aiOverview.length > 40
    ? `AI Overview (authoritative answer):\n${data.aiOverview.slice(0, 2000)}\n\nResults:\n`
    : '';
  // URLs are first-class — the LLM can only offer links it was actually shown.
  return overview + results.slice(0, 5)
    .map(r => `- ${r.title || ''}\n  ${r.url || r.link || ''}\n  ${r.snippet || r.description || ''}`.trim())
    .filter(s => s.length > 2)
    .join('\n');
}

// Generic tool-marker parser — matches ANY <tool>name("arg")</tool> so a name
// the registry doesn't know lands as a corrective <tool_results> entry and the
// model self-corrects next round. The old allowlist regex silently dropped
// unknown names: the model then narrated fake results to match its own claim
// (observed: <tool>fs.read(...)</tool> "read" an RTF file that was never opened
// — the reply carried a fabricated <tool_results> block with invented content).
const _TOOL_CALL_RE = /<tool>\s*([a-zA-Z][\w.]*)\s*(?:\(\s*([\s\S]*?)\s*\))?\s*<\/tool>/g;

// Lenient arg extraction — strip one matching quote pair; bare args pass as-is.
function _toolArg(raw) {
  const s = String(raw || '').trim();
  const m = s.match(/^([\"'`])([\s\S]*)\1$/);
  return m ? m[2] : s;
}

const COMMAND_SERVICE_PORT = parseInt(process.env.COMMAND_SERVICE_PORT || '3007', 10);
const COMMAND_API_KEY = process.env.MCP_COMMAND_API_KEY || process.env.MCP_API_KEY || '';

async function _toolMediaResolve(query) {
  const res = await _postJson(COMMAND_SERVICE_PORT, '/media.resolve', {
    query,
  }, COMMAND_API_KEY, 20000);
  if (res?.ok === false) return `media.resolve failed: ${res.error || 'unknown'}`;
  const results = res?.results || res?.data?.results || [];
  if (!Array.isArray(results) || !results.length) return 'No media results found.';
  return results.slice(0, 3)
    .map(r => `- ${r.title || ''}\n  ${r.url || ''}`)
    .join('\n');
}

// ── Local file tools — real reads via command-service skills ─────────────────
// fs.read covers text/code reads, dir trees, grep, and stat; doc.read decodes
// rtf/pdf/docx/xlsx/pptx via textutil/python extractors. READ-ONLY — there is
// no write tool in this lane on purpose.
const _FILE_TOOL_CAP = 12000; // chars per file — keeps results inside the window

function _skillEnvelope(res) {
  // /command.automate → {success:true, data:{ok, stdout, summary, ...raw}}
  return res?.data || res;
}

async function _toolFsRead(arg) {
  const p = String(arg || '').trim();
  if (!p) return 'Usage: fs.read("absolute/path") — a file path is required (use dir.list for folders, doc.read for rtf/pdf/docx).';
  const res = _skillEnvelope(await _postJson(COMMAND_SERVICE_PORT, '/command.automate', {
    payload: { skill: 'fs.read', args: { action: 'read', path: p, maxFileSize: 200 * 1024 } },
  }, COMMAND_API_KEY, 20000));
  if (!res) return `fs.read failed: command-service unreachable (is it running on :${COMMAND_SERVICE_PORT}?). Try again or tell the user the file couldn't be read.`;
  const files = Array.isArray(res.files) ? res.files : [];
  if (!files.length) return `fs.read failed: ${res.error || 'no file content returned'} — the path may not exist ("${p}").`;
  return files.map(f => {
    if (!f.ok) return `${f.path}: ${f.error || 'unreadable'}`;
    const body = String(f.content || '');
    const trunc = body.length > _FILE_TOOL_CAP ? `\n… (${body.length - _FILE_TOOL_CAP} chars truncated)` : '';
    return `${f.path} (${f.size} bytes, ${f.lines} lines)\n${body.slice(0, _FILE_TOOL_CAP)}${trunc}`;
  }).join('\n\n');
}

async function _toolDirList(arg) {
  const p = String(arg || '').trim();
  if (!p) return 'Usage: dir.list("absolute/path") — a folder path is required.';
  const res = _skillEnvelope(await _postJson(COMMAND_SERVICE_PORT, '/command.automate', {
    payload: { skill: 'fs.read', args: { action: 'tree', path: p, maxDepth: 3 } },
  }, COMMAND_API_KEY, 20000));
  if (!res) return `dir.list failed: command-service unreachable (is it running on :${COMMAND_SERVICE_PORT}?).`;
  if (res.ok === false) return `dir.list failed: ${res.error || 'unknown error'} — the folder may not exist ("${p}").`;
  const tree = String(res.tree || '').slice(0, _FILE_TOOL_CAP);
  return tree ? `Contents of ${res.path}:\n${tree}` : `${p} is empty.`;
}

async function _toolFsStat(arg) {
  const p = String(arg || '').trim();
  if (!p) return 'Usage: fs.stat("absolute/path") — a path is required.';
  const res = _skillEnvelope(await _postJson(COMMAND_SERVICE_PORT, '/command.automate', {
    payload: { skill: 'fs.read', args: { action: 'stat', path: p } },
  }, COMMAND_API_KEY, 10000));
  if (!res) return `fs.stat failed: command-service unreachable (is it running on :${COMMAND_SERVICE_PORT}?).`;
  if (res.ok === false) return `fs.stat failed: ${res.error || 'unknown error'} — the path may not exist ("${p}").`;
  return `${res.path}\n  type: ${res.type}  size: ${res.sizeFormatted || res.size}  modified: ${res.modified || 'unknown'}${res.entries != null ? `  entries: ${res.entries}` : ''}`;
}

async function _toolFsSearch(arg) {
  // fs.search("path | pattern") — grep under a file or directory.
  const pipe = String(arg || '').indexOf('|');
  const p = (pipe >= 0 ? String(arg).slice(0, pipe) : String(arg)).trim();
  const pattern = pipe >= 0 ? String(arg).slice(pipe + 1).trim() : '';
  if (!p || !pattern) return 'Usage: fs.search("path | pattern") — both a path and a search pattern are required.';
  const res = _skillEnvelope(await _postJson(COMMAND_SERVICE_PORT, '/command.automate', {
    payload: { skill: 'fs.read', args: { action: 'search', path: p, pattern } },
  }, COMMAND_API_KEY, 20000));
  if (!res) return `fs.search failed: command-service unreachable (is it running on :${COMMAND_SERVICE_PORT}?).`;
  if (res.ok === false) return `fs.search failed: ${res.error || 'unknown error'}`;
  const out = String(res.output || (Array.isArray(res.matches) ? res.matches.join('\n') : '') || '').slice(0, _FILE_TOOL_CAP);
  return out || `No matches for "${pattern}" under ${p}.`;
}

async function _toolDocRead(arg) {
  const p = String(arg || '').trim();
  if (!p) return 'Usage: doc.read("absolute/path") — a document path is required (rtf/pdf/docx/doc/xlsx/pptx/odt/html).';
  const res = _skillEnvelope(await _postJson(COMMAND_SERVICE_PORT, '/command.automate', {
    payload: { skill: 'doc.read', args: { path: p, maxChars: _FILE_TOOL_CAP } },
  }, COMMAND_API_KEY, 30000));
  if (!res) return `doc.read failed: command-service unreachable (is it running on :${COMMAND_SERVICE_PORT}?).`;
  if (res.ok === false) return `doc.read failed: ${res.error || res.reason || 'unknown error'} — the file may not exist or the format may be unsupported ("${p}").`;
  const text = String(res.text || '').trim();
  if (!text) return `doc.read returned no text for "${p}" (${res.format || 'unknown format'}).`;
  return `${res.path || p} [${res.format || 'doc'}${res.truncated ? ', truncated' : ''}]\n${text.slice(0, _FILE_TOOL_CAP)}`;
}

// ── Media-URL grounding ─────────────────────────────────────────────────────
// Video-watch URLs a task prompt may carry must come from a tool — the model
// will otherwise write its most-memorized watch?v= link (dQw4w9WgXcQ) into a
// "cast the show" task and the executor silently casts the wrong video.
const _MEDIA_URL_RE = /https?:\/\/(?:www\.)?(?:youtube\.com\/watch\?[^\s"'<>]+|youtu\.be\/[^\s"'<>]+|vimeo\.com\/\d+[^\s"'<>]*)/gi;

function _mediaId(url) {
  const m = String(url).match(/[?&]v=([\w-]{5,})|youtu\.be\/([\w-]{5,})|vimeo\.com\/(\d+)/);
  return m ? (m[1] || m[2] || m[3]) : null;
}

// Every URL in tool output joins the session's observed set — media.resolve
// lists them explicitly and web.search results embed them too.
function _recordObservedMedia(sess, toolResults) {
  if (!toolResults) return;
  const obs = sess.observedMedia ||= { ids: new Set(), urls: [] };
  for (const u of (String(toolResults).match(_MEDIA_URL_RE) || [])) {
    obs.urls.push(u);
    const id = _mediaId(u);
    if (id) obs.ids.add(id);
  }
}

// Rewrite task prompts that carry ungrounded watch?v=/youtu.be/vimeo links:
// substitute the top observed candidate, or — when nothing was ever resolved —
// strip the URL so the run resolves the link itself instead of casting a
// random memorized video. Both the canonical `prompt` field and the verbatim
// `body` blob get scanned — either can carry a URL the executor reads.
function _groundTaskMediaUrls(tasks, sess) {
  const obs = sess.observedMedia;
  for (const t of tasks) {
    if (!t) continue;
    let _stripped = false;
    for (const field of ['prompt', 'body']) {
      if (!t[field]) continue;
      t[field] = String(t[field]).replace(_MEDIA_URL_RE, (url) => {
        const id = _mediaId(url);
        if (id && obs && obs.ids.has(id)) return url; // tool-returned — keep
        const candidate = obs && obs.urls[0];
        if (candidate) {
          logger.info(`[Planning] Media URL grounding — task ${t.num}: replaced ungrounded ${url} with resolved ${candidate}`);
          (sess.risks ||= []).push(`Auto-corrected media URL in task ${t.num}: ${url} → ${candidate}`);
          return candidate;
        }
        _stripped = true;
        logger.info(`[Planning] Media URL grounding — task ${t.num}: stripped ungrounded ${url} (no resolved candidates)`);
        return '';
      });
      t[field] = t[field].replace(/[ \t]{2,}/g, ' ');
    }
    if (_stripped) {
      const note = ' (resolve the video URL at run time via search before casting)';
      if (t.prompt) t.prompt = t.prompt.trim() + note;
      else if (t.body) t.body = t.body.trimEnd() + note;
    }
  }
}

// Read-only look at the user's live screen — recent OCR text + active app.
// The planner's eyes: call this whenever the task refers to "this", "my
// screen", "this app/site/tool" instead of asking the user to describe it.
async function _toolScreenRead(_focus) {
  const ctx = await screenContext().catch(() => null);
  if (!ctx) return 'Screen context unavailable (OCR monitor not running or empty).';
  const parts = [];
  if (ctx.appName) parts.push(`App: ${ctx.appName}`);
  if (ctx.url) parts.push(`URL: ${ctx.url}`);
  if (ctx.title) parts.push(`Window: "${ctx.title}"`);
  return `${parts.join(', ')}\nVisible text: ${ctx.ocrText || '(no OCR text captured)'}`;
}

async function _toolCapabilitySearch(query) {
  const res = await _postJson(COMMAND_SERVICE_PORT, '/capability.search', {
    query,
  }, COMMAND_API_KEY, 6000);
  const results = res?.results || res?.data?.results || [];
  if (!Array.isArray(results) || !results.length) return 'No capability candidates found.';
  return results.slice(0, 6).map((c, i) => {
    const bits = [
      `${i + 1}. ${c.label || c.id} [${c.kind}]`,
      `setup: ${c.setupSummary || 'unknown'}`,
      c.installed === false ? 'not installed' : null,
      Array.isArray(c.missingSecrets) && c.missingSecrets.length ? `missing: ${c.missingSecrets.join(', ')}` : null,
      c.detail ? `— ${c.detail}` : null,
    ].filter(Boolean);
    return bits.join(' ');
  }).join('\n');
}

async function _toolCapabilityProbe(commandLine) {
  const parts = String(commandLine || '').trim().split(/\s+/).filter(Boolean);
  const tool = parts.shift();
  const res = await _postJson(COMMAND_SERVICE_PORT, '/capability.probe', {
    tool, argv: parts,
  }, COMMAND_API_KEY, 20000);
  if (res?.denied) return `probe denied: ${res.denied}`;
  if (res?.installed === false) return `${tool}: not installed`;
  const out = (res?.output || '').slice(0, 1500);
  return `${tool} ${parts.join(' ')} → ${res?.ok ? 'ok' : `exit ${res?.exitCode ?? '?'}`}\n${out}`;
}

async function _toolCapabilitySelect(name) {
  const res = await _postJson(COMMAND_SERVICE_PORT, '/capability.select', {
    name,
  }, COMMAND_API_KEY, 6000);
  if (res?.ok === false) return `select failed: ${res.error || 'unknown'}`;
  if (res?.alreadyRegistered) return `${res.agentId} is already registered — use it directly in Agents.`;
  return `${res.agentId} registered as a draft agent (status: draft). Use "${res.agentId}" in the task's Agents line — plan-check will offer "Set up" before the run.${res?.secrets?.length ? `\nIt will need: ${res.secrets.join(', ')}` : ''}`;
}

// ── Visible diagnosis — run checks inside a labeled PTY session ────────────
// 'thinkdrop: check' lives in the terminal pane like cli.agent's sessions, so
// the user watches the investigation instead of trusting prose. Everything is
// fail-open: visibility must never break a tool.
const DIAG_SESSION_LABEL = 'thinkdrop: check';
let _diagSessionId = null;

// Ticker line in the collapsed drawer header — fire-and-forget.
function _activity(line, kind = 'note') {
  try {
    _postJson(MAIN_PORT, '/agent-turn', { type: 'terminal:activity', kind, line }, '', 2000).catch?.(() => {});
  } catch (_) {}
}

async function _ptyDiagnose(cmd, timeoutMs = 30000) {
  const r = await _postJson(COMMAND_SERVICE_PORT, '/terminal.exec', {
    label: DIAG_SESSION_LABEL, sessionId: _diagSessionId || undefined,
    cmd, timeoutMs,
  }, '', Math.min(timeoutMs + 3000, 60000));
  if (r && r.ok !== false && r.sessionId) _diagSessionId = r.sessionId;
  return r;
}

async function _ptyNote(text) {
  const r = await _postJson(COMMAND_SERVICE_PORT, '/terminal.note', {
    label: DIAG_SESSION_LABEL, sessionId: _diagSessionId || undefined,
    text: String(text || '').slice(0, 200),
  }, '', 3000);
  if (r && r.ok !== false && r.sessionId) _diagSessionId = r.sessionId;
  return r;
}

// ── Self-knowledge tools — plans on disk, ~/.thinkdrop layout, project logs ──

function _toolPlanFind(query) {
  const hits = sysMap.findPlans(query).slice(0, 5);
  if (!hits.length) return `(no saved plan matches "${query}" — searched name/title/prompt/task text of every plan_* file)`;
  return hits.map(p =>
    `${p.planId} — "${p.name || p.title || '(unnamed)'}" | status=${p.status} | ${p.pendingCount} of ${p.totalTasks} tasks unfinished | tasks: ${p.taskTitles.join('; ')}`
  ).join('\n');
}

// Open (and if needed reopen) a saved plan and bind this session to it.
// Terminal plans (done/failed/cancelled) are reopened: status → ready and
// failed/skipped tasks → pending so the run can continue where it stopped.
function _openPlanForSession(planId, sessionId) {
  const sess2 = _loadPlanFromDisk(planId);
  if (!sess2) return { sess: null, reopened: false, error: `plan ${planId} not found on disk` };
  if (sessionId) _sessionToPlan.set(sessionId, planId);
  _activePlanId = planId;
  const isTerminal = /^(done|failed|cancelled)$/i.test(String(sess2.status || ''));
  const allTasksTerminal = sess2.tasks.length > 0 && sess2.tasks.every(t => /done|skipped|failed|cancelled/i.test(String(t.status || '')));
  if (!isTerminal && !allTasksTerminal) return { sess: sess2, reopened: false };
  try {
    let content = fs.readFileSync(sess2.filePath, 'utf8');
    content = planFormat.updateFrontmatterStatus(content, 'ready');
    for (const t of sess2.tasks) {
      if (/failed|skipped/i.test(String(t.status || ''))) {
        content = planFormat.updateTaskStatus(content, t.num, planFormat.TASK_STATUS.PENDING);
      }
    }
    fs.writeFileSync(sess2.filePath, content, 'utf8');
    logger.info('[Planning] Reopened plan', { planId, from: sess2.status });
    return { sess: _loadPlanFromDisk(planId) || sess2, reopened: true };
  } catch (err) {
    logger.warn('[Planning] Plan reopen failed', { planId, error: err.message });
    return { sess: sess2, reopened: false };
  }
}

function _toolPlanOpen(planId, sessionId) {
  const { sess: opened, reopened, error } = _openPlanForSession(planId, sessionId);
  if (error) return error;
  return `Plan "${opened.name || opened.title || opened.planId}" is now the active plan`
    + (reopened ? ' — REOPENED: it had a terminal status; now status=ready and failed/skipped tasks are reset to pending' : '')
    + `.\nCurrent state:\n${_renderPlanState(opened)}\nTell the user what you found and what the next step is.`;
}

// Parse "name[, n]" tool queries into {name, n} — shared by the log tools.
function _parseLogQuery(query, defN) {
  const m = String(query || '').match(/^([^\s,"]+)(?:[,\s]+(\d+))?/);
  return { name: m ? m[1] : '', n: m && m[2] ? parseInt(m[2], 10) : defN };
}

function _logFilePath(name) {
  const safe = String(name || '').replace(/\.log$/i, '').replace(/[^\w-]/g, '');
  return safe ? path.join(sysMap.logsDir(), safe + '.log') : null;
}

function _toolLogsTail(query) {
  const { name, n } = _parseLogQuery(query, 80);
  return sysMap.tailLog(name, n);
}

function _toolLogsHead(query) {
  const { name, n } = _parseLogQuery(query, 50);
  return sysMap.headLog(name, n);
}

// "logname | pattern [, context]"
function _toolLogsGrep(query) {
  const parts = String(query || '').split('|').map(s => s.trim());
  const m = (parts[1] || '').match(/^([^\s,"]+)(?:[,\s]+(\d+))?/);
  return sysMap.grepLog(parts[0], m ? m[1] : '', { context: m && m[2] ? parseInt(m[2], 10) : 3 });
}

// "logname | from-to"
function _toolLogsRange(query) {
  const parts = String(query || '').split('|').map(s => s.trim());
  const m = (parts[1] || '').match(/(\d+)\s*-\s*(\d+)/);
  return sysMap.logRange(parts[0], m ? m[1] : 1, m ? m[2] : 80);
}

// ── Live truth tools ──────────────────────────────────────────────────────────
// The planner kept claiming cancels/runs/statuses it never performed. Every
// such claim must now trace to one of these results — run state lives in the
// main process (planRunner), task history in this process's taskJournal.

function _resolvePlanId(query, sessionId) {
  return String(query || '').trim()
    || (sessionId && _sessionToPlan.get(sessionId))
    || _activePlanId || null;
}

async function _toolPlanStatus(query, sessionId) {
  const planId = _resolvePlanId(query, sessionId);
  const res = await _postJson(MAIN_PORT, '/plan.status', { planId }, '', 4000);
  if (!res || res.ok !== true) {
    return 'plan.status FAILED — could not reach the app. Do NOT guess at run state; tell the user the status check failed.';
  }
  const parts = [];
  // Lead with the effective verdict — "running" must never be the first word
  // of a dead run's report (the old "plan file status: running" line anchored
  // the model into narrating progress that wasn't happening).
  if (res.liveState) {
    parts.push(res.liveState === 'not-running'
      ? 'LIVE STATE: NOT RUNNING — nothing is executing right now'
      : `LIVE RUN: ${res.liveState}${res.waitingTasks?.length ? ` (paused — waiting for input on task(s) ${res.waitingTasks.join(', ')})` : ''}`);
  } else if (res.runStatus) parts.push(`live run: ${res.runStatus}`);
  else parts.push('no live run — nothing is executing right now');
  if (res.planStatus) parts.push(`plan file status: ${res.planStatus}`);
  if (res.heldAtReview?.length) parts.push(`waiting on approval: task(s) ${res.heldAtReview.join(', ')}`);
  if (res.pendingCheck) parts.push('a readiness-check card is still open');
  if (res.waitingTasks?.length) {
    parts.push(`PAUSED waiting for input: task(s) ${res.waitingTasks.join(', ')} — the plan is NOT progressing until answered/resumed`);
  }
  if (res.interruptedTasks?.length) {
    parts.push(`INTERRUPTED (stale marker healed): task(s) ${res.interruptedTasks.join(', ')} — were mid-flight when the run died; they are NOT running`);
  }
  if (res.tasks?.length) {
    parts.push('tasks: ' + res.tasks.map(t => `#${t.num} ${t.status || 'pending'} — ${t.title}`).join(' | '));
  }
  if (res.runs?.length > 1) parts.push(`other live runs: ${res.runs.map(r => r.planId).join(', ')}`);
  parts.push('TRUTHFULNESS: relay exactly what this says. A task listed as interrupted/waiting-for-input is NOT in progress — say the plan is paused/stopped and offer "run it" to resume. Never say "wrapping up" or "in progress" unless a live run exists.');
  return parts.join('\n');
}

async function _toolPlanCancel(query, sessionId) {
  const planId = _resolvePlanId(query, sessionId);
  const res = await _postJson(MAIN_PORT, '/plan.cancel', { planId }, '', 4000);
  if (!res || res.ok !== true) {
    return 'plan.cancel FAILED — the request did not reach the app; the plan was NOT cancelled. Say so plainly, do not claim it worked.';
  }
  const exitNote = res.exitedPlanning
    ? ' Planning mode is now OFF — you may tell the user so.'
    : '';
  if (res.cancelled) return `Plan ${res.planId} is cancelled — the run was stopped, remaining tasks marked skipped, held approvals dismissed.${exitNote}`;
  return res.planId
    ? `Plan ${res.planId} had no live run to stop (any open checklist/review cards were dismissed).${exitNote}`
    : 'No plan specified and no live run exists — nothing was cancelled.';
}

// Real activity history — answers "what did I do / what's been running / did
// it finish" from the task journal instead of inventing a summary.
function _toolJournalRecent(query) {
  const q = String(query || '').trim();
  let limit = 15;
  let needle = '';
  if (/^\d+$/.test(q)) limit = Math.min(parseInt(q, 10), 50);
  else if (q) needle = q.toLowerCase();
  const tj = require('../taskJournal.cjs');
  const match = t => !needle
    || (t.prompt || '').toLowerCase().includes(needle)
    || (t.originalPrompt || '').toLowerCase().includes(needle)
    || (t.agentId || '').toLowerCase().includes(needle);
  const fmtAgo = (ms) => {
    if (!ms) return '';
    const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
    if (s < 60) return `${s}s ago`;
    if (s < 3600) return `${Math.round(s / 60)}m ago`;
    if (s < 86400) return `${Math.round(s / 3600)}h ago`;
    return `${Math.round(s / 86400)}d ago`;
  };
  const fmt = (t, live) => `[${live ? 'LIVE ' : ''}${t.status}] ${String(t.prompt || t.originalPrompt || '').slice(0, 90)}`
    + (t.agentId ? ` — ${t.agentId}` : '')
    + ` · ${fmtAgo(t.doneAt || t.startedAt || t.createdAt)}`;
  const lines = [
    ...(tj.getActiveTasks() || []).filter(match).map(t => fmt(t, true)),
    ...(tj.getRecentTasks(50) || []).filter(match).slice(0, limit).map(t => fmt(t, false)),
  ];
  return lines.length
    ? lines.join('\n')
    : (needle ? `No journal entries match "${needle}".` : 'The task journal is empty — nothing has run yet.');
}

// Open a real browser page for the user — signup/login/verify/dashboard
// destinations they must visit in person. Only http(s) URLs; report failure
// honestly, never claim a page opened that didn't.
async function _toolUrlOpen(query, sessionId) {
  const url = String(query || '').trim();
  if (!/^https?:\/\//i.test(url)) {
    return `url.open FAILED — "${url || 'empty'}" is not an http(s) URL. Get the real link first (setup.start result, capability info, or web.search).`;
  }
  // F16: pass the live plan id so main.js can verify the open request
  // correlates to a real running plan — phantom opens are rejected there.
  const planId = _sessionToPlan.get(sessionId) || _activePlanId || null;
  const res = await _postJson(MAIN_PORT, '/url.open', { url, planId }, '', 4000);
  if (!res || res.ok !== true) {
    return `url.open FAILED — the browser could not be opened (${res?.error || 'no response'}). Give the user the URL to paste instead: ${url}`;
  }
  return `Opened ${url} in the user's browser. Tell them it's open — do NOT claim they completed anything there yet.`;
}

// ThinkDrop-driven service setup — the terminal lane runs the real init /
// auth / install command, verifies it, and resumes the parked plan. Use this
// instead of telling the user to run commands (nylas init, gh auth login…).
async function _toolSetupStart(query) {
  const service = String(query || '').trim().replace(/\.agent$/, '');
  if (!service) return 'setup.start needs a service name, e.g. setup.start("nylas").';
  const res = await _postJson(MAIN_PORT, '/setup.start', { service }, '', 5000);
  if (!res || res.ok !== true) {
    return `setup.start FAILED — the setup lane could not start for "${service}" (${res?.error || 'no response'}). Only now may you give the user manual steps — with the destination URL.`;
  }
  if (res.already) return `Setup for ${res.service} is ALREADY running in the terminal — narrate that it's in progress; the plan resumes automatically once it verifies.`;
  const bits = [`Setup for ${res.service} is now running in the ThinkDrop terminal — it drives the real init/auth commands, verifies, and resumes the plan. Tell the user to watch the terminal pane and answer its prompts.`];
  if (res.setupUrl) bits.push(`Their console/dashboard: ${res.setupUrl} — offer to open it for them (url.open) if they need to create an account, approve scopes, or copy a key.`);
  return bits.join(' ');
}

// Render a DRAFT of the plan's deliverable on the GhostLayer so the user sees
// what the plan will produce before they approve it. Pipe-separated arg:
//   screen.preview("kind | title | content")
// kind ∈ text|image|chart|effect|emoji|alert|deck|scene|three|doc
// content: chart → "label N" pairs (one per line or comma-separated);
//          deck  → slides split by '--'; doc → markdown; three → preset name.
const _PREVIEW_KINDS = new Set(['text', 'image', 'chart', 'effect', 'emoji', 'alert', 'deck', 'scene', 'three', 'doc']);
async function _toolScreenPreview(query) {
  const parts = String(query || '').split('|').map(s => s.trim());
  const kind = _PREVIEW_KINDS.has(parts[0]) ? parts.shift() : 'text';
  const title = parts.shift() || 'Plan preview';
  const body = parts.join('\n');

  const payload = {
    kind, title, durationMs: 0, dismiss: 'manual', blocking: false,
    interactive: kind === 'chart' || kind === 'deck' || kind === 'scene' || kind === 'three',
  };
  if (kind === 'chart') {
    const data = [];
    const re = /([\w][\w .\-'()&/]{0,40}?)\s*[:=]?\s*(-?\d[\d,]*(?:\.\d+)?)\s*([KMBT])?\s*%?\s*(?=[,;\n]|$)/gm;
    let pm;
    while ((pm = re.exec(body)) !== null && data.length < 12) {
      const label = pm[1].trim().replace(/[,:;=]+$/, '');
      const value = parseFloat(pm[2].replace(/,/g, '')) * ({ K: 1e3, M: 1e6, B: 1e9, T: 1e12 }[(pm[3] || '').toUpperCase()] || 1);
      if (label && /[A-Za-z]/.test(label) && Number.isFinite(value)) data.push({ label, value });
    }
    if (!data.length) return `screen.preview needs chart data as "label N" pairs — e.g. screen.preview("chart | Q3 Sales | apples 5, bananas 3").`;
    payload.chart = { type: 'bar', data, xKey: 'label', yKey: 'value' };
  } else if (kind === 'deck') {
    const slides = body.split(/\n\s*--\s*\n|\n\s*\n/).map(s => s.trim()).filter(Boolean).slice(0, 8)
      .map(s => { const ls = s.split('\n').map(l => l.trim()).filter(Boolean); return { title: ls[0], text: ls.slice(1).join('\n') }; });
    if (!slides.length) return 'screen.preview deck needs slide text separated by "--" or blank lines.';
    payload.deck = { slides };
  } else if (kind === 'doc') {
    if (!body) return 'screen.preview doc needs markdown content after the title pipe.';
    payload.doc = { markdown: body };
  } else if (kind === 'three') {
    payload.three = { scene: (body || 'starfield').toLowerCase() };
  } else if (kind === 'scene') {
    if (!body) return 'screen.preview scene needs a registered scene name or generated markup.';
    // Multi-word body = generated three.js markup the planner wrote itself —
    // pass it through as scene.js (libs: ['three']) so a parametric scene can
    // be previewed live during planning, not just named presets.
    payload.scene = /^[\w-]+$/.test(body)
      ? { name: body }
      : { js: body, libs: ['three'] };
  } else {
    if (!body && !title) return 'screen.preview needs content, e.g. screen.preview("text | Title | body text").';
    payload.text = body;
    payload.fit = 'auto';
  }

  const res = await _postJson(MAIN_PORT, '/screen/display', payload, '', 4000);
  if (!res || res.ok === false) {
    return `screen.preview FAILED — the GhostLayer didn't take the display (${res?.error || 'no response'}). Describe the deliverable in text instead.`;
  }
  return `Preview shown on the user's screen (${kind}${payload.title ? ` — "${payload.title}"` : ''}). It's a draft — tell the user it stays up until they tap it away, and this is what the plan will produce.`;
}

// Strip PTY delta down to real output: ANSI codes, exit markers, zsh init
// noise, end-of-output markers, and the trailing user@host prompt line.
const _PTY_ANSI_RE = /\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07]*(?:\x07|\x1b\\)/g;
function _ptyCleanDelta(delta) {
  return String(delta || '')
    .replace(_PTY_ANSI_RE, '')
    .split('\n')
    .filter(l => !l.includes('__TD_EXIT'))
    .filter(l => !/command not found: compdef/.test(l))
    .filter(l => !/^\s*%\s*$/.test(l))
    .join('\n')
    .replace(/(?:^|\n)[^\n]*@\S+\s+[^\n]*[%$#>]\s*$/, '')
    .trim();
}

// Run a log read as a REAL terminal command inside the diagnosis pane — the
// user watches `tail`/`grep` happen; the screen output IS the tool result.
// Falls back to the file helpers when the PTY layer is unreachable.
async function _ptyLogsCmd(shellCmd, fallbackFn) {
  const r = await _ptyDiagnose(shellCmd);
  const text = r && r.ok !== false ? _ptyCleanDelta(r.delta) : '';
  return text || fallbackFn();
}

function _ptyCmdText(r) {
  return r ? _ptyCleanDelta(r.delta) : '';
}

// Tools allowed on the route-pick turn (capability_options arrival) — the
// verified options list is already on screen and the reply this turn must be
// the route question. Lookup tools wait until after the user picks (an
// unrestricted memory.search once produced a wife's-name question riding
// beside the route card — two unrelated questions in one reply).
const ROUTE_PICK_TOOLS = new Set(['capability.select', 'setup.start', 'plan.cancel', 'plan.find', 'plan.open', 'plan.status']);

// Read-only probe runs VISIBLY in the diagnosis pane — but the pane executes
// through a real shell, so the raw string must pass the same verb/metachar
// gate as the spawn path before it can run.
async function _toolCapabilityProbeVisible(commandLine) {
  const gate = capIndex.validateProbeCommand(commandLine);
  if (!gate.ok) {
    return `PROBE DENIED (${gate.denied}) — capability.probe only runs "<cli-tool> <read-only verb>" (help/status/list/version/auth status…). Reissue with an allowed verb.`;
  }
  const r = await _ptyDiagnose(commandLine);
  return _ptyCmdText(r) || await _toolCapabilityProbe(commandLine);
}

// logs.* run as REAL terminal commands in the pane — visible, bounded,
// greppable. Falls back to the file helpers when the PTY layer is unreachable.
async function _toolLogsPty(kind, query) {
  const file = _logFilePath((query || '').split('|')[0].trim().split(/[,\s]/)[0]);
  const args2 = String(query || '');
  let shellCmd = null;
  if (file) {
    if (kind === 'tail') shellCmd = `tail -n ${_parseLogQuery(args2, 80).n} ${JSON.stringify(file)}`;
    else if (kind === 'head') shellCmd = `head -n ${_parseLogQuery(args2, 50).n} ${JSON.stringify(file)}`;
    else if (kind === 'grep') {
      const parts = args2.split('|').map(s => s.trim());
      const gm = (parts[1] || '').match(/^([^\s,"]+)(?:[,\s]+(\d+))?/);
      shellCmd = gm ? `grep -n -i -C${gm[2] || 3} ${JSON.stringify(gm[1])} ${JSON.stringify(file)} | head -n 120` : null;
    } else {
      const parts = args2.split('|').map(s => s.trim());
      const rm = (parts[1] || '').match(/(\d+)\s*-\s*(\d+)/);
      shellCmd = rm ? `sed -n '${rm[1]},${rm[2]}p' ${JSON.stringify(file)} | nl -ba -v${rm[1]}` : null;
    }
  }
  const fb = kind === 'tail' ? () => _toolLogsTail(query)
           : kind === 'head' ? () => _toolLogsHead(query)
           : kind === 'grep' ? () => _toolLogsGrep(query)
           : () => _toolLogsRange(query);
  return shellCmd ? await _ptyLogsCmd(shellCmd, fb) : fb();
}

function _shortPath(p) {
  const s = String(p || '').trim();
  const tail = s.split('/').filter(Boolean).pop() || s;
  return s.length > 60 ? `…/${tail}` : s;
}
function _logLabel(q) {
  return String(q || '').split('|')[0].trim().split(/[,\s]/)[0] || 'log';
}

// Tool registry — name → {note(arg) → ticker line, run(arg, ctx) → result text}.
// The directive's TOOLS section must stay in sync with these keys; the drift
// check at the bottom of this file warns when they diverge.
const TOOL_HANDLERS = {
  'memory.search':     { note: q => `searching memory for "${q}"…`,              run: (q) => _toolMemorySearch(q) },
  'memory.update':     { note: () => 'updating stored memory…',                  run: (q) => _toolMemoryUpdate(q) },
  'memory.delete':     { note: () => 'deleting stored memory…',                  run: (q) => _toolMemoryDelete(q) },
  'memory.store':      { note: () => 'saving to memory…',                        run: (q) => _toolMemoryStore(q) },
  'profile.get':       { note: () => 'checking stored profile fact…',            run: (q) => _toolProfileGet(q) },
  'profile.set':       { note: q => `storing profile fact ${String(q || '').split('|')[0]}…`, run: (q) => _toolProfileSet(q) },
  'episodic.search':   { note: q => `searching activity history for "${q}"…`,    run: (q) => _toolEpisodicSearch(q) },
  'memory.getAppUsageSummary': { note: () => 'summarizing app usage…',           run: (q) => _toolAppUsage(q) },
  'web.search':        { note: q => `searching the web for "${q}"…`,             run: (q) => _toolWebSearch(q) },
  'media.resolve':     { note: q => `finding playable media: "${q}"…`,           run: (q) => _toolMediaResolve(q) },
  'screen.read':       { note: () => 'reading the screen…',                      run: (q) => _toolScreenRead(q) },
  'capability.search': { note: q => `looking up capabilities for "${q}"…`,       run: (q, ctx) => ctx?.opts?.optionsTurn
                          ? 'SKIPPED — a verified route-options list was already shown for this turn. Do not re-search; ask the user to pick from the list.'
                          : _toolCapabilitySearch(q) },
  'capability.probe':  { note: q => `probing ${String(q || '').split(/\s+/)[0] || 'tool'}…`, run: (q) => _toolCapabilityProbeVisible(q) },
  'capability.select': { note: q => `registering ${q}…`,                         run: (q) => _toolCapabilitySelect(q) },
  'plan.find':         { note: q => `searching saved plans for "${q}"…`,         run: (q) => _toolPlanFind(q) },
  'plan.open':         { note: q => `opening saved plan ${q}…`,                  run: (q, ctx) => _toolPlanOpen(q, ctx?.sessionId) },
  'plan.status':       { note: () => 'checking plan status…',                    run: (q, ctx) => _toolPlanStatus(q, ctx?.sessionId) },
  'plan.cancel':       { note: () => 'cancelling the plan…',                     run: (q, ctx) => _toolPlanCancel(q, ctx?.sessionId) },
  'journal.recent':    { note: () => 'checking the task journal…',               run: (q) => _toolJournalRecent(q) },
  'url.open':          { note: q => `opening ${q}…`,                             run: (q, ctx) => _toolUrlOpen(q, ctx?.sessionId) },
  'setup.start':       { note: q => `starting ${q} setup in the terminal…`,      run: (q) => _toolSetupStart(q) },
  'screen.preview':    { note: () => 'rendering a preview on screen…',           run: (q) => _toolScreenPreview(q) },
  'system.map':        { note: () => 'loading ThinkDrop system map…',            run: () => sysMap.renderLayout() },
  'logs.tail':         { note: q => `tailing ${_logLabel(q)}…`,                  run: (q) => _toolLogsPty('tail', q) },
  'logs.head':         { note: q => `reading top of ${_logLabel(q)}…`,           run: (q) => _toolLogsPty('head', q) },
  'logs.grep':         { note: q => `searching ${_logLabel(q)} logs…`,           run: (q) => _toolLogsPty('grep', q) },
  'logs.range':        { note: q => `reading ${_logLabel(q)} lines…`,            run: (q) => _toolLogsPty('range', q) },
  'fs.read':           { note: q => `reading ${_shortPath(q)}…`,                 run: (q) => _toolFsRead(q) },
  'dir.list':          { note: q => `listing ${_shortPath(q)}…`,                 run: (q) => _toolDirList(q) },
  'fs.stat':           { note: q => `checking ${_shortPath(q)}…`,                run: (q) => _toolFsStat(q) },
  'fs.search':         { note: q => `searching files under ${_shortPath(q)}…`,   run: (q) => _toolFsSearch(q) },
  'doc.read':          { note: q => `extracting text from ${_shortPath(q)}…`,    run: (q) => _toolDocRead(q) },
};

/**
 * Extract + execute every <tool>name("arg")</tool> marker in a model reply.
 * Returns { text, toolCalls } — text is the <tool_results> body injected back
 * as the next user turn; toolCalls is the structured record for metadata so
 * the UI can show what actually ran. Returns null when no marker exists.
 */
async function _runTools(text, sessionId, opts = {}) {
  const calls = [];
  _TOOL_CALL_RE.lastIndex = 0;
  let m;
  while ((m = _TOOL_CALL_RE.exec(text)) !== null) {
    calls.push({ tool: m[1], query: _toolArg(m[2]) });
  }
  if (!calls.length) return null;
  const results = [];
  const toolCalls = [];
  for (const call of calls.slice(0, 4)) {
    logger.info('[Planning] Tool call', { tool: call.tool, query: call.query });
    const handler = TOOL_HANDLERS[call.tool];
    let out, ok = true;
    if (opts.routePickTurn && !ROUTE_PICK_TOOLS.has(call.tool)) {
      ok = false;
      out = 'SKIPPED — the verified route-options list is already on screen. Ask which route the user wants; other lookups wait until after they pick.';
    } else if (!handler) {
      // Unknown name — the model called a tool that doesn't exist in this
      // lane (e.g. fs.read before it was registered, or a run-lane agent name
      // like edit.agent). Correct it explicitly so the next round calls a
      // real tool instead of fabricating a result to match the narration.
      ok = false;
      await _ptyNote(`unknown tool ${call.tool} — correcting…`);
      logger.warn('[Planning] Unknown tool call — injecting correction', { tool: call.tool });
      out = `UNKNOWN TOOL "${call.tool}" — it does not exist in this lane. Valid tools: ${Object.keys(TOOL_HANDLERS).join(', ')}. To read local files/folders/documents use fs.read, dir.list, doc.read, or fs.search. Re-emit the call with a valid name, or answer only from what is already known.`;
    } else {
      try {
        const note = typeof handler.note === 'function' ? handler.note(call.query) : null;
        if (note) await _ptyNote(note);
        out = await handler.run(call.query, { sessionId, opts });
        if (out == null || out === '') { ok = false; out = '(no result)'; }
        else if (/^(?:[\w.]+\s+)?(?:failed|FAILED|denied|DENIED|SKIPPED|threw)\b|\bfailed:/i.test(String(out).slice(0, 80))) ok = false;
      } catch (err) {
        ok = false;
        out = `${call.tool} threw: ${err.message}`;
        logger.warn('[Planning] Tool call threw', { tool: call.tool, error: err.message });
      }
    }
    const brief = String(out || '').split('\n')[0].slice(0, 90);
    _activity(`${call.tool} ${ok ? 'done' : 'failed'} — ${brief}`, ok ? 'tool' : 'warn');
    toolCalls.push({ tool: call.tool, query: call.query || '', ok, detail: brief });
    results.push(`${call.tool}("${call.query || ''}") →\n${out}`);
  }
  if (calls.length > 4) {
    results.push(`(${calls.length - 4} more tool call(s) ignored — at most 4 run per turn)`);
  }
  return { text: results.join('\n\n'), toolCalls };
}

// ── Planning directive (appended to the persona system prompt) ────────────────

const PLANNING_DIRECTIVE = `

═══════════════════════════════════════════════
PLANNING MODE — ACTIVE NOW
═══════════════════════════════════════════════
You are in PLANNING mode. The user is building a multi-task plan with you —
you will NOT execute anything yourself. Your job is to (1) gather the context
needed to make the plan correct, and (2) maintain the plan's Task list.

TOOLS — when you need facts about the user or the world, emit ONE of:
  <tool>memory.search("query")</tool>       — the user's stored facts/preferences;
  <tool>memory.store("fact text")</tool>    — save a fact the user asked to remember;
  <tool>profile.get("name")</tool>          — canonical profile attribute (self:name,
                                            self:email, …); use when memory.search
                                            doesn't have a direct fact.
  <tool>profile.set("name|John")</tool>     — write a canonical profile attribute;
  <tool>episodic.search("query|days")</tool> — activity/capture history: what the
                                            user was watching/reading/doing. Use
                                            for "what have I been watching/doing".
  <tool>memory.getAppUsageSummary("hours")</tool> — per-app usage durations
                                            ("apps I used", "how long in X").
                                            each result line starts with its
                                            [memoryId] for update/delete calls
  <tool>memory.update("id|new text")</tool> — rewrite a stored fact by memoryId
  <tool>memory.delete("id")</tool>          — remove a stale/wrong fact by memoryId
  <tool>web.search("query")</tool>          — live web research (results include URLs)
  <tool>media.resolve("name")</tool>        — find a playable video/song by name via
                                            YouTube search (yt-dlp). Returns real
                                            watch URLs catt can cast. Prefer this
                                            over web.search for "find X and cast/
                                            play it" requests — it can't 404.
  <tool>capability.search("query")</tool>   — what can accomplish this: registered
                                            agents, CLIs, APIs, MCP servers, and
                                            built-in tools, ranked easiest-to-
                                            setup first with a per-option "setup:"
                                            summary.
  <tool>capability.probe("gh auth status")</tool> — read-only CLI check: first
                                            token is the tool, rest is a read-only
                                            command (help/status/whoami/list/
                                            version/auth status/doctor/scan).
                                            Use it to learn whether a tool is
                                            installed, signed in, or what flags
                                            it takes. It cannot change anything.
  <tool>screen.read("optional focus")</tool> — look at the user's live screen:
                                            returns the active app, URL, window
                                            title, and recent OCR text. Use it
                                            whenever the request refers to "this",
                                            "my screen", "this app/site/tool" —
                                            NEVER claim you can take a screenshot
                                            or that you can't see; this IS how
                                            you see. OCR text may lag the live
                                            screen by a few seconds.
  <tool>capability.select("twilio")</tool>  — after the user picks an option that
                                            is NOT already a registered agent,
                                            call this ONCE to register it as a
                                            draft agent. It returns the agentId
                                            to put in the task's Agents line.
                                            ONLY call this for an option the user
                                            explicitly picked from a <choices>
                                            card — never on your own initiative,
                                            and never for a need a LOCAL LANE or
                                            registered agent already covers.
                                            Setup still happens at plan-check —
                                            this only files the intent. It does
                                            NOT create the task — the task does
                                            not exist until you emit
                                            <plan_update> using the returned
                                            agentId in the same reply or the
                                            next one. Never say the task/plan
                                            is set up before that marker lands.
  <tool>plan.find("nylas")</tool>           — search SAVED plans on disk by name/
                                            title/task text. Use this (not
                                            memory.search) for "the X plan",
                                            "do we have a plan for Y" —
                                            memory.search only knows user facts.
  <tool>plan.open("plan_…")</tool>          — make a saved plan the active plan
                                            for this session. Reopens terminal
                                            (failed/cancelled) plans: resets
                                            failed/skipped tasks to pending.
  <tool>plan.status()</tool>                — LIVE run state of the active plan
                                            (or "plan.status("plan_…")" for a
                                            specific one): running/cancelled,
                                            per-task status, approvals waiting.
                                            "is it still running", "did it
                                            finish", "where is it at" → call
                                            this first. NEVER answer status
                                            questions from memory or vibes.
  <tool>plan.cancel()</tool>                — actually cancels the plan/run NOW
                                            (stops the run, clears held cards).
                                            When the user asks to cancel/stop/
                                            abort the plan, call this — NEVER
                                            say it was cancelled without it.
  <tool>journal.recent("email")</tool>      — REAL task history: what has
                                            actually run lately (status + when).
                                            "what did I do this week", "what's
                                            been running", "did the X send" →
                                            this tool. Number arg = how many
                                            (default 15).
  <tool>fs.read("absolute/path")</tool>     — read a local file's REAL contents
                                            (text/code/markdown/json). For
                                            rtf/pdf/docx use doc.read —
                                            fs.read can't decode binary
                                            formats. Use dir.list first when
                                            you don't know the exact filename.
  <tool>dir.list("absolute/path")</tool>    — directory tree of a folder: file
                                            names and structure. Use this when
                                            the user names a folder you haven't
                                            seen.
  <tool>doc.read("absolute/path")</tool>    — extract text from rtf, pdf, docx,
                                            doc, xlsx, pptx, odt, html.
  <tool>fs.search("path | pattern")</tool>  — grep a file or directory for a
                                            pattern (pipe separates them).
  <tool>fs.stat("absolute/path")</tool>     — file metadata without reading:
                                            exists? size? last modified?
  <tool>setup.start("nylas")</tool>         — ThinkDrop runs the service's real
                                            setup ITSELF in the terminal pane:
                                            init/auth/install commands, then it
                                            verifies and resumes the plan. Call
                                            this when a service needs setup —
                                            NEVER tell the user to run setup
                                            commands themselves (no "run nylas
                                            init", no "run gh auth login"). The
                                            result may include a setupUrl for
                                            the console/dashboard — relay it.
  <tool>screen.preview("kind | title | content")</tool>
                                          — show a DRAFT of the plan's deliverable
                                            on the user's screen (GhostLayer).
                                            kind ∈ text|image|chart|effect|emoji|
                                            alert|deck|scene|three|doc. Use it
                                            when the plan produces a visual
                                            artifact (chart, slideshow, essay,
                                            3D model, animation) so the user
                                            approves against a real preview —
                                            NOT as a substitute for the final
                                            step, which stays a screen.display
                                            task. chart content = "label N"
                                            pairs; deck = slides split by "--";
                                            doc = markdown; three = preset name
                                            (starfield/particles/wave/cube/knot/
                                            globe); scene = a registered scene
                                            name. Do NOT try to pass generated
                                            scene code — the arg is one quoted
                                            string and cannot carry code.
  <tool>url.open("https://…")</tool>       — open a page in the user's browser.
                                            Use when they must personally sign
                                            up, log in, verify, approve scopes,
                                            or copy a credential — and only with
                                            a REAL URL (from setup.start's
                                            setupUrl, capability info, or
                                            web.search). Never invent URLs.
  <tool>system.map</tool>                  — ThinkDrop's own data layout:
                                            what every ~/.thinkdrop folder holds
                                            and which service runs on which port.
  <tool>logs.tail("comms-graph", 100)</tool> — tail a project log
                                            (logs/<name>.log: main, comms-graph,
                                            command, …). For "why did X fail /
                                            didn't it work" — check logs first.
  <tool>logs.head("main", 50)</tool>      — first N lines of a log — startup
                                            failures live at the top, never tail.
  <tool>logs.grep("comms-graph | EADDRINUSE | 3")</tool>
                                        — search a log for a pattern with
                                            ±context lines and line numbers.
  <tool>logs.range("comms-graph | 120-180")</tool>
                                        — print lines N-M of a log (zoom into
                                            a region grep located).
Use at most 3 tool calls per turn, then answer. Tool results come back inside
<tool_results>. Do NOT use tools for things you already know.

VISIBILITY — every tool call you emit appears on the user's live activity
line; the user can see exactly what you are doing. NEVER narrate work in
progress — no "I'm looking into that", "I'm running this", "checking that
folder", "one moment while I…", "let me read that file" — a reply that
describes work in progress without a <tool> call is REJECTED and you get
one more turn to emit the real call. Emit the tool call; the ticker shows
it. Your words should carry only conclusions, questions, or plan changes.
NEVER write <tool_results> yourself — results are system-generated; a
<tool_results> block in your reply is stripped and rejected. If a tool
fails or returns nothing useful, say that plainly — never imply a check
ran when it didn't.

LOCAL LANES — reading, writing, moving, searching, or converting files on
THIS computer is NEVER a capability gap. When YOU need to look at a file
or folder while drafting, the tools above cover it directly:
fs.read / dir.list / doc.read / fs.search / fs.stat as <tool> calls. When a
TASK needs local file work at run time, shell, edit.agent, shell.run,
cli.agent cover it — put them in the Agents line. Never
capability.search/select and never pin an MCP server or external CLI just
to touch the user's own files, folders, clipboard, or screen.
capability.search is for EXTERNAL services only (APIs, SaaS tools, web
services, device control).

CLARIFY — when the request is ambiguous, underspecified, or risky, ask ONE
question at a time (important for voice). Good questions resolve: target
service/account, names/titles, timing, dependencies between steps, and
whether the user is already signed in. Scan the conversation before asking —
NEVER re-ask anything the user already answered, including bundled answers
like "friday, dentist appt". The moment route + required details are known,
emit <plan_update> in this same reply — no extra confirmation questions.

PLAN UPDATE — whenever the plan changes (first draft, edits after answers),
emit the COMPLETE task list inside <plan_update>...</plan_update> using this
exact block format for every task:

<plan_update>
## Task 1 — Short title
- **Prompt**: A self-contained instruction a single automation run can execute
- **Agents**: names from REGISTERED AGENTS below | shell | edit.agent | none
- **Depends on**: — | Task 1, Task 2
- **Mode**: sequential | parallel
- **Approval**: required  ← ONLY on tasks with real-world side effects
- **Done when**: a checkable success criterion (optional)
## Task 2 — ...
...
<risks>
- risk or side effect worth flagging before run (optional)
</risks>
</plan_update>

RULES for tasks:
- Each Task = ONE deliverable for ONE service/action — never mix services in
  one Task. "Doc + Calendar + Sheet" = 3 tasks.
- Prompt must stand alone: include titles, dates, column names — the run has
  no memory of this conversation. If it needs an earlier result, say so in
  Depends on and phrase it as "the result of the previous step".
- Never prescribe specific binaries or tools in a Prompt (no "using pandoc",
  "run pdftotext", "via curl"). Name the file/goal ("extract the text from
  <path>") — the runtime's registered skills (e.g. doc.read for documents)
  pick the actual tool, and a named binary may not even support the format.
- Mode: parallel only for tasks with NO dependency and different services.
- Keep task count honest — do not split trivially.
- Content stored IN a service (a Doc, Sheet, event, email) is its own Task
  with that service's agent — never bury service URLs inside research or
  compile tasks; research gathers data into local files.
- GATHER → REVIEW → COMMIT — never fuse searching and committing into one
  task. Anything with a real-world side effect (book, buy, pay, reserve,
  send, post, delete, submit a form that commits) is its OWN task carrying
  "- **Approval**: required", depends on the gather task, and its Prompt says
  "using the result of Task N". Research/search/compare tasks stay on
  web.agent / web.crawl — do NOT spend a signed-in browser session on
  read-only lookups (they hit bot walls and burn auth sessions).
- ONE agent per task — never list alternates like "expedia.agent |
  skyscanner.agent". If interchangeable services could serve the same
  deliverable, emit a <choices> block first and let the user pick, then
  write the task with the chosen agent.

AGENTS — every Task's Agents line uses ONLY names from the REGISTERED AGENTS
catalog injected below — never invent an agent id (e.g. "doc.agent" when the
registry says "google_docs.agent"). Generic surfaces — browser.agent,
web.agent, edit.agent, shell, cli.agent, screen.display — are execution
lanes, not services; a task whose deliverable lives on a registered service
names that service's agent.

SCREEN DELIVERABLES — the GhostLayer IS the render surface for visual
artifacts. screen.display (a task's Agents name) paints natively on the
user's screen — NO html files, NO "open in browser", NO python/image tooling.
Kinds: text | image | chart | deck | doc | scene | three | effect | emoji |
alert. Chart = antV (pie/donut/bar/line/area/stat with real data). Deck =
slideshow with controls. Doc = editable markdown card. Scene = GENERATED
three.js code — parametric 3D models (a car, a molecule, a diagram),
custom animations, anything a preset can't express; the scene model writes
the code at run time, so the task Prompt must carry the full visual spec
(dimensions, parts, materials, colors) AND the interaction words the user
asked for ("orbitable", "drag to rotate") — pointer capture keys off them.
Three = instant presets: starfield | particles | wave | cube | knot | globe
— fine for generic ambient 3D, NOT for a specific object (a sedan is a
scene). For literal-data visuals (chart/deck/doc/text) you MAY preview first
with <tool>screen.preview("kind | title | content")</tool> so the user
approves a real draft — but NEVER preview a scene: the preview tool arg is a
single quoted string and cannot carry generated code, and the code doesn't
exist until run time anyway. Either way the final Task still ends with
screen.display as the delivery step. Example for a 3D car: Task "Render the
parametric sedan scene on screen" with Agents: screen.display and a Prompt
that says screen.display kind=scene with the full spec + "orbitable via drag".

ROUTING PREFERENCE — prefer type:cli/api/mcp agents over type:browser agents
when both could satisfy the deliverable. Deterministic CLIs/APIs are faster
and far more reliable than browser automation. Exception: keep the browser
agent when its service has a trained playbook the user expects (signed-in
app flows like composing in Gmail) or when no programmatic agent covers the
capability. Browser agents are the last resort, not the default.

CAPABILITY GAP — if a task needs something no registered agent covers (e.g.
"send a text", a service nobody built an agent for), FIRST use
<tool>capability.search("...")</tool> for ranked candidates (CLIs, APIs, MCP
servers, built-in tools — already ordered easiest-to-setup). Fall back to
<tool>web.search</tool> only if capability.search finds nothing. Then emit
ONE structured choice block and wait for the user to pick:
  <choices>{"question": "Which service should I use for X?",
    "options": [{"label": "...", "description": "...", "url": "..."},
                {"label": "...", "description": "...", "cliTool": "..."},
                {"label": "None of these", "description": "..."}]}</choices>
CHOICE RULES — order options exactly as capability.search returned them
(easiest setup first). Put "[Recommended] " in front of the FIRST option's
label — the user usually just accepts it. Each option's description MUST
open with its verbatim "setup:" + "eta:" text (e.g. "needs an API key (paste
once) — ~2 min, you paste the key") — the user must see what they're signing
up for BEFORE they pick — then add the real trade-off (costs money, needs an
account, uses your browser login). Carry "friction" and "setup" as structured
fields on each option so the UI can badge them. If EVERY option needs
sign-in or a developer account (friction ≥4), say so in the question text
("all routes need a sign-in — easiest is X") — never present a hard path as
if it were easy. Keep options to 4 max + "None of these".
If the user is already signed in somewhere (capability.probe showed it),
prefer that option even at slightly higher setup cost — mention why.
AFTER the user picks a setup-needing option, the task that does the setup
should say what they'll experience ("I'll drive the install; you'll paste a
key when asked") — no surprise prompts mid-run.
AFTER THE USER PICKS — if the choice is already a registered agent, use it
directly in the Agents line. If it is a new CLI/API/MCP/local tool, emit
<tool>capability.select("<tool-or-service-name>")</tool> FIRST — it files a
draft agent descriptor and returns the agentId your Agents line must use.
If nothing viable exists, say so and offer alternatives (nearest registered
agent, or a manual step the user does themselves).

NEVER FAKE A RESULT — do not claim you searched, found, downloaded, or sent
anything unless a <tool_results> entry in this conversation actually contains
it. If the task needs a URL/link/file path, quote the exact URL from the tool
result inside the Task's Prompt — a task that says "the video found earlier"
will fail because the run can't see this conversation. If a tool returns an
error or empty results, try media.resolve or a different query before asking
the user.

CAPABILITY FIT — when the user names a target but not a clear action ("connect
to my chromecast", "use the scanner", "talk to my printer"), or when a chosen
tool may not actually do what was asked ("mirror my screen" vs a media caster),
do NOT write tasks yet. First call <tool>capability.probe("<tool> --help")</tool>
to read the tool's real capabilities, then either ask ONE clarifying question
("what should I do on it — cast a video, play audio, check status?") or emit
<choices> describing what the tool CAN do. Never commit a tool to a Task for
an action it doesn't support.

OTHER MARKERS (optional):
  <plan_name>dot.syntax.name</plan_name> — when the user names the plan
    (e.g. history.project.plan) or you propose one and they accept.
  <plan_desc>one-sentence summary</plan_desc> — once the plan firms up (with
    or after <plan_status>ready</plan_status>). One sentence capturing the
    goal, key dates/constraints, and deliverables — NOT the user's literal
    message. Shown under the plan title as the plan's description.
  <plan_status>ready</plan_status> — when the user confirms the plan is good
    to run AND every task is concrete. Do not mark ready while asking questions.
  <plan_run/> — when the user confirms they want to EXECUTE the plan now
    ("let's do it", "run it", "go ahead", "I'm ready"). Emitting this marker
    REQUESTS the run — the app then performs a readiness check and reports
    the result back as its own message. NEVER say tasks are "running" or
    "queued" — say you're starting the plan check. The check decides what
    happens next: all-clear with no approval gates starts the run itself;
    approval-gated plans wait for the user to press "Run all" / "Review
    task" on the card — if that's needed, say exactly that ("press Run all
    on the readiness card to start"). Only emit when the plan has tasks —
    on an empty plan it is REJECTED and nothing runs; emit <plan_update>
    with the tasks first. If you're still gathering info, keep asking instead.
    If RUN GATE says BLOCKED, a run will be refused — never tell the user
    tasks are running; state which agent needs attention instead.
  <plan_exit/> — when the user wants OUT of planning mode ("stop planning",
    "exit planning", "leave plan mode", "I'm done planning", "forget the
    planning"). Emitting this marker REALLY flips the mode off in the app —
    the plan draft stays saved and resumable ("continue the plan"). Never say
    planning mode is off/closed/exited without this marker — it is the ONLY
    thing that exits. Also emit it when a turn resolves COMPLETELY through a
    tool result — a stored fact, an answered question — with no plan drafted:
    confirm in one sentence and emit <plan_exit/>. Planning is for plans; a
    turn that ended in a single action leaves the lane.

REPLY TEXT — everything outside the markers is spoken/shown to the user.
Keep it short and conversational: acknowledge, ask your one question, or
summarize what changed in the plan. Do not restate the whole plan in prose.

TRUTHFULNESS — NEVER claim something happened that a tool or marker did not
produce. No "cancelled", "sent", "done", "finished at <time>", "running",
"queued", "scheduled", or remembered facts without the matching tool result.
Status question → plan.status. History/activity question → journal.recent.
Cancel/stop request → plan.cancel (its result tells you what actually stopped).
A plan is "running" ONLY when plan.status reports a live run. Tasks marked
interrupted or waiting-for-input mean the plan is PAUSED — say so plainly and
offer to resume ("say 'run it'"), never narrate progress that isn't happening.
Question about the user → memory.search ALWAYS first — even "what do you
remember about me". If a tool fails, report the failure; never fill the gap
with a plausible-sounding answer.

PERSONAL EVENT WITHOUT AN ACTION — when the user states a future event but
says nothing about what to do ("I have an appointment next week at 5",
"my dentist appt is friday"), do NOT just store it or draft a plan blindly.
Offer <choices>: "Just remember it", "Add to my calendar", "Set a reminder" —
and if the day/date or other detail is missing, ask for it in the same turn
before drafting any tasks. When the user PICKS a choice, DO it — memory.store
for "remember it", a drafted task for calendar/reminder — never only
acknowledge with words like "noted" or "filing that away".

CONFLICTING MEMORY — when memory.search returns contradictory values for the
same fact (e.g. two different names for "my wife"), do NOT pick one silently
and do NOT fold the question into a plan draft. Ask the user via <choices>
with each stored value as an option plus "Neither — let me tell you". After
the user answers, reconcile immediately: call memory.update("<id>|<corrected
text>") to fix the stale entry or memory.delete("<id>") to remove it, then
continue with the task. The [id] prefix on each result line is the memoryId.

NO EXECUTION FROM THIS LANE — you cannot dispatch work: no handoff, no
background task, no "let me run that" — there is no mechanism. The only run
lever is <plan_run/> (the WHOLE approved plan). When the user asks to just
do something now that is NOT the plan ("just send it", "do that now",
"actually never mind the plan, do X"): say it needs leaving planning and
emit <plan_exit/>, or offer to add it as a Task. Never write "doing that
now", "on it", "handing this off", "one sec while I…", or "let me check"
for anything that isn't a <tool> call in THIS turn.

SETUP & LINKS — when a service needs setup (account, auth, credentials,
install): call setup.start — ThinkDrop runs the real commands in the
terminal itself and resumes the plan after it verifies. NEVER instruct the
user to run setup commands ("run nylas init", "run gh auth login",
"npm install …") — setup.start does it. When the user must personally visit
a page (sign up, log in, verify, approve scopes, copy an API key), ALWAYS
give the direct URL and offer to open it via url.open — real URLs only
(setup.start's setupUrl or a web.search result); never guess a URL.
═══════════════════════════════════════════════`;

// Directive ↔ registry drift check — a tool the directive doesn't document
// gets called by name anyway (the model saw it in run-lane docs) and the old
// allowlist regex silently dropped it; a documented tool with no handler
// hangs the same way. Warn loudly at boot so the lists can't drift silently.
try {
  for (const name of Object.keys(TOOL_HANDLERS)) {
    if (!PLANNING_DIRECTIVE.includes(`<tool>${name}`)) {
      logger.warn(`[Planning] Directive missing tool doc: ${name}`);
    }
  }
} catch (_) {}

// ── Marker extraction ─────────────────────────────────────────────────────────

function _extractTag(text, tag) {
  const m = String(text || '').match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`));
  return m ? m[1].trim() : null;
}

/**
 * Incremental marker filter for streaming: emits prose while swallowing
 * <tool>/<plan_update>/<plan_name>/<plan_status>/<plan_run>/<tool_results>
 * blocks — even when a tag is split across chunk boundaries. Unknown tags
 * pass through literally.
 */
// Includes 'budget:token_budget' — a provider scaffolding artifact (model
// echoes its context-window tag inside content). Not a lane marker; stripped
// at the backend's ThinkStripper too — this is defense-in-depth.
const _STREAM_MARKERS = new Set(['tool', 'plan_update', 'plan_name', 'plan_status', 'plan_desc', 'tool_results', 'choices', 'plan_exit', 'budget:token_budget']);

class _StreamFilter {
  constructor(onEmit) { this.onEmit = onEmit; this.buf = ''; this.sink = null; this.visible = 0; }
  push(chunk) { this.buf += chunk; this._drain(false); return this.visible; }
  flush() { this._drain(true); return this.visible; }
  _emit(s) { if (s) { this.visible += s.length; if (this.onEmit) { try { this.onEmit(s); } catch (_) {} } } }
  _drain(end) {
    for (;;) {
      if (this.sink) {
        const close = this.buf.indexOf(`</${this.sink}>`);
        if (close === -1) { if (end) this.buf = ''; return; }
        this.buf = this.buf.slice(close + this.sink.length + 3);
        this.sink = null;
        continue;
      }
      const lt = this.buf.indexOf('<');
      if (lt === -1) { this._emit(this.buf); this.buf = ''; return; }
      if (lt > 0) { this._emit(this.buf.slice(0, lt)); this.buf = this.buf.slice(lt); }
      const gt = this.buf.indexOf('>');
      if (gt === -1) { if (end) { this._emit(this.buf); this.buf = ''; } return; }
      const tag = this.buf.slice(1, gt).trim();
      const m = tag.match(/^([a-z_][a-z0-9_:]*)\s*(\/)?$/i);
      if (m && (_STREAM_MARKERS.has(m[1]) || m[1] === 'plan_run' || m[1] === 'plan_exit')) {
        if (m[1] === 'plan_run' || m[1] === 'plan_exit' || m[2]) { this.buf = this.buf.slice(gt + 1); continue; }
        this.sink = m[1];
        this.buf = this.buf.slice(gt + 1);
        continue;
      }
      // Orphan closing tag for a known marker — drop it silently.
      const cm = tag.match(/^\/([a-z_][a-z0-9_:]*)$/i);
      if (cm && (_STREAM_MARKERS.has(cm[1]) || cm[1] === 'plan_run' || cm[1] === 'plan_exit')) {
        this.buf = this.buf.slice(gt + 1);
        continue;
      }
      // Unknown tag (or a closing tag) — emit the '<' literally and rescan.
      this._emit('<');
      this.buf = this.buf.slice(1);
    }
  }
}

// Provider scaffolding artifact — strip the pair plus orphan closers so the
// tag never reaches display text or stored conversation history.
function _stripMetaTags(text) {
  return String(text || '')
    .replace(/<budget:token_budget>[\s\S]*?<\/budget:token_budget>/gi, '')
    .replace(/<\/?budget:token_budget\s*\/?\s*>/gi, '');
}

// Model-emitted <tool_results> blocks are fabrications — real results are
// injected by this lane as user-role turns. Strip them (closed AND unclosed)
// from assistant text before it enters history or display.
function _stripFabricatedResults(text) {
  return String(text || '')
    .replace(/<tool_results>[\s\S]*?<\/tool_results>/gi, '')
    .replace(/<tool_results>[\s\S]*$/gi, '');
}

// Reply prose that claims in-progress tool work — used by the stall gate.
// Broad set feeds the decision-model question; the tight set is the fallback
// verdict when phi4 is unreachable (fail toward honesty, never toward silent
// fabrication).
const _CLAIM_TOOL_WORK_RE = /\b(?:let me|i'?ll|i'?m|i am|i will|going to|one (?:sec|second|moment|minute)|hold on|bear with me)\b[^.!?\n]{0,80}\b(?:read|reading|check|checking|look|looking|pull(?:ing)? up|open|opening|search|searching|scan|scanning|list|listing|fetch|fetching|load|loading|inspect|examining|grab|grabbing|find|finding|retriev\w+|review\w+|load up|bring up)\b|\b(?:reading|checking|searching|scanning|listing|fetching|loading|opening|inspecting|pulling up|looking at)\s+(?:the|your|that|both|this)\b/i;
const _STRONG_CLAIM_RE = /\b(?:i'?m (?:now )?(?:reading|checking|looking|pulling|opening|searching|scanning|fetching|loading|listing)|let me (?:read|check|look|pull|open|search|scan|fetch|list)|one (?:sec|moment|minute)|hold on (?:a (?:sec|moment|second) )?while|bear with me while|apolog\w+ for the delay)\b/i;
// Completion claims — "filing that away", "saved", "added it" — a false-DONE
// is worse than a stall: the user believes the action happened. Plan-marker
// vocabulary (drafted/approved/running) is excluded — those come from real
// markers, not tools.
const _CLAIM_COMPLETION_RE = /\b(?:fil(?:ed|ing)\s+(?:that|it|this|away)|saved|stored|noted|added\s+(?:it|that|this|them|to)|done\b|finished|completed|set\s+(?:a\s+|the\s+|your\s+|up\s+a\s+)?reminder|scheduled|booked|created|updated|deleted|cancelled|sent|posted|opened|launched|marked|remembered\s+(?:that|it|this|for\s+you))\b/i;
// Prose describing a plan the model never wrote — the observed failure was a
// reply like "I have everything I need. I'll advance each child to Exodus 7
// and assign new songs…" with NO <plan_update>: the draft stayed empty and
// the user's "do it" dead-ended on "The plan is empty". Catches intent-to-
// edit claims; a trailing question (clarify) still exempts the reply.
const _PLAN_IN_PROSE_RE = /\b(?:i (?:have|got|now have) everything i need|here'?s (?:the|my|a|your) (?:plan|tasks?)|i'?ll|i'?m (?:going|about) to|i will)\b[^.!?\n]{0,90}\b(?:advance|update|edit|assign|add|create|schedule|draft|write|rewrite|fill|populate|pick|choose|set|change|make|move)\b/i;

// ── Repeat-question guard helpers ────────────────────────────────────────────
// Normalize a question for dedup — strip vocalization tags, punctuation, and
// glue words so "Which day next week should I schedule it?" and "Which day
// next week?" share the same content stem.
const _Q_GLUE = new Set(['the','a','an','it','its','your','you','for','of','to','in','on','do','does','did','should','would','could','about','me','my','we','i','just','please','any','some','this','that','be','is','are','was','were','am','at','so','if']);
function _qNorm(q) {
  return String(q || '')
    .toLowerCase()
    .replace(/\[(?:sigh|um|laugh|gasp|crying)\]/g, ' ')
    .replace(/[^a-z0-9 ]/g, ' ')
    .split(/\s+/)
    .filter(w => w && !_Q_GLUE.has(w))
    .join(' ');
}
// ≥70% of the shorter question's content tokens shared → same question.
// (Distinct asks like "call the event" vs "title the event" stay separate.)
function _qSimilar(a, b) {
  const wa = new Set(String(a).split(' ').filter(Boolean));
  const wb = new Set(String(b).split(' ').filter(Boolean));
  const n = Math.min(wa.size, wb.size);
  if (!n) return false;
  let shared = 0;
  for (const w of wa) if (wb.has(w)) shared++;
  return shared / n >= 0.7;
}

function _stripMarkers(text) {
  return _stripMetaTags(String(text || ''))
    .replace(/<tool>[\s\S]*?<\/tool>/g, '')
    .replace(/<plan_update>[\s\S]*?<\/plan_update>/g, '')
    .replace(/<plan_name>[\s\S]*?<\/plan_name>/g, '')
    .replace(/<plan_desc>[\s\S]*?<\/plan_desc>/g, '')
    .replace(/<plan_status>[\s\S]*?<\/plan_status>/g, '')
    .replace(/<plan_run\s*\/?\s*>/g, '')
    .replace(/<plan_exit\s*\/?\s*>/g, '')
    .replace(/<choices>[\s\S]*?<\/choices>/g, '')
    .replace(/<tool_results>[\s\S]*?<\/tool_results>/g, '')
    // Unclosed markers — an open <tool>/<tool_results> with no closer swallows
    // the rest of the reply (the model's fabricated results end mid-stream).
    .replace(/<tool_results>[\s\S]*$/g, '')
    .replace(/<tool>[\s\S]*$/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ── Entry point ───────────────────────────────────────────────────────────────

// Unnamed plan continuation — "continue/resume/pick up/finish the plan" with
// no named referent. Used to decide whether several saved plans need a
// disambiguation card.
const _UNNAMED_RESUME_RE = /\b(?:continu\w*|resum\w*|pick\w* up|carry on|keep going|get back to|work on|finish|go back to|reopen)\b[\s\S]{0,30}\bplan\b|\bplan\b[\s\S]{0,15}\b(?:continu\w*|resum\w*)/i;
function _isUnnamedResume(t) {
  return _UNNAMED_RESUME_RE.test(String(t || ''));
}

// Apply <plan_update>/<plan_name>/<plan_desc>/<plan_status> markers from one
// assistant round. Runs per-round (not just on the final reply) — a
// <plan_update> riding alongside a <tool> call used to be silently dropped
// when the loop continued, leaving "I updated the plan" prose with zero tasks.
// Returns true when the plan actually changed.
async function _applyPlanMarkers(text, sess, unknownAgents) {
  let changed = false;
  const update = _extractTag(text, 'plan_update');
  if (update) {
    const newTasks = planFormat.parseTasks(update);
    if (newTasks.length) {
      // Canonicalize service aliases in the file itself — google_docs.agent →
      // google.agent so preflight and the run lock share one identity.
      for (const t of newTasks) {
        t.agents = (t.agents || []).map(a => canonicalAgent(a) || a);
      }
      // Phantom-agent detection — names that match no registry entry, no
      // generic surface, and no local agent are flagged for the check card
      // (with a "did you mean" suggestion when one is unambiguous).
      try {
        const svcMap = require('../../../shared/service-map.cjs');
        const LOCAL = new Set(['shell', 'none', 'general_knowledge', 'synthesize']);
        for (const t of newTasks) {
          const bad = (t.agents || []).filter(a => {
            const n = String(a).toLowerCase();
            return n && !LOCAL.has(n) && !skillIndex.skillExists(n) && !svcMap.isServiceAgent(a);
          });
          for (const a of bad) {
            const entry = { taskNum: t.num, agent: a, suggested: svcMap.suggestAgent(a) || null };
            if (!unknownAgents.some(u => u.taskNum === entry.taskNum && u.agent === entry.agent)) {
              unknownAgents.push(entry);
            }
          }
        }
      } catch (_) {}
      // Preserve statuses/results for tasks that survive the edit, and carry
      // generated steps over when the task's prompt didn't change.
      for (const t of newTasks) {
        const prev = sess.tasks.find(p => p.num === t.num);
        if (prev && (prev.status !== planFormat.TASK_STATUS.PENDING || prev.result)) {
          t.status = prev.status;
          t.result = prev.result;
        }
        if (prev && prev.prompt === t.prompt) {
          if (prev.steps) {
            t.steps = prev.steps;
            t._stepsHash = prev._stepsHash;
          }
          // 'failed' is sticky while the prompt is unchanged — otherwise a
          // plan_update rewrite would reset it to null and the next
          // _scheduleStepGen pass would re-run the same doomed generation.
          if (prev.stepsStatus != null) t.stepsStatus = prev.stepsStatus;
          if (prev._failedHash != null) t._failedHash = prev._failedHash;
          if (prev._pinnedAgent != null) t._pinnedAgent = prev._pinnedAgent;
        }
      }
      sess.tasks = newTasks;
      // Deterministic tool binding — the LLM planner picks agents by service
      // name and can miss the artifact's creator (observed: a calendar-event
      // delete drafted with google.agent while nylas.agent owned the event).
      // Two deterministic tiers, same as the direct-handoff path: an explicit
      // tool name in the task prompt wins; otherwise the journal's creating
      // agent claims the artifact it made (carries the server-side id).
      try {
        const _ref = require('../artifactReferent.cjs');
        const _recentTasks = require('../taskJournal.cjs').getRecentTasks(25);
        for (const t of newTasks) {
          const _hit = (_ref.resolveExplicitTool && _ref.resolveExplicitTool(t.prompt))
            || _ref.resolve(t.prompt, _recentTasks);
          if (!_hit) continue;
          // A pin the user/model already removed must not be re-applied by
          // the next plan_update — otherwise "remove that agent" gets undone
          // every turn (observed: messages.app.agent re-pinned seconds after
          // the planner cleared it).
          if (t._pinnedAgent === _hit.agentId && !(t.agents || []).includes(_hit.agentId)) continue;
          // Weak-tier hits are bare vocabulary tokens ("messages" inside
          // "commit messages") — in planner-generated task text they name data,
          // never tools. A weak hit can never pin here: not silently, and not
          // via verdict — the candidate shouldn't exist at this layer at all.
          if (_hit.tier === 'weak') continue;
          // The pin only overrides a planner-chosen agent list when context
          // agrees — lexical matching can't tell "text" (scripture) from
          // "text" (SMS), so the decision model vetoes bad binds.
          const _disagrees = (t.agents || []).length && !t.agents.includes(_hit.agentId);
          if (_disagrees) {
            // Give the judge the agent's real identity — "messages.app.agent"
            // alone reads as agreement with the matched word — plus the plan's
            // other tasks so a git-sync plan can't pass for a messaging task.
            const _desc = serviceMap.describeAgent ? serviceMap.describeAgent(_hit.agentId) : null;
            const _who = _desc
              ? `${_hit.agentId} (service "${_desc.service || '?'}", type ${_desc.type || '?'}${_desc.cliTool ? `, drives ${_desc.cliTool}` : ''}${_desc.keywords?.length ? ` — for: ${_desc.keywords.slice(0, 5).join(', ')}` : ''})`
              : _hit.agentId;
            const _planCtx = (newTasks || []).map(x => `${x.num}: ${String(x.prompt || '').slice(0, 100)}`).join(' | ');
            const _verdict = await decision.confirmJudgment({
              site: 'tool-pin',
              question: `A binder wants to assign the tool ${_who} to this task because the word "${_hit.matched || 'artifact'}" appears in it. The word may be ordinary vocabulary (e.g. "commit messages" names git output, not the Messages app). Does this task actually intend to invoke that tool/service?`,
              state: `Plan tasks — ${_planCtx}\nThis task: ${String(t.prompt || '').slice(0, 600)}`,
            });
            if (_verdict === 'NO') {
              logger.info('[Planning] tool pin vetoed by context', { taskNum: t.num, agentId: _hit.agentId, matched: _hit.matched });
              continue;
            }
            if (_verdict !== 'YES' && _hit.tier !== 'strong') {
              // Decision model down — weak lexical matches get no benefit of the doubt.
              logger.info('[Planning] tool pin skipped — no context verdict', { taskNum: t.num, agentId: _hit.agentId, tier: _hit.tier });
              continue;
            }
            logger.info('[Planning] tool pin confirmed by context', { taskNum: t.num, agentId: _hit.agentId, verdict: _verdict || 'model-down' });
          }
          t.agents = [_hit.agentId];
          t._pinnedAgent = _hit.agentId;
          if (_hit.referentDesc && !/\(Resolved referent/i.test(String(t.prompt))) {
            t.prompt = `${t.prompt} (Resolved referent — ${_hit.referentDesc})`;
          }
          logger.info('[Planning] task tool pin', { taskNum: t.num, agentId: _hit.agentId });
        }
      } catch (_) {}
      // Task prompts may only carry media URLs a tool actually returned —
      // an ungrounded watch?v= gets the wrong video cast silently.
      try { _groundTaskMediaUrls(newTasks, sess); } catch (_) {}
      changed = true;
    }
    const risks = _extractTag(update, 'risks');
    if (risks) {
      sess.risks = risks.split('\n').map(l => l.replace(/^\s*-\s*/, '').trim()).filter(Boolean);
      changed = true;
    }
  }
  const nameTag = _extractTag(text, 'plan_name');
  if (nameTag && planFormat.isValidDotName(nameTag)) {
    sess.name = nameTag;
    changed = true;
  }
  // <plan_desc> — generated one-liner replaces the "Plan for:" echo of the
  // original prompt once the plan has real content to summarize.
  const descTag = _extractTag(text, 'plan_desc');
  if (descTag && sess.tasks.length) {
    sess.description = descTag.slice(0, 300);
    changed = true;
  }
  const statusTag = _extractTag(text, 'plan_status');
  if (statusTag === 'ready' && sess.tasks.length) {
    sess.status = 'ready';
    changed = true;
  }
  return changed;
}

/** Match a route-options entry to the gate's recommended pick id — compares
 * against id/service/label with .agent suffix and punctuation normalized. */
function _isRecommended(h, recommendedId) {
  if (!recommendedId || !h) return false;
  const norm = (s) => String(s || '').toLowerCase().replace(/\.agent$/, '').replace(/[^a-z0-9]+/g, '');
  const rec = norm(recommendedId);
  if (!rec) return false;
  return [h.id, h.service, h.label, h.tool].some(v => norm(v) === rec);
}

/**
 * Handle a prompt while planning mode is active.
 *
 * @param {Object} args
 * @param {string} args.englishText   - English user message
 * @param {string} args.systemPrompt  - persona system prompt (planning directive appended here)
 * @param {string} [args.sessionId]   - conversation session this turn routed into
 * @param {Object} [args.planning]    - { active:true, planId?, name? }
 * @param {string} [args.source]      - 'voice' | 'text'
 * @param {Function} [args.onReplyChunk] - stream callback for reply prose
 *   (marker blocks are filtered out before chunks reach this)
 * @returns {Promise<{text, fullText, metadata}>}
 */
async function execute({ englishText, systemPrompt, sessionId, planning = {}, source = 'text', conversationContext = null, onReplyChunk = null, capabilityHints = null, gateReason = null, needsInfo = null, recommended = null, screenContext: passedScreenContext = null }) {
  const startedExplicit = planning.startedExplicit === true;

  // ── Fresh-draft escape — "none of these — start a new plan" (the dismiss
  // option on the resume choice card) and explicit "start a new/fresh plan"
  // phrasing. Unbind the session and open a new draft instead of mutating the
  // still-bound plan. Deterministic reply — no LLM call needed.
  if (/^none of these\b|\bstart (?:a )?(?:new|fresh) plan\b/i.test(String(englishText || '').trim())) {
    _sessionToPlan.delete(sessionId);
    const draft = _getOrCreateSession({
      planId: null, sessionId,
      originalPrompt: '', conversationContext,
    });
    const text = 'Starting a fresh plan — what would you like it to do?';
    return {
      text,
      fullText: text,
      metadata: {
        source: 'planning', intent: 6, planId: draft.planId, planFile: draft.filePath,
        planTitle: draft.title, planName: draft.name, planStatus: draft.status,
        taskCount: 0, authRequired: 0, unknownAgents: [],
        choices: null, runPlan: false, startedExplicit, speakable: true,
      },
    };
  }

  // ── Plan referent detection (pre-binding) ─────────────────────────────────
  // Computed before session resolution: a definite referent or resume phrase
  // is allowed to bind to an existing plan even when preferFresh is set.
  const refMatch = String(englishText || '').match(/\bthe\s+([\w][\w .-]{0,40}?)\s+plan\b/i);
  const referentHit = !!(refMatch && !/^(?:new|next|same)$/i.test(refMatch[1].trim()));
  const unnamedResume = _isUnnamedResume(englishText);

  let boundId = planning.planId || _sessionToPlan.get(sessionId) || (planning.active ? _activePlanId : null);
  if (planning.forceNewPlan && boundId && !referentHit && !unnamedResume) {
    // Non-resume-shaped prompt — never absorb into any open plan, drafting
    // or not. Replies that should continue a plan are short/resume-shaped
    // and never reach this flag.
    boundId = null;
  } else if (planning.preferFresh && boundId && !referentHit && !unnamedResume) {
    // A capability_gap turn is a new capability request — inheriting the
    // session's bound FINALIZED plan would let this prompt rewrite its tasks
    // (observed: a file-count prompt overwrote the nylas plan). Only a session
    // still drafting (its own clarify flow) may be continued; anything else
    // gets a fresh draft. The bound plan stays on disk, resumable by referent.
    const boundSess = _planSessions.get(boundId) || _loadPlanFromDisk(boundId);
    if (boundSess && String(boundSess.status || 'drafting') !== 'drafting') boundId = null;
  }

  let sess = _getOrCreateSession({
    planId: boundId,
    sessionId,
    originalPrompt: englishText,
    conversationContext,
    refs: planning.refs,
  });
  if (!sess.originalPrompt) sess.originalPrompt = englishText;

  // Context refs — a dispatch-carried seed (planning.refs) or a mid-run
  // discovery (planning.addRefs from a task.agent plan_update) merges into
  // the session and persists to frontmatter on the next write.
  const _incomingRefs = mergeRefs(planning.refs, planning.addRefs);
  if (_incomingRefs.length) {
    const merged = mergeRefs(sess.refs, _incomingRefs);
    if (merged.length !== (sess.refs || []).length) {
      sess.refs = merged;
      sess._refsChanged = true; // persisted by the planChanged write below
    }
  }
  // Escalated turns (needs_plan loop-back, task.agent plan_update) are
  // machine-dispatched, not user phrasing — mark the session so the run
  // auto-fires once steps generate instead of parking on the Run-all gate.
  if (planning.escalated) sess._escalated = true;

  // ── Plan referent resolution ────────────────────────────────────────────────
  // "the nylas plan" — a DEFINITE reference to an existing plan. If it names a
  // different saved plan than the session's, switch (and reopen if terminal).
  // "a plan for X" (indefinite) is a draft request — never a referent.
  if (referentHit) {
    _activity(`searching saved plans for "${refMatch[1].trim()}"…`);
    const hits = sysMap.findPlans(refMatch[1]);
    const top = hits[0];
    if (top && top.planId !== sess.planId && (!hits[1] || hits[1].score < top.score)) {
      const { sess: opened, reopened } = _openPlanForSession(top.planId, sessionId);
      if (opened) {
        logger.info('[Planning] Referent switch', { from: sess.planId, to: opened.planId, reopened });
        _activity(reopened ? `reopened plan "${opened.name || opened.planId}"` : `switched to plan "${opened.name || opened.planId}"`);
        sess = opened;
      }
    }
  } else if (unnamedResume) {
    // "let continue the plan" with no named referent — if several resumable
    // plans exist (open OR failed — never done), ask which instead of guessing.
    _activity('looking for resumable plans…');
    const resumables = sysMap.resumablePlans().slice(0, 6);
    if (resumables.length > 1) {
      _activity(`found ${resumables.length} resumable plans — asking which one`);
      const options = resumables.map(p => ({
        label: `the ${p.name || p.title || p.planId} plan`,
        description: `${p.status} · ${p.pendingCount} of ${p.totalTasks} tasks left`,
      }));
      options.push({ label: 'none of these — start a new plan', description: 'draft a fresh plan instead' });
      return {
        text: 'Which plan did you mean?',
        fullText: 'Which plan did you mean?',
        metadata: {
          // No plan identity — nothing is chosen yet. Carrying the bound
          // session's planFile/'ready' status would fire the proactive
          // plan:check readiness card underneath this question card and pin
          // planning:state to a plan the user hasn't picked.
          source: 'planning', intent: 6, planId: null, planFile: null,
          planTitle: null, planName: null, planStatus: null,
          taskCount: 0, authRequired: 0, unknownAgents: [],
          choices: { question: 'I found a few plans on the go — which one did you mean?', options },
          runPlan: false, startedExplicit, speakable: true,
        },
      };
    }
  }

  // Eyes for ambient prompts: if the message refers to the screen and no
  // screen context was handed down, fetch it now — bounded, fail-open.
  const screenCtx = passedScreenContext
    || (needsAmbientCtx(englishText) ? await screenContext().catch(() => null) : null);

  // Conversational rename — "call it history.project.plan"
  const inlineName = planning.name || planFormat.extractDotNameFromPrompt(
    /\b(?:call|name|rename)\b[^.]*\b(?:it|plan|this)\b[^a-z0-9]*([a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*){1,4})/i.test(englishText)
      ? englishText : '');
  if (inlineName && planFormat.isValidDotName(inlineName)) {
    sess.name = inlineName;
    // planChanged is declared below — a name-only turn still must persist,
    // so flag the write on a sticky field the writer always consults.
    sess._nameChanged = true;
  }

  // Fresh truth each turn — the session snapshot goes stale the moment
  // planRunner, /plan.status healing, stepgen, or the user touches the file.
  _refreshSessionFromDisk(sess);

  // ── Deterministic run confirm — the durable fix for "do it" ──────────────
  // The <plan_run/> marker depends on the LLM choosing to emit it; observed
  // failure: the model wrote "Starting the plan check now — I'll verify…" as
  // bare prose, no marker, and the run never fired. Bare confirm/run phrases
  // are too regular to leave to the model — when the session already has
  // tasks and isn't live/terminal, treat the phrase as the execution request
  // directly, skip the LLM round entirely, and return runPlan: true so main
  // fires the readiness check. Nothing else on this path invents prose.
  const _runConfirm = (() => {
    if (sess.tasks.length === 0) return false;
    const st = String(sess.status || 'drafting');
    if (!['drafting', 'ready'].includes(st)) return false;
    const t = String(englishText || '').toLowerCase().replace(/[.!?,;:'"]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (!t || t.length > 60 || PLAN_RUN_NEG_RE.test(t)) return false;
    // Run-shaped phrases ("do it", "run it", "send it") are unambiguous —
    // fire during drafting or ready. Bare confirms ("yes", "sure") only fire
    // once the plan is ready — during drafting a "yes" is usually answering a
    // clarify question, not requesting execution.
    if (st === 'ready' && t.length <= 30 && PLAN_CONFIRM_RE.test(t)) return true;
    return t.length <= 45 && PLAN_RUN_RE.test(t);
  })();
  if (_runConfirm) {
    logger.info('[Planning] Deterministic run confirm — bypassing LLM', { planId: sess.planId, text: String(englishText).slice(0, 60) });
    if (sess.status === 'drafting') sess.status = 'ready';
    // Keep auth annotations current so metadata + file agree.
    let confirmAuthRequired = [];
    try {
      const { assessTasks } = require('../planPreflight.cjs');
      const assessment = assessTasks(sess.tasks);
      confirmAuthRequired = assessment.authRequired;
      for (const t of sess.tasks) {
        const a = assessment.byTask.get(t.num);
        if (a && a.auth !== t.auth) t.auth = a.auth;
      }
    } catch (_) {}
    _writePlanFile(sess);
    _sessionToPlan.set(sessionId, sess.planId);
    const text = "Kicking off the readiness check — I'll report back what it finds.";
    return {
      text,
      fullText: text,
      metadata: {
        source: 'planning', intent: 6, planId: sess.planId, planFile: sess.filePath,
        planTitle: sess.title, planName: sess.name, planStatus: sess.status,
        taskCount: sess.tasks.length, authRequired: confirmAuthRequired, unknownAgents: [],
        choices: null, runPlan: true, startedExplicit, speakable: true,
      },
    };
  }

  // Route-options context persists on the session — the diverted turn carries
  // gateReason/hints, but the user's pick reply arrives as planning_pinned
  // with neither. Keep the verified list + missing-info flag alive until the
  // pick resolves into a task.
  if (gateReason === 'capability_options' && Array.isArray(capabilityHints) && capabilityHints.length) {
    sess._routeOptions = capabilityHints;
    sess._needsInfo = needsInfo || null;
    sess._routeRecommended = recommended || null;
  }
  if (sess.tasks.length) { sess._routeOptions = null; sess._needsInfo = null; sess._routeRecommended = null; }
  // The SHOWING turn (gateReason just arrived) is the only one where the
  // reply is restricted to the route question. sess._routeOptions persists
  // into the follow-up turns so the pick can resolve — but those turns get
  // post-show instructions: the old block kept saying "reply ONLY with the
  // route question" after the user had already picked, which is one of the
  // ways the lane looped on the same question.
  const _showTurn = gateReason === 'capability_options';
  const _optsTurn = _showTurn || !!sess._routeOptions;
  const _optionsList = sess._routeOptions || (_showTurn ? capabilityHints : null);
  const _missingInfo = sess._needsInfo || needsInfo;
  // The gate's recommended pick (selector verdict) — drives the card's
  // RECOMMENDED badge. Falls back to first-ready only when absent.
  const _recommendedId = sess._routeRecommended || recommended || null;

  // Deterministic pick detection — a follow-up turn naming an option label/
  // id/service is the pick; the model must never re-ask which route.
  const _normPick = s => String(s || '').toLowerCase().replace(/\.agent\b/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim();
  const _pickable = (!_showTurn && Array.isArray(_optionsList) && _optionsList.length);
  const _picked = _pickable
    ? _optionsList.find(h => {
        const t = ` ${_normPick(englishText)} `;
        const cands = [h.label, h.id, h.service, h.tool]
          .map(_normPick)
          .filter(v => v.length >= 3)
          .flatMap(v => {
            const dedup = [...new Set(v.split(' '))].join(' ');
            const first = v.split(' ')[0];
            return [v, dedup, ...(first.length >= 4 ? [first] : [])];
          });
        return cands.some(c => t.includes(` ${c} `));
      })
    : null;
  if (_picked) sess._routePicked = _picked.label || _picked.id;
  const _pickedName = _picked
    ? String(_picked.tool || _picked.service || _picked.id || _picked.label)
    : (sess._routePicked || null);

  const _missingInfoAsk = _missingInfo === 'recipient'
    ? 'the missing recipient detail (phone number / contact)'
    : (_missingInfo && _missingInfo !== 'clarify' ? `the missing ${_missingInfo} detail` : 'any still-missing required detail');
  const _renderOptionLine = h =>
    `- ${h.label || h.id}${h.ready ? ' — READY (installed/registered)' : ' — needs setup'}${_isRecommended(h, _recommendedId) ? ' — RECOMMENDED' : ''}${h.setupSummary ? `, setup: "${h.setupSummary}"` : ''}${h.eta ? `, eta: ${h.eta}` : ''}${h.authEnv?.length ? `, needs keys: ${h.authEnv.join(', ')}` : ''}`;

  const _routeBlock = (_optsTurn && Array.isArray(_optionsList) && _optionsList.length)
    ? (_showTurn
      ? `\n\nROUTE OPTIONS — an options card listing these verified routes is shown to the user automatically. Do NOT emit <choices> or list them yourself; do NOT call capability.search (the list is already verified and complete). ` +
        `Your reply this turn is ONLY the route question — one short conversational sentence asking which route they want. Do NOT call other tools (memory.search, web.search, etc.) and do NOT ask about anything else — sign-in, credentials, missing details, or unrelated questions all come AFTER they pick. ` +
        `If one is marked ready/recommended, say it's the suggested one. ` +
        `After they pick: (a) if the pick isn't a registered agent, call <tool>capability.select("<name>")</tool> to get its agentId; ` +
        (_missingInfo && _missingInfo !== 'clarify'
          ? `(b) ask for ${_missingInfoAsk} — ONE short question; (c) when both route and ${_missingInfo === 'recipient' ? 'recipient' : 'details'} are known, immediately <plan_update> the task with the agentId and details baked in — no confirmation loops.`
          : `(b) if any required detail is still missing, ask ONE short question; (c) when the route and details are known, immediately <plan_update> the task with the agentId baked in — no confirmation loops.`) +
        ` If the pick needs setup, call <tool>setup.start("<name>")</tool> AFTER collecting missing details.\n\nOptions:\n`
        + _optionsList.map(_renderOptionLine).join('\n')
      : _pickedName
        ? `\n\nROUTE PICKED — the user chose "${_pickedName}" from the verified options. NEVER ask which route to use. ` +
          `(a) if it isn't a registered agent, call <tool>capability.select("${_pickedName}")</tool> ONCE to get its agentId; ` +
          `(b) if a required detail is still missing, ask for ${_missingInfoAsk} — ONE short question; ` +
          `(c) when route + details are known, emit <plan_update> in this same reply — no confirmation loops. ` +
          `If the pick needs setup, call <tool>setup.start("${_pickedName}")</tool> AFTER collecting missing details.\n\nOptions (reference):\n`
          + _optionsList.map(_renderOptionLine).join('\n')
        : `\n\nROUTE OPTIONS ALREADY SHOWN — the verified options card is on screen (list below for reference — do NOT re-render it or emit <choices>). ` +
          `The user's message may pick a route, answer a pending detail question, or add information. If it names an option, treat it as the pick and follow the after-pick steps — NEVER re-ask which route. ` +
          `Otherwise continue with ${_missingInfoAsk} — ONE short question. Once route + details are known, emit <plan_update> in this reply.\n\nOptions:\n`
          + _optionsList.map(_renderOptionLine).join('\n'))
    : null;

  const sysContent = (systemPrompt || '') + PLANNING_DIRECTIVE
    + `\n\nREGISTERED AGENTS (the ONLY agent names allowed in Tasks):\n`
    + _renderAgentCatalog()
    + `\n\nCURRENT PLAN STATE (planId ${sess.planId}, file already saved — update it with <plan_update> when it changes):\n`
    + _renderPlanState(sess)
    + (_routeBlock !== null
      ? _routeBlock
      : Array.isArray(capabilityHints) && capabilityHints.length
      ? `\n\nVERIFIED CANDIDATES (existence confirmed by the capability index — prefer these in <choices> over your own suggestions, ordered easiest-setup first):\n`
        + capabilityHints.map(h =>
            `- ${h.label || h.id}: kind=${h.kind || '?'}, setup="${h.setupSummary || ''}", eta="${h.eta || ''}"${h.installed ? ', already installed' : ''}${h.installCmd ? `, install: ${h.installCmd}` : ''}${h.detail ? ` — ${h.detail}` : ''}`).join('\n')
      : '')
    + (screenCtx
      ? `\n\nACTIVE SCREEN (live context — what the user is looking at now; use this to resolve "this"/"that"/"my screen" references):\n`
        + `App: ${screenCtx.appName || '?'}${screenCtx.url ? `, URL: ${screenCtx.url}` : ''}${screenCtx.title ? `, Window: "${screenCtx.title}"` : ''}`
        + (screenCtx.ocrText ? `\nVisible text: ${screenCtx.ocrText}` : '')
      : '')
    + (sess.contextSeed && sess.history.length <= 4
      // The seed exists to ground a fragmentary ENTRY prompt — once the
      // session has its own turns they are the truth, and a frozen stale
      // conversation (routed session may be unrelated) only misleads.
      ? `\n\nPRIOR CONVERSATION (context only — planning started mid-conversation; the user's latest message may refer to this):\n${sess.contextSeed}`
      : '');

  // Seed the conversation: planning turns are their own thread — the caller's
  // general conversation context is intentionally NOT mixed in so the draft
  // isn't poisoned by unrelated chit-chat.
  sess.history.push({ role: 'user', content: englishText });
  if (sess.history.length > 30) sess.history.splice(0, sess.history.length - 30);

  let replyText = '';
  let toolNotes = null;
  let planCancelQuery = null;
  const MAX_TOOL_ROUNDS = 3; // extra room: a stall-recovery round still leaves two for real tools
  let planChanged = false;
  const unknownAgents = [];
  // <plan_run/> seen in ANY round (the request flag sticks across the loop);
  // planRunRejected gates the corrective re-prompt to a single retry.
  let planRunSeen = false;
  let planRunRejected = false;
  // Confirm-shaped user text ("sounds good do it", "do the plan") is run
  // intent even when the model forgot the <plan_run/> marker — hoisted before
  // the loop so an empty plan gets the corrective rejection instead of the
  // dead-end "plan is empty" fallback. The tasks>0 path still goes through
  // the post-loop askEarly verifier below.
  const _userTxtEarly = String(englishText || '');
  const userConfirmish = computeTurnFacts({ rawText: englishText }).confirmish;

  const streamFilter = onReplyChunk ? new _StreamFilter(onReplyChunk) : null;
  const sessToolCalls = [];
  let stallChecked = false;
  let stallRecovered = false;
  let repeatCorrected = false;

  for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
    _activity(round === 0 ? 'planning · thinking…' : `planning · still working — round ${round + 1} of ${MAX_TOOL_ROUNDS + 1}`, 'plan');
    const messages = [{ role: 'system', content: sysContent }, ...sess.history];
    const { text } = await askStream(messages, {
      maxTokens: 1200,
      temperature: 0.4,
      timeoutMs: 30000,
      taskType: 'planning',
    }, streamFilter ? streamFilter.push.bind(streamFilter) : null);

    if (!text) {
      logger.warn('[Planning] LLM returned empty', { planId: sess.planId, round });
      replyText = replyText || "I'm having trouble drafting right now — try again in a moment.";
      break;
    }

    // Provider scaffolding artifacts (e.g. <budget:token_budget>) must not
    // enter stored history — the model would imitate the markup next turn.
    let cleanText = _stripMetaTags(text);
    // Model-emitted <tool_results> are FABRICATIONS — real results only arrive
    // as system-injected user turns. Strip them so invented file contents or
    // search results can't enter history (the observed failure: the model
    // wrote a <tool_results> block full of invented RTF text when its fs.read
    // call silently did nothing).
    const fabricatedResults = /<tool_results>[\s\S]/i.test(cleanText);
    if (fabricatedResults) {
      logger.warn('[Planning] Stripped model-fabricated <tool_results>', { planId: sess.planId, round });
      _activity('ignored a fabricated tool result — verifying for real', 'warn');
      cleanText = _stripFabricatedResults(cleanText);
    }

    // A plan.cancel call in ANY round may close the lane — the final
    // replyText won't carry the earlier round's tool call, so capture the
    // query here where each round's text is still in scope.
    const cancelM = cleanText.match(/<tool>\s*plan\.cancel\(\s*(?:"([^"]*)")?\s*\)/);
    if (cancelM) planCancelQuery = cancelM[1] || '';

    // Plan markers land the round they're written — a <plan_update> riding
    // beside a <tool> call must still reach sess.tasks (previously only the
    // final replyText was parsed, silently dropping mid-loop updates).
    if (await _applyPlanMarkers(cleanText, sess, unknownAgents)) planChanged = true;
    if (/<plan_run\s*\/?\s*>/.test(cleanText)) planRunSeen = true;

    const ran = await _runTools(cleanText, sessionId, { optionsTurn: _optsTurn, routePickTurn: gateReason === 'capability_options' });
    if (ran?.toolCalls?.length) sessToolCalls.push(...ran.toolCalls);
    const toolResults = ran?.text || null;
    _recordObservedMedia(sess, toolResults);
    if (toolResults && round < MAX_TOOL_ROUNDS) {
      // Record the assistant's tool-call turn, then feed results back. A
      // fabricated <tool_results> riding beside real calls gets a corrective
      // note so the model knows which results are real.
      sess.history.push({ role: 'assistant', content: cleanText });
      sess.history.push({ role: 'user', content: `<tool_results>\n${toolResults}${fabricatedResults ? '\n\nNOTE: a <tool_results> block you wrote was removed — results are system-generated. Trust ONLY the entries above.' : ''}\n</tool_results>` });
      toolNotes = (toolNotes ? toolNotes + '\n' : '') + toolResults;
      continue;
    }

    // <plan_run/> on an empty plan used to be silently swallowed — the marker
    // stripped, the fallback said "Working on the plan now.", nothing ran.
    // Reject it like a failed tool call (once) so the model writes the task it
    // was about to run — or explains what's missing. Run intent also counts
    // from a confirm-shaped user message, and a reply that describes the plan
    // in prose without <plan_update> gets the same corrective — both used to
    // dead-end on "The plan is empty".
    const spokenSoFar = _stripMarkers(cleanText);
    const planInProse = !sess.tasks.length && !toolResults
      && !/\?\s*$/.test(spokenSoFar.trim())
      && _PLAN_IN_PROSE_RE.test(spokenSoFar);
    if (!sess.tasks.length && !planRunRejected && round < MAX_TOOL_ROUNDS
        && (planRunSeen || userConfirmish || planInProse)) {
      planRunRejected = true;
      sess.history.push({ role: 'assistant', content: cleanText });
      sess.history.push({ role: 'user', content: '<tool_results>\nplan_run → REJECTED: the plan has no tasks, so nothing would run.'
        + (planInProse && !planRunSeen ? ' You described the plan in prose but emitted no <plan_update> marker —' : '')
        + ' Emit the complete task list in <plan_update> first (Agents line: use the agentId from capability.select or REGISTERED AGENTS), then <plan_run/> again — or ask the user what is missing.\n</tool_results>' });
      continue;
    }

    // ── Stall verification ───────────────────────────────────────────────
    // The reply narrates in-progress tool work ("I'm reading the file now…")
    // but no <tool> marker executed this round — either the model forgot the
    // marker or called a name not in the registry. The semantic check goes
    // through the local decision model: does this reply promise work that did
    // not happen? A fabricated <tool_results> block is an automatic YES — the
    // model already proved it's inventing evidence.
    if (!toolResults && !stallChecked && round < MAX_TOOL_ROUNDS
        && (fabricatedResults || _CLAIM_TOOL_WORK_RE.test(spokenSoFar) || _CLAIM_COMPLETION_RE.test(spokenSoFar))) {
      stallChecked = true;
      let verdict = fabricatedResults; // fabrication is a proven stall — no judgment needed
      if (!verdict) {
        const _stallV = await decision.confirmJudgment({
          site: 'stall',
          question: 'The assistant reply says it is doing tool work (reading files, searching, checking something) but NO tool call was executed in this turn. Does this reply promise work that did not happen?',
          state: spokenSoFar.slice(0, 800),
        });
        verdict = _stallV === 'YES';
        // Decision model down → fall back to the strong-claim regex so the
        // honest path still wins over silent narration.
        if (!verdict && _stallV == null && _STRONG_CLAIM_RE.test(spokenSoFar)) verdict = true;
        logger.info('[Planning] Stall verifier', { verdict, planId: sess.planId, round });
      }
      if (verdict) {
        stallRecovered = true;
        _activity('planning stall detected — recovering…', 'warn');
        logger.warn('[Planning] Narration without tool execution — corrective round', { planId: sess.planId, round, fabricated: fabricatedResults });
        sess.history.push({ role: 'assistant', content: cleanText });
        sess.history.push({ role: 'user', content: '<tool_results>\nsystem → REJECTED: '
          + (fabricatedResults
            ? 'your reply contained a <tool_results> block — results are system-generated only; yours was removed.'
            : 'your reply described work in progress but no <tool> call was emitted — nothing actually happened.')
          + ' If a lookup was intended, emit the real <tool>name("arg")</tool> call now (valid tools: '
          + Object.keys(TOOL_HANDLERS).join(', ')
          + '). Otherwise answer only with what is already known — do not narrate work that is not running.\n</tool_results>' });
        continue;
      }
    }

    // ── Repeat-question guard ────────────────────────────────────────────
    // A clarifying question the lane ALREADY asked (and the user answered)
    // means the model lost the thread — observed loop: "Which day next
    // week?" re-asked four times after the user had already said "friday".
    // Detect a duplicate trailing question, reject it like a failed tool
    // call, and take one more round with an explicit instruction to use the
    // answer it already has.
    const _trailingQ = (() => {
      const s = spokenSoFar.trim();
      const m = s.match(/([^.!?]*\?)\s*$/);
      return m ? m[1].trim() : null;
    })();
    if (_trailingQ && !repeatCorrected && round < MAX_TOOL_ROUNDS) {
      const key = _qNorm(_trailingQ);
      const prev = (sess._askedQuestions ||= []);
      if (prev.some(p => _qSimilar(p, key))) {
        repeatCorrected = true;
        _activity('re-asked an answered question — correcting…', 'warn');
        logger.warn('[Planning] Repeat-question loop detected — corrective round', { planId: sess.planId, round, question: _trailingQ.slice(0, 80) });
        sess.history.push({ role: 'assistant', content: cleanText });
        sess.history.push({ role: 'user', content: '<tool_results>\nsystem → REJECTED: you already asked that question and the user answered it — re-read the conversation above and use their answer. If route + required details are now known, emit <plan_update> in this reply; if something else is genuinely missing, ask about THAT — never repeat a question.\n</tool_results>' });
        continue;
      }
    }
    if (_trailingQ) (sess._askedQuestions ||= []).push(_qNorm(_trailingQ));

    sess.history.push({ role: 'assistant', content: cleanText });
    replyText = cleanText;
    break;
  }
  if (streamFilter) streamFilter.flush();

  // Explicit run intent ("run the plan", "do it", "execute it") is already a
  // confirmation — don't pay an LLM call to ask whether the user meant it.
  // Bounded to runish: bare confirms still go through the verifier below
  // since a "yes" can be answering a clarifying question.
  const userRunish = computeTurnFacts({ rawText: englishText }).runish;
  if (!planRunSeen && userRunish && sess.tasks.length > 0
      && ['drafting', 'ready'].includes(String(sess.status || 'drafting'))) {
    planRunSeen = true;
    logger.info('[Planning] Explicit run intent — bypassing confirm verifier', { planId: sess.planId });
  }

  // ── Run-confirm verifier — the marker-paraphrase net ──────────────────────
  // Observed failure: user says "do it", the model writes "Starting the plan
  // check now — I'll verify…" as PROSE, never emits <plan_run/>, and the run
  // silently dies. When the turn smells like a confirm — the user's text is
  // confirm-shaped OR the reply itself claims to be starting — one tiny
  // yes/no call decides whether the user actually confirmed execution. Blast
  // radius is bounded: a false YES only fires the readiness CHECK, never the
  // run itself.
  if (!planRunSeen && sess.tasks.length > 0
      && ['drafting', 'ready'].includes(String(sess.status || 'drafting'))) {
    const _userTxt = _userTxtEarly;
    const _userConfirmish = userConfirmish;
    const _replyClaimsStart = /\b(starting|kicking off|firing|beginning|launching|executing|running|checking|verifying)\b[^.!?\n]{0,60}\b(check|checks|readiness|plan|run|task|tasks|it|this|verif)/i.test(replyText);
    if (_userConfirmish || _replyClaimsStart) {
      try {
        const v = await askEarly([
          { role: 'user', content: `The user has a plan with ${sess.tasks.length} task(s) that is ready to execute.\nUser's latest message: "${_userTxt.slice(0, 200)}"\nAssistant's reply: "${String(replyText).slice(0, 300)}"\nDid the user just confirm they want the plan executed NOW? Answer YES or NO only.` },
        ], { maxTokens: 8, temperature: 0 });
        const verdict = /^yes\b/i.test((v.firstSentence || v.fullText || '').trim());
        logger.info('[Planning] Run-confirm verifier', { verdict, userText: _userTxt.slice(0, 60), trigger: _userConfirmish ? 'user-text' : 'reply-claims' });
        if (verdict) planRunSeen = true;
      } catch (err) {
        logger.warn('[Planning] Run verifier failed (non-fatal)', { error: err.message });
      }
    }
  }

  // <plan_run/> — user confirmed execution. Only meaningful with tasks; the
  // run itself is triggered by main.js from metadata.runPlan below.
  // Escalated turns (needs_plan loop-back / task.agent plan_update revisions)
  // auto-run once the draft has tasks — the user already asked for the work;
  // a second Run-all gate would just re-stall it.
  const runPlan = (planRunSeen || sess._escalated === true) && sess.tasks.length > 0;
  if (runPlan && sess.status === 'drafting') {
    sess.status = 'ready';
    planChanged = true;
  }
  // <plan_exit/> — the ONLY LLM-side way to close the lane. Also implied by a
  // plan.cancel call that targeted THIS lane's plan (cancelling a different
  // named plan shouldn't kick the user out of drafting). main.js reads
  // metadata.exitPlanning to actually flip _planningMode and to skip the
  // planId re-pin that would otherwise undo the exit on the same turn.
  const lanePlanId = planning.planId || sess.planId;
  const cancelledThisLane = planCancelQuery !== null
    && _resolvePlanId(planCancelQuery, sessionId) === lanePlanId;
  const exitPlanning = /<plan_exit\s*\/?\s*>/.test(replyText) || cancelledThisLane;
  if (!sess.description && sess.tasks.length) {
    sess.description = `Plan for: ${sess.originalPrompt.slice(0, 200)}`;
    planChanged = true;
  }

  // ── Preflight: resolve each task's auth need against the ledger ────────────
  let authRequired = [];
  if (sess.tasks.length) {
    try {
      const { assessTasks } = require('../planPreflight.cjs');
      const assessment = assessTasks(sess.tasks);
      authRequired = assessment.authRequired;
      for (const t of sess.tasks) {
        const a = assessment.byTask.get(t.num);
        if (a && a.auth !== t.auth) { t.auth = a.auth; planChanged = true; }
      }
    } catch (err) {
      logger.warn('[Planning] Preflight assessment failed (non-fatal)', { error: err.message });
    }
  }

  if (planChanged || sess._nameChanged || sess._refsChanged || sess.status === 'drafting') {
    sess._nameChanged = false;
    sess._refsChanged = false;
    _writePlanFile(sess);
  }
  // Background: generate execution steps for tasks that lack them — user can
  // keep chatting/editing while steps stream into the plan file.
  _scheduleStepGen(sess);
  _activePlanId = sess.planId;
  if (sessionId) {
    // Lane closed — unbind so the next prompt on this session can't silently
    // re-enter planning on the old plan. The plan file stays on disk and
    // remains resumable via a "the X plan" referent.
    if (exitPlanning) _sessionToPlan.delete(sessionId);
    else _sessionToPlan.set(sessionId, sess.planId);
  }

  // <choices> — capability-gap options for the renderer QuestionCard.
  let choices = null;
  const choicesRaw = _extractTag(replyText, 'choices');
  if (choicesRaw) {
    try {
      const parsed = JSON.parse(choicesRaw);
      if (parsed && typeof parsed.question === 'string' && Array.isArray(parsed.options)) {
        choices = { question: parsed.question, options: parsed.options.slice(0, 6) };
      }
    } catch (err) {
      logger.warn('[Planning] Malformed <choices> block ignored', { error: err.message });
    }
  }
  // Route-options turns — the verified list is shown EVERY time (the user's
  // pick, not the LLM's prose). Grouped: ready routes first, then setup.
  if (_optsTurn && Array.isArray(_optionsList) && _optionsList.length && !sess.tasks.length && !sess._routeOptionsShown) {
    sess._routeOptionsShown = true;
    choices = {
      question: 'Which route should I use? Verified options:',
      options: _optionsList.slice(0, 8).map(h => ({
        label: h.label || h.id,
        description: [
          h.ready ? 'ready now' : 'needs setup',
          h.setupSummary && !/^(ready|installed|none|no setup needed)$/i.test(h.setupSummary) ? h.setupSummary : null,
          h.eta || null,
          h.authEnv?.length ? `keys: ${h.authEnv.join(', ')}` : null,
        ].filter(Boolean).join(' · ').slice(0, 200),
        primary: _recommendedId
          ? _isRecommended(h, _recommendedId)
          : (!!h.ready && h === _optionsList.find(x => x.ready)),
      })),
    };
    logger.info('[Planning] Route options card', { planId: sess.planId, options: choices.options.length });
  }
  // Deterministic backstop — the capability gate already ranked verified
  // candidates; the selection surface must never depend on the LLM emitting
  // a <choices> marker. Synthesize the card from capabilityHints when the
  // turn arrived via a capability lane and the model dropped the block.
  else if (!choices && Array.isArray(capabilityHints) && capabilityHints.length && !sess.tasks.length) {
    choices = {
      question: 'How should I handle this? These are the verified options:',
      options: capabilityHints.slice(0, 6).map(h => ({
        label: h.label || h.id,
        description: [h.setupSummary, h.eta, h.installed ? 'installed' : null, h.detail]
          .filter(Boolean).slice(0, 3).join(' · ').slice(0, 200),
      })),
    };
    logger.info('[Planning] Synthesized <choices> from capability hints', { planId: sess.planId, options: choices.options.length });
  }

  // Marker-only replies need a fallback that says what actually happened —
  // never "working on it" prose when nothing moved.
  let spoken = _stripMarkers(replyText)
    || (sess.tasks.length
      ? 'I updated the plan — take a look.'
      : (planRunSeen || userConfirmish
        ? "The plan is still empty — nothing to run. Tell me the tasks you want in it, or say 'exit planning'."
        : "The plan is empty — tell me what you want it to do."));

  // Last-line honesty scrub — zero tools ran all turn but the reply still
  // narrates in-progress work ("I'm reading the file now"). Drop the claim
  // sentences entirely; if nothing else remains, say what actually happened.
  if (!sessToolCalls.length && (_CLAIM_TOOL_WORK_RE.test(spoken) || _CLAIM_COMPLETION_RE.test(spoken))) {
    const kept = spoken
      .split(/(?<=[.!?…—])\s+/)
      .filter(s => s.trim() && !_CLAIM_TOOL_WORK_RE.test(s) && !_STRONG_CLAIM_RE.test(s) && !_CLAIM_COMPLETION_RE.test(s))
      .join(' ').trim();
    spoken = kept || "I went to look that up but nothing actually ran — try rephrasing or ask me again.";
    logger.warn('[Planning] Final reply scrubbed — claim prose with zero tool calls', { planId: sess.planId });
  }

  // A clarifying question during drafting must mark the session awaiting input —
  // otherwise findOpenPlan() sees an empty plan as closed and the user's answer
  // ("metallic blue, dark wheels") dispatches as a brand-new handoff task.
  if (!sess.tasks.length && /\?\s*$/.test(spoken.trim())) {
    sess._needsInfo = sess._needsInfo || 'clarify';
  }

  return {
    text: spoken,
    fullText: spoken,
    metadata: {
      source: 'planning',
      intent: 6,
      planId: sess.planId,
      planFile: sess.filePath,
      planTitle: sess.title,
      planName: sess.name,
      planStatus: sess.status,
      taskCount: sess.tasks.length,
      authRequired,
      unknownAgents,
      choices,
      runPlan,
      exitPlanning,
      startedExplicit,
      speakable: true,
      // What actually ran this turn — the feed can badge "tools used" and the
      // stall check's recovery is visible rather than silent.
      toolCalls: sessToolCalls,
      stallRecovered,
    },
  };
}

/** Real registry catalog for the directive — the anti-phantom-agent list. */
function _renderAgentCatalog() {
  try {
    const { listAgentNames } = require('../../../shared/service-map.cjs');
    const list = listAgentNames();
    if (!list.length) return '(empty registry — use generic surfaces only)';
    return list.map(a =>
      `- ${a.agentId} — service:${a.service} type:${a.type}` +
      (a.cliTool ? ` cli:${a.cliTool}` : '') +
      (a.secrets && a.secrets.length ? ` secrets:[${a.secrets.join(', ')}]` : '')
    ).join('\n')
      + '\nGeneric surfaces (execution lanes, not services): browser.agent | web.agent | web.crawl | edit.agent | shell | screen.display | none';
  } catch (_) { return '(registry unavailable — use generic surfaces only)'; }
}

// Cheap reality check for install-shaped tasks: does the binary the task is
// supposed to install actually exist on PATH right now? Plan-file statuses go
// stale (a task "running" when its process died, or an install that finished
// out-of-band) — the LLM was quoting file status verbatim and telling users
// "Task 2 is running" while the binary already sat on PATH. One `which` call
// per install task is ~2ms and turns the reply into observed truth.
const _INSTALL_BIN_RE = /\binstall(?:ing)?\s+(?:the\s+)?([a-z0-9][a-z0-9._-]*)/i;
function _liveInstallCheck(title) {
  const m = String(title || '').match(_INSTALL_BIN_RE);
  if (!m) return null;
  const bin = m[1].replace(/-cli$/i, '').replace(/[^a-z0-9@._-]/gi, '');
  if (!bin || bin.length < 2 || /^(node\.?js|npm|package|the)$/i.test(bin)) return null;
  try {
    const r = require('child_process').spawnSync('which', [bin], { timeout: 3000 });
    return r.status === 0 ? `${bin} on PATH` : `${bin} NOT on PATH`;
  } catch (_) { return null; }
}

function _renderPlanState(sess) {
  // Never say "first turn" — the string is injected on EVERY turn while the
  // plan is empty, and the model took it literally: it kept re-asking the
  // opening clarify question because the state claimed none had happened.
  if (!sess.tasks.length) return '(no tasks yet — emit <plan_update> once route + required details are known)';
  const lines = sess.tasks.map(t => {
    const live = /pending|progress|running/i.test(String(t.status || ''))
      ? _liveInstallCheck(t.title) : null;
    // A 'running' status is only a file marker — it proves dispatch, not life.
    // If the run died the marker lingers until something heals it, so the LLM
    // must verify with plan.status before narrating any progress.
    const staleNote = String(t.status || '') === 'running'
      ? ' (file marker — call plan.status before claiming this is running)'
      : '';
    return `Task ${t.num} — ${t.title} | mode=${t.mode} | deps=[${t.dependsOn.join(',') || 'none'}] | auth=${t.auth} | status=${t.status}${staleNote}`
      + (live ? ` | live-check: ${live} (reality, right now — trust this over the stale status)` : '');
  });
  if (sess.risks.length) lines.push('Risks: ' + sess.risks.join('; '));
  // Show the gate truth so the LLM never claims execution while blocked.
  try {
    const { assessRunGate } = require('../planPreflight.cjs');
    const gate = assessRunGate(sess.tasks);
    lines.push(gate.ok
      ? 'RUN GATE: ready — all tasks clear to execute'
      : `RUN GATE: BLOCKED — needs resolution: ${gate.blockers.map(b => `${b.agentId} (${b.state}, task ${b.taskNum})`).join(', ')}. Do NOT claim tasks are running; tell the user what is needed to unblock.`);
  } catch (_) {}
  return lines.join('\n');
}

// ── Public helpers for server.cjs / planRunner ────────────────────────────────

function getActivePlanId() { return _activePlanId; }

/**
 * Find the most relevant open plan for continuation prompts — a non-terminal
 * task plan with at least one incomplete task. Resolution order:
 * this session's plan → most recently touched plan → newest open plan on disk.
 * Disk hits re-bind _sessionToPlan so the mapping survives restarts.
 * @param {string|null} sessionId
 * @returns {{planId:string, title:string, pendingCount:number, totalTasks:number, taskTitles:string[], filePath:string}|null}
 */
function findOpenPlan(sessionId) {
  const TERMINAL = new Set(['done', 'failed', 'cancelled']);
  const TASK_TERMINAL = new Set([planFormat.TASK_STATUS.DONE, planFormat.TASK_STATUS.SKIPPED]);

  const _openFromSess = (sess) => {
    if (!sess || !Array.isArray(sess.tasks)) return null;
    if (TERMINAL.has(String(sess.status || '').toLowerCase())) return null;
    const pending = sess.tasks.filter(t => !TASK_TERMINAL.has(t.status));
    // A session awaiting a route pick / missing detail is still open even
    // with zero tasks — the user's reply ("Messages", "555-0134") must be
    // able to resume it instead of dispatching as a new task. A plan with no
    // tasks at all is mid-clarification by definition (status 'drafting').
    const awaitingInput = !!(sess._routeOptions?.length || sess._needsInfo)
      || (sess.tasks.length === 0 && String(sess.status || '').toLowerCase() === 'drafting');
    if (!pending.length && !awaitingInput) return null;
    return {
      planId: sess.planId,
      title: sess.title || sess.planId,
      pendingCount: pending.length,
      totalTasks: sess.tasks.length,
      taskTitles: sess.tasks.map(t => t.title || '').filter(Boolean),
      filePath: sess.filePath,
      awaitingInput,
      // Route options the session is waiting on — lets callers shape what
      // counts as an answer (a label/ordinal pick) vs a new command.
      routeOptions: sess._routeOptions || null,
      // boundToSession set by the caller below — whether this plan belongs
      // to the routed conversation. Short-reply capture only applies to
      // session-bound plans; cross-session plans need explicit referents.
      boundToSession: undefined,
    };
  };

  // Session-bound plan first.
  const bound = sessionId ? _sessionToPlan.get(sessionId) : null;
  const boundSess = bound
    ? (_planSessions.get(bound) || _loadPlanFromDisk(bound))
    : null;
  const hit = _openFromSess(boundSess);
  if (hit) { hit.boundToSession = true; return hit; }

  // Most recently touched in-memory plan.
  const activeSess = _activePlanId
    ? (_planSessions.get(_activePlanId) || _loadPlanFromDisk(_activePlanId))
    : null;
  const activeHit = _openFromSess(activeSess);
  if (activeHit) {
    activeHit.boundToSession = !!(sessionId && activeSess.sessionId === sessionId);
    return activeHit;
  }

  // Disk scan — newest open task plan wins.
  try {
    const dir = _plansDir();
    if (!fs.existsSync(dir)) return null;
    const files = fs.readdirSync(dir)
      .filter(f => f.endsWith('.md') && f.startsWith('plan'))
      .map(f => ({ f, mtime: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    for (const { f } of files) {
      const planId = f.replace(/\.md$/, '');
      const sess = _loadPlanFromDisk(planId);
      const open = _openFromSess(sess);
      if (open) {
        open.boundToSession = !!(sessionId && sess.sessionId === sessionId);
        return open;
      }
    }
  } catch (_) {}
  return null;
}

function getPlanSession(planId) {
  return _planSessions.get(planId) || _loadPlanFromDisk(planId);
}

/** Clear the in-memory active plan (cancel / leave planning mode). */
function clearActivePlan() {
  _activePlanId = null;
}

/**
 * Planning mode exited — unbind the conversation session from its plan so the
 * next prompt can't silently re-enter the lane. Keeps _activePlanId: the plan
 * stays the "most recently touched" resume target for "continue the plan".
 */
function releaseSession(sessionId) {
  if (sessionId) _sessionToPlan.delete(sessionId);
}

/**
 * Re-run step generation for one task after a failure. Clears the
 * `Steps Status` marker on disk + the live task, then re-schedules.
 */
function retrySteps(planId, taskNum) {
  const sess = getPlanSession(planId);
  if (!sess) return { ok: false, error: 'no planning session for ' + planId };
  // Pick up on-disk edits first (agent swaps via the readiness card clear
  // steps+stepsStatus in the file) — otherwise regen runs against stale
  // session agents.
  _refreshSessionFromDisk(sess);
  const task = (sess.tasks || []).find(t => t.num === taskNum);
  if (!task) return { ok: false, error: 'no task ' + taskNum };
  try {
    const onDisk = fs.readFileSync(sess.filePath, 'utf8');
    fs.writeFileSync(sess.filePath,
      planFormat.updateTaskStepsStatus(onDisk, taskNum, null), 'utf8');
  } catch (_) {}
  task.steps = null;
  task.stepsStatus = null;
  task._stepsHash = null;
  _scheduleStepGen(sess);
  return { ok: true };
}

module.exports = { execute, getActivePlanId, getPlanSession, clearActivePlan, releaseSession, retrySteps, findOpenPlan, _isRecommended, _generateTaskSteps, _scheduleStepGen };
