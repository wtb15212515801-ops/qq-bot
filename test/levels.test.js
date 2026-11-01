import test from 'node:test';
import assert from 'node:assert';
import { evaluateDecision } from '../src/decision.js';
import { LEVELS, LEVEL_ORDER, applyLevel } from '../src/presets.js';
import { DEFAULTS } from '../src/config.js';

const persona = { aliases: ['小满', '小满'], interests: ['薯片', '糊糊'] };

function behaviorOf(level) {
  const base = applyLevel(DEFAULTS, level);
  return base.behavior;
}

function rate(level, event, { state = { lastSpokeAt: 0 }, trials = 300 } = {}) {
  const behavior = behaviorOf(level);
  const now = 10_000_000;
  let hit = 0;
  for (let i = 0; i < trials; i += 1) {
    const d = evaluateDecision({
      event: { replyToSelf: false, ...event },
      state,
      persona,
      behavior,
      now,
    });
    if (d.shouldReply) hit += 1;
  }
  return hit / trials;
}

test('任何档位下，被 @ 一定回', () => {
  for (const lv of LEVEL_ORDER) {
    assert.equal(rate(lv, { text: '在吗', atSelf: true }), 1, `${lv} 档漏了 @`);
  }
});

test('任何档位下，叫名字一定回', () => {
  for (const lv of LEVEL_ORDER) {
    const r = rate(lv, { text: '小满你在干嘛', atSelf: false });
    assert.equal(r, 1, `${lv} 档叫名字却不回（实际 ${r}）`);
  }
});

test('档位越高，普通问句接话率越高', () => {
  const rates = LEVEL_ORDER.map((lv) => rate(lv, { text: '明天去哪吃饭', atSelf: false }));
  for (let i = 1; i < rates.length; i += 1) {
    assert.ok(
      rates[i] >= rates[i - 1],
      `${LEVEL_ORDER[i]}(${rates[i]}) 不该低于 ${LEVEL_ORDER[i - 1]}(${rates[i - 1]})`
    );
  }
  assert.ok(rates[0] < 0.1, `冷淡档不该乱答问题，实际 ${rates[0]}`);
  assert.ok(rates.at(-1) > 0.95, `话痨档应该几乎有问必答，实际 ${rates.at(-1)}`);
});

test('档位越高，普通闲聊接话率越高', () => {
  const rates = LEVEL_ORDER.map((lv) => rate(lv, { text: '今天上班好累', atSelf: false }));
  for (let i = 1; i < rates.length; i += 1) {
    assert.ok(rates[i] >= rates[i - 1], `${LEVEL_ORDER[i]} 应该不低于上一档`);
  }
  assert.ok(rates.at(-1) - rates[0] > 0.4, `话痨和冷淡要有明显差距，实际 ${rates}`);
});

test('冷淡档不该乱插话', () => {
  const r = rate('quiet', { text: '今天上班好累', atSelf: false });
  assert.ok(r < 0.1, `冷淡档不该接普通闲聊，实际 ${r}`);
});

test('聊到兴趣话题时，正常档明显更容易接', () => {
  const interest = rate('normal', { text: '我想吃薯片', atSelf: false });
  const plain = rate('normal', { text: '我想买手机', atSelf: false });
  assert.ok(interest > plain + 0.3, `兴趣 ${interest} 应该远高于普通 ${plain}`);
});

test('刚说完被夸，正常档会接住', () => {
  const r = rate(
    'normal',
    { text: '好可爱', atSelf: false },
    { state: { lastSpokeAt: 10_000_000 - 5_000 } }
  );
  assert.ok(r > 0.9, `实际 ${r}`);
});

test('阈值随档位单调递减', () => {
  const t = LEVEL_ORDER.map((lv) => LEVELS[lv].behavior.replyThreshold);
  for (let i = 1; i < t.length; i += 1) assert.ok(t[i] < t[i - 1]);
});
