'use strict';

/**
 * persona.cjs — Personality layer for comms-graph
 *
 * Fetches the live personality overlay (mood, traits, behavioral guidance)
 * from personality-service and loads the base persona prompt.
 * The overlay is injected into both the intent classification prompt and
 * the response generation prompt so ThinkDrop's current emotional state
 * shapes how it speaks and what handoff phrases it uses.
 *
 * Falls back gracefully — zero breakage if personality-service is down.
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const logger = require('./logger.cjs');

const PERSONALITY_SERVICE_PORT = parseInt(process.env.PERSONALITY_SERVICE_PORT || '3012', 10);

// ── Base persona prompt — static, loaded once at startup ──────────────────────
function _loadPersonaPrompt() {
  try {
    return fs.readFileSync(path.join(__dirname, '../prompts/persona.md'), 'utf8').trim();
  } catch (_) {
    return 'You are ThinkDrop — a sharp, composed AI butler. Be concise, helpful, and use no markdown.';
  }
}
const BASE_PERSONA = _loadPersonaPrompt();

// ── Personality overlay fetch ──────────────────────────────────────────────────
// Fetches the THINKDROP LIVE STATE block from personality-service.
// Falls back to empty string if personality-service is down.
function fetchOverlay() {
  return new Promise((resolve) => {
    const body = JSON.stringify({
      version: 'mcp.v1',
      service: 'personality-service',
      action: 'personality.overlay',
      payload: {},
      requestId: 'cg_' + Date.now(),
    });
    const req = http.request({
      hostname: '127.0.0.1',
      port: PERSONALITY_SERVICE_PORT,
      path: '/personality.overlay',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 500,
    }, (res) => {
      let raw = '';
      res.on('data', c => { raw += c; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(raw);
          resolve(parsed && parsed.data && parsed.data.overlay ? parsed.data.overlay : '');
        } catch (_) { resolve(''); }
      });
    });
    req.on('error', () => resolve(''));
    req.on('timeout', () => { req.destroy(); resolve(''); });
    req.write(body);
    req.end();
  });
}

// ── Mood context fetch (lightweight — for behavioral modifiers) ───────────────
function fetchMoodContext() {
  return new Promise((resolve) => {
    const body = JSON.stringify({
      version: 'mcp.v1',
      service: 'personality-service',
      action: 'personality.moodContext',
      payload: {},
      requestId: 'cg_mood_' + Date.now(),
    });
    const req = http.request({
      hostname: '127.0.0.1',
      port: PERSONALITY_SERVICE_PORT,
      path: '/personality.moodContext',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 1500,
    }, (res) => {
      let raw = '';
      res.on('data', c => { raw += c; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(raw);
          resolve(parsed && parsed.data ? parsed.data : { mood_label: 'content', behavioral_guidance: '' });
        } catch (_) { resolve({ mood_label: 'content', behavioral_guidance: '' }); }
      });
    });
    req.on('error', () => resolve({ mood_label: 'content', behavioral_guidance: '' }));
    req.on('timeout', () => { req.destroy(); resolve({ mood_label: 'content', behavioral_guidance: '' }); });
    req.write(body);
    req.end();
  });
}

/**
 * Build the full system prompt for response generation.
 * Combines base persona + personality overlay + mood context + language directive.
 *
 * @param {Object} opts
 * @param {string} [opts.language]       - User's detected language (for response language directive)
 * @param {string} [opts.overlay]       - Pre-fetched personality overlay (skip refetch)
 * @param {Object} [opts.moodContext]   - Pre-fetched mood context
 * @param {string} [opts.speakerProfile] - Speaker profile block (from voice-service)
 * @param {boolean} [opts.isResemble]    - Whether Resemble TTS is active (emotion tags)
 * @returns {Promise<string>} full system prompt
 */
async function buildSystemPrompt(opts = {}) {
  // Fetch overlay + mood in parallel if not pre-fetched
  const [overlay, mood] = await Promise.all([
    opts.overlay !== undefined ? Promise.resolve(opts.overlay) : fetchOverlay(),
    opts.moodContext !== undefined ? Promise.resolve(opts.moodContext) : fetchMoodContext(),
  ]);

  let prompt = BASE_PERSONA;

  if (overlay) {
    prompt += '\n\n' + overlay;
  }

  // Mood behavioral guidance
  if (mood && mood.behavioral_guidance) {
    prompt += `\n\n═══ CURRENT MOOD ═══\nMood: ${mood.mood_label || 'content'}\n${mood.behavioral_guidance}\n═══════════════════`;
  }

  // Speaker profile (from voice-service emotion detection)
  if (opts.speakerProfile) {
    prompt += '\n\n' + opts.speakerProfile;
  }

  // Emotion tag instructions
  if (opts.isResemble) {
    // Keep vocalization tag instructions from base persona
  } else {
    prompt += '\n\nDo NOT use any emotion tags like [happy] or [excited] in your response. Plain text only.';
  }

  // Language directive
  const lang = opts.language || 'en';
  if (lang && lang !== 'en') {
    const { LANGUAGE_NAMES } = require('./translate.cjs');
    prompt += `\n\nIMPORTANT: The user is speaking ${LANGUAGE_NAMES[lang] || lang}. You MUST respond entirely in ${LANGUAGE_NAMES[lang] || lang}. Do not use English.`;
  }

  return prompt;
}

module.exports = { BASE_PERSONA, fetchOverlay, fetchMoodContext, buildSystemPrompt };
