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
const { ask } = require('../llm-providers.cjs');
const planFormat = require('../../../shared/plan-format.cjs');
const { canonicalAgent } = require('../../../shared/agent-canonical.cjs');
const skillIndex = require('../../../shared/skill-index.cjs');

// ── Paths / services ─────────────────────────────────────────────────────────

function _plansDir() {
  return process.env.THINKDROP_PLANS_DIR
    || path.join(os.homedir(), '.thinkdrop', 'plans');
}

const MEMORY_PORT = parseInt(process.env.MEMORY_SERVICE_PORT || '3001', 10);
const WEB_SEARCH_PORT = parseInt(process.env.WEB_SEARCH_PORT || '3002', 10);
const MAIN_PORT = parseInt(process.env.THINKDROP_MAIN_PORT || '3010', 10);
const MCP_API_KEY = process.env.MCP_MEMORY_API_KEY || process.env.MCP_API_KEY || '';
const WS_API_KEY = process.env.MCP_WEBSEARCH_API_KEY || process.env.MCP_API_KEY || '';

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

const _STEPGEN_PROMPT = `You are ThinkDrop's execution planner. Convert ONE task
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

async function _generateTaskSteps(task) {
  const agents = (task.agents || []).join(' | ') || 'auto';
  const userMsg =
    `TASK AGENTS: ${agents}\n` +
    `TASK PROMPT: ${task.prompt || task.title}\n` +
    (task.doneWhen ? `DONE WHEN: ${task.doneWhen}\n` : '') +
    `\nEmit the step list now.`;
  try {
    const { text } = await ask([
      { role: 'system', content: _STEPGEN_PROMPT },
      { role: 'user', content: userMsg },
    ], { maxTokens: 900, temperature: 0.2, timeoutMs: 45000, taskType: 'planning' });
    const m = String(text || '').match(/```(?:json)?\s*\n?([\s\S]*?)```/);
    const steps = m ? JSON.parse(m[1].trim()) : null;
    if (!Array.isArray(steps) || !steps.length) return null;
    const valid = steps.every(s => s && typeof s.skill === 'string' && s.skill);
    if (!valid) return null;
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
        const steps = await _generateTaskSteps(task);
        if (!steps) continue;
        // Patch the file IN PLACE — the user may have edited other fields (or
        // this task's prompt) while generation ran. Only write when the
        // on-disk prompt still matches what we generated for.
        try {
          const onDisk = fs.readFileSync(sess.filePath, 'utf8');
          const diskTask = planFormat.parseTasks(onDisk).find(t => t.num === task.num);
          if (diskTask && diskTask.prompt === promptAtGen) {
            const norm = task._normalized;
            let next = planFormat.updateTaskSteps(onDisk, task.num, steps);
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
  const data = res?.data || res;
  const results = data?.results || data?.organic || [];
  if (!Array.isArray(results) || !results.length) return 'No web results found.';
  return results.slice(0, 5)
    .map(r => `- ${r.title || ''}: ${r.snippet || r.description || ''}`.trim())
    .filter(s => s.length > 2)
    .join('\n');
}

const _TOOL_RE = /<tool>\s*(memory\.search|web\.search)\s*\(\s*"([^"]+)"\s*\)\s*<\/tool>/g;

async function _runTools(text) {
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
    const out = call.tool === 'memory.search'
      ? await _toolMemorySearch(call.query)
      : await _toolWebSearch(call.query);
    results.push(`${call.tool}("${call.query}") →\n${out || '(no result)'}`);
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
  <tool>memory.search("query")</tool>   — the user's stored facts/preferences
  <tool>web.search("query")</tool>      — live web research
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
- **Agents**: service.agent | cli.agent | shell | edit.agent | none
- **Depends on**: — | Task 1, Task 2
- **Mode**: sequential | parallel
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

OTHER MARKERS (optional):
  <plan_name>dot.syntax.name</plan_name> — when the user names the plan
    (e.g. history.project.plan) or you propose one and they accept.
  <plan_status>ready</plan_status> — when the user confirms the plan is good
    to run AND every task is concrete. Do not mark ready while asking questions.
  <plan_run/> — when the user confirms they want to EXECUTE the plan now
    ("let's do it", "run it", "go ahead", "I'm ready"). Emitting this marker
    is what actually starts the tasks — NEVER tell the user tasks are running
    or queued unless you emitted it in the same reply. Only emit when the
    plan has tasks; if you're still gathering info, keep asking instead.
    If RUN GATE says BLOCKED, a run was refused — never tell the user tasks
    are running; state which agent needs attention instead.

REPLY TEXT — everything outside the markers is spoken/shown to the user.
Keep it short and conversational: acknowledge, ask your one question, or
summarize what changed in the plan. Do not restate the whole plan in prose.
═══════════════════════════════════════════════`;

// ── Marker extraction ─────────────────────────────────────────────────────────

