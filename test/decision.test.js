import test from 'node:test';
import assert from 'node:assert';
import { evaluateDecision, isQuestion, containsAlias } from '../src/decision.js';

const persona = { aliases: ['小满', '小满'], interests: ['薯片', '糊糊'] };
const behavior = { replyThreshold: 8.5, spontaneousChance: 0, spontaneousCooldownSec: 180 };
const state = { lastSpokeAt: 0 };

const base = { text: '', atSelf: false, replyToSelf: false };

test('被@一定回', () => {
  const d = evaluateDecision({
    event: { ...base, text: '早' },
    state,
    persona,
    behavior,
    now: 10_000_000,
  });
  // 没被 @ 时不该因为这个回
  assert.ok(d.score < 8.5);

  const d2 = evaluateDecision({
    event: { ...base, atSelf: true, text: '早' },
    state,
    persona,
    behavior,
    now: 10_000_000,
  });
  assert.ok(d2.shouldReply, `分数 ${d2.score}`);
  assert.ok(d2.reasons.includes('被@'));
});

test('提到名字会加分', () => {
  const d = evaluateDecision({
    event: { ...base, text: '小满你在干嘛' },
    state,
    persona,
    behavior,
    now: 10_000_000,
  });
  assert.ok(d.reasons.includes('提到我'));
});

test('聊到薯片会加分', () => {
  const d = evaluateDecision({
    event: { ...base, text: '我想吃薯片' },
    state,
    persona,
    behavior,
    now: 10_000_000,
  });
  assert.ok(d.reasons.some((r) => r.startsWith('话题:')), d.reasons.join(','));
});

test('刚说完被夸会接话', () => {
  const d = evaluateDecision({
    event: { ...base, text: '好可爱' },
    state: { lastSpokeAt: 10_000_000 - 5_000 },
    persona,
    behavior,
    now: 10_000_000,
  });
  assert.ok(d.reasons.includes('在夸我'));
});

test('普通闲聊不回', () => {
  const d = evaluateDecision({
    event: { ...base, text: '今天上班好累' },
    state: { lastSpokeAt: 0 },
    persona,
    behavior,
    now: 10_000_000,
  });
  assert.equal(d.shouldReply, false);
});

test('isQuestion 识别问句', () => {
  assert.equal(isQuestion('今天几号？'), true);
  assert.equal(isQuestion('明天去哪'), true);
  assert.equal(isQuestion('好的'), false);
  assert.equal(isQuestion('啊'.repeat(200)), false, '太长的句子不当问句');
});

test('containsAlias 大小写和空值安全', () => {
  assert.equal(containsAlias('小满 在吗', persona.aliases), true);
  assert.equal(containsAlias('', persona.aliases), false);
  assert.equal(containsAlias(null, persona.aliases), false);
});
