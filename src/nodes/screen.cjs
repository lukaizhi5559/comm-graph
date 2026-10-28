'use strict';

/**
 * screen.cjs — Intent 7: screen output lane
 *
 * Paints content onto the GhostLayer's "screen as an output" surface via
 * POST http://127.0.0.1:3010/screen/display (normalized by
 * shared/screen-output.cjs). This is the fast lane for prompts whose whole
 * purpose is display — "show this on the screen", "put that chart up",
 * "clear the screen", "make it rain". No stategraph run, no task journal
 * entry — just resolve what to show and display it.
 *
 * Resolution order for the payload:
 *   1. clear commands                         → POST /screen/clear
 *   2. deterministic kinds                    → effects (rain/snow/confetti/
 *                                               fireworks), three presets,
 *                                               emoji, literal text
 *   3. file/plan referents ("the X plan",
 *      "the verses file", "/path/x.md")       → doc card (sourcePath)
 *   4. referential ("show this/those results")→ last completed task's items
 *                                               (images → carousel, links →
 *                                               doc list) or last assistant
 *                                               turn (markdown → doc, else
 *                                               fenced text)
 *   5. generative asks (chart of X, a 3D car) → metadata.shouldHandoff so
 *                                               server falls back to the
 *                                               stategraph, which owns scene
 *                                               codegen + LLM data extraction
 */

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const logger = require('../logger.cjs');
const taskJournal = require('../taskJournal.cjs');

const MAIN_PORT = parseInt(process.env.THINKDROP_MAIN_PORT || '3010', 10);

function _postJson(port, urlPath, payload, timeoutMs = 5000) {
  return new Promise((resolve) => {
    try {
      const body = JSON.stringify(payload);
      const req = http.request({
        hostname: '127.0.0.1', port, path: urlPath, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        timeout: timeoutMs,
      }, (res) => {
        let raw = '';
        res.on('data', c => { raw += c; });
        res.on('end', () => { try { resolve(JSON.parse(raw)); } catch (_) { resolve(null); } });
      });
      req.on('error', () => resolve(null));
      req.on('timeout', () => { req.destroy(); resolve(null); });
      req.end(body);
    } catch (_) { resolve(null); }
  });
}

function _activity(line, kind = 'note') {
  try {
    _postJson(MAIN_PORT, '/agent-turn', { type: 'terminal:activity', kind, line }, 2000);
  } catch (_) {}
}

// ── Prompt → payload resolvers ────────────────────────────────────────────────

const CLEAR_RE = /\b(?:clear|hide|dismiss|remove|close)\s+(?:(?:the|my|that|all|everything)\s+){0,3}screen\b|\bclear\s+(?:everything|all|that)\b/i;

// Deterministic ambient effects — the prompt itself IS the payload.
const EFFECT_MAP = [
  { re: /\bmake\s+it\s+rain\b|\brain\s+(?:on|all over)\s+(?:my\s+|the\s+)?screen\b/i, effect: 'rain', mood: 'calm' },
  { re: /\bmake\s+it\s+snow\b|\bsnow\s+(?:on|all over)\s+(?:my\s+|the\s+)?screen\b/i, effect: 'snow', mood: 'calm' },
  { re: /\bconfetti\b/i, effect: 'confetti', mood: 'happy' },
  { re: /\bfireworks?\b/i, effect: 'fireworks', mood: 'happy' },
  { re: /\bemoji\s*rain\b|\brain\w*\s+(?:of\s+)?emojis?\b|\b(?:shower|storm)\s+of\s+emojis?\b|\bemojis?\s+(?:rain\w*|shower|storm)\b/i, effect: 'emoji-rain', mood: 'playful' },
];

const THREE_PRESETS = new Set(['starfield', 'particles', 'wave', 'cube', 'knot', 'globe']);

// Referential display words — the payload lives in prior context, not the prompt.
const REFERENTIAL_RE = /\b(?:this|that|it|these|those|them|him|his|her|he|she|the\s+(?:results?|answers?|response|replies|images?|pictures?|photos?|list|data|findings|above))\b/i;

// "the <name> plan" / "the <name> file" / "that markdown file" — disk referents.
const PLAN_REF_RE = /\b(?:the\s+|my\s+|our\s+)?([\w][\w .-]{0,40}?)\s+plan\b/i;
const FILE_REF_RE = /\b([\w][\w .-]{0,50})\.(md|markdown|txt|rtf|pdf|docx?)\b/i;
const ABS_PATH_RE = /(\/[\w .\-/]+\.(?:md|markdown|txt|rtf|pdf|docx?|png|jpe?g|gif|webp|mp4|mov))/i;

