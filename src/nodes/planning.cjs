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
const { ask, askStream } = require('../llm-providers.cjs');
const planFormat = require('../../../shared/plan-format.cjs');
const { canonicalAgent } = require('../../../shared/agent-canonical.cjs');
const skillIndex = require('../../../shared/skill-index.cjs');
const serviceMap = require('../../../shared/service-map.cjs');
const sysMap = require('../../../shared/system-map.cjs');

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

function _getOrCreateSession({ planId, sessionId, originalPrompt, conversationContext }) {
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
  };
  _planSessions.set(id, sess);
  if (sessionId) _sessionToPlan.set(sessionId, id);
  _activePlanId = id;
  // Write the skeleton immediately so the Plans tab shows the draft the
  // moment planning mode opens — before the first LLM turn finishes.
  _writePlanFile(sess);
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
    };
    _planSessions.set(planId, sess);
    if (sess.sessionId) _sessionToPlan.set(sess.sessionId, planId);
    _activePlanId = planId;
    return sess;
  } catch (err) {
    logger.warn('[Planning] Failed to load plan from disk', { planId, error: err.message });
    return null;
  }
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
    });
    if (sess.name) content = planFormat.setFrontmatterField(content, 'name', sess.name);
    if (sess.status && sess.status !== 'drafting') {
      content = planFormat.updateFrontmatterStatus(content, sess.status);
    }
    if (sess.risks && sess.risks.length) {
      content = content.replace(/## Risks\n\s*$/m, '## Risks\n' + sess.risks.map(r => `- ${r}`).join('\n') + '\n');
    }
    fs.writeFileSync(sess.filePath, content, 'utf8');
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
- edit.agent: {goal} — edit project files.
- cli.agent: {tool, args} — a configured CLI.

Rules: 2-8 steps. Deterministic, self-contained, ordered. Research/compile
tasks gather via web.agent/web.crawl and write results to LOCAL files
(edit.agent/shell.run) — a service (Doc/Sheet/email) only appears when the
user named it as the deliverable. No commentary — ONLY the json fence.`;

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

function _stepgenSystemPrompt(task) {
  const core = _loadSgPrompt('plan-skills-core.md');
  if (!core) return _STEPGEN_FALLBACK;
  const appendixName = _pickStepgenAppendix(task);
  const appendix = appendixName ? _loadSgPrompt(appendixName) : null;
  return [
    "You are ThinkDrop's execution planner. Convert ONE task into a concrete step list for the skill runtime.",
    core,
    appendix || '',
    '## Task scope\nYou are planning ONE task from a larger approved plan — emit ONLY the steps this task needs (the surrounding plan handles ordering and dependencies).',
    '## Output contract\nReply with ONLY a fenced json block — an array of steps, each {"skill": "...", "args": {...}, "description": "..."}. Every step taking an agentId arg carries the exact TASK AGENTS value — never invent another agent id. synthesize is always last. No commentary — ONLY the json fence.',
  ].filter(Boolean).join('\n\n');
}

async function _generateTaskSteps(task) {
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
    ], { maxTokens: 900, temperature: 0.2, timeoutMs: 45000, taskType: 'planning' });
    const m = String(text || '').match(/```(?:json)?\s*\n?([\s\S]*?)```/);
    let steps = null;
    try { steps = m ? JSON.parse(m[1].trim()) : null; }
    catch (e) {
      logger.warn('[Planning] Step JSON parse failed', { taskNum: task.num, error: e.message });
    }
    if (!Array.isArray(steps) || !steps.length) {
      logger.warn('[Planning] Step generation produced no steps', { taskNum: task.num, preview: String(text || '').slice(0, 120) });
      return null;
    }
    const valid = steps.every(s => s && typeof s.skill === 'string' && s.skill);
    if (!valid) {
      logger.warn('[Planning] Step list malformed (missing skill field)', { taskNum: task.num });
      return null;
    }
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
  if (!sess.tasks.length || _stepGenInFlight.has(sess.planId)) return;
  _stepGenInFlight.add(sess.planId);
  setImmediate(async () => {
    try {
      for (const task of sess.tasks) {
        if (Array.isArray(task.steps) && task.steps.length
            && task._stepsHash === _promptHash(task.prompt)) continue;
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
              if (live) live.stepsStatus = 'failed';
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
  return results.map(r => (r.text || r.content || r.value || '')).filter(Boolean).slice(0, 3).join('\n');
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
  // URLs are first-class — the LLM can only offer links it was actually shown.
  return results.slice(0, 5)
    .map(r => `- ${r.title || ''}\n  ${r.url || r.link || ''}\n  ${r.snippet || r.description || ''}`.trim())
    .filter(s => s.length > 2)
    .join('\n');
}

const _TOOL_RE = /<tool>\s*(memory\.search|web\.search|media\.resolve|screen\.read|capability\.search|capability\.probe|capability\.select|plan\.find|plan\.open|system\.map|logs\.tail|logs\.head|logs\.grep|logs\.range)(?:\s*\(\s*"([^"]+)"\s*\))?\s*<\/tool>/g;

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

async function _runTools(text, sessionId) {
  const calls = [];
  _TOOL_RE.lastIndex = 0;
  let m;
  while ((m = _TOOL_RE.exec(text)) !== null) {
    calls.push({ tool: m[1], query: m[2] });
  }
  if (!calls.length) return null;
  const results = [];
  for (const call of calls.slice(0, 3)) {
    logger.info('[Planning] Tool call', { tool: call.tool, query: call.query });
    let out;
    if (call.tool === 'memory.search') {
      await _ptyNote(`searching memory for "${call.query}"…`);
      out = await _toolMemorySearch(call.query);
    }
    else if (call.tool === 'web.search') {
      await _ptyNote(`searching the web for "${call.query}"…`);
      out = await _toolWebSearch(call.query);
    }
    else if (call.tool === 'media.resolve') {
      await _ptyNote(`finding playable media: "${call.query}"…`);
      out = await _toolMediaResolve(call.query);
    }
    else if (call.tool === 'screen.read') {
      await _ptyNote('reading the screen…');
      out = await _toolScreenRead(call.query);
    }
    else if (call.tool === 'capability.search') {
      await _ptyNote(`looking up capabilities for "${call.query}"…`);
      out = await _toolCapabilitySearch(call.query);
    }
    else if (call.tool === 'capability.probe') {
      // Read-only probe runs VISIBLY in the diagnosis pane — same command the
      // user could run, with the pane watching exit status.
      const r = await _ptyDiagnose(call.query);
      out = _ptyCmdText(r) || await _toolCapabilityProbe(call.query);
    }
    else if (call.tool === 'plan.find') {
      await _ptyNote(`searching saved plans for "${call.query}"…`);
      out = _toolPlanFind(call.query);
    }
    else if (call.tool === 'plan.open') {
      await _ptyNote(`opening saved plan ${call.query}…`);
      out = _toolPlanOpen(call.query, sessionId);
    }
    else if (call.tool === 'system.map') {
      await _ptyNote('loading ThinkDrop system map…');
      out = sysMap.renderLayout();
    }
    else if (call.tool === 'logs.tail' || call.tool === 'logs.head'
             || call.tool === 'logs.grep' || call.tool === 'logs.range') {
      // Real terminal command in the pane — visible, bounded, greppable.
      const file = _logFilePath((call.query || '').split('|')[0].trim().split(/[,\s]/)[0]);
      const args2 = String(call.query || '');
      let shellCmd = null;
      if (file) {
        if (call.tool === 'logs.tail') shellCmd = `tail -n ${_parseLogQuery(args2, 80).n} ${JSON.stringify(file)}`;
        else if (call.tool === 'logs.head') shellCmd = `head -n ${_parseLogQuery(args2, 50).n} ${JSON.stringify(file)}`;
        else if (call.tool === 'logs.grep') {
          const parts = args2.split('|').map(s => s.trim());
          const gm = (parts[1] || '').match(/^([^\s,"]+)(?:[,\s]+(\d+))?/);
          shellCmd = gm ? `grep -n -i -C${gm[2] || 3} ${JSON.stringify(gm[1])} ${JSON.stringify(file)} | head -n 120` : null;
        } else {
          const parts = args2.split('|').map(s => s.trim());
          const rm = (parts[1] || '').match(/(\d+)\s*-\s*(\d+)/);
          shellCmd = rm ? `sed -n '${rm[1]},${rm[2]}p' ${JSON.stringify(file)} | nl -ba -v${rm[1]}` : null;
        }
      }
      const fb = call.tool === 'logs.tail' ? () => _toolLogsTail(call.query)
               : call.tool === 'logs.head' ? () => _toolLogsHead(call.query)
               : call.tool === 'logs.grep' ? () => _toolLogsGrep(call.query)
               : () => _toolLogsRange(call.query);
      out = shellCmd ? await _ptyLogsCmd(shellCmd, fb) : fb();
    }
    else {
      await _ptyNote(`registering ${call.query}…`);
      out = await _toolCapabilitySelect(call.query);
    }
    results.push(`${call.tool}("${call.query || ''}") →\n${out || '(no result)'}`);
  }
  return results.join('\n\n');
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
  <tool>memory.search("query")</tool>       — the user's stored facts/preferences
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
                                            Setup still happens at plan-check —
                                            this only files the intent.
  <tool>plan.find("nylas")</tool>           — search SAVED plans on disk by name/
                                            title/task text. Use this (not
                                            memory.search) for "the X plan",
                                            "do we have a plan for Y" —
                                            memory.search only knows user facts.
  <tool>plan.open("plan_…")</tool>          — make a saved plan the active plan
                                            for this session. Reopens terminal
                                            (failed/cancelled) plans: resets
                                            failed/skipped tasks to pending.
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

CLARIFY — when the request is ambiguous, underspecified, or risky, ask ONE
question at a time (important for voice). Good questions resolve: target
service/account, names/titles, timing, dependencies between steps, and
whether the user is already signed in.

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
web.agent, edit.agent, shell, cli.agent — are execution lanes, not services;
a task whose deliverable lives on a registered service names that service's
agent.

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
    "queued" — say you're starting the plan check. Only emit when the plan
    has tasks; if you're still gathering info, keep asking instead.
    If RUN GATE says BLOCKED, a run will be refused — never tell the user
    tasks are running; state which agent needs attention instead.

REPLY TEXT — everything outside the markers is spoken/shown to the user.
Keep it short and conversational: acknowledge, ask your one question, or
summarize what changed in the plan. Do not restate the whole plan in prose.
═══════════════════════════════════════════════`;

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
const _STREAM_MARKERS = new Set(['tool', 'plan_update', 'plan_name', 'plan_status', 'plan_desc', 'tool_results', 'choices', 'budget:token_budget']);

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
      if (m && (_STREAM_MARKERS.has(m[1]) || m[1] === 'plan_run')) {
        if (m[1] === 'plan_run' || m[2]) { this.buf = this.buf.slice(gt + 1); continue; }
        this.sink = m[1];
        this.buf = this.buf.slice(gt + 1);
        continue;
      }
      // Orphan closing tag for a known marker — drop it silently.
      const cm = tag.match(/^\/([a-z_][a-z0-9_:]*)$/i);
      if (cm && (_STREAM_MARKERS.has(cm[1]) || cm[1] === 'plan_run')) {
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

function _stripMarkers(text) {
  return _stripMetaTags(String(text || ''))
    .replace(/<tool>[\s\S]*?<\/tool>/g, '')
    .replace(/<plan_update>[\s\S]*?<\/plan_update>/g, '')
    .replace(/<plan_name>[\s\S]*?<\/plan_name>/g, '')
    .replace(/<plan_desc>[\s\S]*?<\/plan_desc>/g, '')
    .replace(/<plan_status>[\s\S]*?<\/plan_status>/g, '')
    .replace(/<plan_run\s*\/?\s*>/g, '')
    .replace(/<choices>[\s\S]*?<\/choices>/g, '')
    .replace(/<tool_results>[\s\S]*?<\/tool_results>/g, '')
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
async function execute({ englishText, systemPrompt, sessionId, planning = {}, source = 'text', conversationContext = null, onReplyChunk = null, capabilityHints = null, screenContext: passedScreenContext = null }) {
  const startedExplicit = planning.startedExplicit === true;
  let sess = _getOrCreateSession({
    planId: planning.planId || _sessionToPlan.get(sessionId) || (planning.active ? _activePlanId : null),
    sessionId,
    originalPrompt: englishText,
    conversationContext,
  });
  if (!sess.originalPrompt) sess.originalPrompt = englishText;

  // ── Plan referent resolution ────────────────────────────────────────────────
  // "the nylas plan" — a DEFINITE reference to an existing plan. If it names a
  // different saved plan than the session's, switch (and reopen if terminal).
  // "a plan for X" (indefinite) is a draft request — never a referent.
  const refMatch = String(englishText || '').match(/\bthe\s+([\w][\w .-]{0,40}?)\s+plan\b/i);
  if (refMatch && !/^(?:new|next|same)$/i.test(refMatch[1].trim())) {
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
  } else if (_isUnnamedResume(englishText)) {
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
          source: 'planning', intent: 6, planId: sess.planId, planFile: sess.filePath,
          planTitle: sess.title, planName: sess.name, planStatus: sess.status,
          taskCount: sess.tasks.length, authRequired: 0, unknownAgents: [],
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

  const sysContent = (systemPrompt || '') + PLANNING_DIRECTIVE
    + `\n\nREGISTERED AGENTS (the ONLY agent names allowed in Tasks):\n`
    + _renderAgentCatalog()
    + `\n\nCURRENT PLAN STATE (planId ${sess.planId}, file already saved — update it with <plan_update> when it changes):\n`
    + _renderPlanState(sess)
    + (Array.isArray(capabilityHints) && capabilityHints.length
      ? `\n\nVERIFIED CANDIDATES (existence confirmed by the capability index — prefer these in <choices> over your own suggestions, ordered easiest-setup first):\n`
        + capabilityHints.map(h =>
            `- ${h.label || h.id}: kind=${h.kind || '?'}, setup="${h.setupSummary || ''}", eta="${h.eta || ''}"${h.installed ? ', already installed' : ''}${h.installCmd ? `, install: ${h.installCmd}` : ''}${h.detail ? ` — ${h.detail}` : ''}`).join('\n')
      : '')
    + (screenCtx
      ? `\n\nACTIVE SCREEN (live context — what the user is looking at now; use this to resolve "this"/"that"/"my screen" references):\n`
        + `App: ${screenCtx.appName || '?'}${screenCtx.url ? `, URL: ${screenCtx.url}` : ''}${screenCtx.title ? `, Window: "${screenCtx.title}"` : ''}`
        + (screenCtx.ocrText ? `\nVisible text: ${screenCtx.ocrText}` : '')
      : '')
    + (sess.contextSeed
      ? `\n\nPRIOR CONVERSATION (context only — planning started mid-conversation; the user's latest message may refer to this):\n${sess.contextSeed}`
      : '');

  // Seed the conversation: planning turns are their own thread — the caller's
  // general conversation context is intentionally NOT mixed in so the draft
  // isn't poisoned by unrelated chit-chat.
  sess.history.push({ role: 'user', content: englishText });
  if (sess.history.length > 30) sess.history.splice(0, sess.history.length - 30);

  let replyText = '';
  let toolNotes = null;
  const MAX_TOOL_ROUNDS = 2;

  const streamFilter = onReplyChunk ? new _StreamFilter(onReplyChunk) : null;

  for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
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
    const cleanText = _stripMetaTags(text);

    const toolResults = await _runTools(cleanText, sessionId);
    if (toolResults && round < MAX_TOOL_ROUNDS) {
      // Record the assistant's tool-call turn, then feed results back.
      sess.history.push({ role: 'assistant', content: cleanText });
      sess.history.push({ role: 'user', content: `<tool_results>\n${toolResults}\n</tool_results>` });
      toolNotes = (toolNotes ? toolNotes + '\n' : '') + toolResults;
      continue;
    }

    sess.history.push({ role: 'assistant', content: cleanText });
    replyText = cleanText;
    break;
  }
  if (streamFilter) streamFilter.flush();

  // ── Apply plan mutations ────────────────────────────────────────────────────
  let planChanged = false;
  const unknownAgents = [];
  const update = _extractTag(replyText, 'plan_update');
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
          if (bad.length) unknownAgents.push(...bad.map(a => ({ taskNum: t.num, agent: a, suggested: svcMap.suggestAgent(a) || null })));
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
        if (prev && prev.steps && prev.prompt === t.prompt) {
          t.steps = prev.steps;
          t._stepsHash = prev._stepsHash;
        }
      }
      sess.tasks = newTasks;
      planChanged = true;
    }
    const risks = _extractTag(update, 'risks');
    if (risks) {
      sess.risks = risks.split('\n').map(l => l.replace(/^\s*-\s*/, '').trim()).filter(Boolean);
      planChanged = true;
    }
  }
  const nameTag = _extractTag(replyText, 'plan_name');
  if (nameTag && planFormat.isValidDotName(nameTag)) {
    sess.name = nameTag;
    planChanged = true;
  }
  // <plan_desc> — generated one-liner replaces the "Plan for:" echo of the
  // original prompt once the plan has real content to summarize.
  const descTag = _extractTag(replyText, 'plan_desc');
  if (descTag && sess.tasks.length) {
    sess.description = descTag.slice(0, 300);
    planChanged = true;
  }
  const statusTag = _extractTag(replyText, 'plan_status');
  if (statusTag === 'ready' && sess.tasks.length) {
    sess.status = 'ready';
    planChanged = true;
  }
  // <plan_run/> — user confirmed execution. Only meaningful with tasks; the
  // run itself is triggered by main.js from metadata.runPlan below.
  const runPlan = /<plan_run\s*\/?\s*>/.test(replyText) && sess.tasks.length > 0;
  if (runPlan && sess.status === 'drafting') {
    sess.status = 'ready';
    planChanged = true;
  }
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

  if (planChanged || sess._nameChanged || sess.status === 'drafting') {
    sess._nameChanged = false;
    _writePlanFile(sess);
  }
  // Background: generate execution steps for tasks that lack them — user can
  // keep chatting/editing while steps stream into the plan file.
  _scheduleStepGen(sess);
  _activePlanId = sess.planId;
  if (sessionId) _sessionToPlan.set(sessionId, sess.planId);

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

  const spoken = _stripMarkers(replyText)
    || (sess.tasks.length ? 'I updated the plan — take a look.' : 'Working on the plan now.');

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
      startedExplicit,
      speakable: true,
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
      + '\nGeneric surfaces (execution lanes, not services): browser.agent | web.agent | web.crawl | edit.agent | shell | none';
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
  if (!sess.tasks.length) return '(no tasks yet — first turn)';
  const lines = sess.tasks.map(t => {
    const live = /pending|progress|running/i.test(String(t.status || ''))
      ? _liveInstallCheck(t.title) : null;
    return `Task ${t.num} — ${t.title} | mode=${t.mode} | deps=[${t.dependsOn.join(',') || 'none'}] | auth=${t.auth} | status=${t.status}`
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
    if (!sess || !Array.isArray(sess.tasks) || !sess.tasks.length) return null;
    if (TERMINAL.has(String(sess.status || '').toLowerCase())) return null;
    const pending = sess.tasks.filter(t => !TASK_TERMINAL.has(t.status));
    if (!pending.length) return null;
    return {
      planId: sess.planId,
      title: sess.title || sess.planId,
      pendingCount: pending.length,
      totalTasks: sess.tasks.length,
      taskTitles: sess.tasks.map(t => t.title || '').filter(Boolean),
      filePath: sess.filePath,
    };
  };

  // Session-bound plan first.
  const bound = sessionId ? _sessionToPlan.get(sessionId) : null;
  const boundSess = bound
    ? (_planSessions.get(bound) || _loadPlanFromDisk(bound))
    : null;
  const hit = _openFromSess(boundSess);
  if (hit) return hit;

  // Most recently touched in-memory plan.
  const activeSess = _activePlanId
    ? (_planSessions.get(_activePlanId) || _loadPlanFromDisk(_activePlanId))
    : null;
  const activeHit = _openFromSess(activeSess);
  if (activeHit) return activeHit;

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
      if (open) return open;
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
 * Re-run step generation for one task after a failure. Clears the
 * `Steps Status` marker on disk + the live task, then re-schedules.
 */
function retrySteps(planId, taskNum) {
  const sess = getPlanSession(planId);
  if (!sess) return { ok: false, error: 'no planning session for ' + planId };
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

module.exports = { execute, getActivePlanId, getPlanSession, clearActivePlan, retrySteps, findOpenPlan };
