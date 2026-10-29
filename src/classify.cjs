'use strict';

/**
 * classify.cjs — Force-prompt intent classification for comms-graph
 *
 * Uses the same proven technique as stategraph-module's decomposePromptV2:
 * "Return ONLY a single number" with maxTokens:5, temperature:0.1.
 *
 * Intent taxonomy:
 *   0 - handoff              → needs tools/MCPs/automation → enqueue to main stategraph
 *   1 - general_quick        → chitchat, opinions, known facts → direct LLM respond
 *   2 - memory_quick         → quick profile/fact recall (name, favorite color) → user-memory lookup
 *   3 - status_check         → "how is my task going?" → read task journal
 *   4 - control_signal       → cancel/stop → abort via journal + main.js
 *   6 - planning             → multi-deliverable/multi-service request → planning lane
 *
 * Falls back to embedding-based classification (classifier-fallback.cjs) if LLM
 * returns an unparseable response.
 */

const fs = require('fs');
const path = require('path');
const logger = require('./logger.cjs');
// Canonical patterns live in shared/text-patterns.cjs — update there, not here.
const { BARE_AFFIRM_RE, OFFER_RE, BARE_FOLLOWUPS, CONVERSATION_RECALL_RE, SCREEN_OBSERVATION_RE, DEICTIC_CONTINUATION_RE, DEVICE_STATE_RE, isContextDependent, CONTROL_SIGNAL_RE } = require('../../shared/text-patterns.cjs');
const { isLocalMultiEntityTask } = require('../../shared/context-refs.cjs');
const _ds = require('../../shared/decision-state.cjs');

// ── Intent definitions ─────────────────────────────────────────────────────────
const INTENTS = {
  0: { name: 'handoff',           description: 'Anything needing tools, web search, browser automation, computer actions, deep memory retrieval, scheduling, file operations, or multi-step tasks — including opening, checking, or using a named app or website ("check my gmail", "open chatgpt", "go to youtube")' },
  1: { name: 'general_quick',    description: 'Chitchat, greetings, opinions, simple knowledge questions the LLM can answer directly without tools' },
  // 2 is intentionally vacant — the memory_quick lane was removed; all memory
  // READS go to the stategraph (handoff), all explicit stores go to intent 5.
  3: { name: 'status_check',      description: 'Asking about the status/progress of a running or recently completed task' },
  // pause/resume are intentionally absent — those signals are unimplemented
  // (main.js aborts on 'cancel' only); advertising them here routes utterances
  // to a node that can't serve them.
  4: { name: 'control_signal',    description: 'Cancel, stop, or abort a RUNNING ThinkDrop task ("cancel that", "stop it", "nevermind") — ONLY while a task is in flight. NOT for deleting/removing a created artifact (event, file, reminder, meeting) — those are handoff actions on the artifact itself.' },
  5: { name: 'memory_store',      description: 'Storing a general memory, note, appointment, or event — NOT a personal profile fact. E.g., "i have a dentist appt next week", "remember I have a meeting at 3pm", "note: buy milk tomorrow"' },
  6: { name: 'planning',          description: 'Requests that need a multi-task plan drafted BEFORE execution — brainstorming, "let\'s plan X", building/creating a new skill, app, agent, workflow, automation, or script, or multiple distinct deliverables/services in one request (e.g. doc + calendar + sheet, add to cart then email me). NOT single quick actions.' },
  7: { name: 'screen',            description: 'Display content on the user\'s screen output surface — show a previous reply/search result/file on screen ("show this on the screen", "put that chart up"), paint text/doc/image/chart/deck/effect/emoji/alert/three.js scene, or clear the screen. The output surface only — NOT for gathering data first ("check my mail and show it on screen" is handoff) and NOT for observing the screen ("what\'s on my screen" is handoff).' },
  8: { name: 'web_search',        description: 'Standalone public web lookups needing live web data — facts, news, prices, recommendations, media ("pictures of cats", "latest headlines", "best laptops", "what does a ps5 cost"). NOT lookups inside a named app or account ("search gmail", "find on my youtube" is handoff), NOT personal/stored data ("what do you know about me" is handoff), and NOT screen output ("show X on my screen" is screen).' },
};

// ── Load classification prompt ─────────────────────────────────────────────────
function _loadClassifyPrompt() {
  try {
    return fs.readFileSync(path.join(__dirname, '../prompts/classify.md'), 'utf8').trim();
  } catch (_) {
    return null;
  }
}
const CLASSIFY_PROMPT_TEMPLATE = _loadClassifyPrompt();

/**
 * Build the force-classification prompt for a given English user message.
 */
function _buildClassifyMessages(englishText, conversationContext, openPlan) {
  const intentList = Object.entries(INTENTS)
    .map(([num, info]) => `${num} - ${info.name}: ${info.description}`)
    .join('\n');

  const systemPrompt = CLASSIFY_PROMPT_TEMPLATE
    ? CLASSIFY_PROMPT_TEMPLATE.replace('{{INTENT_LIST}}', intentList)
    : `You are an intent classifier for ThinkDrop AI. Classify the user's message into exactly one of these intents:

${intentList}

Return ONLY a single number (${_intentListStr}). No words, no explanation, no punctuation — just the number.`;

  const openPlanLine = openPlan
    ? `\n\nOpen plan: "${openPlan.title}" is paused — ${openPlan.pendingCount} of ${openPlan.totalTasks} tasks still undone (${openPlan.taskTitles.join('; ')}). If this message continues that plan or asks about it, return 6.`
    : '';

  const userContent = conversationContext
    ? `Conversation context (last 3 turns):\n${conversationContext}${openPlanLine}\n\nCurrent message: ${englishText}`
    : `Message: ${englishText}${openPlanLine}`;

  return [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userContent },
  ];
}

// ── Regex guard for parsing (derived from INTENTS — auto-maintains) ─────────────
const _intentKeys = Object.keys(INTENTS).map(Number);
const _intentMin = Math.min(..._intentKeys);
const _intentMax = Math.max(..._intentKeys);
const NUMBER_RE = new RegExp(`^\\s*([${_intentMin}-${_intentMax}])\\s*$`);
const _intentListStr = _intentKeys.join(', ');

