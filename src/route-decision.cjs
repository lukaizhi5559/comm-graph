/**
 * route-decision.cjs — the canonical RouteDecision envelope.
 *
 * ONE classification per prompt. comms-graph's cheap 0–6 lane triage decides
 * which *tier* a prompt enters; for handoff-bound prompts this module runs
 * the rich task classifier (stategraph-module's classifyTask — the same
 * schema the execution graph consumes) ONCE, here at ingress, and the result
 * travels with the task:
 *
 *   comms-graph  ──RouteDecision──▶  /comms.handoff ──▶ state._taskClassification
 *
 * Downstream, resolveReferencesV2 consumes the seeded decision instead of
 * re-deriving it — the two layers can no longer disagree about what a prompt
 * is, and the hint-veto / bypass-regex scar tissue becomes unnecessary.
 *
 * The envelope also informs the capability gate: a task whose taskType is a
 * local/query type and names no service can never be a service task, so the
 * gate returns null on structure alone — no regex needed to be right.
 */
const path = require('path');
const http = require('http');
const { ask } = require('./llm-providers.cjs');
const logger = require('./logger.cjs');

// Bound extension tabs are the single most important fact for "what is this
// prompt" — fetched once at ingress so the envelope's follow-up/first-result
// decisions see the live browser surface instead of guessing context-free.
const COMMAND_PORT = parseInt(process.env.COMMAND_SERVICE_PORT || '3007', 10);
function _fetchExtSessions(timeoutMs = 600) {
  return new Promise((resolve) => {
    const req = http.get({ hostname: '127.0.0.1', port: COMMAND_PORT, path: '/ext.sessions', timeout: timeoutMs }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try {
          const j = JSON.parse(data);
          resolve(Array.isArray(j.sessions) ? j.sessions.filter(s => s && s.url && /^https?:/i.test(s.url)) : []);
        } catch (_) { resolve([]); }
      });
    });
    req.on('timeout', () => { req.destroy(); resolve([]); });
    req.on('error', () => resolve([]));
  });
}

// Task types that name an external/automation capability and may legitimately
// reach the service-picker. Everything else (query, local_file, local_system,
// ambiguous-without-service) bypasses the capability gate on structure.
const SERVICE_TASK_TYPES = new Set([
  'messaging',
  'browser',
  'scheduling',
  'app_automation',
]);

// taskType/suggestedIntent vocabulary is owned by stategraph-module's
// classifyTask; lanes are comms-graph's tier vocabulary (the switch cases in
// server.cjs). LANE_BY_INTENT is the bridge between the two.
const LANE_BY_INTENT = {
  handoff: 0,
  general_quick: 1,
  memory_store: 5,
  screen_display: 7,
  web_search: 8,
};

let _classifyTask = null;
let _classifyTried = false;

function _getClassifyTask() {
  if (_classifyTried) return _classifyTask;
  _classifyTried = true;
  try {
    // Cross-module require — classifyTask stays home next to its own
    // dependencies (textPatterns, localPlanTemplates, parseLlmJson). If the
    // layout ever moves, everything degrades to null → pre-envelope behavior.
    _classifyTask = require(path.resolve(
      __dirname, '../../stategraph-module/src/utils/classifyTask.js'
    )).classifyTask;
  } catch (e) {
    logger.warn(`[route-decision] classifyTask unavailable — envelope disabled: ${e.message}`);
    _classifyTask = null;
  }
  return _classifyTask;
}

// Adapter over comms-graph's provider chain so classifyTask's
// llmBackend.generateAnswer(prompt, {context}, {maxTokens…}) contract is met.
const _llmBackend = {
  generateAnswer: async (prompt, opts = {}, gen = {}) => {
    const sys = opts?.context?.systemInstructions;
    const messages = [
      ...(sys ? [{ role: 'system', content: sys }] : []),
      { role: 'user', content: prompt },
    ];
    const r = await ask(messages, {
      maxTokens: gen.maxTokens || 400,
      temperature: gen.temperature ?? 0,
      taskType: 'classification',
    });
    return r.text;
  },
};

