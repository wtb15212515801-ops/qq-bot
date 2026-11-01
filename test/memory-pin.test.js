import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Store } from '../src/memory.js';
import { Brain } from '../src/brain.js';

const silent = { info() {}, warn() {}, error() {}, debug() {} };
const cfg = { memory: { maxFacts: 5, forgetDays: 14, maxUsers: 200, maxGroups: 120 } };
const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mempin-')), 'memory.json');
const DAY = 86_400_000;

function makeBrain() {
  const store = new Store(tmp(), silent).load();
  return { store, brain: new Brain({ cfg, llm: null, store, logger: silent }) };
}

test('置顶的事实不会被遗忘', () => {
  const { store, brain } = makeBrain();
  const g = store.group('g1');
  const old = Date.now() - 40 * DAY;
  g.facts = [
    { text: '张三在准备考公', at: old, pinned: true },
    { text: '李四的猫叫团子', at: old, pinned: false },
  ];

  const r = brain.forget();
  assert.equal(r.facts, 1);
  assert.deepEqual(g.facts.map((f) => f.text), ['张三在准备考公']);
});

test('togglePin 会写入文件，tidy 时置顶排最前', () => {
  const { store, brain } = makeBrain();
  const g = store.group('g1');
  g.facts = [
    { text: '第一条事实内容', at: 1 },
    { text: '第二条事实内容', at: 2 },
  ];

  assert.equal(brain.togglePin('g1', 1, true), true);
  assert.equal(g.facts[1].pinned, true);

  brain.tidy();
  assert.equal(g.facts[0].text, '第二条事实内容');
});

test('togglePin 越界不会崩', () => {
  const { brain } = makeBrain();
  assert.equal(brain.togglePin('g1', 99, true), false);
});

test('resetAll 清空所有会话的摘要与事实', () => {
  const { store, brain } = makeBrain();
  const a = store.group('g1');
  const b = store.group('g2');
  a.summary = '甲群摘要';
  a.facts = [{ text: '张三在准备考公', at: Date.now() }];
  b.summary = '乙群摘要';
  b.facts = [{ text: '李四的猫叫团子', at: Date.now() }];

  const n = brain.resetAll();
  assert.equal(n, 2);
  for (const g of [a, b]) {
    assert.equal(g.summary, '');
    assert.deepEqual(g.facts, []);
    assert.equal(g.mood, 60);
  }
});

test('旧版字符串事实读出来也带 pinned 字段', () => {
  const { store, brain } = makeBrain();
  const g = store.group('g1');
  g.facts = ['张三在准备考公'];

  const list = brain._facts(g);
  assert.deepEqual(list.map((f) => f.text), ['张三在准备考公']);
  assert.equal(list[0].pinned, false);
});
