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
const { ask } = require('./llm-providers.cjs');
const logger = require('./logger.cjs');

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
  memory_quick: 2,
  memory_store: 5,
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
  const isServiceTask =
    SERVICE_TASK_TYPES.has(tc.taskType) || !!tc.targetService;
  if (tc.taskType !== 'query' || hasScreenSignal || isServiceTask ||
      tc.isRecurring || tc.requiresDOM || tc.isBrowseOnly) {
    return 'handoff';
  }
  if (tc.suggestedIntent === 'memory_store') return 'memory_store';
  if (tc.suggestedIntent === 'memory_retrieve' && !tc.isFollowUp) return 'memory_quick';
  if (tc.suggestedIntent === 'greeting' || tc.suggestedIntent === 'general_knowledge') return 'general_quick';
  return 'handoff';
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
    // "User: …\nAssistant: …" string. Coerce — string history is still useful
    // context, just in the wrong shape.
    const convArr = Array.isArray(conversationHistory)
      ? conversationHistory
      : String(conversationHistory || '').split('\n').filter(Boolean).map(l =>
          /^Assistant:/i.test(l) ? { role: 'assistant', content: l.replace(/^Assistant:\s*/i, '') }
                                 : { role: 'user', content: l.replace(/^User:\s*/i, '') });
    const tc = await classifyTask(
      userMessage,
      convArr,
      _llmBackend,
      logger,
      null, // priorScreenSummary — not gathered at ingress; screen follow-ups default to handoff anyway
      null, // activeAppContext — stategraph gathers its own live context
    );
    if (!tc || typeof tc !== 'object' || !tc.taskType) return null;
    const lane = deriveLane(tc);
    logger.info(`[route-decision] taskType=${tc.taskType} suggestedIntent=${tc.suggestedIntent || 'null'} lane=${lane}${tc.targetService ? ` service=${tc.targetService}` : ''}`);
    return { ...tc, lane };
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

module.exports = { classifyRoute, deriveLane, canSkipCapabilityGate, serializeDecision, SERVICE_TASK_TYPES, LANE_BY_INTENT };
