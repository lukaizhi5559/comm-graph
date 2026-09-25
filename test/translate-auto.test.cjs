'use strict';
/**
 * translate-auto.test.cjs — 'auto'/'und' language-tag policy.
 *
 * Regression: normalizeLanguage('auto') used to return 'auto' verbatim, so
 * every prompt arriving with the default tag paid a dead auto→English
 * translate call (~10–25s) and fromEnglish translated responses *to* "auto" —
 * an arbitrary language. 'auto'/'und' are unknown-language sentinels, not
 * languages: they must resolve to 'en' and let detectScriptLanguage upgrade
 * non-Latin input to a concrete language.
 *
 * Run: node comms-graph/test/translate-auto.test.cjs
 */

const { normalizeLanguage, needsTranslation, detectScriptLanguage, toEnglish, fromEnglish } = require('../src/translate.cjs');

let passed = 0, failed = 0;
function check(cond, label) {
  if (cond) { console.log(`  PASS: ${label}`); passed++; }
  else { console.error(`  FAIL: ${label}`); failed++; }
}

(async () => {
  // ── normalizeLanguage ────────────────────────────────────────────────────
  check(normalizeLanguage('auto') === 'en', "'auto' → 'en'");
  check(normalizeLanguage('und') === 'en', "'und' → 'en'");
  check(normalizeLanguage('unknown') === 'en', "'unknown' → 'en'");
  check(normalizeLanguage('AUTO') === 'en', "'AUTO' (case) → 'en'");
  check(normalizeLanguage(null) === 'en', "null → 'en'");
  check(normalizeLanguage(undefined) === 'en', "undefined → 'en'");
  check(normalizeLanguage('') === 'en', "'' → 'en'");

  // Real codes unaffected
  check(normalizeLanguage('es') === 'es', "'es' stays 'es'");
  check(normalizeLanguage('zh-CN') === 'zh', "'zh-CN' → 'zh'");
  check(normalizeLanguage('spa') === 'es', "ISO-3 'spa' → 'es'");
  check(normalizeLanguage('spanish') === 'es', "name 'spanish' → 'es'");

  // ── needsTranslation ─────────────────────────────────────────────────────
  check(needsTranslation('auto') === false, "needsTranslation('auto') === false — no dead translate call");
  check(needsTranslation('en') === false, "needsTranslation('en') === false");
  check(needsTranslation('es') === true, "needsTranslation('es') === true");

  // ── toEnglish: auto + Latin text = passthrough (the hot path) ────────────
  const en = await toEnglish({ text: "what's running right now", language: 'auto' });
  check(en.wasTranslated === false && en.detectedLanguage === 'en' && en.englishText === "what's running right now",
    'auto + English → passthrough (wasTranslated=false, lang=en)');

  const enUnd = await toEnglish({ text: 'hello', language: 'und' });
  check(enUnd.wasTranslated === false && enUnd.detectedLanguage === 'en', "'und' + English → passthrough");

  const enMissing = await toEnglish({ text: 'hello', language: undefined });
  check(enMissing.wasTranslated === false && enMissing.detectedLanguage === 'en', 'missing language → passthrough');

  // ── toEnglish: auto + CJK still upgrades via script detection ───────────
  check(detectScriptLanguage('你好，今天天气怎么样') === 'zh', 'script detector → zh for Han text');
  // NOTE: a full toEnglish on CJK would call the provider chain — assert the
  // detection half only; the translate() call itself is provider-dependent.

  // ── fromEnglish: 'auto' can never be a translation target ────────────────
  const back = await fromEnglish('Your name is Kai.', 'auto');
  check(back === 'Your name is Kai.', "fromEnglish('auto') returns text unchanged — no random-language output");
  const backEn = await fromEnglish('Hello.', 'en');
  check(backEn === 'Hello.', "fromEnglish('en') passthrough");

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
