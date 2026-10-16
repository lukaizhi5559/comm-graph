'use strict';
/**
 * route-decision.test.cjs — the single RouteDecision envelope contract
 *
 * One classification per prompt, produced at comms-graph ingress, consumed
 * downstream by the stategraph. Covered here:
 *
 *   - deriveLane: a 'query' taskType with a chat/memory suggestedIntent
 *     demotes to the right quick lane; any action/screen/service signal
 *     keeps the handoff lane (a wrong demotion — a task answered as chat —
 *     is worse than a question sent to the graph).
 *   - canSkipCapabilityGate: service-named taskTypes or an explicit
 *     targetService keep the gate; everything else skips it on structure —
 *     the regex bypass family (LOCAL_FS_RE etc.) is no longer load-bearing.
 *   - serializeDecision: the envelope crossing /comms.handoff is JSON-safe
 *     (no live promise fields).
 */
const assert = require('assert');
const { deriveLane, canSkipCapabilityGate, serializeDecision, LANE_BY_INTENT } = require('../src/route-decision.cjs');

let tests = 0, passed = 0;
function check(name, cond) { tests++; if (cond) { passed++; console.log(`  PASS: ${name}`); } else { console.error(`  FAIL: ${name}`); } }

console.log('\nroute-decision tests');

// ── deriveLane — demotion conditions ─────────────────────────────────────
check('local_file taskType stays handoff',
  deriveLane({ taskType: 'local_file' }) === 'handoff');
check('messaging taskType stays handoff',
  deriveLane({ taskType: 'messaging', suggestedIntent: 'command_automate' }) === 'handoff');
check('browser taskType stays handoff',
  deriveLane({ taskType: 'browser', suggestedIntent: 'web_search' }) === 'handoff');
check('query + general_knowledge → general_quick',
  deriveLane({ taskType: 'query', suggestedIntent: 'general_knowledge' }) === 'general_quick');
check('query + greeting → general_quick',
  deriveLane({ taskType: 'query', suggestedIntent: 'greeting' }) === 'general_quick');
check('query + memory_store → memory_store',
  deriveLane({ taskType: 'query', suggestedIntent: 'memory_store' }) === 'memory_store');
check('query + memory_retrieve (not follow-up) → memory_quick',
  deriveLane({ taskType: 'query', suggestedIntent: 'memory_retrieve', isFollowUp: false }) === 'memory_quick');
check('query + memory_retrieve follow-up stays handoff (needs graph context)',
  deriveLane({ taskType: 'query', suggestedIntent: 'memory_retrieve', isFollowUp: true }) === 'handoff');
check('query + command_automate stays handoff',
  deriveLane({ taskType: 'query', suggestedIntent: 'command_automate' }) === 'handoff');
check('query + screen flag stays handoff',
  deriveLane({ taskType: 'query', suggestedIntent: 'general_knowledge', isScreenFollowUp: true }) === 'handoff');
check('query + requiresDOM stays handoff',
  deriveLane({ taskType: 'query', suggestedIntent: 'general_knowledge', requiresDOM: true }) === 'handoff');
check('query + recurring stays handoff',
  deriveLane({ taskType: 'query', suggestedIntent: 'general_knowledge', isRecurring: true }) === 'handoff');
check('query + targetService stays handoff',
  deriveLane({ taskType: 'query', suggestedIntent: 'general_knowledge', targetService: 'slack' }) === 'handoff');
check('ambiguous stays handoff',
  deriveLane({ taskType: 'ambiguous' }) === 'handoff');
check('null envelope stays handoff',
  deriveLane(null) === 'handoff');

// ── lane → intent-number bridge ──────────────────────────────────────────
check('general_quick maps to intent 1', LANE_BY_INTENT.general_quick === 1);
check('memory_quick maps to intent 2', LANE_BY_INTENT.memory_quick === 2);
check('memory_store maps to intent 5', LANE_BY_INTENT.memory_store === 5);
check('handoff maps to intent 0', LANE_BY_INTENT.handoff === 0);

// ── canSkipCapabilityGate — structure over regex ─────────────────────────
check('local_file skips the gate', canSkipCapabilityGate({ taskType: 'local_file' }) === true);
check('local_system skips the gate', canSkipCapabilityGate({ taskType: 'local_system' }) === true);
check('plain query skips the gate', canSkipCapabilityGate({ taskType: 'query' }) === true);
check('ambiguous-without-service skips the gate', canSkipCapabilityGate({ taskType: 'ambiguous' }) === true);
check('messaging keeps the gate', canSkipCapabilityGate({ taskType: 'messaging' }) === false);
check('browser keeps the gate', canSkipCapabilityGate({ taskType: 'browser' }) === false);
check('scheduling keeps the gate', canSkipCapabilityGate({ taskType: 'scheduling' }) === false);
check('app_automation keeps the gate', canSkipCapabilityGate({ taskType: 'app_automation' }) === false);
check('query + targetService keeps the gate', canSkipCapabilityGate({ taskType: 'query', targetService: 'slack' }) === false);
check('no envelope → gate still runs (fail open to old behavior)', canSkipCapabilityGate(null) === false);

// ── serializeDecision — HTTP-safe envelope ───────────────────────────────
const seeded = serializeDecision({ taskType: 'local_file', lane: 'handoff', _detPrefirePromise: Promise.resolve(null), resolution: 'resolved' });
check('serializeDecision strips _detPrefirePromise', seeded._detPrefirePromise === undefined);
check('serializeDecision keeps taskType + lane', seeded.taskType === 'local_file' && seeded.lane === 'handoff');
check('serializeDecision JSON round-trips', JSON.parse(JSON.stringify(seeded)).taskType === 'local_file');
check('serializeDecision(null) → null', serializeDecision(null) === null);

console.log(`\n${passed}/${tests} passed`);
process.exit(passed === tests ? 0 : 1);
