'use strict';

/**
 * planReply.cjs — pure routing helpers for plan-adjacent prompts
 *
 * Extracted from server.cjs so they can be unit-tested (server.cjs binds a
 * port on require). Two decisions live here:
 *
 *   isPlanAnswerShape — does a short reply ANSWER an open plan's pending
 *   question (verb-free phrase, route-option label, ordinal), or is it a
 *   new command that must classify on its own merits?
 *
 *   shouldPinGate — capability gate mapping: an exact+ready selector pick
 *   with no missing info pins the agent and hands off; anything else keeps
 *   the planning options/clarify flow.
 */

// Action/nav verbs — a short prompt carrying one of these is a new command,
// not an answer to the plan's pending question. go/goto/navigate/browse were
// missing once and voice navigation commands ("goto john 1") were eaten by
// an awaiting-input plan.
const PLAN_REPLY_VERB_RE = /\b(go|goto|navigate|browse|visit|open|launch|play|show|display|search|look|read|click|watch|listen|send|add|create|check|tell|text|call|find|get|set|make|remind|schedule|summarize|give|what|how|when|where|who|why)\b/i;

const _ORDINAL_RE = /\b(?:option|choice|pick)\s+\w+|^(?:the\s+)?(?:first|second|third|fourth|fifth|last|top|bottom)\b/i;

/**
 * @param {string} ansText - the short user reply
 * @param {object} [openPlan] - findOpenPlan result; routeOptions labels shape
 *   what counts as a pick
 * @returns {boolean} true when the reply is answer-shaped
 */
function isPlanAnswerShape(ansText, openPlan) {
  const t = String(ansText || '').trim();
  if (!t) return false;
  if (!PLAN_REPLY_VERB_RE.test(t)) return true;
  const lower = t.toLowerCase();
  const labels = (openPlan && openPlan.routeOptions || [])
    .map(o => String(o.label || o.id || '').toLowerCase().replace(/\.agent$/, '').replace(/[_-]+/g, ' '))
    .filter(Boolean);
  if (labels.some(l => lower.includes(l) || l.split(/\s+/).every(w => w && lower.includes(w)))) return true;
  return _ORDINAL_RE.test(t);
}

function shouldPinGate(decision, needsInfo) {
  return decision === 'pin' && !needsInfo;
}

/**
 * Should a short reply be captured as an open plan's pending answer?
 * Requires ALL of:
 *   - the plan is bound to THIS conversation session (a foreign/dormant plan
 *     must not swallow fresh commands)
 *   - the plan is actually AWAITING input (route pick / needsInfo / drafting)
 *     — a plan with merely-pending tasks is mid-run, and short verb-free
 *     prompts like "pictures of Batman" are new commands, not plan answers
 *   - the text is short and answer-shaped (verb-free phrase, option label,
 *     ordinal pick)
 */
function shouldCaptureShortReply(openPlan, ansText) {
  if (!openPlan) return false;
  const t = String(ansText || '').trim();
  if (!t || t.length > 60 || t.split(/\s+/).length > 6) return false;
  if (openPlan.boundToSession === false) return false;
  if (openPlan.awaitingInput !== true) return false;
  return isPlanAnswerShape(t, openPlan);
}

module.exports = { PLAN_REPLY_VERB_RE, isPlanAnswerShape, shouldPinGate, shouldCaptureShortReply };
