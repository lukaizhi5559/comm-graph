'use strict';
/**
 * intent-guesser.test.cjs — the carried-hint vocabulary contract.
 *
 * The guesser runs on handoff and its `guessedIntent` becomes the stategraph's
 * `_carriedHint` prior — the last-resort fallback when the number-call flakes.
 * Stage-2 failures traced to missing coverage: providers returned safety-guard
 * JSON for classify calls, both attempts were unparseable, and the hint was
 * null or wrong (e.g. "when did I last mention my dentist appointment" hinted
 * general_knowledge). These cases pin the phrasings that must hint correctly,
 * and the phrasings that must NOT produce hints (ambiguous = honest null).
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { guess } = require('../src/intentGuesser.cjs');

const expect = (text, want) => {
  const r = guess(text);
  const got = r ? r.guessedIntent : null;
  assert.equal(got, want, `hint for ${JSON.stringify(text)}`);
};

describe('intentGuesser — screen_analysis hints', () => {
  it('covers the observed screen phrasings', () => {
    expect("what's on my screen right now", 'screen_analysis');
    expect('what app am I looking at', 'screen_analysis');
    expect('read the text visible on my screen', 'screen_analysis');
    expect('describe what I\u2019m looking at', 'screen_analysis');
    expect('is there an error dialog visible on my screen', 'screen_analysis');
    // Second-person sight + STT locatives (observed miss: "what do you see now"
    // hinted general_knowledge → no action-veto rescue → canned non-answer)
    expect('what do you see now', 'screen_analysis');
    expect('what are you seeing', 'screen_analysis');
    expect('can you see my screen', 'screen_analysis');
    expect('what this about on the screen', 'screen_analysis');
  });
  it('does not fire on imperative screen actions', () => {
    // "click the button on my screen" is automation, not observation
    assert.equal(guess('click the button on my screen').guessedIntent !== 'screen_analysis', true);
  });
});

describe('intentGuesser — memory_retrieve hints', () => {
  it('covers time-query recall phrasings', () => {
    expect('when did I last mention my dentist appointment', 'memory_retrieve');
    expect("when's the last time I told you my address", 'memory_retrieve');
    expect('have I told you my favorite color before', 'memory_retrieve');
    expect('did I mention my flight details', 'memory_retrieve');
  });
  it('covers activity-summary phrasings', () => {
    expect('summarize what I worked on recently', 'memory_retrieve');
    expect('recap what I did this week', 'memory_retrieve');
    expect('what was I doing yesterday afternoon', 'memory_retrieve');
    expect('what apps did I use this morning', 'memory_retrieve');
    expect('what did we talk about last week', 'memory_retrieve');
  });
});

describe('intentGuesser — web_search hints', () => {
  it('covers live-data and local lookups', () => {
    expect('latest news on spacex', 'web_search');
    expect('find me three highly rated ramen restaurants in San Francisco', 'web_search');
    expect('what are some good coffee shops in downtown Portland', 'web_search');
    expect("what's the current price of bitcoin", 'web_search');
  });
});

describe('intentGuesser — general_knowledge hints', () => {
  it('covers creative-writing phrasings', () => {
    expect('write a haiku about debugging', 'general_knowledge');
    expect('tell me a joke', 'general_knowledge');
    expect('compose a limerick about mondays', 'general_knowledge');
  });
  it('covers timeless explanations', () => {
    expect('what is the capital of france', 'general_knowledge');
    // "difference between X and Y" is claimed by web_search's comparison rule —
    // a defensible route (search adds grounded examples), pinned to document it.
    expect('explain the difference between TCP and UDP', 'web_search');
  });
});

describe('intentGuesser — boundary cases', () => {
  it('messaging still wins over creative writing (checked earlier)', () => {
    expect('write an email to my boss about the report', 'command_automate');
    expect('share this on twitter', 'command_automate');
  });
  it('recall beats named-app+verb', () => {
    expect('what was I watching on Netflix last night', 'memory_retrieve');
  });
});
