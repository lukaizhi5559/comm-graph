'use strict';

/**
 * webSearchExpress.cjs — express lane for standalone public web searches.
 *
 * The stategraph's web_search lane wraps ~1.4s of SERP fetch in ~7-10s of
 * orchestration (LLM classify → classifyTask → spine hops → retrieveMemory →
 * LLM answer synthesis → logConversation). For a standalone lookup none of
 * that context is used — this node calls the same :3002/web.search service
 * directly and returns the overview/cards verbatim.
 *
 * Gate discipline (isEligible): the lane only admits prompts that are
 * context-free — no pronoun referent, no continuation markers, no selection,
 * no open plan, no file/screen/personal referents. Anything ambiguous falls
 * through to classify → handoff → stategraph where resolveReferencesV2 can
 * resolve it properly. Under-claim is safe; over-claim is not.
 *
 * Result shape matches the stategraph lane's renderer contract: metadata
 * carries `sources` + `items` which main.js emits as \x00SOURCES\x00 and
 * \x00ITEMS\x00 sentinel chunks — identical cards in the overlay.
 *
 * Env: WEB_SEARCH_EXPRESS=0 disables the lane entirely.
 */

const http = require('http');
const https = require('https');
const logger = require('../logger.cjs');
const { standaloneSearchQuery } = require('../query-context.cjs');
const {
  isContextDependent,
  FILE_PATH_RE,
  LOCAL_FS_PROBE_RE,
  SCREEN_OBSERVATION_RE,
  LIVE_PAGE_REF_RE,
  PAGE_ITEM_REF_RE,
  NAMED_APP_RE,
  NAV_VERB_START_RE,
  SCRIPTURE_REF_RE,
} = require('../../../shared/text-patterns.cjs');
const { toItem: _toItem, hostnameOf: _hostname } = require('../../../shared/serp-item.cjs');

const WEB_SEARCH_PORT = parseInt(process.env.WEB_SEARCH_PORT || '3002', 10);
const WS_API_KEY = process.env.MCP_WEB_SEARCH_API_KEY || process.env.MCP_WEBSEARCH_API_KEY || process.env.MCP_API_KEY || '';
const SERP_TIMEOUT_MS = parseInt(process.env.WEB_SEARCH_EXPRESS_TIMEOUT_MS || '12000', 10);
const EXPRESS_ENABLED = process.env.WEB_SEARCH_EXPRESS !== '0';

// Media intent hint — computed on the ENGLISH (translated) prompt so it works
// for non-English queries too. The service's own classifier also detects
// explicit phrasing; this hint only reinforces (search.js applies it when the
// service-side classification is 'web').
const IMAGE_HINT_RE = /\b(images?|pictures?|photos?|pics|wallpapers?|logos?|icons?|gifs?|memes?|thumbnails?)\b/i;
const VIDEO_HINT_RE = /\b(videos?|clips?|trailers?|tutorials?|episodes?)\b/i;

// Continuation/follow-up shapes the pronoun check misses — "again", "too",
// "more like that". These only make sense against prior context.
const FOLLOWUP_SHAPE_RE = /^(?:yes|yeah|yep|ok(?:ay)?|sure|please|now|then|again|more|another|same|also|too|and|next|continue|go\s+ahead|what\s+about|how\s+about)\b|\b(?:too|again|instead|as\s+well|this\s+time|as\s+before|the\s+same)\s*[.?!]?\s*$/i;

// Personal/local referents — a web SERP cannot answer these.
const PERSONAL_DATA_RE = /\bmy\s+(notes?|files?|folders?|documents?|downloads?|desktop|inbox|gmail|google\s*mail|e?-?mails?|outlook|messages?|texts?|chats?|dms|voicemails?|calendar|contacts?|bookmarks?|photos?|reminders?|history|saved|notifications?)\b|\b(?:saved|bookmarked|stored)\s+(?:in|on|to)\s+(?:my|the)\b/i;

