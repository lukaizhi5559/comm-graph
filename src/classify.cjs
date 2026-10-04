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
 *
 * Falls back to embedding-based classification (classifier-fallback.cjs) if LLM
 * returns an unparseable response.
 */

const fs = require('fs');
const path = require('path');
const logger = require('./logger.cjs');
// Canonical patterns live in shared/text-patterns.cjs — update there, not here.
const { BARE_AFFIRM_RE, OFFER_RE, BARE_FOLLOWUPS, CONVERSATION_RECALL_RE, SCREEN_OBSERVATION_RE, DEICTIC_CONTINUATION_RE, DEVICE_STATE_RE } = require('../../shared/text-patterns.cjs');

// ── Intent definitions ─────────────────────────────────────────────────────────
const INTENTS = {
  0: { name: 'handoff',           description: 'Anything needing tools, web search, browser automation, computer actions, deep memory retrieval, scheduling, file operations, or multi-step tasks' },
  1: { name: 'general_quick',    description: 'Chitchat, greetings, opinions, simple knowledge questions the LLM can answer directly without tools' },
  2: { name: 'memory_quick',      description: 'Quick personal fact recall — name, favorite color, email, job, age. Also handles explicit profile fact storage ("my name is X"). NOT deep temporal history or complex queries' },
  3: { name: 'status_check',      description: 'Asking about the status/progress of a running or recently completed task' },
  // pause/resume are intentionally absent — those signals are unimplemented
  // (main.js aborts on 'cancel' only); advertising them here routes utterances
  // to a node that can't serve them.
  4: { name: 'control_signal',    description: 'Cancel, stop, or abort a running task' },
  5: { name: 'memory_store',      description: 'Storing a general memory, note, appointment, or event — NOT a personal profile fact. E.g., "i have a dentist appt next week", "remember I have a meeting at 3pm", "note: buy milk tomorrow"' },
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
function _buildClassifyMessages(englishText, conversationContext) {
  const intentList = Object.entries(INTENTS)
    .map(([num, info]) => `${num} - ${info.name}: ${info.description}`)
    .join('\n');

  const systemPrompt = CLASSIFY_PROMPT_TEMPLATE
    ? CLASSIFY_PROMPT_TEMPLATE.replace('{{INTENT_LIST}}', intentList)
    : `You are an intent classifier for ThinkDrop AI. Classify the user's message into exactly one of these intents:

${intentList}

Return ONLY a single number (${_intentListStr}). No words, no explanation, no punctuation — just the number.`;

  const userContent = conversationContext
    ? `Conversation context (last 3 turns):\n${conversationContext}\n\nCurrent message: ${englishText}`
    : `Message: ${englishText}`;

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

async function classify(englishText, conversationContext, opts = {}) {
  if (!englishText || !englishText.trim()) {
    return { intent: 1, intentName: 'general_quick', confidence: 0.5, source: 'empty_input' };
  }
  const hasSelectionContext = !!opts.hasSelectionContext;

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

  // Screen-output commands ("show it on the screen", "make it rain on my
  // screen", "clear the screen") drive the GhostLayer display channel in the
  // stategraph — never let them land in general_quick or control_signal.
  if (/\bon(?:to)?\s+(?:the|my)\s+screen\b|\bon\s+screen\b|\bmake it (?:rain|snow)\b|\bfireworks?\b|\b(?:clear|hide|dismiss)\s+(?:the\s+|my\s+)?screen\b/i.test(englishText)) {
    logger.info('[Classify] Screen-output guard → handoff', {
      inputPreview: englishText.substring(0, 60),
    });
    return { intent: 0, intentName: 'handoff', confidence: 0.95, source: 'screen_output_guard' };
  }

  // Screen-observation questions ("what's on my screen", "describe what I'm
  // looking at", "read the text on screen") need a live capture — general_quick
  // has no eyes. The classifier LLM slips here because the question *looks*
  // answerable; deterministic handoff instead.
  if (SCREEN_OBSERVATION_RE.test(englishText)) {
    logger.info('[Classify] Screen-observation guard → handoff', {
      inputPreview: englishText.substring(0, 60),
    });
    return { intent: 0, intentName: 'handoff', confidence: 0.95, source: 'screen_observation_guard' };
  }

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
  const _GRAPH_ONLY_INTENTS = new Set(['command_automate', 'screen_analysis', 'web_search', 'memory_retrieve']);
  let _guessedIntent = null;
  try { _guessedIntent = require('./intentGuesser.cjs').guess(englishText, { hasSelectionContext }).guessedIntent; } catch (_) {}
  const _vetoQuick = (result) => {
    // memory_retrieve and memory_quick share the memory domain — the guesser's
    // "what's my X" recall patterns overlap the quick tier's profile-fact
    // surface. When the LLM picked memory_quick, trust its depth judgment over
    // a regex that can't tell shallow fact recall from deep transcript search.
    const _sameMemoryDomain = result.intent === 2 && _guessedIntent === 'memory_retrieve';
    // status_check (3) is non-executable too — it only reads the task journal.
    // Observed: "…explain the status for each repo… commit it" — the status
    // keyword vetoed the LLM's handoff and the prompt died as a canned
    // journal summary while intentGuesser saw command_automate.
    if (!_sameMemoryDomain && (result.intent === 1 || result.intent === 2 || result.intent === 3 || result.intent === 4 || result.intent === 5) && _GRAPH_ONLY_INTENTS.has(_guessedIntent)) {
      logger.info('[Classify] Action veto — quick tier cannot serve graph-only intent', {
        llmIntent: result.intent, guessedIntent: _guessedIntent,
        inputPreview: englishText.substring(0, 60),
      });
      return { intent: 0, intentName: 'handoff', confidence: 0.85, source: 'action_veto' };
    }
    return result;
  };

  const _adoptKeyword = (reason) => {
    logger.info('[Classify] Keyword fallback result', {
      intent: keywordHit.intent, intentName: keywordHit.intentName,
      confidence: keywordHit.confidence, reason,
      inputPreview: englishText.substring(0, 60),
    });
    return _vetoQuick({ ...keywordHit, source: 'keyword_fallback' });
  };

  // ── Try force-prompt classification (primary) ────────────────────────────────
  // One retry on unparseable responses — a flaky provider echoing the system
  // prompt back is transient; the backend rotates providers between calls.
  const messages = _buildClassifyMessages(englishText, conversationContext);
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
        const tailMatch = trimmed.match(/([0-5])\s*[.!)]*\s*$/)
          || trimmed.match(/intent\s*(?:is|:|=|->|of)?\s*([0-5])\s*[.!)]*\s*$/i);
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
}

module.exports = { classify, INTENTS };
