import test from 'node:test';
import assert from 'node:assert';

import { retrieve } from '../src/retrieval.js';
import { pickRelevantFacts } from '../src/cognition.js';

const DAY = 86_400_000;

test('不相关就一条都不给（不会再回退前 N 条）', () => {
  const facts = ['张三在准备考公', '李四的猫叫团子', '王五上周去爬山'];
  const out = retrieve({ facts, query: '今天好热啊' });
  assert.deepEqual(out.facts, []);
});

test('事实数量少于上限时也要按相关性过滤（旧 bug 回归）', () => {
  const facts = ['张三在准备考公', '李四的猫叫团子'];
  const out = retrieve({ facts, query: '考公好难', limitFacts: 8 });
  assert.deepEqual(out.facts, ['张三在准备考公']);
});

test('多条相关时只给最相关的那条（IDF 加权）', () => {
  const facts = ['张三最近很忙', '张三在准备考公'];
  const out = retrieve({ facts, query: '张三 考公', limitFacts: 1 });
  assert.deepEqual(out.facts, ['张三在准备考公']);
});

test('几乎重复的事实会去重', () => {
  const facts = ['张三在准备考公', '张三在准备考公。', '李四的猫叫团子'];
  const out = retrieve({ facts, query: '考公' });
  assert.equal(out.facts.length, 1);
});

test('事件也按相关度挑，不相关的旧事件不塞', () => {
  const now = 1_800_000_000_000;
  const events = [
    { text: '张三约大家周五开黑', at: now - DAY },
    { text: '李四昨天生日', at: now - 30 * DAY },
  ];
  const out = retrieve({ events, facts: ['张三在准备考公'], query: '周五开黑吗', now });
  assert.deepEqual(out.events.map((e) => e.text), ['张三约大家周五开黑']);
});

test('pickRelevantFacts 兼容旧接口，内部同样过滤', () => {
  const facts = Array.from({ length: 10 }, (_, i) => `无关的记忆第${i}条`);
  assert.deepEqual(pickRelevantFacts(facts, '今天天气不错'), []);
});

test('空查询或空记忆不报错', () => {
  assert.deepEqual(retrieve({ facts: [], events: [], query: '考公' }), { facts: [], events: [] });
  assert.deepEqual(retrieve({ facts: ['张三在准备考公'], query: '' }), { facts: [], events: [] });
});
