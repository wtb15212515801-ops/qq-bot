import test from 'node:test';
import assert from 'node:assert';

import { designLines, designExamples } from '../src/design.js';
import { buildSystemPrompt } from '../src/context.js';

test('结构化设计会进入 system prompt', () => {
  const sys = buildSystemPrompt({
    persona: { name: '小满', text: '你是小满。' },
    design: {
      tagline: '嘴硬心软',
      style: { length: 'short', tone: 'edgy', emoji: 0, catchphrases: ['啊这'], taboo: ['政治'] },
      examples: [{ u: '在吗', b: '在' }],
    },
  });

  assert.ok(sys.includes('## 说话方式（按这个来）'));
  assert.ok(sys.includes('15 字'));
  assert.ok(sys.includes('群友：在吗'));
  assert.ok(sys.includes('你：在'));
});


test('designLines 把结构化设计变成 prompt 行', () => {
  const lines = designLines({
    tagline: '群里嘴硬心软的小家伙',
    style: {
      length: 'short',
      tone: 'edgy',
      emoji: 1,
      catchphrases: ['啊这', '确实'],
      taboo: ['政治'],
    },
  });

  const text = lines.join('\n');
  assert.ok(text.includes('嘴硬心软'));
  assert.ok(text.includes('15 字'));
  assert.ok(text.includes('毒舌'));
  assert.ok(text.includes('偶尔'));
  assert.ok(text.includes('啊这'));
  assert.ok(text.includes('政治'));
});

test('designLines 没有设计时返回空数组', () => {
  assert.deepEqual(designLines(null), []);
  assert.deepEqual(designLines({}), []);
});

test('designExamples 过滤空项并限流', () => {
  const list = designExamples({
    examples: [
      { u: '在吗', b: '在' },
      { u: '', b: '' },
      { u: '吃了吗', b: '吃了' },
    ],
  });
  assert.equal(list.length, 2);
});
