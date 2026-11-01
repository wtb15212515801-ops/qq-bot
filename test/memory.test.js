import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/memory.js';
import { Brain } from '../src/brain.js';

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mem-')), 'memory.json');
const silent = { info() {}, warn() {}, error() {}, debug() {} };

test('存档再读回来，数据不丢', () => {
  const file = tmp();
  const a = new Store(file, silent).load();
  a.group('g1').summary = '测试摘要';
  a.group('g1').mood = 77;
  a.save();

  const b = new Store(file, silent).load();
  assert.equal(b.group('g1').summary, '测试摘要');
  assert.equal(b.group('g1').mood, 77);
});

test('文件损坏时重置而不是崩溃', () => {
  const file = tmp();
  fs.writeFileSync(file, '{坏掉的 json', 'utf8');
  const s = new Store(file, silent).load();
  assert.deepEqual(s.data.groups, {});
});

test('保存的文件没有 BOM', () => {
  const file = tmp();
  const s = new Store(file, silent).load();
  s.group('g1');
  s.save();
  const bytes = fs.readFileSync(file);
  assert.notDeepEqual([...bytes.slice(0, 3)], [0xef, 0xbb, 0xbf]);
});

const cfg = {
  memory: { maxFacts: 12, forgetDays: 14, maxUsers: 200, maxGroups: 120 },
};
const DAY = 86_400_000;

test('tidy 删掉「小满是机器人」这类污染', () => {
  const file = tmp();
  const store = new Store(file, silent).load();
  const brain = new Brain({
    cfg: { ...cfg, persona: { name: '小满', aliases: ['小满'] } },
    llm: null,
    store,
    logger: silent,
  });
  const g = store.group('g1');
  g.facts = [
    { text: '小满是一个机器人', at: Date.now() },
    { text: '张三在准备考公', at: Date.now() },
  ];

  const r = brain.tidy();
  assert.equal(r.junk, 1);
  assert.deepEqual(g.facts.map((f) => f.text), ['张三在准备考公']);
});

test('事实清洗跟着人设名走，不写死', () => {
  const file = tmp();
  const store = new Store(file, silent).load();
  const first = new Brain({
    cfg: { ...cfg, persona: { name: '阿柊' } },
    llm: null,
    store,
    logger: silent,
  });
  const second = new Brain({
    cfg: { ...cfg, persona: { name: '小满' } },
    llm: null,
    store,
    logger: silent,
  });

  assert.equal(first._junk('阿柊是一个机器人'), true);
  assert.equal(second._junk('阿柊是一个机器人'), false);
});

test('tidy 合并重复事实', () => {
  const file = tmp();
  const store = new Store(file, silent).load();
  const brain = new Brain({ cfg, llm: null, store, logger: silent });
  const g = store.group('g1');
  const now = Date.now();
  g.facts = [
    { text: '张三在准备考公', at: now - 1000 },
    { text: '张三在准备考公。', at: now },
  ];

  const r = brain.tidy();
  assert.equal(g.facts.length, 1);
  assert.ok(r.dup >= 1);
});

test('tidy 保留最早的时间戳', () => {
  const file = tmp();
  const store = new Store(file, silent).load();
  const brain = new Brain({ cfg, llm: null, store, logger: silent });
  const g = store.group('g1');
  const old = Date.now() - 5 * DAY;
  g.facts = [
    { text: '阿杰养的猫叫团子', at: old },
    { text: '阿杰养的猫叫团子。', at: Date.now() },
  ];
  brain.tidy();
  assert.equal(g.facts[0].at, old);
});

test('forget 清掉过期事实', () => {
  const file = tmp();
  const store = new Store(file, silent).load();
  const brain = new Brain({ cfg, llm: null, store, logger: silent });
  const g = store.group('g1');
  g.facts = [
    { text: '很久以前的事', at: Date.now() - 30 * DAY },
    { text: '刚发生的事', at: Date.now() },
  ];
  const r = brain.forget();
  assert.equal(r.facts, 1);
  assert.deepEqual(g.facts.map((f) => f.text), ['刚发生的事']);
});

test('旧格式字符串事实只转换一次，时间戳不再刷新', () => {
  const file = tmp();
  const store = new Store(file, silent).load();
  const brain = new Brain({ cfg, llm: null, store, logger: silent });
  const g = store.group('g1');
  g.summaryAt = 1000;
  g.facts = ['老格式的事实'];

  const first = brain._facts(g)[0].at;
  const second = brain._facts(g)[0].at;
  assert.equal(first, 1000);
  assert.equal(second, first, '第二次读取不能刷新时间');
});