/**
 * Classify an English user message into an intent.
 *
 * @param {string} englishText       - English translation of user input
 * @param {string[]} [conversationContext] - Recent conversation turns for context
 * @returns {Promise<{ intent: number, intentName: string, confidence: number, source: string }>}
 */
// ── Bare follow-up guard ──────────────────────────────────────────────────────
// Short conversational follow-ups about the previous answer can never be
// actionable tasks — but the LLM classifier occasionally routes them to
// handoff (observed: "why not" → intent 0 → a spurious queued task).
// Exact-match a small set after stripping punctuation — no regexes.
// Requires conversation history so a bare "why" as a session opener still
// goes through normal classification.
// ── Offer-consent guard ──────────────────────────────────────────────────────
// A bare affirmation ("yes", "sure", "ok", "go ahead", "yes you can") replying
// to an assistant OFFER ("Would you like me to X?", "Want me to X?", "I can X")
// means "do the offered thing" — that needs the stategraph, not a quick "Sure!".
// Without this, general_quick can acknowledge the consent without executing the
// offer (and the stategraph then has to reverse-engineer the referent).
// Patterns are canonical in shared/text-patterns.cjs.
function _lastAssistantTurn(conversationContext) {
  if (typeof conversationContext !== 'string') return '';
  const matches = conversationContext.match(/Assistant: ([^\n]*)/g);
  if (!matches || matches.length === 0) return '';
  return matches[matches.length - 1].replace(/^Assistant: /, '');
}

// ── Conversation-recall guard ────────────────────────────────────────────────
// Questions that ask to inspect the chat transcript itself ("what have we been
// chatting about", "look up our previous conversation", "no conversation with
// you at all") must hand off — general_quick only sees the current session's
// recent turns and will confidently (wrongly) deny prior conversations exist.
// The LLM classifier (rule 8) catches clean phrasings but slips on
// voice-transcribed/borderline ones, so this deterministic check runs first.
// CONVERSATION_RECALL_RE is canonical in shared/text-patterns.cjs (tolerant
// multi-alternative version — STT stems "chatt"/"talkin" handled there).

// ── Planning-detection guards ────────────────────────────────────────────────
// Explicit "let's plan / brainstorm / come up with a plan" phrasing → planning
// lane deterministically (the LLM slips these to general_quick or handoff).
const PLANNING_PHRASE_RE = /\b(?:let'?s|lets|help me|i want to|i need to|we need to|can we|wanna)\s+(?:make|create|build|come up with|work out|draft|do|start)\s+(?:a\s+|an\s+|the\s+|some\s+|up\s+a\s+)?plan\b|\bcome up with a plan\b|\bplan (?:out|for|to)\b|\bmake a plan\b|\bcreate a plan\b|\bdraft a plan\b|\bplanning mode\b|\bbrainstorm\b|\bwork out a plan\b|\bplanning session\b|\b(?:let'?s|lets)\s+plan\b|\bwork\s+out\s+(?:an?\s+|the\s+)?(?:idea|approach|plan|strategy)\b|\bthink\s+(?:it|this|that|things)\s+through\b|\bthink\s+through\s+(?:an?\s+idea|this|the\s+\w+)\b|\bfigure\s+out\s+(?:an?\s+|the\s+)?(?:approach|idea|plan|strategy|way\s+forward)\b|\bhash\s+out\s+(?:the\s+|some\s+)?(?:details|idea|ideas|plan|approach)\b|\bmap\s+out\s+(?:a\s+|an\s+|the\s+)?(?:plan|idea|approach|strategy|roadmap)\b|\bpick\s+your\s+brain\b/i;

// Plan-resume vocabulary — fires only when an open (paused) plan exists, so
// the false-positive surface is bounded. Approval words are deliberately
// absent: prompt-queue's _tryResolvePendingApproval consumes them upstream.
const PLAN_RESUME_RE = /\bcontinue\b|\bresume\b|\bkeep going\b|\bcarry on\b|\bpick up where we left off\b|\bwhere were we\b|\bwhat happened with (?:the|that|my) (?:plan|setup|install)\b|\bfinish (?:the|that) (?:plan|setup|install)\b|\bhow'?s the (?:plan|setup|install) (?:going|doing)\b|\bdid (?:the|that|it) (?:plan|setup|install|task) (?:finish|work|succeed|complete|go through)\b|\bdo(?:n'?t| not) i have a plan\b|\bi have a plan\b|\bthe plan\b.*\b(?:continue|finish|done|status|going|working)\b/i;

// Intents only the main stategraph can serve — a quick-tier pick with one of
// these guessed is an action-veto flake (also used by server.cjs's selection
// fastlane so "post this" + a highlight can't be answered instead of run).
const GRAPH_ONLY_INTENTS = new Set(['command_automate', 'screen_analysis', 'memory_retrieve']);

// "is <thing> installed / done / set up" — anchored when <thing> names a task
// in the open plan, or the referent is bare "it"/"the plan".
const _INSTALL_PROBE_RE = /\b(?:is|was|did)\s+(?:the\s+plan|it|that|([a-z0-9@._-]+))\s+(installed|set up|done|finished|working|running|complete|still going)\b/i;

// Résumé/CV document signals — when "resume" is the only plan-resume match
// AND these appear, the word is a noun (a biodata doc), not "resume the plan".
// Observed: "Analyze the attached resume and compare…" pinned into planning
// three times while a stale plan was open.
const _RESUME_DOC_RE = /\b(?:attached|attach|pdf|cv|biodata|doc(?:ument)?|file|highlighted|job|career|experien|analy[sz]e|review|compare|upload|edit|read|scan|hiring|applicant|candidate|application|portfolio)\b/i;
const _RESUME_VERB_CONTEXT_RE = /\b(?:continue|resume|keep going|carry on|pick up)\b[^.]{0,25}\b(?:plan|tasks?|setup|install|workflow|checklist)\b/i;

