import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Stats } from '../src/stats.js';
import { Control } from '../src/control.js';
import { Pipeline } from '../src/pipeline.js';
import { Store } from '../src/memory.js';
import { Brain } from '../src/brain.js';
import { forgetMessage } from '../src/notices.js';

const silent = { info() {}, warn() {}, debug() {}, error() {} };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------- 统计 ----------------

test('统计按小时计数', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-'));
  const s = new Stats({ file: path.join(dir, 'stats.json'), logger: silent });
  const t = new Date(2026, 0, 1, 10, 30).getTime();

  s.bump('received', t);
  s.bump('received', t);
  s.bump('replied', t);

  const series = s.series(3, t);
  const hit = series.find((x) => x.received === 2);
  assert.ok(hit, '应该有一条收到 2 条');
  assert.equal(hit.replied, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('统计序列会补齐空小时', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'st2-'));
  const s = new Stats({ file: path.join(dir, 'stats.json'), logger: silent });
  const series = s.series(5, Date.now());
  assert.equal(series.length, 5);
  assert.ok(series.every((x) => x.received === 0));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('统计能存盘再读回', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'st3-'));
  const file = path.join(dir, 'stats.json');
  const a = new Stats({ file, logger: silent });
  a.bump('received');
  a.save();

  const b = new Stats({ file, logger: silent }).load();
  const total = b.series(1).reduce((x, y) => x + y.received, 0);
  assert.equal(total, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('统计文件损坏不影响启动', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'st4-'));
  const file = path.join(dir, 'stats.json');
  fs.writeFileSync(file, '{坏掉的', 'utf8');
  const s = new Stats({ file, logger: silent }).load();
  assert.deepEqual(s.data.hours, {});
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------- 控制通道 ----------------

test('控制通道执行新增指令', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-'));
  const file = path.join(dir, 'control.jsonl');
  const got = [];
  const c = new Control({ file, logger: silent, onCommand: async (cmd) => got.push(cmd), intervalMs: 40 });
  c.start();
  await wait(100);

  fs.appendFileSync(file, '{"cmd":"clearFacts","chat":"g1"}\n', 'utf8');
  await wait(200);
  c.stop();

  assert.equal(got.length, 1);
  assert.equal(got[0].cmd, 'clearFacts');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('控制通道忽略坏行继续执行', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ct2-'));
  const file = path.join(dir, 'control.jsonl');
  const got = [];
  const c = new Control({ file, logger: silent, onCommand: async (cmd) => got.push(cmd), intervalMs: 40 });
  c.start();
  await wait(100);

  fs.appendFileSync(file, 'oops\n{"cmd":"resetGroup","chat":"g1"}\n', 'utf8');
  await wait(200);
  c.stop();

  assert.equal(got.length, 1);
  assert.equal(got[0].cmd, 'resetGroup');
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------- 指令执行 ----------------

function makeBrain() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmd-'));
  const store = new Store(path.join(dir, 'memory.json'), silent).load();
  const brain = new Brain({ cfg: { memory: { maxFacts: 12 } }, llm: null, store, logger: silent });
  return { dir, store, brain };
}

function ctx(brain, store) {
  return { brain, store, log: silent, cfg: {}, states: new Map(), noticeAt: new Map() };
}

test('forgetFact 删掉指定条目', async () => {
  const { dir, store, brain } = makeBrain();
  const g = store.group('g1');
  g.facts = [{ text: '甲在考公', at: Date.now() }, { text: '乙养了猫', at: Date.now() }];

  await Pipeline.prototype.applyCommand.call(ctx(brain, store), { cmd: 'forgetFact', chat: 'g1', index: 0 });
  assert.deepEqual(g.facts.map((f) => f.text), ['乙养了猫']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('clearFacts / clearSummary / resetGroup', async () => {
  const { dir, store, brain } = makeBrain();
  const g = store.group('g1');
  g.facts = [{ text: '甲', at: Date.now() }];
  g.summary = '一段摘要';
  const c = ctx(brain, store);

  await Pipeline.prototype.applyCommand.call(c, { cmd: 'clearFacts', chat: 'g1' });
  assert.equal(g.facts.length, 0);

  await Pipeline.prototype.applyCommand.call(c, { cmd: 'clearSummary', chat: 'g1' });
  assert.equal(g.summary, '');

  g.facts = [{ text: '甲', at: Date.now() }];
  g.mood = 10;
  await Pipeline.prototype.applyCommand.call(c, { cmd: 'resetGroup', chat: 'g1' });
  assert.equal(g.facts.length, 0);
  assert.equal(g.mood, 60);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('setMood 会夹在 0-100 之间', async () => {
  const { dir, store, brain } = makeBrain();
  const c = ctx(brain, store);

  await Pipeline.prototype.applyCommand.call(c, { cmd: 'setMood', chat: 'g1', value: 999 });
  assert.equal(store.group('g1').mood, 100);

  await Pipeline.prototype.applyCommand.call(c, { cmd: 'setMood', chat: 'g1', value: -50 });
  assert.equal(store.group('g1').mood, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('未知指令不抛错', async () => {
  const { dir, store, brain } = makeBrain();
  await assert.doesNotReject(() =>
    Pipeline.prototype.applyCommand.call(ctx(brain, store), { cmd: '不认识', chat: 'g1' })
  );
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------- 撤回清理（抽到 notices.js） ----------------

test('forgetMessage 只删掉指定那条', () => {
  const states = new Map();
  const state = {
    messages: [
      { id: 1, text: 'a' },
      { id: 2, text: 'b' },
    ],
  };
  states.set('g1', state);
  const pl = { states, log: silent };

  assert.equal(forgetMessage(pl, 'g1', 1), true);
  assert.deepEqual(state.messages.map((m) => m.id), [2]);

  assert.equal(forgetMessage(pl, 'g1', 99), false, '找不到返回 false');
  assert.equal(forgetMessage(pl, 'nope', 1), false, '会话不存在返回 false');
});