/**
 * True when the envelope describes a standalone public-web research request:
 * the LLM typed it 'browser' only because the phrasing says "search online",
 * but there is no named service, no DOM interaction, no follow-up referent,
 * and nothing to navigate to — the SERP answers it directly. This mirrors
 * stategraph's routeTable 'public-research' rule (browser + public_read +
 * no service → web_search) so the ingress envelope and the graph agree on
 * what the prompt is instead of handing a lookup to page_nav_scan browser
 * automation (observed: highlight + "tell me about smoothstack… search
 * online" → taskType=browser → handoff → google.com nav + scan_page, and the
 * user got an automation report instead of an answer).
 */
function isPublicWebResearch(tc) {
  if (!tc) return false;
  const noActions = !Array.isArray(tc.interactiveActions) || tc.interactiveActions.length === 0;
  // public_read is the primary signal; a model that emits suggestedIntent
  // 'web_search' over a 'browser' taskType is saying the same thing — its own
  // rules say browser → command_automate, so the override is deliberate.
  const researchSignal = tc.webAccessMode === 'public_read' || tc.suggestedIntent === 'web_search';
  return tc.taskType === 'browser'
    && researchSignal
    && !tc.targetService
    && tc.requiresDOM !== true
    && noActions
    && tc.isFollowUp !== true
    && tc.needsClarification !== true
    && tc.isRecurring !== true
    && tc.isBrowseOnly !== true
    && tc.expectsFileOutput !== true
    && !tc.isScreenFollowUp && !tc.needsFreshScreen && !tc.isAppUiInspection
    && !tc.isSpatialAnalysis && !tc.isImageAnalysis && !tc.isConversationRecall
    && !tc.isActivityQuery
    && (!tc.resolution || tc.resolution === 'resolved');
}

/**
 * Map a classifyTask envelope to a comms-graph lane. Conservative by design:
 * a prompt only leaves the handoff lane when the taskType is 'query', no
 * screen/recurring/DOM/service signal is set, and suggestedIntent is one of
 * the unambiguous chat/memory intents. Everything else stays a task — a
 * wrong demotion (task answered as chat) is worse than a question sent to
 * the graph, which has its own answer path.
 */
function deriveLane(tc) {
  if (!tc || !tc.taskType) return 'handoff';
  const hasScreenSignal =
    tc.isScreenFollowUp || tc.needsFreshScreen || tc.isAppUiInspection ||
    tc.isSpatialAnalysis || tc.isImageAnalysis || tc.isConversationRecall;
  // Context-free public research rides the express SERP executor even when
  // the envelope typed it 'browser' — same answer the graph's web_search
  // intent would produce, minus the browser takeover.
  if (isPublicWebResearch(tc)) return 'web_search';
  const isServiceTask =
    SERVICE_TASK_TYPES.has(tc.taskType) || !!tc.targetService;
  if (tc.taskType !== 'query' || hasScreenSignal || isServiceTask ||
      tc.isRecurring || tc.requiresDOM || tc.isBrowseOnly) {
    return 'handoff';
  }
  if (tc.suggestedIntent === 'memory_store') return 'memory_store';
  // "Show/display X on screen" — the screen lane captures + answers +
  // displays on the GhostLayer. Only reached when no screen-follow-up signal
  // fired above (those need the graph's live-context resolution instead).
  if (tc.suggestedIntent === 'screen_display') return 'screen_display';
  // A clean standalone lookup the envelope calls web_search can ride the
  // express executor (~1.5s) instead of a full graph run.
  if (tc.suggestedIntent === 'web_search') return 'web_search';
  // Memory retrieval stays handoff — the stategraph's retrieveMemory does
  // profile.get + memory.search with full context; the old demote to the
  // memory_quick lane produced shallow/wrong answers.
  if (tc.suggestedIntent === 'greeting' || tc.suggestedIntent === 'general_knowledge') return 'general_quick';
  return 'handoff';
}

/**
 * Plan shape — whether an automation-shaped prompt is a single concrete
 * deliverable (the bounded planner can just run it) vs genuinely plan-shaped
 * work (multi-step / recurring / service-coordinating / unclear / follow-up).
 * gatherPlanContext's no_skill_coverage gate consumes 'single' to suppress
 * the escalation into conversational planning — observed: "give me code for
 * hello world in python" bounced into a ~96s planning lane + 2 clarifying
 * questions when the bounded planner would have simply written the file.
 * Returns 'single' | 'complex' | null — null means "unknown, let the gate
 * decide on its own" (the conservative default).
 */