function _isPlanResume(englishText, openPlan) {
  const t = String(englishText || '');
  if (PLAN_RESUME_RE.test(t)) {
    // Ambiguous: "resume" appears with document context and no resume-the-plan
    // phrasing — could be a résumé/CV. The guard asks semantically instead of
    // blind-pinning (AGENTS.md: lexical overrides need a verdict).
    if (_RESUME_DOC_RE.test(t) && !_RESUME_VERB_CONTEXT_RE.test(t)) return 'ambiguous';
    return 'yes';
  }
  const m = t.match(_INSTALL_PROBE_RE);
  if (!m) return 'no';
  const entity = (m[1] || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!entity) return 'yes'; // bare "it"/"the plan" — referent is the open plan
  const haystack = `${openPlan.title || ''} ${(openPlan.taskTitles || []).join(' ')}`.toLowerCase();
  return haystack.includes(entity) ? 'yes' : 'no';
}

// Multi-deliverable complexity scorer — catches prompts that never SAY "plan"
// but describe several services × several actions (the "Doc + Calendar +
// Sheet" case). Counts distinct service signals and distinct action verbs;
// ≥2 of each is strong evidence for a plan-first route.
const _SERVICE_SIGNALS = /\b(amazon|gmail|google docs?|google sheets?|google calendar|google drive|youtube|twitter|x\.com|reddit|github|notion|slack|spotify|netflix|chatgpt|claude|perplexity|grok|jira|trello|figma|linkedin|facebook|instagram|calendar|spreadsheet|sheet\b|doc(?:ument)?\b|email|e-mail|terminal|shell|cli\b|file|folder|browser)\b/gi;
const _ACTION_SIGNALS = /\b(create|add|send|write|update|delete|post|schedule|build|make|generate|draft|open|download|upload|rename|move|copy|organize|set up|setup|fill|submit|order|buy|purchase|email|message|notify|remind|save|edit)\b/gi;
const _SEQUENCE_SIGNALS = /\b(then|after(?:wards?)?|next|and also|as well as|followed by|once (?:done|finished|complete)|when (?:done|finished|complete))\b/i;

// Canonical service families — raw keyword hits collapse to one service id so
// aliases can't inflate the count ("send an email via gmail" = ONE service,
// "a doc and a spreadsheet" = two). Anything unmapped keeps its own spelling.
const _SERVICE_CANON = {
  'gmail': 'mail', 'email': 'mail', 'e-mail': 'mail',
  'doc': 'docs', 'document': 'docs', 'google doc': 'docs', 'google docs': 'docs',
  'sheet': 'sheets', 'spreadsheet': 'sheets', 'google sheet': 'sheets', 'google sheets': 'sheets',
  'calendar': 'calendar', 'google calendar': 'calendar',
  'google drive': 'drive',
  'x.com': 'twitter',
  'terminal': 'shell', 'shell': 'shell', 'cli': 'shell',
  'file': 'files', 'folder': 'files',
};

function _complexityPlanningScore(text) {
  // Value payloads are arguments, not service references — a recipient like
  // "randallakers.work@gmail.com" must not count "gmail" as a second service.
  const scrubbed = String(text || '')
    .replace(/\S+@\S+/g, ' ')
    .replace(/https?:\/\/\S+/gi, ' ');
  const services = new Set((scrubbed.match(_SERVICE_SIGNALS) || [])
    .map(s => _SERVICE_CANON[s.toLowerCase()] || s.toLowerCase()));
  const actions = new Set((scrubbed.match(_ACTION_SIGNALS) || []).map(s => s.toLowerCase()));
  const sequenced = _SEQUENCE_SIGNALS.test(text || '');
  const words = String(text || '').trim().split(/\s+/).length;
  // ≥2 distinct canonical services → multi-deliverable (the verb count doesn't
  // matter — "create a doc, then a calendar event and a spreadsheet" is three
  // deliverables under one verb). One service with many sequenced actions, or
  // a long multi-step ask (>35 words, 3+ actions), also benefits from a draft.
  // ≥2 distinct canonical services → multi-deliverable (the verb count doesn't
  // matter — "create a doc, then a calendar event and a spreadsheet" is three
  // deliverables under one verb). Single-service prompts stay handoff no
  // matter how long or sequenced they are — the stategraph's decomposePromptV2
  // already handles in-app multi-step; prompt length is not a routing signal.
  // Local multi-entity work — a file/folder anchor + per-entity iteration +
  // a side-effecting verb is plan-shaped even when zero external services are
  // named ("scan this folder and commit each repo"). Without this the prompt
  // falls to a bare handoff and grills instead of drafting a plan. Detector
  // lives in shared/context-refs.cjs (stategraph's needs_plan gate shares it).
  const localMultiEntity = isLocalMultiEntityTask(scrubbed);
  const multiDeliverable = services.size >= 2 || localMultiEntity;
  return { score: multiDeliverable ? 1 : 0, services: services.size, actions: actions.size, sequenced, words, localMultiEntity };
}