function _plansDir() {
  return process.env.THINKDROP_PLANS_DIR
    || path.join(os.homedir(), '.thinkdrop', 'plans');
}

// Resolve "the X plan" → {path, title} by searching plan files on disk.
function _findPlanFile(query) {
  try {
    const hits = require('../../../shared/system-map.cjs').findPlans(query).slice(0, 3);
    if (!hits.length) return null;
    const dir = _plansDir();
    for (const h of hits) {
      const fp = path.join(dir, `${h.planId}.md`);
      if (fs.existsSync(fp)) return { path: fp, title: h.name || h.title || h.planId };
    }
  } catch (_) {}
  return null;
}

// Resolve a filename referent ("the memory verses file") or explicit path.
// Home-scoped search: ~/Desktop, ~/Documents, plans dir — bounded depth.
function _findFile(text) {
  const abs = String(text || '').match(ABS_PATH_RE);
  if (abs) {
    const p = abs[1].replace(/^~/, os.homedir());
    if (fs.existsSync(p)) return p;
  }
  const m = String(text || '').match(FILE_REF_RE);
  if (!m) return null;
  const wanted = `${m[1]}.${m[2]}`.toLowerCase().replace(/\s+/g, '');
  const roots = [_plansDir(), path.join(os.homedir(), 'Desktop'), path.join(os.homedir(), 'Documents'), os.homedir()];
  for (const root of roots) {
    try {
      const stack = [[root, 0]];
      while (stack.length) {
        const [dir, depth] = stack.pop();
        if (depth > 4) continue;
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, e.name);
          if (e.isDirectory()) {
            if (!e.name.startsWith('.') && e.name !== 'node_modules' && depth < 4) stack.push([full, depth + 1]);
          } else if (e.name.toLowerCase().replace(/\s+/g, '').includes(wanted)
                     || wanted.includes(e.name.toLowerCase().replace(/\s+/g, ''))) {
            return full;
          }
        }
      }
    } catch (_) {}
  }
  return null;
}

const DOC_EXTS = new Set(['.md', '.markdown', '.txt', '.rtf', '.docx', '.doc', '.pdf']);
const IMG_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);
const VID_EXTS = new Set(['.mp4', '.mov', '.webm']);

function _payloadForFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const title = path.basename(filePath);
  if (IMG_EXTS.has(ext)) return { kind: 'image', title, images: [{ path: filePath }] };
  if (VID_EXTS.has(ext)) return { kind: 'doc', title, doc: { markdown: `**${title}**\n\n\`${filePath}\`\n\n(Video file — open in a player to watch.)` } };
  if (DOC_EXTS.has(ext)) {
    let markdown = '';
    try { markdown = fs.readFileSync(filePath, 'utf8').slice(0, 150000); } catch (_) {}
    return { kind: 'doc', title, doc: { markdown: markdown || `Could not read ${filePath}`, sourcePath: filePath } };
  }
  return null;
}

// Last completed task that carried structured items (search results, media
// cards) — "show those results on my screen".
function _lastTaskWithItems() {
  const tasks = taskJournal.getRecentTasks(20);
  for (let i = tasks.length - 1; i >= 0; i--) {
    const t = tasks[i];
    if (t && t.status === 'done' && Array.isArray(t.items) && t.items.length) return t;
  }
  return null;
}

function _payloadForItems(items) {
  const imgs = items.filter(it => it.imageUrl || it.posterUrl).slice(0, 12)
    .map(it => ({ url: it.imageUrl || it.posterUrl, caption: it.title || it.channel || '' }));
  if (imgs.length >= 2) return { kind: 'image', title: 'Results', images: imgs };
  if (imgs.length === 1 && items.length === 1) return { kind: 'image', title: imgs[0].caption || 'Result', images: imgs };
  // Mixed/link results → markdown list doc.
  const md = items.slice(0, 15).map(it => {
    const bits = [`- [${it.title || it.url || 'link'}](${it.url || it.sourceUrl || '#'})`];
    const meta = [it.price, it.hostname, it.channel, it.duration].filter(Boolean).join(' · ');
    if (meta) bits.push(`  ${meta}`);
    if (it.snippet) bits.push(`  ${it.snippet.slice(0, 200)}`);
    return bits.join('\n');
  }).join('\n');
  return { kind: 'doc', title: 'Results', doc: { markdown: md || '(no results to show)' } };
}

