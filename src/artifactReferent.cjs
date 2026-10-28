'use strict';
/**
 * artifactReferent.cjs — bind "delete that event I just set" to the artifact a
 * just-completed task created.
 *
 * The task journal holds the creator's agentId AND the raw step output (event
 * ids, file paths) — the creating agent owns the artifact's server-side
 * identity, so it gets first claim when a mutation prompt refers back. The
 * resolved referent (title + id + when) rides into the handoff prompt as a
 * "(Resolved referent — …)" clause so classifyTask/planSkillsV2 see the
 * concrete target instead of the bare pronoun.
 */

let _tp = {};
try { _tp = require('../../shared/text-patterns.cjs'); } catch (_) {}
const ARTIFACT_MUTATION_RE = _tp.ARTIFACT_MUTATION_RE
  || /\b(delete|remove|erase|trash|cancel|reschedul\w*|postpone|move|change|edit|update|rename|clear)\b/i;
const ARTIFACT_NOUN_RE = _tp.ARTIFACT_NOUN_RE
  || /\b(event|meeting|appointment|reminder|alarm|timer|alert|calendar|note|file|folder|document|doc|playlist|booking|reservation|task|to-?do|post|tweet|message|draft|contact|invite|invitation)\b/i;
const ARTIFACT_CREATE_RE = _tp.ARTIFACT_CREATE_RE
  || /\b(create|set\s+up|set|add|schedule|book|make|new|put|register|invite)\b/i;
const ARTIFACT_RECENCY_RE = _tp.ARTIFACT_RECENCY_RE
  || /\b(that|this|it|the one|just|recent|earlier)\b/i;

/** Recency window for a BARE-deictic referent ("delete it" with no noun) —
 *  "it" binds only to something created moments ago. */
const BARE_DEICTIC_WINDOW_MS = 30 * 60 * 1000;

/** Artifact noun in the user message → tokens the create-task prompt should
 *  also carry. Keeps "delete that event" from binding a file-create task. */
const NOUN_SYNONYMS = [
  [/\b(events?|meetings?|appointments?|calendar(?:\s+events?)?|bookings?|reservations?)\b/i, /\b(event|events|meeting|meetings|appointment|appointments|calendar|booking|reservation)\b/i],
  [/\b(reminders?|alarms?|timers?|alerts?)\b/i, /\b(reminder|reminders|alarm|alarms|timer|timers|alert|alerts)\b/i],
  [/\b(notes?|docs?|documents?)\b/i, /\b(note|notes|doc|docs|document|documents)\b/i],
  [/\b(files?|folders?)\b/i, /\b(file|files|folder|folders)\b/i],
  [/\b(playlists?)\b/i, /\b(playlist|playlists)\b/i],
  [/\b(tasks?|to-?dos?)\b/i, /\b(task|tasks|to-?do|to-?dos)\b/i],
  [/\b(posts?|tweets?|messages?|drafts?)\b/i, /\b(post|posts|tweet|tweets|message|messages|draft|drafts)\b/i],
  [/\b(contacts?|invites?|invitations?)\b/i, /\b(contact|contacts|invite|invites|invitation|invitations)\b/i],
];

function _nounMatchRe(message) {
  const m = String(message || '');
  for (const [msgRe, promptRe] of NOUN_SYNONYMS) {
    if (msgRe.test(m)) return promptRe;
  }
  return null;
}

/** Pull the artifact's identity out of a done task: quoted title from the
 *  prompt, `ID:`/`When:`/`Title:` lines from result or step outputs. */
