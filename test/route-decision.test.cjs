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
  deriveLane({ taskType: 'browser', suggestedIntent: 'command_automate' }) === 'handoff');
// Public-research shape — browser only in name (routeTable's public-research
// rule): context-free SERP lookups ride the express executor instead of
// page_nav_scan browser automation (observed: highlight + "tell me about
// smoothstack… search online" → handoff → google.com nav takeover).
check('browser + public_read + no service → web_search',
  deriveLane({ taskType: 'browser', webAccessMode: 'public_read' }) === 'web_search');
check('browser + public_read + targetService stays handoff',
  deriveLane({ taskType: 'browser', webAccessMode: 'public_read', targetService: 'gmail' }) === 'handoff');
check('browser + public_read + requiresDOM stays handoff',
  deriveLane({ taskType: 'browser', webAccessMode: 'public_read', requiresDOM: true }) === 'handoff');
check('browser + public_read + interactiveActions stays handoff',
  deriveLane({ taskType: 'browser', webAccessMode: 'public_read', interactiveActions: ['click'] }) === 'handoff');
check('browser + public_read + isFollowUp stays handoff',
  deriveLane({ taskType: 'browser', webAccessMode: 'public_read', isFollowUp: true, followUpTarget: 'X' }) === 'handoff');
check('browser + public_read + isBrowseOnly stays handoff (nav task)',
  deriveLane({ taskType: 'browser', webAccessMode: 'public_read', isBrowseOnly: true }) === 'handoff');
check('browser + interactive webAccessMode stays handoff',
  deriveLane({ taskType: 'browser', webAccessMode: 'interactive' }) === 'handoff');
check('browser + public_read + unresolved resolution stays handoff',
  deriveLane({ taskType: 'browser', webAccessMode: 'public_read', resolution: 'needs_clarification' }) === 'handoff');
check('browser + suggestedIntent web_search (no webAccessMode) → web_search',
  deriveLane({ taskType: 'browser', suggestedIntent: 'web_search', webAccessMode: null }) === 'web_search');
check('browser + suggestedIntent web_search + targetService stays handoff',
  deriveLane({ taskType: 'browser', suggestedIntent: 'web_search', targetService: 'youtube' }) === 'handoff');
check('query + general_knowledge → general_quick',
  deriveLane({ taskType: 'query', suggestedIntent: 'general_knowledge' }) === 'general_quick');
check('query + greeting → general_quick',
  deriveLane({ taskType: 'query', suggestedIntent: 'greeting' }) === 'general_quick');
check('query + memory_store → memory_store',
  deriveLane({ taskType: 'query', suggestedIntent: 'memory_store' }) === 'memory_store');
check('query + memory_retrieve (not follow-up) → handoff (memory_quick removed)',
  deriveLane({ taskType: 'query', suggestedIntent: 'memory_retrieve', isFollowUp: false }) === 'handoff');
check('query + memory_retrieve follow-up stays handoff (needs graph context)',
  deriveLane({ taskType: 'query', suggestedIntent: 'memory_retrieve', isFollowUp: true }) === 'handoff');
check('query + web_search demotes to express executor',
  deriveLane({ taskType: 'query', suggestedIntent: 'web_search', isFollowUp: false }) === 'web_search');
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
check('web_search maps to intent 8', LANE_BY_INTENT.web_search === 8);
check('memory_quick removed from LANE_BY_INTENT', LANE_BY_INTENT.memory_quick === undefined);
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
