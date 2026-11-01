import test from 'node:test';
import assert from 'node:assert';
import { splitReply } from '../src/humanize.js';

const timing = {
  maxCharsPerSegment: 10,
  maxSegments: 3,
  readDelayMs: [0, 0],
  typingMsPerChar: [0, 0],
  typingMaxMs: 0,
  gapBetweenSegmentsMs: [0, 0],
};

test('空输入返回空数组', () => {
  assert.deepEqual(splitReply('', timing), []);
  assert.deepEqual(splitReply('   ', timing), []);
});

test('短句不拆', () => {
  assert.deepEqual(splitReply('好耶', timing), ['好耶']);
});

test('段数不超过 maxSegments', () => {
  const long = '一'.repeat(100);
  const parts = splitReply(long, timing);
  assert.ok(parts.length <= 3, `实际 ${parts.length} 段`);
  assert.equal(parts.join('').length, 100, '内容不能丢');
});

test('优先在标点处切', () => {
  const parts = splitReply('今天好热，我们去吃薯片吧', { ...timing, maxCharsPerSegment: 6, maxSegments: 5 });
  assert.ok(parts[0].endsWith('，') || parts[0].length <= 6);
});

test('不会把 emoji 切成半个', () => {
  const parts = splitReply('😀😀😀😀😀😀😀😀你好呀', { ...timing, maxCharsPerSegment: 6, maxSegments: 5 });
  const broken = parts.some((p) => /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(p));
  assert.equal(broken, false);
});
