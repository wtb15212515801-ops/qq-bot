import test from 'node:test';
import assert from 'node:assert';
import { RateLimiter } from '../src/ratelimit.js';
import { flattenSegments, toSegments, formatClock } from '../src/message.js';

test('冷却时间内拦住', () => {
  const l = new RateLimiter({ minGapSeconds: 10, maxPerMinute: 5, maxPerHour: 20 });
  const t = 1_000_000;
  l.commit('g1', t);
  assert.equal(l.check('g1', t + 5_000).ok, false);
  assert.equal(l.check('g1', t + 11_000).ok, true);
});

test('每分钟上限', () => {
  const l = new RateLimiter({ minGapSeconds: 0, maxPerMinute: 2, maxPerHour: 100 });
  const t = 1_000_000;
  l.commit('g1', t);
  l.commit('g1', t + 100);
  assert.equal(l.check('g1', t + 200).reason, '每分钟上限');
  assert.equal(l.check('g1', t + 61_000).ok, true);
});

test('每小时上限', () => {
  const l = new RateLimiter({ minGapSeconds: 0, maxPerMinute: 100, maxPerHour: 2 });
  const t = 1_000_000;
  l.commit('g1', t);
  l.commit('g1', t + 1000);
  assert.equal(l.check('g1', t + 2000).reason, '每小时上限');
  assert.equal(l.check('g1', t + 3_600_001).ok, true);
});

test('不同会话互不影响', () => {
  const l = new RateLimiter({ minGapSeconds: 10, maxPerMinute: 1, maxPerHour: 5 });
  const t = 1_000_000;
  l.commit('g1', t);
  assert.equal(l.check('g2', t).ok, true);
});

test('prune 清理长期没动静的会话', () => {
  const l = new RateLimiter();
  const t = 1_000_000;
  l.commit('g1', t);
  l.commit('g2', t);
  assert.equal(l.windows.size, 2);
  assert.equal(l.prune(t + 7_200_000), 2);
  assert.equal(l.windows.size, 0);
});

test('flattenSegments 处理 @ / 图片 / 引用', () => {
  const out = flattenSegments(
    [
      { type: 'at', data: { qq: '123456789' } },
      { type: 'text', data: { text: ' 看图' } },
      { type: 'image', data: { url: 'http://x/1.png' } },
      { type: 'reply', data: { id: 42 } },
      { type: 'face', data: { id: 1 } },
    ],
    { selfId: 123456789, resolveName: () => '小满' }
  );

  assert.equal(out.atSelf, true);
  assert.equal(out.hasImage, true);
  assert.deepEqual(out.images, ['http://x/1.png']);
  assert.equal(out.replyId, '42');
  assert.match(out.text, /@小满/);
  assert.match(out.text, /\[图片\]/);
  assert.match(out.text, /\[表情\]/);
});

test('@全体成员 不算 @ 自己', () => {
  const out = flattenSegments([{ type: 'at', data: { qq: 'all' } }], { selfId: 123 });
  assert.equal(out.atSelf, false);
  assert.match(out.text, /@全体成员/);
});

test('字符串消息直接当文本', () => {
  const out = flattenSegments('在吗', { selfId: 1 });
  assert.equal(out.text, '在吗');
  assert.equal(out.hasImage, false);
});

test('空/异常段不会崩', () => {
  assert.equal(flattenSegments(null).text, '');
  assert.equal(flattenSegments(undefined).text, '');
  assert.equal(flattenSegments([{ type: 'unknown_thing' }]).text, '[unknown_thing]');
});

test('未知段类型有占位符，不会丢信息', () => {
  const out = flattenSegments([{ type: 'video', data: {} }, { type: 'record', data: {} }], {});
  assert.match(out.text, /\[视频\]/);
  assert.match(out.text, /\[语音\]/);
});

test('toSegments 生成合法消息段', () => {
  assert.deepEqual(toSegments('早'), [{ type: 'text', data: { text: '早' } }]);
});

test('formatClock 补零', () => {
  const d = new Date(2026, 0, 1, 9, 5);
  assert.equal(formatClock(d.getTime()), '09:05');
});