function derivePlanShape(tc) {
  if (!tc || !tc.taskType) return null;
  if (tc.isRecurring || tc.suggestedIntent === 'multi_step' || tc.needsClarification
      || tc.isFollowUp || tc.targetService || SERVICE_TASK_TYPES.has(tc.taskType)) {
    return 'complex';
  }
  if (tc.taskType === 'local_file' || tc.taskType === 'local_system' || tc.taskType === 'query') {
    return 'single';
  }
  return null;
}

/**
 * True when the capability gate has nothing to decide — the task is a local
 * or query type and names no service. Structure, not regex, is the check.
 */
function canSkipCapabilityGate(tc) {
  if (!tc) return false;
  return !SERVICE_TASK_TYPES.has(tc.taskType) && !tc.targetService;
}

/**
 * Run the single classification for a handoff-bound prompt.
 * @returns {Promise<object|null>} envelope {taskType, suggestedIntent, lane,
 *   …flags} or null when unavailable/failed (callers keep prior behavior).
 */
async function classifyRoute(userMessage, conversationHistory) {
  const classifyTask = _getClassifyTask();
  if (!classifyTask || !userMessage) return null;
  try {
    // classifyTask wants [{role, content}] turns; callers pass the formatted
    // "User: …\nAssistant: …" string. Coerce — but continuation lines (the
    // body of a multi-line Assistant answer) belong to the PREVIOUS turn,
    // not to a new user turn. Flattening them to role:'user' made answer
    // fragments the newest "user" text — elliptical-follow-up lane inference
    // then read a filename/list bullet as the prior turn and fell back to
    // memory_retrieve (observed: Downloads follow-ups → memory_retrieve).
    const convArr = Array.isArray(conversationHistory)
      ? conversationHistory
      : String(conversationHistory || '').split('\n').reduce((out, line) => {
          if (/^Assistant:/i.test(line)) {
            out.push({ role: 'assistant', content: line.replace(/^Assistant:\s*/i, '') });
          } else if (/^User:/i.test(line)) {
            out.push({ role: 'user', content: line.replace(/^User:\s*/i, '') });
          } else if (out.length) {
            out[out.length - 1].content += '\n' + line;
          } else {
            out.push({ role: 'user', content: line });
          }
          return out;
        }, []);
    const tc = await classifyTask(
      userMessage,
      convArr,
      _llmBackend,
      logger,
      null, // priorScreenSummary — not gathered at ingress; screen follow-ups default to handoff anyway
      null, // activeAppContext — stategraph gathers its own live context
      { askDecision: require('./decision.cjs').askDecision, // local typed-decision path (DECISION_LOCAL=0 disables)
        extSessions: await _fetchExtSessions() }, // bound tabs — first-result/follow-up vetoes need them
    );
    if (!tc || typeof tc !== 'object' || !tc.taskType) return null;
    const lane = deriveLane(tc);
    const planShape = derivePlanShape(tc);
    logger.info(`[route-decision] taskType=${tc.taskType} suggestedIntent=${tc.suggestedIntent || 'null'} lane=${lane} planShape=${planShape || 'null'}${tc.targetService ? ` service=${tc.targetService}` : ''}`);
    return { ...tc, lane, planShape };
  } catch (e) {
    logger.warn(`[route-decision] classifyTask failed — continuing without envelope: ${e.message}`);
    return null;
  }
}

/** Strip non-serializable fields before the envelope crosses HTTP. */
function serializeDecision(tc) {
  if (!tc || typeof tc !== 'object') return null;
  const out = { ...tc };
  delete out._detPrefirePromise;
  return out;
}

module.exports = { classifyRoute, deriveLane, derivePlanShape, canSkipCapabilityGate, serializeDecision, isPublicWebResearch, SERVICE_TASK_TYPES, LANE_BY_INTENT, fetchExtSessions: _fetchExtSessions, _llmBackend };
