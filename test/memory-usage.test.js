import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Store } from '../src/memory.js';
import { Brain } from '../src/brain.js';

const silent = { info() {}, warn() {}, error() {}, debug() {} };
const cfg = { memory: { maxFacts: 5, forgetDays: 14, maxUsers: 200, maxGroups: 120 } };
const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'memuse-')), 'memory.json');
const DAY = 86_400_000;

function makeBrain() {
  const store = new Store(tmp(), silent).load();
  return { store, brain: new Brain({ cfg, llm: null, store, logger: silent }) };
}

test('markUsed 会刷新最后使用时间', () => {
  const { store, brain } = makeBrain();
  const g = store.group('g1');
  const old = Date.now() - 40 * DAY;
  g.facts = [{ text: '张三在准备考公', at: old }];

  brain.markUsed('g1', ['张三在准备考公']);

  assert.equal(g.facts[0].hits, 1);
  assert.ok(g.facts[0].lastUsed > old);
});

test('常用的事实不会因为「记得早」而被遗忘', () => {
  const { store, brain } = makeBrain();
  const g = store.group('g1');
  const now = Date.now();
  const old = now - 40 * DAY;

  g.facts = [
    { text: '张三在准备考公', at: old },
    { text: '李四的猫叫团子', at: old },
  ];
  brain.markUsed('g1', ['张三在准备考公'], now);

  const r = brain.forget(now);
  assert.equal(r.facts, 1);
  assert.deepEqual(g.facts.map((f) => f.text), ['张三在准备考公']);
});

test('从未用过且过期的事实照常忘掉', () => {
  const { store, brain } = makeBrain();
  const g = store.group('g1');
  g.facts = [{ text: '很久以前的事实', at: Date.now() - 40 * DAY }];

  const r = brain.forget();
  assert.equal(r.facts, 1);
  assert.equal(g.facts.length, 0);
});