// Automation-shaped action verbs — a named app + one of these means the user
// wants the app DRIVEN, not a SERP about it. Kept deliberately narrow (no
// bare "search"/"find" — "search YouTube for X" is still a content lookup).
const APP_ACTION_VERB_RE = /\b(go\s+to|goto|navigate|open|launch|visit|log\s*in|sign\s*in|check|read|post|send|compose|reply|upload|download|scroll|click|fill|submit|play|watch|browse)\b/i;

// Nav-verb LEADING the prompt — "goto biblegateway", "open trello", "launch
// figma". A command-shaped prompt is never a SERP lookup, and NAMED_APP_RE
// can't enumerate every site the user might name — the verb's position is
// the signal that doesn't depend on the list. (Shared: NAV_VERB_START_RE.)

// Episodic/activity recall — "what was I doing monday", "what did I browse
// last night". A public SERP cannot answer the user's own history; these are
// memory_retrieve, and guessing web_search on them opens a useless Google
// SERP in the user's browser (observed).
const ACTIVITY_RECALL_RE = /\b(what was i doing|what did i do|was i doing|did i (?:do|work|browse|visit|watch|read|look)|what i was doing|what i did|my (?:recent )?(?:activity|browsing history|screen time))\b/i;

// Bare "search/find/look for X" — when a searchable site is bound in front,
// the site's own search box owns the task, not a public SERP.
const BARE_SEARCH_RE = /^\s*(?:please\s+)?(?:now\s+)?(?:then\s+)?(?:search|find|look)\s+(?:for|up)\b/i;
const SEARCHABLE_HOST_RE = /(amazon|ebay|etsy|walmart|target|bestbuy|aliexpress|youtube|reddit|pinterest|imdb|yelp|airbnb|booking|zillow|indeed|spotify|netflix|tiktok|wikipedia|stackoverflow|github|gitlab|npmjs|pypi|quora|medium|substack|goodreads|wayfair|homedepot|lowes|newegg|chewy|instacart|doordash|ubereats|grubhub|depop|poshmark|mercari|craigslist|realtor|redfin|kayak|expedia|hotels|trivago|nordstrom|macys|kohls|sephora|ulta|shein|temu|discogs|bandcamp|soundcloud|vimeo|dailymotion|twitch|flickr|unsplash|pexels|archive\.org|genius|allrecipes|foodnetwork|bbcgoodfood|seriouseats)\./i;
function _hostOf(u) { try { return new URL(u).hostname.replace(/^www\./, '').toLowerCase(); } catch (_) { return ''; } }

/**
 * @param {string} text         - English prompt (selection chips stripped)
 * @param {Object} opts         - { hasSelectionContext, openPlan, hasAttachment }
 */
function isEligible(text, opts = {}) {
  if (!EXPRESS_ENABLED) return false;
  const t = String(text || '').trim();
  if (t.length < 8 || t.split(/\s+/).length < 3) return false;
  if (opts.hasSelectionContext || opts.openPlan || opts.hasAttachment) return false;
  // Pronoun-subject follow-ups ("how long has he been in office") — the
  // referent lives in conversation history; classifyTask resolves it.
  if (isContextDependent(t)) return false;
  if (FOLLOWUP_SHAPE_RE.test(t)) return false;
  if (PERSONAL_DATA_RE.test(t)) return false;
  // Named app + action verb → the user wants the app driven (command_automate),
  // not a SERP about it. "goto youtube", "open gmail", "check my netflix" all
  // fall through to the real classifier — express only claims pure lookups.
  if (NAMED_APP_RE.test(t) && APP_ACTION_VERB_RE.test(t)) return false;
  // Nav-verb-led command ("goto biblegateway…") — command-shaped regardless
  // of whether the destination is a listed app. Fail closed: the real
  // classifier decides what it is; express just doesn't claim it.
  if (NAV_VERB_START_RE.test(t)) return false;
  // File paths, local-fs probes, and live screen/page referents can never be
  // answered by a public SERP — the stategraph owns those.
  if (FILE_PATH_RE.test(t) || LOCAL_FS_PROBE_RE.test(t)) return false;
  if (SCREEN_OBSERVATION_RE.test(t) || LIVE_PAGE_REF_RE.test(t)) return false;
  // Ordinal page-item referents ("the first three items", "the second
  // listing") — context-dependent by definition; the bound tab owns the
  // answer, a SERP can only answer wrong (observed: ebay follow-up →
  // screw-multipack prices).
  if (PAGE_ITEM_REF_RE.test(t)) return false;
  // Episodic/activity recall — the user's own history lives in memory lanes.
  if (ACTIVITY_RECALL_RE.test(t)) return false;
  // Bound-search veto — "search for baby mittens" with an Amazon tab bound
  // in front is on-page automation on that tab, never a public SERP.
  if (BARE_SEARCH_RE.test(t) && Array.isArray(opts.extSessions)
      && opts.extSessions.some(s => s && s.url && SEARCHABLE_HOST_RE.test(_hostOf(s.url)))) return false;
  return true;
}