function _extractTag(text, tag) {
  const m = String(text || '').match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`));
  return m ? m[1].trim() : null;
}

function _stripMarkers(text) {
  return String(text || '')
    .replace(/<tool>[\s\S]*?<\/tool>/g, '')
    .replace(/<plan_update>[\s\S]*?<\/plan_update>/g, '')
    .replace(/<plan_name>[\s\S]*?<\/plan_name>/g, '')
    .replace(/<plan_status>[\s\S]*?<\/plan_status>/g, '')
    .replace(/<plan_run\s*\/?\s*>/g, '')
    .replace(/<tool_results>[\s\S]*?<\/tool_results>/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ── Entry point ───────────────────────────────────────────────────────────────

/**
 * Handle a prompt while planning mode is active.
 *
 * @param {Object} args
 * @param {string} args.englishText   - English user message
 * @param {string} args.systemPrompt  - persona system prompt (planning directive appended here)
 * @param {string} [args.sessionId]   - conversation session this turn routed into
 * @param {Object} [args.planning]    - { active:true, planId?, name? }
 * @param {string} [args.source]      - 'voice' | 'text'
 * @returns {Promise<{text, fullText, metadata}>}
 */
async function execute({ englishText, systemPrompt, sessionId, planning = {}, source = 'text', conversationContext = null }) {
  const startedExplicit = planning.startedExplicit === true;
  const sess = _getOrCreateSession({
    planId: planning.planId || _sessionToPlan.get(sessionId) || (planning.active ? _activePlanId : null),
    sessionId,
    originalPrompt: englishText,
    conversationContext,
  });
  if (!sess.originalPrompt) sess.originalPrompt = englishText;

  // Conversational rename — "call it history.project.plan"
  const inlineName = planning.name || planFormat.extractDotNameFromPrompt(
    /\b(?:call|name|rename)\b[^.]*\b(?:it|plan|this)\b[^a-z0-9]*([a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*){1,4})/i.test(englishText)
      ? englishText : '');
  if (inlineName && planFormat.isValidDotName(inlineName)) {
    sess.name = inlineName;
  }

  const sysContent = (systemPrompt || '') + PLANNING_DIRECTIVE
    + `\n\nCURRENT PLAN STATE (planId ${sess.planId}, file already saved — update it with <plan_update> when it changes):\n`
    + _renderPlanState(sess)
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

  for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
    const messages = [{ role: 'system', content: sysContent }, ...sess.history];
    const { text } = await ask(messages, {
      maxTokens: 1200,
      temperature: 0.4,
      timeoutMs: 30000,
      taskType: 'planning',
    });

    if (!text) {
      logger.warn('[Planning] LLM returned empty', { planId: sess.planId, round });
      replyText = replyText || "I'm having trouble drafting right now — try again in a moment.";
      break;
    }

    const toolResults = await _runTools(text);
    if (toolResults && round < MAX_TOOL_ROUNDS) {
      // Record the assistant's tool-call turn, then feed results back.
      sess.history.push({ role: 'assistant', content: text });
      sess.history.push({ role: 'user', content: `<tool_results>\n${toolResults}\n</tool_results>` });
      toolNotes = (toolNotes ? toolNotes + '\n' : '') + toolResults;
      continue;
    }

    sess.history.push({ role: 'assistant', content: text });
    replyText = text;
    break;
  }

  // ── Apply plan mutations ────────────────────────────────────────────────────
  let planChanged = false;
  const update = _extractTag(replyText, 'plan_update');
  if (update) {
    const newTasks = planFormat.parseTasks(update);
    if (newTasks.length) {
      // Canonicalize service aliases in the file itself — google_docs.agent →
      // google.agent so preflight and the run lock share one identity.
      for (const t of newTasks) {
        t.agents = (t.agents || []).map(a => canonicalAgent(a) || a);
      }
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

  if (planChanged || sess.status === 'drafting') {
    _writePlanFile(sess);
  }
  // Background: generate execution steps for tasks that lack them — user can
  // keep chatting/editing while steps stream into the plan file.
  _scheduleStepGen(sess);
  _activePlanId = sess.planId;
  if (sessionId) _sessionToPlan.set(sessionId, sess.planId);

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
      runPlan,
      startedExplicit,
      speakable: true,
    },
  };
}

function _renderPlanState(sess) {
  if (!sess.tasks.length) return '(no tasks yet — first turn)';
  const lines = sess.tasks.map(t =>
    `Task ${t.num} — ${t.title} | mode=${t.mode} | deps=[${t.dependsOn.join(',') || 'none'}] | auth=${t.auth} | status=${t.status}`);
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

function getPlanSession(planId) {
  return _planSessions.get(planId) || _loadPlanFromDisk(planId);
}

/** Clear the in-memory active plan (cancel / leave planning mode). */
function clearActivePlan() {
  _activePlanId = null;
}

module.exports = { execute, getActivePlanId, getPlanSession, clearActivePlan };