async function classify(englishText, conversationContext, opts = {}) {
  if (!englishText || !englishText.trim()) {
    return { intent: 1, intentName: 'general_quick', confidence: 0.5, source: 'empty_input' };
  }
  const hasSelectionContext = !!opts.hasSelectionContext;
  const openPlan = opts.openPlan || null;
  // Bound tabs fetched in parallel with the guards — the local intent model
  // can't see open pages otherwise and demotes page actions to quick lanes
  // (observed: "click the first result" with a bound tab → local=general_quick
  // vs remote=handoff). ~5ms localhost; awaited lazily inside _localIntent.
  const _extSessP = require('./route-decision.cjs').fetchExtSessions().catch(() => []);

  // Explicit planning request — deterministic, runs before every other guard.
  // ("plan" inside a bigger automation prompt like "follow this plan" is NOT
  // matched — the phrases above require intent-to-draft framing.)
  if (PLANNING_PHRASE_RE.test(englishText)) {
    logger.info('[Classify] Planning phrase guard → planning', {
      inputPreview: englishText.substring(0, 60),
    });
    return { intent: 6, intentName: 'planning', confidence: 0.95, source: 'planning_phrase_guard' };
  }

  // Plan-resume guard — an open (paused) plan exists and the message uses
  // continuation vocabulary or probes the plan's state. The LLM classifier
  // can't see plan state and picks status_check / memory_retrieve; the
  // planning lane resolves planId via _sessionToPlan and answers from the
  // plan file (or emits <plan_run/>). Approval words are excluded — they're
  // consumed by _tryResolvePendingApproval upstream.
  const _planResumeVerdict = openPlan ? _isPlanResume(englishText, openPlan) : 'no';
  if (_planResumeVerdict === 'ambiguous') {
    // Lexical collision — "resume" the document vs resume-the-plan. Never
    // blind-pin: the semantic verdict decides (fail-open to normal classify).
    const _dec = require('./decision.cjs');
    const _prv = await _dec.confirmJudgment({
      site: 'plan-resume',
      question: 'The user message contains the word "resume". Are they asking to RESUME the paused plan, or talking about a résumé/CV document? Answer YES only if they mean resume the plan.',
      state: _ds.buildDecisionState({
        site: 'plan-resume',
        message: englishText,
        extras: [`Paused plan: "${openPlan.title}" — ${openPlan.pendingCount}/${openPlan.totalTasks} undone`],
      }),
    });
    logger.info(`[semantic-gate-evidence] site=plan-resume verdict=${_prv || 'null'} input=${englishText.substring(0, 60)}`);
    if (_prv === 'YES') {
      return { intent: 6, intentName: 'planning', confidence: 0.9, source: 'plan_resume_guard', resumePlanId: openPlan.planId };
    }
  } else if (_planResumeVerdict === 'yes') {
    logger.info('[Classify] Plan-resume guard → planning', {
      inputPreview: englishText.substring(0, 60),
      planId: openPlan.planId,
    });
    return { intent: 6, intentName: 'planning', confidence: 0.9, source: 'plan_resume_guard', resumePlanId: openPlan.planId };
  }

  const normalized = englishText.toLowerCase().trim()
    .replaceAll('?', '').replaceAll('!', '').replaceAll('.', '').trim();
  // Offer-consent: bare affirmation + last assistant turn was an offer → handoff
  // (the user is asking us to DO the offered action, not just chatting).
  if (conversationContext && BARE_AFFIRM_RE.test(normalized)) {
    const lastAsst = _lastAssistantTurn(conversationContext);
    if (lastAsst && OFFER_RE.test(lastAsst)) {
      logger.info('[Classify] Offer-consent guard → handoff', {
        inputPreview: englishText.substring(0, 60),
        offerPreview: lastAsst.substring(0, 80),
      });
      return { intent: 0, intentName: 'handoff', confidence: 0.9, source: 'offer_consent_guard' };
    }
  }

  if (conversationContext && BARE_FOLLOWUPS.has(normalized)) {
    logger.info('[Classify] Bare follow-up → general_quick', {
      inputPreview: englishText.substring(0, 60),
    });
    return { intent: 1, intentName: 'general_quick', confidence: 0.95, source: 'bare_followup' };
  }

  // Conversation-recall questions always need the full transcript search —
  // hand off deterministically instead of trusting the LLM classifier.
  if (CONVERSATION_RECALL_RE.test(englishText)) {
    logger.info('[Classify] Conversation-recall guard → handoff', {
      inputPreview: englishText.substring(0, 60),
    });
    return { intent: 0, intentName: 'handoff', confidence: 0.95, source: 'conversation_recall_guard' };
  }

  // Generated deliverables — slideshows, 3D scenes, resumes/docs — are
  // composed artifacts, not literal screen output. They belong in planning:
  // preview/draft → confirm → run. Literal displays ("show X on my screen",
  // "pie chart: a 5 b 3") still fast-path via the screen-output guard below.
  // Composed-deliverable requests also include ThinkDrop buildables —
  // "put a skill together", "build me an app", "create a workflow". These
  // are the planning lane's bread and butter: draft a .md plan → readiness
  // check → approved run, never a single blind handoff. Mere references to
  // an app/skill stay on their own merits (no build verb → no match).
  if (/\b(?:slideshow|slide\s*deck|slide\s*show)\b|\b3d\s*(?:model|scene)\b|\b(?:build|create|make|write|draft|generate|put\s+together|do|develop|design|program|code|spin\s+up|set\s+up)\s+(?:me\s+)?(?:a|an|the|some|my|new|up)\s+[\w\s-]{0,40}\b(?:deck|slideshow|scene|report|resume|doc|document|pdf|plans?|skills?|apps?|agents?|workflows?|automations?|extensions?|integrations?|bots?|scripts?|projects?|prototypes?|tools?|websites?)\b|\bput\s+(?:a|an|the|some|my|new)\s+[\w\s-]{0,40}\b(?:plans?|skills?|apps?|agents?|workflows?|automations?|extensions?|integrations?|bots?|scripts?|projects?|prototypes?|tools?|websites?|deck|slideshow|report)\b[\w\s-]{0,20}\btogether\b/i.test(englishText)) {
    logger.info('[Classify] Deliverable guard → planning', {
      inputPreview: englishText.substring(0, 60),
    });
    return { intent: 6, intentName: 'planning', confidence: 0.9, source: 'deliverable_guard' };
  }

  // Screen-observation guard must run BEFORE the screen-output guard —
  // "what's on my screen" matches the output regex too ("on my screen").
  if (SCREEN_OBSERVATION_RE.test(englishText)) {
    logger.info('[Classify] Screen-observation guard → handoff', {
      inputPreview: englishText.substring(0, 60),
    });
    return { intent: 0, intentName: 'handoff', confidence: 0.95, source: 'screen_observation_guard' };
  }

  // Screen-output commands ("show it on the screen", "make it rain on my
  // screen", "clear the screen") go to the dedicated screen lane — it posts
  // straight to the GhostLayer display channel without a stategraph run.
  // …but not when the prompt also names a personal account/service — "check
  // my inbox … and put a summary on my screen" is a gather+display compound
  // that needs the service lane (nylas/gmail) first. Let it reach the
  // capability gate instead of display-short-circuiting the whole prompt.
  // Rule/automation phrasing ("set a rule that…", "whenever X …") also vetoes
  // the display lane — an embedded "on my screen" inside a rule is decoration,
  // not a display command. Swallowing the whole prompt into intent=7 lost the
  // rule (observed: "set a rule that if I goto youtube … on my screen").
  const _serviceRef = /\b(?:inbox|e-?mails?|gmail|outlook|slack|discord|calendar|notion|drive|spotify|whatsapp|imessage|messages|reminders|contacts|files?|photos?)\b/i.test(englishText);
  const _rulePhrasing = /\b(?:set|create|make|add|save)\s+(?:a\s+|me\s+(?:a\s+)?)?rules?\b|\brule\s+that\b|\bwhenever\b|\bevery\s+time\b/i.test(englishText);
  if (!_serviceRef && !_rulePhrasing && /\bon(?:to)?\s+(?:the|my)\s+screen\b|\bon\s+screen\b|\bmake it (?:rain|snow)\b|\bfireworks?\b|\b(?:clear|hide|dismiss)\s+(?:the\s+|my\s+)?screen\b/i.test(englishText)) {
    logger.info('[Classify] Screen-output guard → screen lane', {
      inputPreview: englishText.substring(0, 60),
    });
    return { intent: 7, intentName: 'screen', confidence: 0.95, source: 'screen_output_guard' };
  }

  // (screen-observation guard moved above the screen-output guard — both
  // patterns match "on my screen" and observation must win.)

  // Bare-deictic continuations ("when was that", "tell me more about that")
  // carry their referent entirely in a pronoun — only the graph's transcript
  // access resolves them. general_quick either can't see the prior turns or
  // hallucinates a referent (observed: "when was that" → invented a date).
  // Exception: a captured text selection rides in the payload and IS the
  // referent — "what does this word mean" + highlight is self-contained.
  if (!hasSelectionContext && DEICTIC_CONTINUATION_RE.test(englishText)) {
    logger.info('[Classify] Deictic-continuation guard → handoff', {
      inputPreview: englishText.substring(0, 60),
    });
    return { intent: 0, intentName: 'handoff', confidence: 0.95, source: 'deictic_continuation_guard' };
  }

  // Device-state questions ("what's my battery", "how much disk space",
  // "is my wifi on") only exist behind OS tools — any text tier answers by
  // hallucinating telemetry (observed: "what's my battery percentage" →
  // general_quick → "I can't see your device's battery level"). Same class
  // as the live-data exclusion: freshness requires a tool, not a guess.
  if (DEVICE_STATE_RE.test(englishText)) {
    logger.info('[Classify] Device-state guard → handoff', {
      inputPreview: englishText.substring(0, 60),
    });
    return { intent: 0, intentName: 'handoff', confidence: 0.95, source: 'device_state_guard' };
  }

  // Memory read-vs-store guards — tev1:0.8b confuses "what do you have on file"
  // with "store this": questions about stored memory were landing in
  // memory_store (intent 5) and getting WRITTEN as facts. Interrogatives can
  // never be stores; broad recalls ("all memories", "this month") need the
  // graph's memory search, not the 12-attribute quick lane.
  const _isQuestion = /^(?:what|who|when|where|which|whos|how|do you|can you|could you|tell me|show me|list|give me)\b|\?\s*$/i.test(englishText);
  const _memoryRef = /\b(?:remember|memory|memories|on file|stored|saved|know about me|have about me|about me\b)/i.test(englishText);
  const _broadRecall = /\b(?:all (?:my |the )?memor|everything (?:you|about)|history|this (?:week|month|year)|last (?:week|month))\b/i.test(englishText);
  if (_isQuestion && _memoryRef) {
    logger.info('[Classify] Memory-question guard → handoff', { inputPreview: englishText.substring(0, 60) });
    return { intent: 0, intentName: 'handoff', confidence: 0.95, source: 'memory_question_guard' };
  }
  // Personal-fact attribute questions without the word "memory" — "what's my
  // github", "do you know my email", "when is my dentist appt". All memory
  // reads ride the graph — retrieveMemory does profile.get + memory.search.
  if (_isQuestion && /\bmy\s+(?:name|e-?mails?|github|gitlab|phone|number|address|birthday|age|job|title|role|company|timezone|location|favorite|favourite|appt|appointment|meeting|schedule|password|username)\b|\bdo you (?:know|remember) (?:my|who|what|when|where)\b/i.test(englishText)) {
    logger.info('[Classify] Attribute-question guard → handoff', { inputPreview: englishText.substring(0, 60) });
    return { intent: 0, intentName: 'handoff', confidence: 0.95, source: 'attribute_question_guard' };
  }

  // Bare personal future-event statements with no action verb — "I have an
  // appointment next week at 5", "my dentist appt is friday". The intent is
  // ambiguous (remember? calendar event? reminder?) and details are missing —
  // planning asks instead of silently storing (as fact) or blindly automating
  // (observed: gemini picked memory_store → sentinel → stategraph decomposed a
  // doomed Google-Calendar task against the YouTube tab). An explicit action
  // verb keeps the normal route ("add it to my calendar", "remind me").
  const _personalEvent = /\bi\s+(?:have|'ve\s+got|got)\s+(?:a\s+|an\s+|the\s+|my\s+)?(?:appointment|appt|meeting|dentist|doctor|checkup|interview|call|date|event|haircut|reservation|flight|class|session|practice|party|dinner|lunch|brunch|exam|test|shift|game|concert|wedding|funeral|recital|inspection|deadline)\b/i.test(englishText);
  const _eventAction = /\b(?:add|put|schedule|remind|create|book|set|make|plan|cancel|move|reschedul\w*|delete|remove|check|confirm|note|remember|save|store|what|when|where|who|tell|show)\b/i.test(englishText);
  if (!_isQuestion && _personalEvent && !_eventAction) {
    logger.info('[Classify] Personal-event guard → planning', { inputPreview: englishText.substring(0, 60) });
    return { intent: 6, intentName: 'planning', confidence: 0.9, source: 'personal_event_guard' };
  }

  // Explicit standalone web lookups → web_search lane (express executor).
  // Personal/screen/service referents already returned above; this keeps the
  // ~1.5s SERP path for shapes that can't mean anything else — ambiguous
  // lookups pay the local-decision classify instead.
  if (/^(?:please\s+)?(?:search|google|look\s+up|find|look\s+for|show\s+me\s+(?:pictures?|images|photos|pics|videos|clips)\s+of)\b/i.test(englishText)) {
    logger.info('[Classify] Explicit-search guard → web_search', { inputPreview: englishText.substring(0, 60) });
    return { intent: 8, intentName: 'web_search', confidence: 0.9, source: 'search_guard' };
  }

  // ── Pre-compute the keyword fallback (synchronous, free) ─────────────────────
  // It only fires when the LLM path fails or returns garbage — but computing it
  // up front lets a confident keyword hit short-circuit a failed LLM attempt
  // instead of paying a second 12s provider call. LLM stays primary.
  const { ask } = require('./llm-providers.cjs');
  let keywordHit = null;
  try {
    const fb = require('./classifier-fallback.cjs');
    const r = fb._keywordClassify(englishText);
    if (r && r.confidence > 0.5 && INTENTS[r.intent]) {
      keywordHit = { intent: r.intent, intentName: INTENTS[r.intent].name, confidence: r.confidence };
    }
  } catch (_) { /* fallback unavailable — LLM path proceeds normally */ }

  // Action veto (mirror of the residual-bucket veto below): quick tiers
  // answer with text only — they cannot execute. When the deterministic
  // intentGuesser claims a graph-only intent, a quick pick is a flake.
  // Observed: "post a tweet saying hello world" drew general_quick and comms
  // answered "tweet going live" — nothing ever ran.
  let _guessedIntent = null;
  try { _guessedIntent = require('./intentGuesser.cjs').guess(englishText, { hasSelectionContext }).guessedIntent; } catch (_) {}
  const _vetoQuick = (result) => {
    // status_check (3) is non-executable too — it only reads the task journal.
    // Observed: "…explain the status for each repo… commit it" — the status
    // keyword vetoed the LLM's handoff and the prompt died as a canned
    // journal summary while intentGuesser saw command_automate.
    if ((result.intent === 1 || result.intent === 3 || result.intent === 4 || result.intent === 5 || result.intent === 8) && GRAPH_ONLY_INTENTS.has(_guessedIntent)) {
      logger.info('[Classify] Action veto — quick tier cannot serve graph-only intent', {
        llmIntent: result.intent, guessedIntent: _guessedIntent,
        inputPreview: englishText.substring(0, 60),
      });
      return { intent: 0, intentName: 'handoff', confidence: 0.85, source: 'action_veto' };
    }
    // Control-vocab guard: intent 4 can only abort a RUNNING task — the
    // utterance must carry control vocabulary ("cancel", "stop", "nevermind").
    // Observed: "use nylas to delte it" drew control_signal → the lane has no
    // handler for artifact deletion → dead-end "did you want to cancel
    // something?". Artifact mutations route to handoff where the stategraph
    // (and the artifact-referent pin) can act on them.
    if (result.intent === 4 && !(CONTROL_SIGNAL_RE && CONTROL_SIGNAL_RE.test(englishText))) {
      logger.info('[Classify] control_signal picked but no control vocabulary — veto to handoff', {
        inputPreview: englishText.substring(0, 60),
      });
      return { intent: 0, intentName: 'handoff', confidence: 0.8, source: 'control_vocab_veto' };
    }
    // Multi-deliverable upgrade: LLM routes a many-service/many-action prompt to
    // handoff (or even general_quick) — the complexity scorer catches the shape
    // the LLM missed and moves it to the planning lane instead of one fused run.
    if (result.intent === 0 || result.intent === 1) {
      const cx = _complexityPlanningScore(englishText);
      if (cx.score >= 1) {
        logger.info('[Classify] Complexity guard → planning', {
          was: result.intentName, services: cx.services, actions: cx.actions,
          sequenced: cx.sequenced, words: cx.words,
          inputPreview: englishText.substring(0, 60),
        });
        return { intent: 6, intentName: 'planning', confidence: 0.8, source: 'complexity_guard' };
      }
    }
    return result;
  };

  const _adoptKeyword = (reason) => {
    // Context-dependency guard: a prompt whose subject is a pronoun with no
    // named referent ("how long has he been in office") can only be answered
    // after resolveReferences binds the pronoun — a standalone quick tier
    // would send the literal "he" to Google and answer about the wrong
    // person (observed: follow-up to a Trump answer returned a Biden
    // overview). Keyword adoption is blocked no matter which path led here.
    // Control signals are exempt: "cancel that"/"stop it" act on the ambient
    // running task — the pronoun is their object, not a referent the
    // resolver must bind. Blocking these sends an abort request to handoff.
    if (isContextDependent(englishText) && keywordHit.intent !== 4) {
      logger.info('[Classify] Context-dependent prompt — keyword veto blocked', {
        wouldBe: keywordHit.intentName, reason,
        inputPreview: englishText.substring(0, 60),
      });
      return { intent: 0, intentName: 'handoff', confidence: 0.85, source: 'context_dependent' };
    }
    logger.info('[Classify] Keyword fallback result', {
      intent: keywordHit.intent, intentName: keywordHit.intentName,
      confidence: keywordHit.confidence, reason,
      inputPreview: englishText.substring(0, 60),
    });
    return _vetoQuick({ ...keywordHit, source: 'keyword_fallback' });
  };

  // ── Missing-details → planning (decision-model check) ──────────────────────
  // Statement-shaped prompts that routed to a write/task lane may be
  // underspecified or ambiguous about what should happen ("send the report" —
  // missing recipient; "remind me" — missing when). The personal-event regex
  // above catches the common shape for free; this askDecision call is the
  // general check for the rest. Gated narrow: non-question statements bound
  // for intent 0/5 only, one call, fail-open to the original pick.
  const _missingDetailCheck = async (result) => {
    if (!result || (result.intent !== 0 && result.intent !== 5)) return result;
    if (_isQuestion || englishText.trim().split(/\s+/).length < 3) return result;
    if (!decision.decisionEnabled()) return result;
    // Resolvable-referent skip — "the current web page/screen/tab" IS the
    // target; the stategraph resolves it against live context, so nothing is
    // missing. Observed: "Scroll to the bottom of the current web page" and
    // "Open the Medicaid site" were judged missing-detail → planning. Same
    // for clearly imperative actions the guesser already recognizes.
    if (/\b(?:the|this|that|current|my|open|visible)\s+(?:web\s?)?(?:page|site|website|tab|screen|window|document|doc|form|field|app|browser)\b/i.test(englishText)
        || /\b(?:check|search|look|see|recall|find|is there|what'?s in|do you (?:have|remember))\b[^.]{0,40}\b(?:memory|memories|stored|saved|remembered)\b/i.test(englishText)
        || (GRAPH_ONLY_INTENTS.has(_guessedIntent) && englishText.trim().split(/\s+/).length >= 4)) {
      return result;
    }
    try {
      // The decision model sees conversation context — a referential prompt
      // ("the calendar event to take out the trash I want you to remove it
      // now") judged in a vacuum looks ambiguous; with the prior create turn
      // in view it is a complete instruction. Observed: zero-context state
      // sent an event-delete to planning, which pinned the UI and produced an
      // empty plan.
      const _ctxStr = Array.isArray(conversationContext)
        ? conversationContext.join('\n')
        : String(conversationContext || '');
      const _missingV = await decision.confirmJudgment({
        site: 'missing-detail',
        question: 'This user statement would be executed or stored as-is. Is it missing details needed to act correctly (missing target, date, recipient, or subject) OR ambiguous about what the user wants done? Answer NO for clear instructions, questions, and complete statements — including actions on an artifact already established in the conversation (e.g. "delete that event I just set" after an event was created is complete), and actions whose target is the user\'s current page, screen, tab, site, or window (e.g. "scroll to the bottom of the current web page" is complete — the open page is the target).',
        state: _ds.buildDecisionState({
          site: 'missing-detail',
          message: englishText,
          history: _ctxStr.split('\n').filter(Boolean).slice(-3),
        }),
      });
      logger.info(`[semantic-gate-evidence] site=missing-detail verdict=${_missingV || 'null'} input=${englishText.substring(0, 60)}`);
      if (_missingV === 'YES') {
        logger.info('[Classify] Missing-details decision → planning', {
          was: result.intentName, inputPreview: englishText.substring(0, 60),
        });
        return { intent: 6, intentName: 'planning', confidence: 0.75, source: 'missing_detail_guard' };
      }
    } catch (_) { /* fail open */ }
    return result;
  };

  // ── Local decision-model path ──────────────────────────────────────────────
  // phi4 decision.answer replaces the remote force-prompt: one local forward
  // pass (~50–300ms) vs 1.6–12.5s remote with pathological tails. Options are
  // indexed to match INTENTS keys 0..6, so answers.intent.index IS the intent.
  // DECISION_LOCAL=0 disables; DECISION_SHADOW=1 runs both, logs agreement,
  // returns remote (see decision.cjs).
  const decision = require('./decision.cjs');
  const _localIntent = async () => {
    const options = Object.entries(INTENTS).map(([n, i]) => `${i.name} — ${i.description}`);
    const _extSess = await _extSessP;
    const _boundHosts = (_extSess || [])
      .map(s => { try { return new URL(s.url).hostname.replace(/^www\./, ''); } catch (_) { return null; } })
      .filter(Boolean);
    // Shaped per-site state — the decision model only needs the message, a
    // couple of turn previews, and the plan/host lines (decision-state.cjs).
    const state = _ds.buildDecisionState({
      site: 'classify.intent',
      message: englishText,
      history: String(conversationContext || '').split('\n').filter(Boolean).slice(-3),
      extras: [
        _boundHosts.length ? `Bound pages: ${_boundHosts.join(', ')} — prompts acting on/continuing those pages are intent 0 (handoff), NEVER a quick lane.` : '',
        openPlan ? `Open plan: "${openPlan.title}" paused — ${openPlan.pendingCount}/${openPlan.totalTasks} undone (${(openPlan.taskTitles || []).join('; ')}) — continues/questions about it → planning.` : '',
      ],
    });
    const r = await decision.askDecision([{
      id: 'intent', type: 'choice',
      question: 'Which intent best classifies the user\'s current message?',
      options,
    }], { state });
    const a = r?.answers?.intent;
    const idx = a?.index;
    // Confidence floor — a 0.8b model's coin-flip must not route writes
    // (memory_store) or wrong lanes. Below the floor → null → remote path.
    const conf = a?.confidence;
    if (idx != null && conf != null && conf < 0.55) {
      logger.info('[Classify] Low-confidence local pick — remote fallback', { intent: idx, confidence: conf });
      return null;
    }
    return (idx != null && INTENTS[idx]) ? idx : null;
  };

  // ── Remote force-prompt classification (fallback / shadow-remote) ──────────
  // One retry on unparseable responses — a flaky provider echoing the system
  // prompt back is transient; the backend rotates providers between calls.
  const messages = _buildClassifyMessages(englishText, conversationContext, opts.openPlan);
  const _remoteClassify = async () => {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const { text, provider } = await ask(messages, {
        maxTokens: 5,
        temperature: 0.1,
        timeoutMs: 12000,
        taskType: 'classification',
      });

      if (text) {
        const trimmed = text.trim();
        const match = trimmed.match(NUMBER_RE);
        if (match) {
          const intent = parseInt(match[1], 10);
          const info = INTENTS[intent];
          // Residual-bucket veto: intent 0 is the least-informative class
          // ("send it to the graph"), and providers flake toward it —
          // the same prompt draws 0 and 1 across calls. A confident
          // deterministic keyword hit is positive evidence for a closed
          // quick-intent domain and outweighs a forced single-digit guess
          // that landed on the catch-all. Never vetoes a specific
          // non-zero intent — the LLM remains primary for real routing.
          if (intent === 0 && keywordHit) return _adoptKeyword('veto_llm_handoff');
          logger.info('[Classify] Force-prompt result', {
            intent, intentName: info.name, provider, text: trimmed,
            inputPreview: englishText.substring(0, 60),
            ...(attempt > 1 ? { attempt } : {}),
          });
          return _vetoQuick({ intent, intentName: info.name, confidence: 0.92, source: attempt > 1 ? 'force_prompt_retry' : 'force_prompt' });
        }
        // LLM returned something but not a clean number — try to extract.
        // Only trust a SINGLE distinct digit: providers sometimes echo a
        // numbered intent list or emit enumeration prose, where the first
        // digit is almost always 0 (handoff) — the most expensive misroute.
        // Multiple distinct digits = untrustworthy → retry → keyword fallback.
        const digitHits = trimmed.match(/\d/g) || [];
        const uniqueDigits = [...new Set(digitHits)];
        if (uniqueDigits.length === 1 && trimmed.length <= 60) {
          const intent = parseInt(uniqueDigits[0], 10);
          const info = INTENTS[intent];
          if (info) {
            if (intent === 0 && keywordHit) return _adoptKeyword('veto_llm_handoff');
            logger.info('[Classify] Force-prompt (extracted)', {
              intent, intentName: info.name, provider, raw: trimmed,
            });
            return _vetoQuick({ intent, intentName: info.name, confidence: 0.75, source: 'force_prompt_extracted' });
          }
        }
        // CoT-leaking providers (gemini-free) reason at length but end with the
        // answer ("...Intent: 2." / "...single number.2"). Multi-digit responses
        // are untrustworthy as a whole, but a trailing digit or an explicit
        // "intent: N" phrase is a deliberate final answer — extract it rather
        // than paying a second flaky 12s call that ends in blind handoff.
        const tailMatch = trimmed.match(new RegExp(`([${_intentMin}-${_intentMax}])\\s*[.!)]*\\s*$`))
          || trimmed.match(new RegExp(`intent\\s*(?:is|:|=|->|of)?\\s*([${_intentMin}-${_intentMax}])\\s*[.!)]*\\s*$`, 'i'));
        if (tailMatch) {
          const intent = parseInt(tailMatch[1], 10);
          const info = INTENTS[intent];
          if (info) {
            if (intent === 0 && keywordHit) return _adoptKeyword('veto_llm_handoff');
            logger.info('[Classify] Force-prompt (tail-extracted)', {
              intent, intentName: info.name, provider,
              rawTail: trimmed.slice(-80),
            });
            return _vetoQuick({ intent, intentName: info.name, confidence: 0.7, source: 'force_prompt_tail' });
          }
        }
        logger.warn('[Classify] Force-prompt returned unparseable response', { raw: trimmed, provider, attempt });
        // A confident keyword hit beats a second 12s provider call — the LLM
        // already flaked once; degraded-mode routing now beats a slow lottery.
        if (keywordHit) return _adoptKeyword('llm_unparseable');
        continue;
      }
      // Empty text — backend down; keyword hit still beats a blind retry.
      if (keywordHit) return _adoptKeyword('llm_empty');
      break;
    } catch (err) {
      logger.warn('[Classify] Force-prompt error', { error: err.message, attempt });
      if (keywordHit) return _adoptKeyword('llm_error');
      break;
    }
  }

  // ── Fallback: default to handoff (safe) ──────────────────────────────────────
  // When the LLM fails and no keyword matched, default to handoff — the main
  // stategraph can handle anything (including chitchat — it would just answer
  // directly).
  logger.info('[Classify] LLM failed — defaulting to handoff (safe)');
  return { intent: 0, intentName: 'handoff', confidence: 0.3, source: 'default_handoff' };
  }; // end _remoteClassify

  // Adaptive mode — DECISION_ADAPTIVE=1: run whichever leg has been faster
  // for this site (EWMA); race both on cold start / periodic resample, first
  // valid answer wins. First-valid-wins replaces shadow's remote-authority:
  // on a slow-local box remote answers in ~0.5-1s while local keeps timing
  // in the background; once state shaping makes local fast it wins again.
  if (decision.decisionEnabled() && decision.adaptiveEnabled && decision.adaptiveEnabled()) {
    const pick = await decision.adaptiveChoose('classify.intent', async () => {
      const li = await _localIntent();
      return li == null ? null : { intent: li, intentName: INTENTS[li].name, confidence: 0.9, source: 'decision_local' };
    }, _remoteClassify);
    let result = pick;
    if (!result) {
      logger.warn('[Classify] Adaptive: both legs failed — defaulting to handoff');
      result = { intent: 0, intentName: 'handoff', confidence: 0.3, source: 'adaptive_none' };
    }
    if (result.intent === 0 && keywordHit) return _missingDetailCheck(_adoptKeyword('veto_llm_handoff'));
    logger.info('[Classify] Adaptive result', {
      intent: result.intent, intentName: result.intentName, source: result.source,
      inputPreview: englishText.substring(0, 60),
    });
    return _missingDetailCheck(_vetoQuick(result));
  }

  // Local-first: authoritative when enabled and not in shadow mode.
  if (decision.decisionEnabled() && !decision.shadowMode('classify.intent')) {
    try {
      const li = await _localIntent();
      if (li != null) {
        if (li === 0 && keywordHit) return _adoptKeyword('veto_llm_handoff');
        const info = INTENTS[li];
        logger.info('[Classify] Local decision result', {
          intent: li, intentName: info.name,
          inputPreview: englishText.substring(0, 60),
        });
        return _missingDetailCheck(_vetoQuick({ intent: li, intentName: info.name, confidence: 0.9, source: 'decision_local' }));
      }
      logger.debug('[Classify] Local decision unavailable — falling back to remote');
    } catch (e) {
      logger.warn(`[Classify] Local decision error — falling back to remote: ${e.message}`);
    }
    return _missingDetailCheck(await _remoteClassify());
  }

  // Shadow mode: run local alongside remote, log agreement, remote wins.
  if (decision.decisionEnabled() && decision.shadowMode('classify.intent')) {
    // Compare the intent NUMBERS — local returns an index while remote returns
    // the full result object, so a raw JSON compare would always disagree.
    // shadowCompare returns the remoteFn VALUE — it must be the full result
    // object, not just .intent, or processMessage's destructure gets
    // undefined for every field and every prompt falls to generalQuick→
    // sentinel→blind handoff (observed: every shadow-mode prompt misrouted).
    let _remoteFull = null;
    await decision.shadowCompare('classify.intent', _localIntent,
      async () => { _remoteFull = await _remoteClassify(); return _remoteFull?.intent; });
    return _missingDetailCheck(_remoteFull || { intent: 0, intentName: 'handoff', confidence: 0.3, source: 'shadow_remote_missing' });
  }

  return _missingDetailCheck(await _remoteClassify());
}

module.exports = { classify, INTENTS, GRAPH_ONLY_INTENTS, _complexityPlanningScore };
