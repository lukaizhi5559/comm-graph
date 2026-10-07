'use strict';

/**
 * statusCheck.cjs — Intent 3: task status query
 *
 * Handles "how is my task going?", "are you done?", "what's the status?"
 * Reads the task journal and responds instantly with progress info.
 * No LLM call needed for the data — only for naturalizing the response.
 */

const logger = require('../logger.cjs');
const { ask, buildMessages } = require('../llm-providers.cjs');
const { formatStatusSummary, getActiveTasks, getRecentTasks } = require('../taskJournal.cjs');

// "is <tool> installed" — probe the real binary rather than guessing.
const _INSTALL_PROBE_RE = /\b(?:is|was)\s+(?:the\s+plan|it|that|([a-z0-9@._-]+))\s+(installed|set up)\b/i;

function _probeInstalled(englishText) {
  const m = String(englishText || '').match(_INSTALL_PROBE_RE);
  const bin = m && m[1] ? m[1].replace(/[^a-z0-9@._-]/gi, '') : null;
  if (!bin || bin.length < 2) return null;
  try {
    const r = require('child_process').spawnSync('which', [bin], { timeout: 2000 });
    if (r.status === 0) return `Yes — ${bin} is on the PATH.`;
    return `No — ${bin} isn't on the PATH.`;
  } catch (_) { return null; }
}

// ── Status query patterns ──────────────────────────────────────────────────────
const STATUS_PATTERNS = [
  /\bhow\s+(is|'s)\s+(that|it|the)\b/i,
  /\bwhat('?s| is)\s+the\s+status\b/i,
  /\bare\s+you\s+done\b/i,
  /\bstill\s+running\b/i,
  /\bhow\s+far\s+along\b/i,
  /\bany\s+progress\b/i,
  /\bcoming\s+along\b/i,
];

/**
 * Check if a message is a status query.
 * @param {string} englishText
 * @returns {boolean}
 */
function isStatusQuery(englishText) {
  return STATUS_PATTERNS.some(p => p.test(englishText));
}

/**
 * @param {string} englishText  - English user message
 * @param {string} systemPrompt - Full system prompt (persona + personality)
 * @returns {Promise<{ text: string, fullText: string, metadata: Object }>}
 */
// "do we have a plan for X" / "the X plan" / "I thought we had X planned" —
// search saved plans on disk (incl. terminal ones) instead of trusting memory.
const _PLAN_PROBE_RE = /\b(?:a\s+|the\s+|my\s+|our\s+)?([\w][\w .-]{0,40}?)\s+plan\b|\bplan\s+(?:for|about|on)\s+([\w][\w .-]{1,40})/i;
function _probePlan(englishText) {
  const s = String(englishText || '');
  if (!/\bplan\b/i.test(s)) return null;
  const m = s.match(_PLAN_PROBE_RE);
  const query = (m && (m[1] || m[2]) || '').trim()
    .replace(/^(?:the|a|an|my|our)\s+/i, '').trim();
  // "the plan" / "my plan" alone carries no referent — let open-plan path answer.
  const meaningful = query.split(/[^a-z0-9]+/i).filter(t => t.length > 1 && !/^(the|a|an|my|our|new|next|same|plan)$/i.test(t));
  if (!meaningful.length) return null;
  const hits = require('../../../shared/system-map.cjs').findPlans(query);
  if (!hits.length) return null;
  const p = hits[0];
  return `Yes — I found the ${p.name || p.title || 'saved'} plan (${p.planId}), `
    + `status ${p.status}, ${p.pendingCount} of ${p.totalTasks} tasks unfinished`
    + (p.taskTitles.length ? ` (${p.taskTitles.slice(0, 4).join('; ')})` : '') + '.'
    + (/^(done|cancelled|failed)$/i.test(p.status)
      ? ' It\'s not active — say "continue the ' + (p.name || query) + ' plan" in planning mode and I\'ll reopen it.'
      : ' Say "continue" to pick it back up.');
}

async function execute(englishText, systemPrompt) {
  // Plan-existence questions answer from disk, not the task journal — a saved
  // plan is "something we had" even when nothing is running right now.
  const planProbe = _probePlan(englishText);
  if (planProbe) {
    return {
      text: planProbe,
      fullText: planProbe,
      metadata: { source: 'status_check_plan_probe', intent: 3 },
    };
  }

  // Get status summary from task journal
  const summary = formatStatusSummary();

  logger.info('[StatusCheck] Summary', {
    activeCount: getActiveTasks().length,
    recentCount: getRecentTasks().length,
    summaryPreview: summary.substring(0, 80),
  });

  if (summary === 'Nothing is currently running. The slate is clean.') {
    // No active tasks in the journal — but a plan may still be open (paused
    // mid-run). Report plan state instead of a blind "nothing's running",
    // and probe "is <tool> installed" questions for a truthful answer.
    let openPlan = null;
    try { openPlan = require('./planning.cjs').findOpenPlan(null); } catch (_) {}
    const probe = _probeInstalled(englishText);
    if (openPlan || probe) {
      const parts = [];
      if (probe) parts.push(probe);
      if (openPlan) {
        parts.push(`Your plan "${openPlan.title}" is paused — `
          + `${openPlan.totalTasks - openPlan.pendingCount} of ${openPlan.totalTasks} tasks done. `
          + `Say "continue" to pick it back up.`);
      }
      const response = parts.join(' ');
      return {
        text: response,
        fullText: response,
        metadata: { source: 'status_check_plan', intent: 3, planId: openPlan ? openPlan.planId : null },
      };
    }
    // No active tasks, no open plan — respond directly, rotating phrasing so
    // repeated checks don't read as a stuck loop.
    const variants = [
      summary,
      'All clear — nothing in flight right now.',
      'No active tasks at the moment. Standing by.',
      'Nothing on the board — idle and ready.',
      'All tasks are done. Nothing is running.',
    ];
    const response = variants[Math.floor(Math.random() * variants.length)];
    return {
      text: response,
      fullText: response,
      metadata: { source: 'status_check_empty', intent: 3 },
    };
  }

  // Naturalize the status summary through the personality layer
  const naturalizePrompt = `The user asked: "${englishText}"\n\nCurrent task status:\n${summary}\n\nRespond naturally in 1-2 sentences as ThinkDrop. Summarize what's running and the progress. No markdown. Be conversational.`;
  const messages = buildMessages(naturalizePrompt, systemPrompt);
  const { text: naturalized } = await ask(messages, {
    maxTokens: 100,
    temperature: 0.7,
    timeoutMs: 5000,
  });

  const response = naturalized || summary;

  return {
    text: response,
    fullText: response,
    metadata: { source: 'status_check', intent: 3, taskCount: getActiveTasks().length },
  };
}

module.exports = { execute, isStatusQuery };