function _postJson(port, urlPath, payload, apiKey, timeoutMs) {
  return new Promise((resolve) => {
    const body = JSON.stringify(payload);
    const req = http.request({
      hostname: '127.0.0.1', port, path: urlPath, method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      timeout: timeoutMs,
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch (_) { resolve(null); } });
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
    req.write(body);
    req.end();
  });
}

// SSE variant of _postJson for /web.search stream:true — parses `data:`
// lines, calls onEvent(ev) for progress events ({type:'engine'} chain
// transitions, {type:'items'} partial result sets), resolves with the
// {type:'done'} payload. 'answer' deltas are ignored — the express lane
// synthesizes its own text from the overview/cards.
function _postSse(port, urlPath, payload, apiKey, timeoutMs, onEvent) {
  return new Promise((resolve) => {
    const body = JSON.stringify(payload);
    const req = http.request({
      hostname: '127.0.0.1', port, path: urlPath, method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      timeout: timeoutMs,
    }, (res) => {
      let buf = '';
      res.on('data', (c) => {
        buf += c;
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          for (const line of block.split('\n')) {
            if (!line.startsWith('data:')) continue;
            try {
              const ev = JSON.parse(line.slice(5));
              if (ev.type === 'done') { req.destroy(); resolve(ev.data); return; }
              if (onEvent) onEvent(ev);
            } catch (_) {}
          }
        }
      });
      res.on('end', () => resolve(null));
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
    req.write(body);
    req.end();
  });
}

// Scripture lookup fast path — bible-api.com (free, no key). Google's AI
// Overview only returns verse fragments for full-chapter asks; the API
// returns the complete passage deterministically in <1s. Returns the
// "Reference\nPassage" text on success, null on any failure (SERP fallback).
function _fetchBiblePassage(ref, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const url = `https://bible-api.com/${encodeURIComponent(String(ref).trim().slice(0, 40))}`;
    const req = https.get(url, { timeout: timeoutMs }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try {
          const j = JSON.parse(data);
          if (j.error || !j.text) return resolve(null);
          resolve(`${(j.reference || ref).trim()}\n\n${j.text.trim()}`);
        } catch (_) { resolve(null); }
      });
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
  });
}



// Strip command-shaped preamble before sending to SERP — "goto google and
// search X" → "X". The raw command phrasing degrades results and suppresses
// AI Overview generation. Falls back to the raw query if stripping empties it.
function _cleanQuery(q) {
  const cleaned = String(q || '')
    .replace(/\b(?:goto|go\s+to|navigate\s+to|open|visit|launch|browse)\s+(?:to\s+)?[\w.-]+(?:\.[a-z]{2,})?\s*(?:and|then|for\s+me)?\s*/gi, ' ')
    .replace(/\b(?:look\s+up|search\s+for|search)\s+/gi, ' ')
    .replace(/\bfor\s+me\b/gi, ' ')
    .replace(/\s{2,}/g, ' ').trim();
  return cleaned.length >= 4 ? cleaned : String(q || '').trim();
}



/**
 * Attempt the express answer. Returns a result object on success, null to
 * abstain (service down, no results) — the caller then takes the normal path.
 *
 * @param {Object} opts
 *   englishText      - translated prompt
 *   originalText     - raw prompt (used as the SERP query when non-English)
 *   detectedLanguage - 'en', 'zh', …
 *   context          - formatted conversation history for the synth fallback
 */
