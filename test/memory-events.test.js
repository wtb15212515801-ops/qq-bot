import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Store } from '../src/memory.js';
import { Brain } from '../src/brain.js';

const silent = { info() {}, warn() {}, error() {}, debug() {} };
const cfg = { memory: { maxFacts: 5, forgetDays: 14, maxUsers: 200, maxGroups: 120 } };
const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'memev-')), 'memory.json');
const DAY = 86_400_000;

function makeBrain() {
  const store = new Store(tmp(), silent).load();
  return { store, brain: new Brain({ cfg, llm: null, store, logger: silent }) };
}

test('事件记忆兼容旧字符串，并保留时间', () => {
  const { store, brain } = makeBrain();
  const g = store.group('g1');
  g.events = ['张三约大家周五开黑', { text: '李四昨天生日', at: 123 }];

  const list = brain._events(g);
  assert.deepEqual(list.map((e) => e.text), ['张三约大家周五开黑', '李四昨天生日']);
  assert.equal(list[1].at, 123);
});

test('forget 会清掉过期事件，保留新事件', () => {
  const { store, brain } = makeBrain();
  const g = store.group('g1');
  const now = Date.now();
  g.events = [
    { text: '很久以前发生的事', at: now - 30 * DAY },
    { text: '昨天发生的事', at: now - DAY },
  ];

  const r = brain.forget(now);
  assert.equal(r.events, 1);
  assert.deepEqual(g.events.map((e) => e.text), ['昨天发生的事']);
});

test('tidy 合并相似事件并限制条数', () => {
  const { store, brain } = makeBrain();
  const g = store.group('g1');
  const now = Date.now();
  g.events = [
    { text: '张三约大家周五开黑', at: now - 2000 },
    { text: '张三约大家周五开黑。', at: now - 1000 },
  ];
  for (let i = 0; i < 15; i += 1) g.events.push({ text: `第 ${i} 件不一样的事情`, at: now - i });

  brain.tidy(now);
  assert.equal(g.events.length <= 12, true);
  assert.equal(g.events.filter((e) => e.text.startsWith('张三约大家周五开黑')).length, 1);
});

test('resetGroup 会清空事件', () => {
  const { store, brain } = makeBrain();
  const g = store.group('g1');
  g.events = [{ text: '张三约大家周五开黑', at: Date.now() }];
  brain.resetGroup('g1');
  assert.deepEqual(g.events, []);
});

test('get() 输出事件快照', () => {
  const { store, brain } = makeBrain();
  const g = store.group('g1');
  g.facts = [{ text: '张三在准备考公', at: Date.now() }];
  g.events = [{ text: '张三约大家周五开黑', at: Date.now() }];

  const snap = brain.get('g1');
  assert.deepEqual(snap.facts, ['张三在准备考公']);
  assert.equal(snap.events.length, 1);
  assert.equal(snap.events[0].text, '张三约大家周五开黑');
});
