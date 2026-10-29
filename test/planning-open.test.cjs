'use strict';
/**
 * planning-open.test.cjs — plan binding / reopen semantics regressions
 *
 * Observed failure (2026-10-29): "can you pull up the plan regarding micro
 * frontend" — the model emitted an invented <plan_open>plan_id</plan_open>
 * tag that leaked verbatim into the reply; the session kept a brand-new
 * empty 'drafting' stub while claiming the saved plan was reopened; and
 * opening a fully-done plan flipped it to 'ready' so a run card showed
 * "queued" over nothing-to-run tasks.
 *
 * Fixes under test:
 *   - _stripMarkers drops every plan_* tag variant (paired, self-closing,
 *     unclosed tail) — sanitization catch-all for invented markers.
 *   - _openPlanForSession returns alreadyComplete for all-done plans and
 *     does NOT rewrite their status to ready.
 *   - _neutralizeStubDraft cancels a taskless drafting stub left behind when
 *     a saved plan binds the session.
 *   - _writePlanFile preserves frontmatter it doesn't own (skill_plan_json,
 *     slots_json, auth_bypass, created) on a saved plan rewrite.
 *
 * THINKDROP_PLANS_DIR is pointed at a temp dir so ~/.thinkdrop/plans is
 * untouched.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'thinkdrop-plans-'));
process.env.THINKDROP_PLANS_DIR = tmpDir;

const {
  _stripMarkers, _openPlanForSession, _neutralizeStubDraft, _describeOpenedPlan, _writePlanFile,
} = require('../src/nodes/planning.cjs');

let tests = 0, passed = 0;
function check(name, cond, extra = '') {
  tests++;
  if (cond) { passed++; console.log(`  PASS: ${name}`); }
  else { console.error(`  FAIL: ${name}${extra ? ' — ' + extra : ''}`); }
}

const DONE_PLAN = `---
id: plan_test_done
created: 2026-10-28T21:21:24.301Z
kind: task_plan
status: done
original_prompt: "could we do that with angular and react"
plan_session_id: sess_old
auth_bypass: []
refs: []
skill_plan_json: 'W3sic2tpbGwiOiJ3ZWIuYWdlbnQifV0='
slots_json: 'eyJmaWxlUGF0aHMiOlsiLi9hIl19'
---
# Plan: Micro frontend plan

Research and scaffold.

## Tasks

## Task 1 — Research patterns
- **Prompt**: research micro frontend patterns
- **Agents**: web.agent
- **Depends on**: —
- **Mode**: sequential
- **Auth**: unknown
- **Status**: ✅ done
- **Result**: found the guide

## Task 2 — Scaffold
- **Prompt**: scaffold workspace
- **Agents**: shell.run
- **Depends on**: Task 1
- **Mode**: sequential
- **Auth**: unknown
- **Approval**: required
- **Status**: ✅ done
- **Result**: workspace created

## Risks
`;

const FAILED_PLAN = `---
id: plan_test_failed
created: 2026-10-28T22:00:00.000Z
kind: task_plan
status: failed
original_prompt: "ship it"
plan_session_id: sess_old
auth_bypass: []
refs: []
---
# Plan: Failed plan

## Tasks

## Task 1 — First
- **Prompt**: do first
- **Agents**: —
- **Depends on**: —
- **Mode**: sequential
- **Auth**: unknown
- **Status**: ✅ done
- **Result**: ok

## Task 2 — Second
- **Prompt**: do second
- **Agents**: —
- **Depends on**: Task 1
- **Mode**: sequential
- **Auth**: unknown
- **Status**: ✗ failed
- **Result**: blew up

## Risks
`;

const STUB_PLAN = `---
id: plan_test_stub
created: 2026-10-28T23:00:00.000Z
kind: task_plan
status: drafting
original_prompt: "can you pull up the plan regarding micro frontend"
plan_session_id: sess_live
auth_bypass: []
refs: []
---
# Plan: Can You Pull Up

## Tasks

## Risks
`;

function writePlan(name, content) {
  fs.writeFileSync(path.join(tmpDir, name + '.md'), content, 'utf8');
}
function readPlan(name) {
  return fs.readFileSync(path.join(tmpDir, name + '.md'), 'utf8');
}

(async () => {
  console.log('\nplanning open/reopen regression tests');

  // ── _stripMarkers — invented plan_* tags never reach the user ────────────
  const leaked = _stripMarkers('Found it! <plan_open>plan_test_done</plan_open> Here is your plan.');
  check('paired <plan_open> stripped from reply', !/<plan_open|plan_test_done/.test(leaked) && /Found it/.test(leaked));

  const invented = _stripMarkers('a <plan_ready/> b <plan_foo>x</plan_foo> c');
  check('invented self-closing + paired plan_* variants stripped',
    !/plan_ready|plan_foo/.test(invented) && /\ba\b/.test(invented) && /\bc\b/.test(invented));

  const unclosed = _stripMarkers('intro <plan_open>plan_test_done and everything after is marker payload');
  check('unclosed <plan_open> swallows tail (payload is markup, not prose)',
    unclosed === 'intro');

  const real = _stripMarkers('say <plan_run/> <plan_exit/> done');
  check('known markers still stripped', !/plan_run|plan_exit/.test(real));

  const prose = _stripMarkers('the plan_is_underscored word and <div>html</div> survive');
  check('plain underscores + non-plan markup untouched',
    /plan_is_underscored/.test(prose) && /<div>/.test(prose));

  // ── _openPlanForSession — all-done plan stays done ───────────────────────
  writePlan('plan_test_done', DONE_PLAN);
  const doneRes = _openPlanForSession('plan_test_done', 'sess_new');
  check('all-done plan → alreadyComplete:true', doneRes.alreadyComplete === true);
  check('all-done plan → reopened:false', doneRes.reopened === false);
  check('all-done plan file NOT rewritten to ready', /status: done/.test(readPlan('plan_test_done')));
  check('all-done plan tasks stay done', !/⬜ pending/i.test(readPlan('plan_test_done')));

  const doneText = _describeOpenedPlan(doneRes);
  check('describe says ALREADY COMPLETE', /ALREADY COMPLETE/.test(doneText));
  check('describe carries no REOPENED/pending-work implication', !/REOPENED|status=ready/.test(doneText));

  // ── _openPlanForSession — failed plan reopens properly ───────────────────
  writePlan('plan_test_failed', FAILED_PLAN);
  const failRes = _openPlanForSession('plan_test_failed', 'sess_new');
  check('failed plan → reopened:true', failRes.reopened === true);
  check('failed plan → alreadyComplete falsy', !failRes.alreadyComplete);
  const failedContent = readPlan('plan_test_failed');
  check('failed plan file rewritten to ready', /status: ready/.test(failedContent));
  check('failed task reset to pending', /Task 2[\s\S]*?⬜ pending/.test(failedContent));
  check('done task stays done', /Task 1[\s\S]*?✅ done/.test(failedContent));

  // ── _neutralizeStubDraft — taskless stub cancelled ───────────────────────
  writePlan('plan_test_stub', STUB_PLAN);
  const stubSess = _openPlanForSession('plan_test_stub', 'sess_live').sess;
  assert(stubSess, 'stub plan must load');
  _neutralizeStubDraft(stubSess);
  check('empty drafting stub → cancelled on disk', /status: cancelled/.test(readPlan('plan_test_stub')));

  // A drafting plan WITH tasks is never neutralized.
  writePlan('plan_test_stub2', STUB_PLAN.replace('plan_test_stub', 'plan_test_stub2')
    .replace('## Tasks\n', '## Tasks\n\n## Task 1 — X\n- **Prompt**: x\n- **Status**: ⏳ pending\n'));
  const withTasks = _openPlanForSession('plan_test_stub2', 'sess_live').sess;
  _neutralizeStubDraft(withTasks);
  check('drafting plan with tasks is NOT neutralized', /status: drafting/.test(readPlan('plan_test_stub2')));

  // ── _writePlanFile — frontmatter the writer doesn't own survives ─────────
  writePlan('plan_test_done', DONE_PLAN); // restore (open above may not have rewritten, but be explicit)
  const bound = _openPlanForSession('plan_test_done', 'sess_new').sess;
  bound.description = 'edited description'; // force a write-worthy change
  _writePlanFile(bound);
  const rewritten = readPlan('plan_test_done');
  check('skill_plan_json survives rewrite', /skill_plan_json:/.test(rewritten));
  check('slots_json survives rewrite', /slots_json:/.test(rewritten));
  check('original created timestamp survives rewrite', /created: 2026-10-28T21:21:24.301Z/.test(rewritten));
  check('plan status stays done after rewrite', /status: done/.test(rewritten));

  console.log(`\n${passed}/${tests} passed`);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  process.exit(passed === tests ? 0 : 1);
})().catch(e => { console.error(e); fs.rmSync(tmpDir, { recursive: true, force: true }); process.exit(1); });
