import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Pipeline } from '../src/pipeline.js';
import { Store } from '../src/memory.js';
import { Outbox } from '../src/outbox.js';

const silent = { info() {}, warn() {}, debug() {}, error() {} };
const SELF = 10001;

function makePipeline() {
  const calls = [];
  const client = {
    async call(action, params) {
      calls.push({ action, params });
      return {};
    },
    async sendGroupMsg(groupId, text) {
      calls.push({ action: 'group', groupId, text });
    },
    async sendPrivateMsg(userId, text) {
      calls.push({ action: 'private', userId, text });
    },
    async sendGroupSegments() {},
    async sendGroupImage() {},
    async sendPrivateImage() {},
  };

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'send-'));
  const store = new Store(path.join(dir, 'memory.json'), silent).load();

  const pl = new Pipeline({
    cfg: {
      onebot: { selfId: SELF },
      limits: {},
      memory: {},
      behavior: {},
      groups: { '578710075': { name: 'Bot' } },
      stickers: { dir: path.join(dir, 's'), enabled: false },
      emoji: { enabled: false },
    },
    persona: { name: '小满', aliases: [], interests: [] },
    llm: null,
    client,
    store,
    logger: silent,
    ui: null,
  });
  pl.setSelfId(SELF);
  return { pl, calls, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('手动发群消息', async () => {
  const { pl, calls, cleanup } = makePipeline();
  const ok = await pl.sendManual('g578710075', '大家好');
  assert.equal(ok, true);

  const msg = calls.find((c) => c.action === 'group');
  assert.equal(msg.groupId, '578710075');
  assert.equal(msg.text, '大家好');
  cleanup();
});

test('手动发私聊消息', async () => {
  const { pl, calls, cleanup } = makePipeline();
  await pl.sendManual('p705511097', '在吗');
  const msg = calls.find((c) => c.action === 'private');
  assert.equal(msg.userId, '705511097');
  cleanup();
});

test('手动发的消息会进上下文', async () => {
  const { pl, cleanup } = makePipeline();
  await pl.sendManual('g578710075', '我说的这句话');
  const state = pl.stateFor('g578710075');
  assert.ok(state.messages.some((m) => m.text === '我说的这句话'));
  assert.ok(state.messages.every((m) => m.userId === String(SELF)));
  cleanup();
});

test('非法会话标识被拒绝', async () => {
  const { pl, calls, cleanup } = makePipeline();
  assert.equal(await pl.sendManual('all', '试试'), false);
  assert.equal(await pl.sendManual('', '试试'), false);
  assert.equal(calls.length, 0);
  cleanup();
});

test('空消息和超长消息被拒绝', async () => {
  const { pl, calls, cleanup } = makePipeline();
  assert.equal(await pl.sendManual('g1', '   '), false);
  assert.equal(await pl.sendManual('g1', 'x'.repeat(600)), false);
  assert.equal(calls.length, 0);
  cleanup();
});

// ---------------- 发件箱 ----------------

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('发件箱只发新增的行', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ob-'));
  const file = path.join(dir, 'outbox.jsonl');
  fs.writeFileSync(file, '{"chat":"g1","text":"旧消息"}\n', 'utf8');

  const got = [];
  const ob = new Outbox({ file, onSend: async (e) => got.push(e), intervalMs: 40 });
  ob.start();
  await wait(120);
  assert.equal(got.length, 0, '启动前的历史内容不该重发');

  fs.appendFileSync(file, '{"chat":"g1","text":"新消息"}\n', 'utf8');
  await wait(200);
  ob.stop();

  assert.equal(got.length, 1);
  assert.equal(got[0].text, '新消息');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('发件箱一次追加多条都能处理', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ob2-'));
  const file = path.join(dir, 'outbox.jsonl');

  const got = [];
  const ob = new Outbox({ file, onSend: async (e) => got.push(e), intervalMs: 40 });
  ob.start();
  await wait(100);

  fs.appendFileSync(file, '{"chat":"g1","text":"一"}\n{"chat":"g2","text":"二"}\n', 'utf8');
  await wait(200);
  ob.stop();

  assert.deepEqual(got.map((g) => g.text), ['一', '二']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('发件箱遇到坏行不中断', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ob3-'));
  const file = path.join(dir, 'outbox.jsonl');

  const got = [];
  const ob = new Outbox({ file, onSend: async (e) => got.push(e), intervalMs: 40 });
  ob.start();
  await wait(100);

  fs.appendFileSync(file, '这不是 JSON\n{"chat":"g1","text":"好的"}\n', 'utf8');
  await wait(200);
  ob.stop();

  assert.equal(got.length, 1);
  assert.equal(got[0].text, '好的');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('发送失败不会卡住后续消息', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ob4-'));
  const file = path.join(dir, 'outbox.jsonl');

  const got = [];
  const ob = new Outbox({
    file,
    intervalMs: 40,
    onSend: async (e) => {
      if (e.text === '会失败') throw new Error('发送失败');
      got.push(e);
    },
  });
  ob.start();
  await wait(100);

  fs.appendFileSync(file, '{"chat":"g1","text":"会失败"}\n{"chat":"g1","text":"能成功"}\n', 'utf8');
  await wait(220);
  ob.stop();

  assert.equal(got.length, 1);
  assert.equal(got[0].text, '能成功');
  fs.rmSync(dir, { recursive: true, force: true });
});