function _describe(t) {
  const bits = [];
  const prompt = String(t.prompt || '');
  const q = prompt.match(/"([^"\n]{2,80})"|'([^'\n]{2,80})'/);
  const title = q ? (q[1] || q[2]).trim() : null;
  const outputs = [t.result, ...((t.artifacts && t.artifacts.steps) || []).map(s => s && s.output)];
  const blob = outputs.filter(Boolean).join('\n');
  const idM = blob.match(/\bID[:=]\s*([A-Za-z0-9_-]{4,})/i);
  const whenM = blob.match(/\bWhen:\s*([^\n]{3,80})/i);
  const titleM = !title && blob.match(/\bTitle:\s*([^\n]{2,80})/i);
  const label = title || (titleM && titleM[1].trim());
  if (label) bits.push(`titled "${label}"`);
  if (whenM) bits.push(`at ${whenM[1].trim()}`);
  if (idM) bits.push(`id ${idM[1]}`);
  return bits.length ? bits.join(', ') : null;
}

/**
 * @param {string} text          user message (English)
 * @param {Array}  recentTasks   taskJournal.getRecentTasks() entries
 * @returns {{ agentId:string, referentDesc:string, taskId:string } | null}
 */
function resolve(text, recentTasks) {
  const msg = String(text || '');
  if (!ARTIFACT_MUTATION_RE.test(msg)) return null;
  const nounRe = _nounMatchRe(msg);
  if (!nounRe && !ARTIFACT_RECENCY_RE.test(msg)) return null;
  const tasks = Array.isArray(recentTasks) ? recentTasks : [];
  const now = Date.now();
  // Newest-first — the referent of "that event I just set" is the most recent
  // matching creation (getRecentTasks already sorts doneAt desc).
  const candidates = tasks
    .filter(t => t && t.status === 'done' && t.agentId && ARTIFACT_CREATE_RE.test(String(t.prompt || '')));
  for (const t of candidates) {
    if (nounRe) {
      if (!nounRe.test(String(t.prompt || ''))) continue;
    } else if (!(typeof t.doneAt === 'number' && now - t.doneAt <= BARE_DEICTIC_WINDOW_MS)) {
      continue; // bare "it" — only a freshly-created artifact qualifies
    }
    const desc = _describe(t);
    return {
      agentId: t.agentId,
      taskId: t.id,
      referentDesc: `${msg.match(ARTIFACT_NOUN_RE)?.[0] || 'artifact'} ${desc ? `(${desc}) ` : ''}created by ${t.agentId} (task ${t.id}) — ${String(t.prompt || '').slice(0, 140)}. If multiple matches exist, list them and ask which one instead of deleting an arbitrary artifact.`,
    };
  }
  return null;
}

// ── Explicit-tool resolution ─────────────────────────────────────────────────
// "use nylas to delete it" names a registered CLI/API/MCP tool — an explicit
// pick must be deterministic, not a capability.search recall + LLM pick.
// Scans the prompt for registered-agent identities (agent stem, service,
// cli_tool, frontmatter keywords) via shared/service-map.cjs.

let _svcMap = null;
try { _svcMap = require('../../shared/service-map.cjs'); } catch (_) {}

const _CLI_TYPES = new Set(['cli', 'api_key', 'bearer', 'basic', 'mcp']);

/** Weak-tier candidates that sit at the tail of a data-artifact compound are
 *  names of things, not tool mentions — "commit messages" is git output, not
 *  Messages.app; "error messages", "log entries", "push notifications" are the
 *  same shape. Collecting their tails lets hits drop them without a wordlist
 *  of services. Heads are modifiers that produce data; verbs like send/write/
 *  read are deliberately absent so "send messages to mom" still resolves. */
const _DATA_COMPOUND_HEAD_RE = /\b(commit|commits?|error|errors?|log|logs?|status|diff|diffs?|push|pull|merge|build|test|tests?|deploy|release|system|audit|debug|console|warning|alerts?|notification|notifications?|chat|chats?|voice|email|e-?mails?|api|server|request|requests?|response|responses?|report|reports?|summar(?:y|ies)|data)\s+([a-z][\w.+-]{2,30})\b/gi;

