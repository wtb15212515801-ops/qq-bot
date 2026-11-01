import test from 'node:test';
import assert from 'node:assert';

import {
  emptyProfile,
  profileOf,
  observe,
  notesFrom,
  topKeywords,
  predictEngage,
  learn,
  describe,
} from '../src/profile.js';

const DAY = 86_400_000;

test('observe 更新说话风格', () => {
  const p = emptyProfile();
  for (let i = 0; i < 10; i += 1) {
    observe(p, { text: '哈哈哈笑死我了', isQuestion: false, now: 1_000_000 + i });
  }
  assert.ok(p.style.laugh > 0.4, String(p.style.laugh));
  assert.ok(p.style.short > 0.5, String(p.style.short));
});

test('observe 把常说的词记进关键词', () => {
  const p = emptyProfile();
  observe(p, { text: '原神今天抽卡', now: 1_000_000 });
  observe(p, { text: '原神又歪了', now: 1_000_001 });

  const kw = topKeywords(p, 3);
  assert.ok(kw.includes('原神'), kw.join(','));
});

test('关键词会随时间衰减', () => {
  const t = 10 * DAY;
  const p = emptyProfile();
  observe(p, { text: '原神原神原神', now: t });
  const before = p.kw['原神'];
  assert.ok(before > 0);

  // 30 天后又说话，先衰减旧词
  observe(p, { text: '今天吃饭', now: t + 30 * DAY });
  assert.ok(p.kw['原神'] === undefined || p.kw['原神'] < before, `${p.kw['原神']} vs ${before}`);
});

test('从「我喜欢…」里抽笔记，并去重', () => {
  const n1 = notesFrom('我喜欢喝美式');
  assert.deepEqual(n1.map((n) => n.text), ['喜欢喝美式']);

  const n2 = notesFrom('我不喜欢太吵的地方');
  assert.equal(n2[0].kind, 'dislike');

  const p = emptyProfile();
  observe(p, { text: '我喜欢喝美式', now: 1 });
  observe(p, { text: '我喜欢喝美式', now: 2 });
  assert.equal(p.notes.length, 1);
});

test('互动模型会从反馈里学习', () => {
  const p = emptyProfile();
  const input = { profile: p, affinity: 60, isQuestion: true, text: '在吗' };

  const before = predictEngage(p, input);
  for (let i = 0; i < 8; i += 1) learn(p, input, 1);
  const after = predictEngage(p, input);
  assert.ok(after > before, `${before} -> ${after}`);
  assert.equal(p.model.n, 8);
});

test('describe 生成可读的画像段落', () => {
  const p = emptyProfile();
  for (let i = 0; i < 8; i += 1) observe(p, { text: '哈哈哈 原神 原神', now: 1000 + i });

  const text = describe(p, { name: '张三', count: 12, affinity: 70 });
  assert.ok(text.includes('张三'));
  assert.ok(text.includes('聊过 12 次'));
  assert.ok(/爱用|说话/.test(text), text);
});

test('profileOf 给老用户补一份默认画像', () => {
  const user = { name: '李四', count: 3, affinity: 40 };
  const p = profileOf(user);
  assert.equal(p.style.short, 0.4);
  assert.equal(user.profile, p);
});