async function execute(opts) {
  const { englishText, originalText, detectedLanguage, context } = opts || {};
  const t0 = Date.now();
  try {
    // Search in the user's own language (mirrors the webSearch node's
    // original-language logic); the media hint comes from the translation.
    let query = _cleanQuery(
      (detectedLanguage && detectedLanguage !== 'en' && originalText)
        ? originalText.trim() : englishText.trim());
    // The eligibility gates are regex — a no-pronoun follow-up ("who has
    // ALS?" after a Chris Johnson lookup) reads as context-free to them but
    // not to a SERP. With conversation history on hand, rewrite the query to
    // standalone form before sending; null = referent unresolvable → abstain.
    if (context && String(context).trim()) {
      const contextual = await standaloneSearchQuery(query, context, null);
      if (contextual === null) {
        logger.warn('[SearchExpress] abstained — follow-up referent unresolvable', {
          queryPreview: query.substring(0, 60),
        });
        return null;
      }
      query = contextual;
    }

    // Scripture lookup → bible-api.com fast path. "look up john 1" deserves
    // the complete chapter, not Google's fragmentary AI Overview.
    const scriptureRef = query.match(SCRIPTURE_REF_RE);
    if (scriptureRef) {
      const passage = await _fetchBiblePassage(scriptureRef[0]);
      if (passage) {
        logger.info('[SearchExpress] answered via bible-api', {
          latencyMs: Date.now() - t0, ref: scriptureRef[0],
        });
        return {
          text: passage,
          fullText: passage,
          metadata: {
            source: 'bible-api',
            provider: 'bible-api.com',
            engine: 'bible-api',
            intent: 1,
            guessedIntent: 'web_search',
            sources: [],
            items: [],
          },
        };
      }
      logger.warn('[SearchExpress] bible-api miss — falling through to SERP', { ref: scriptureRef[0] });
    }

    const mediaHint = VIDEO_HINT_RE.test(englishText) ? 'video'
      : IMAGE_HINT_RE.test(englishText) ? 'image' : null;

    // stream:true when a chunk channel is available — SSE progress events
    // (engine transitions, partial items) become sentinels so the renderer
    // shows favicon chips + cards while the SERP is still extracting.
    const onReplyChunk = typeof opts.onReplyChunk === 'function' ? opts.onReplyChunk : null;
    const _reqBody = {
      version: 'mcp.v1', service: 'web-search', action: 'web.search',
      payload: {
        query,
        limit: mediaHint ? 16 : 5,
        ...(mediaHint ? { maxResults: 16, intent: mediaHint } : {}),
        ...(detectedLanguage && detectedLanguage !== 'en' ? { lang: detectedLanguage } : {}),
        ...(onReplyChunk ? { stream: true } : {}),
      },
      requestId: 'cg_wsx_' + Date.now(),
      context: { userId: 'local_user' },
    };
    const _onSerpEvent = (ev) => {
      try {
        if (ev.type === 'engine' && ev.engine) {
          onReplyChunk('\x00SEARCHING\x00' + ev.engine);
        } else if (ev.type === 'items') {
          if (Array.isArray(ev.items) && ev.items.length) {
            const items = ev.items.map(_toItem).filter(Boolean);
            if (items.length) onReplyChunk('\x00ITEMS\x00' + JSON.stringify(items));
          }
          const srcs = (Array.isArray(ev.sources) && ev.sources.length ? ev.sources
            : (Array.isArray(ev.items) ? ev.items : [])
              .filter(r => (r.url || r.link || '').startsWith('http'))
              .map(r => {
                const url = r.url || r.link;
                return { url, hostname: r.displayDomain || _hostname(url), title: r.title || '' };
              }))
            // google.com/goto wrappers and bare google.com hosts aren't
            // sources — they're un-unwrapped SERP plumbing.
            .filter(s => s.hostname && s.hostname !== 'google.com');
          if (srcs.length) onReplyChunk('\x00SOURCES\x00' + JSON.stringify(srcs));
        }
      } catch (_) {}
    };
    let serp = onReplyChunk
      ? await _postSse(WEB_SEARCH_PORT, '/web.search', _reqBody, WS_API_KEY, SERP_TIMEOUT_MS, _onSerpEvent)
      : null;
    if (!serp) {
      serp = await _postJson(WEB_SEARCH_PORT, '/web.search', _reqBody, WS_API_KEY, SERP_TIMEOUT_MS);
    }

    const data = serp?.data || serp;
    const results = Array.isArray(data?.results) ? data.results : [];
    const overview = typeof data?.aiOverview === 'string' ? data.aiOverview.trim() : '';

    // Whole free chain is down (Google → Bing → DDG all failed) — answer with
    // the connect-an-API guidance verbatim. Do NOT abstain: the stategraph
    // lane would re-hit the same dead chain and LLM-synthesize noise.
    if (data?.searchUnavailable) {
      logger.warn('[SearchExpress] all providers down — serving search-unavailable guidance', {
        latencyMs: Date.now() - t0, queryPreview: query.substring(0, 60),
      });
      const text = typeof data.userMessage === 'string' && data.userMessage.trim()
        ? data.userMessage.trim()
        : "I couldn't reach any free web search providers right now. To search the web, connect a Web Search API (e.g. Brave Search API) in Settings.";
      return {
        text,
        fullText: text,
        metadata: {
          source: 'search_express',
          provider: 'web-search',
          engine: typeof data?.provider === 'string' ? data.provider : undefined,
          intent: 1,
          guessedIntent: 'web_search',
          searchUnavailable: true,
          sources: [],
          items: [],
        },
      };
    }

    // Renderable results only — a raw-text fallback or url-less row would
    // produce a "Here's what I found" header with zero cards beneath it.
    const renderable = results.filter(r =>
      r.type !== 'raw-text' &&
      ((r.url || r.link || '').startsWith('http') || r.thumbnail || r.imageUrl));
    if (!renderable.length && overview.length < 40) {
      // Distinguish "service unreachable/timed out" (serp null) from "service
      // answered but empty" — both abstain, but they mean very different things.
      logger.warn('[SearchExpress] abstained', {
        reason: serp ? 'no-renderable-results' : 'serp-unreachable-or-timeout',
        resultTypes: results.map(r => r.type || '?').join(','),
        latencyMs: Date.now() - t0, queryPreview: query.substring(0, 60),
      });
      return null;
    }

    // Dedupe by hostname — two Yelp results add no value as separate source
    // pills. displayDomain (from the SERP cite row) gives the real host even
    // when r.url is a wrapped google.com/goto link.
    const seenHosts = new Set();
    const sources = renderable
      .filter(r => (r.url || r.link || '').startsWith('http'))
      .map(r => {
        const url = r.url || r.link;
        return {
          url, title: r.title || '',
          hostname: r.displayDomain || _hostname(url),
          snippet: r.snippet || r.description || '',
        };
      })
      .filter(s => s.hostname && !seenHosts.has(s.hostname) && seenHosts.add(s.hostname))
      .slice(0, 14);
    const items = renderable.map(_toItem).filter(Boolean).slice(0, 32);

    let text;
    if (overview.length > 40) {
      // Google's AI Overview IS the answer — zero LLM calls.
      text = overview;
    } else {
      // No overview → cards + sources carry the answer. A synthesized
      // paragraph would be an LLM guess — worse than none (observed: it
      // hallucinated "I don't have the ability to browse the web").
      text = "Here's what I found:";
    }

    logger.info('[SearchExpress] answered', {
      latencyMs: Date.now() - t0, overview: overview.length > 40,
      results: results.length, items: items.length,
      mediaHint, queryPreview: query.substring(0, 60),
    });
    return {
      text,
      fullText: text,
      metadata: {
        source: 'search_express',
        provider: 'web-search',
        engine: typeof data?.provider === 'string' ? data.provider : undefined,
        intent: 1,
        guessedIntent: 'web_search',
        sources,
        items,
        mediaHint,
      },
    };
  } catch (err) {
    logger.warn('[SearchExpress] failed — falling through to normal pipeline', { error: err.message });
    return null;
  }
}

module.exports = { execute, isEligible };