function _dataCompoundTails(msg) {
  const tails = new Set();
  for (const m of String(msg || '').matchAll(_DATA_COMPOUND_HEAD_RE)) {
    tails.add(m[2].toLowerCase().replace(/[.,;:!?'"]+$/g, ''));
  }
  return tails;
}

/** All tokens that could be tool mentions, split by signal strength.
 *  strong — a token captured right after an explicit tool-preposition
 *  ("use nylas", "delete it with nylas"); in/on/from deliberately excluded —
 *  "in text format" isn't a tool mention. weak — every other bare token,
 *  which is how "nylas delete it" still resolves. */
function _candidateNames(text) {
  const msg = String(text || '');
  const norm = n => n.toLowerCase().replace(/[.,;:!?'"]+$/g, '');
  const strong = [];
  for (const m of msg.matchAll(/\b(?:use|using|via|with|through|by)\s+([A-Za-z][\w.+-]{1,30})/gi)) {
    strong.push(norm(m[1]));
  }
  const weak = [...strong];
  for (const m of msg.matchAll(/\b(?:in|on|from)\s+([A-Za-z][\w.+-]{1,30})|\b([a-z][\w.+-]{2,30})\b/gi)) {
    weak.push(norm(m[1] || m[2]));
  }
  return {
    strong: [...new Set(strong)].filter(Boolean),
    weak: [...new Set(weak)].filter(Boolean),
  };
}

/**
 * @param {string} text
 * @returns {{ agentId:string, type:string, matched:string } | null}
 */
function resolveExplicitTool(text) {
  if (!_svcMap || typeof _svcMap.listAgentNames !== 'function') return null;
  const msg = String(text || '').toLowerCase();
  const cands = _candidateNames(text);
  if (!cands.strong.length && !cands.weak.length) return null;
  let agents;
  try { agents = _svcMap.listAgentNames(); } catch (_) { return null; }
  const hits = [];
  for (const a of agents) {
    const stem = String(a.agentId || '').replace(/\.agent$/, '').toLowerCase();
    const d = _svcMap.describeAgent(a.agentId) || {};
    const aliases = new Set([stem, String(d.service || '').toLowerCase(), String(d.cliTool || '').toLowerCase()]);
    aliases.delete('');
    // Single-word keywords are too generic for bare prose ("text" in an ESV
    // scripture edit pinned messages.app.agent) — they only count when the
    // token rides an explicit tool-preposition. Multi-word keyword phrases
    // ("text message") stay specific enough to match anywhere.
    const kwAliases = new Set((d.keywords || []).map(k => String(k).toLowerCase()).filter(k => k && !k.includes(' ')));
    let matched = null;
    let tier = null;
    for (const name of cands.strong) {
      if (aliases.has(name) || kwAliases.has(name)) { matched = name; tier = 'strong'; break; }
    }
    if (!matched) {
      for (const name of cands.weak) {
        if (aliases.has(name)) { matched = name; tier = 'weak'; break; }
      }
    }
    // Multi-word keyword/service ("google calendar", "google docs") — the
    // whole phrase must appear in the message.
    if (!matched) {
      const phrases = (d.keywords || []).map(k => String(k).toLowerCase())
        .filter(al => al.includes(' ') && al.length > 4);
      for (const al of phrases) {
        if (msg.includes(al)) { matched = al; tier = 'phrase'; break; }
      }
    }
    if (matched) {
      hits.push({ agentId: a.agentId, type: d.type || 'browser', matched, tier, _cli: _CLI_TYPES.has(d.type) });
    }
  }
  if (!hits.length) return null;
  // A missed pin is cheap — normal routing still applies; a false pin overrides
  // a planner pick, so weak hits inside data compounds lose their vote.
  const _tails = _dataCompoundTails(msg);
  const surviving = hits.filter(h => !(h.tier === 'weak' && _tails.has(h.matched)));
  if (!surviving.length) return null;
  // Explicit-name precedence: a cli/api/mcp-typed tool beats a browser surface
  // when both appear ("use nylas" while google.calendar also matches 'calendar').
  surviving.sort((x, y) => Number(y._cli) - Number(x._cli));
  return { agentId: surviving[0].agentId, type: surviving[0].type, matched: surviving[0].matched, tier: surviving[0].tier };
}

module.exports = { resolve, _nounMatchRe, _describe, resolveExplicitTool };
