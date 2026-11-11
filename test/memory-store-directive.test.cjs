'use strict';

/**
 * memory-store-directive.test.cjs — boundary phrasing must use the same
 * deterministic memory_store predicate at comms ingress and route-envelope
 * classification.
 */

const assert = require('assert');
const { classify } = require('../src/classify.cjs');
const { classifyTask } = require('../../stategraph-module/src/utils/classifyTask.js');

const logger = { info() {}, warn() {}, debug() {}, error() {} };
const storePrompts = [
  'remember my dentist appointment is friday',
  'keep in mind that I prefer morning meetings',
  'dont forget my anniversary is june 12',
  'save this for later: the wifi password is hunter2',
  'note that my gate code is 4471',
  'remember I am allergic to peanuts',
];

(async () => {
  for (const prompt of storePrompts) {
    const comms = await classify(prompt);
    assert.strictEqual(comms.intentName, 'memory_store', `comms route for: ${prompt}`);

    let called = false;
    const task = await classifyTask(
      prompt,
      [],
      { generateAnswer: async () => { called = true; throw new Error('unexpected LLM call'); } },
      logger,
    );
    assert.strictEqual(task.suggestedIntent, 'memory_store', `envelope route for: ${prompt}`);
    assert.strictEqual(task.taskType, 'query', `memory-store taskType for: ${prompt}`);
    assert.strictEqual(called, false, `deterministic route must skip LLM for: ${prompt}`);
  }

  for (const prompt of ['remember what I asked yesterday', 'remember to call Jake']) {
    const task = await classifyTask(
      prompt,
      [],
      { generateAnswer: async () => '{"taskType":"query","isFollowUp":false,"suggestedIntent":"general_knowledge"}' },
      logger,
    );
    assert.notStrictEqual(task.suggestedIntent, 'memory_store', `not a store: ${prompt}`);
  }

  console.log(`memory-store directive tests: ${storePrompts.length * 3 + 2} passed`);
})().catch((err) => {
  console.error(err.stack || err);
  process.exit(1);
});
