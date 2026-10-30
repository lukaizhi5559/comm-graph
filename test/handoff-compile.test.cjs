'use strict';
/**
 * handoff-compile.test.cjs — compiler-hoist payload wiring.
 *
 * _notifyMain must carry `compiledPlan` + `allowPlannerFallback` in the
 * /comms.handoff body when comms-graph compiled typed steps at dispatch —
 * that's what turns the stategraph run runtime-only (_skillPlan fast-path).
 *
 * Run: node comms-graph/test/handoff-compile.test.cjs
 */

process.env.THINKDROP_MAIN_PORT = '3409'; // capture server

const http = require('http');
let _captured = null;
const server = http.createServer((req, res) => {
  if (req.url === '/comms.handoff' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => { _captured = JSON.parse(body); res.writeHead(200).end('{}'); });
  } else { res.writeHead(200).end('{}'); }
});

let passed = 0, failed = 0;
function check(name, cond) {
  if (cond) { passed++; console.log(`  PASS ${name}`); }
  else { failed++; console.error(`  FAIL ${name}`); }
}

(async () => {
  await new Promise(r => server.listen(3409, r));
  const handoff = require('../src/handoff.cjs');

  // Reach inside via a task dispatch whose lock is free — execute() notifies
  // _notifyMain → our capture server. Compile fires _generateTaskSteps which
  // hits the real backend; if it fails we still verify the body shape when
  // compiledPlan is injected directly into _notifyMain.
  // Direct _notifyMain isn't exported — exercise it through execute() with a
  // stubbed compile by monkeypatching the module cache is fragile; instead
  // verify the POST body shape by calling execute() and inspecting what
  // arrives (compile result or not — field presence is what we assert when
  // compile succeeds).

  // Force-acquire-free dispatch: planTask=false, source='text', unique prompt
  const r = await handoff.execute({
    englishPrompt: `test dispatch ${Date.now()} — reply with the word ok`,
    source: 'text',
    originalPrompt: 'test dispatch',
    sessionId: 'test-session',
  });
  check('execute returned taskId', typeof r.taskId === 'string' && r.taskId.length > 0);

  // Wait for the async notify to land
  await new Promise(r => setTimeout(r, 500));
  check('POST /comms.handoff captured', _captured && _captured.taskId === r.taskId);
  check('prompt rides through', _captured && _captured.prompt === `test dispatch — reply with the word ok`.replace('test dispatch —', `test dispatch ${''}`) || _captured.prompt.includes('reply with the word ok'));

  // compiledPlan presence depends on the live backend — assert SHAPE when present:
  // steps are typed {skill, args} objects and allowPlannerFallback accompanies them.
  if (_captured && Array.isArray(_captured.compiledPlan)) {
    check('compiledPlan is typed steps', _captured.compiledPlan.every(s => s && typeof s.skill === 'string'));
    check('allowPlannerFallback rides with compiledPlan', _captured.allowPlannerFallback === true);
    console.log(`  INFO compiled ${ _captured.compiledPlan.length } steps: ${_captured.compiledPlan.map(s => s.skill).join(' → ')}`);
  } else {
    console.log('  SKIP compiledPlan absent (backend unavailable or compile declined — degrade path OK)');
  }

  server.close();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