// Last assistant turn from the conversation transcript ("Assistant: …" lines).
function _lastAssistantTurn(conversationContext) {
  if (typeof conversationContext !== 'string') return '';
  const matches = conversationContext.match(/Assistant: ([\s\S]*?)(?=\n(?:User|Assistant):|$)/g);
  if (!matches || !matches.length) return '';
  return matches[matches.length - 1].replace(/^Assistant: /, '').trim();
}

function _payloadForText(text, title = 'Response') {
  const t = String(text || '').trim();
  if (!t) return null;
  const looksMarkdown = /^#{1,6}\s|^\s*[-*]\s|\*\*[^*]+\*\*|\[[^\]]+\]\(|```|^>\s|\|.*\|/m.test(t);
  return looksMarkdown
    ? { kind: 'doc', title, doc: { markdown: t.slice(0, 150000) } }
    : { kind: 'text', title, text: t.slice(0, 18000) };
}

// Extract a literal quoted payload — `show "hello world" on my screen`.
function _quotedText(text) {
  const m = String(text || '').match(/["“]([^"”]{1,2000})["”]/);
  return m ? m[1] : null;
}

// ── Execute ──────────────────────────────────────────────────────────────────

/**
 * @param {object} args { englishText, conversationContext, sessionId }
 * @returns {Promise<{text, fullText, metadata}>} — metadata.shouldHandoff=true
 *   when the ask needs generation the lane can't do (scene code, chart-from-
 *   prose); server.cjs converts it to a real handoff.
 */
async function execute({ englishText, conversationContext, sessionId } = {}) {
  const text = String(englishText || '').trim();

  // ── Clear ────────────────────────────────────────────────────────────────
  if (CLEAR_RE.test(text) && !/\b(?:show|put|display|render|bring)\b/i.test(text)) {
    _activity('clearing the screen…');
    const r = await _postJson(MAIN_PORT, '/screen/clear', {});
    const reply = r?.ok ? 'Cleared the screen.' : "I tried to clear the screen but the display channel didn't answer.";
    return { text: reply, fullText: reply, metadata: { source: 'screen', intent: 7, speakable: true, ok: !!r?.ok } };
  }

  // ── Deterministic effects / presets ──────────────────────────────────────
  for (const e of EFFECT_MAP) {
    if (e.re.test(text)) {
      const emojiM = text.match(/\b(?:rain|shower)\s+(?:of\s+)?(?:an?\s+)?emoji\s+([^\s,.!?]+)/i);
      const payload = { kind: 'effect', effect: e.effect, mood: e.mood, title: e.effect.replace(/-/g, ' ') };
      if (e.effect === 'emoji-rain' && emojiM) payload.emoji = emojiM[1];
      _activity(`showing a ${e.effect} effect on screen…`);
      const r = await _postJson(MAIN_PORT, '/screen/display', payload);
      const reply = r?.ok ? `${e.effect === 'fireworks' ? 'Fireworks' : e.effect[0].toUpperCase() + e.effect.slice(1)} on your screen — tap Esc to dismiss.` : `Couldn't paint the screen (${r?.error || 'no response'}).`;
      return { text: reply, fullText: reply, metadata: { source: 'screen', intent: 7, speakable: true, ok: !!r?.ok, kind: 'effect' } };
    }
  }

  // three.js preset — "show a starfield on my screen", "put a 3D globe up"
  const threeM = text.match(/\b(starfield|star\s*field|particles?|waves?|cube|knot|globe|earth)\b/i);
  if (threeM && /\b(?:3d|three\.?js|scene|on\s+(?:my\s+|the\s+)?screen|up)\b/i.test(text)) {
    const scene = /earth/i.test(threeM[1]) ? 'globe'
      : THREE_PRESETS.has(threeM[1].toLowerCase()) ? threeM[1].toLowerCase()
      : /star/i.test(threeM[1]) ? 'starfield'
      : /wave/i.test(threeM[1]) ? 'wave'
      : 'particles';
    _activity(`showing a ${scene} scene on screen…`);
    const r = await _postJson(MAIN_PORT, '/screen/display', { kind: 'three', title: scene, three: { scene } });
    const reply = r?.ok ? `${scene[0].toUpperCase() + scene.slice(1)} on your screen — Esc to dismiss.` : `Couldn't paint the screen (${r?.error || 'no response'}).`;
    return { text: reply, fullText: reply, metadata: { source: 'screen', intent: 7, speakable: true, ok: !!r?.ok, kind: 'three' } };
  }

  // ── File / plan referents ────────────────────────────────────────────────
  const planM = text.match(PLAN_REF_RE);
  const wantsDocSurface = /\b(?:file|document|doc|plan|markdown|\.md|verses?|lyrics?)\b/i.test(text);
  if (planM && wantsDocSurface) {
    const query = planM[1].replace(/^(?:the|a|an|my|our)\s+/i, '').trim();
    const plan = query ? _findPlanFile(query) : null;
    if (plan) {
      _activity(`showing the ${plan.title} plan on screen…`);
      let markdown = '';
      try { markdown = fs.readFileSync(plan.path, 'utf8').slice(0, 150000); } catch (_) {}
      const r = await _postJson(MAIN_PORT, '/screen/display', {
        kind: 'doc', title: plan.title,
        doc: { markdown: markdown || '(empty plan file)', sourcePath: plan.path },
      });
      const reply = r?.ok ? `The ${plan.title} plan is on your screen.` : `Couldn't paint the screen (${r?.error || 'no response'}).`;
      return { text: reply, fullText: reply, metadata: { source: 'screen', intent: 7, speakable: true, ok: !!r?.ok, kind: 'doc', path: plan.path } };
    }
  }
  if (wantsDocSurface || ABS_PATH_RE.test(text)) {
    const filePath = _findFile(text);
    if (filePath) {
      const payload = _payloadForFile(filePath);
      if (payload) {
        _activity(`showing ${path.basename(filePath)} on screen…`);
        const r = await _postJson(MAIN_PORT, '/screen/display', payload);
        const reply = r?.ok ? `${path.basename(filePath)} is on your screen.` : `Couldn't paint the screen (${r?.error || 'no response'}).`;
        return { text: reply, fullText: reply, metadata: { source: 'screen', intent: 7, speakable: true, ok: !!r?.ok, kind: payload.kind, path: filePath } };
      }
    }
  }

  // ── Literal quoted text ──────────────────────────────────────────────────
  const quoted = _quotedText(text);
  if (quoted) {
    _activity('showing text on screen…');
    const r = await _postJson(MAIN_PORT, '/screen/display', _payloadForText(quoted, 'On your screen'));
    const reply = r?.ok ? 'On your screen — Esc to dismiss.' : `Couldn't paint the screen (${r?.error || 'no response'}).`;
    return { text: reply, fullText: reply, metadata: { source: 'screen', intent: 7, speakable: true, ok: !!r?.ok, kind: 'text' } };
  }

  // ── Referential — "show this/those results on my screen" ─────────────────
  // Only when a real referent word is present (this/that/it/these/those/the
  // results…) — a generative ask like "show me a chart of my week" starts with
  // 'show' too, and must fall through to the handoff path that can GENERATE.
  if (REFERENTIAL_RE.test(text)) {
    // 1. Structured items from the last completed task (search results, media).
    const task = _lastTaskWithItems();
    if (task) {
      _activity('showing the last results on screen…');
      const payload = _payloadForItems(task.items);
      payload.title = payload.title || (task.prompt || 'Results').slice(0, 80);
      const r = await _postJson(MAIN_PORT, '/screen/display', payload);
      const reply = r?.ok
        ? 'Your last results are on the screen — Esc to dismiss.'
        : `Couldn't paint the screen (${r?.error || 'no response'}).`;
      return { text: reply, fullText: reply, metadata: { source: 'screen', intent: 7, speakable: true, ok: !!r?.ok, kind: payload.kind, fromTask: task.id } };
    }
    // 2. Last assistant reply (the overlay's most recent answer).
    const last = _lastAssistantTurn(conversationContext);
    if (last) {
      _activity('showing the last reply on screen…');
      const payload = _payloadForText(last);
      const r = await _postJson(MAIN_PORT, '/screen/display', payload);
      const reply = r?.ok
        ? 'My last answer is on your screen — Esc to dismiss.'
        : `Couldn't paint the screen (${r?.error || 'no response'}).`;
      return { text: reply, fullText: reply, metadata: { source: 'screen', intent: 7, speakable: true, ok: !!r?.ok, kind: payload.kind } };
    }
    const reply = "I don't have a previous result or reply to show — search or ask me something first, then say \"show this on the screen\".";
    return { text: reply, fullText: reply, metadata: { source: 'screen', intent: 7, speakable: true, ok: false, noReferent: true } };
  }

  // ── Generative asks the lane can't serve — hand off to the stategraph ────
  // (chart-from-data extraction, scene codegen, web fetch-then-display).
  logger.info('[Screen] No deterministic payload — flagging for handoff', { preview: text.slice(0, 80) });
  return {
    text: null,
    fullText: null,
    metadata: { source: 'screen', intent: 7, shouldHandoff: true },
  };
}

module.exports = { execute };
