import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Pipeline } from '../src/pipeline.js';
import { Store } from '../src/memory.js';

const silent = { info() {}, warn() {}, debug() {}, error() {} };
const SELF = 10001;

function makePipeline(notices = {}) {
  const calls = [];
  const client = {
    async call(action, params) {
      calls.push({ action, params });
      return {};
    },
    async sendGroupMsg(groupId, text) {
      calls.push({ action: 'group', groupId, text });
    },
    async sendGroupSegments(groupId, segments) {
      calls.push({ action: 'segments', groupId, segments });
    },
    async sendPrivateMsg(userId, text) {
      calls.push({ action: 'private', userId, text });
    },
  };

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'notice-'));
  const store = new Store(path.join(dir, 'memory.json'), silent).load();

  const cfg = {
    onebot: { selfId: SELF },
    limits: {},
    memory: {},
    behavior: {},
    stickers: { dir: path.join(dir, 'stickers'), enabled: false },
    emoji: { enabled: false },
    notices,
  };

  const pl = new Pipeline({
    cfg,
    persona: { name: '小满', aliases: ['小满'], interests: [] },
    llm: null,
    client,
    store,
    logger: silent,
    ui: null,
  });
  pl.setSelfId(SELF);

  return { pl, calls, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('撤回消息会从上下文里删掉', async () => {
  const { pl, cleanup } = makePipeline();
  const state = pl.stateFor('g123');
  state.add({ id: 55, userId: '20002', nickname: '张三', text: '刚才那句', receivedAt: Date.now() });
  state.add({ id: 56, userId: '20002', nickname: '张三', text: '另一句', receivedAt: Date.now() });

  await pl.handleNotice({
    post_type: 'notice',
    notice_type: 'group_recall',
    group_id: 123,
    user_id: 20002,
    message_id: 55,
  });

  assert.equal(state.messages.some((m) => String(m.id) === '55'), false);
  assert.equal(state.messages.some((m) => String(m.id) === '56'), true);
  cleanup();
});

test('撤回开关关掉后不动上下文', async () => {
  const { pl, cleanup } = makePipeline({ recallCleanup: false });
  const state = pl.stateFor('g123');
  state.add({ id: 77, userId: '1', nickname: '甲', text: 'x', receivedAt: Date.now() });

  await pl.handleNotice({
    post_type: 'notice',
    notice_type: 'group_recall',
    group_id: 123,
    user_id: 1,
    message_id: 77,
  });

  assert.equal(state.messages.length, 1);
  cleanup();
});

test('入群会发带 @ 的欢迎语', async () => {
  const { pl, calls, cleanup } = makePipeline();
  await pl.handleNotice({
    post_type: 'notice',
    notice_type: 'group_increase',
    group_id: 123,
    user_id: 20002,
  });

  const seg = calls.find((c) => c.action === 'segments');
  assert.ok(seg, '应该发送消息段');
  assert.equal(seg.groupId, '123');
  assert.equal(seg.segments[0].type, 'at');
  assert.equal(seg.segments[0].data.qq, '20002');
  assert.equal(seg.segments[1].type, 'text');
  cleanup();
});

test('同一群 30 秒内不重复欢迎', async () => {
  const { pl, calls, cleanup } = makePipeline();
  const ev = { post_type: 'notice', notice_type: 'group_increase', group_id: 123, user_id: 20002 };

  await pl.handleNotice(ev);
  await pl.handleNotice({ ...ev, user_id: 20003 });

  assert.equal(calls.filter((c) => c.action === 'segments').length, 1);
  cleanup();
});

test('欢迎开关关掉就不发', async () => {
  const { pl, calls, cleanup } = makePipeline({ welcome: false });
  await pl.handleNotice({
    post_type: 'notice',
    notice_type: 'group_increase',
    group_id: 123,
    user_id: 20002,
  });
  assert.equal(calls.length, 0);
  cleanup();
});

test('退群会说一句', async () => {
  const { pl, calls, cleanup } = makePipeline();
  await pl.handleNotice({
    post_type: 'notice',
    notice_type: 'group_decrease',
    sub_type: 'leave',
    group_id: 123,
    user_id: 20002,
  });

  const msg = calls.find((c) => c.action === 'group');
  assert.ok(msg);
  assert.match(msg.text, /走|被踢/);
  cleanup();
});

test('被戳会戳回去', async () => {
  const { pl, calls, cleanup } = makePipeline();
  await pl.handleNotice({
    post_type: 'notice',
    notice_type: 'notify',
    sub_type: 'poke',
    group_id: 123,
    user_id: 20002,
    target_id: SELF,
  });

  const poke = calls.find((c) => c.action === 'send_poke');
  assert.ok(poke, '应该调用 send_poke');
  assert.equal(poke.params.user_id, 20002);
  cleanup();
});

test('戳别人不反应', async () => {
  const { pl, calls, cleanup } = makePipeline();
  await pl.handleNotice({
    post_type: 'notice',
    notice_type: 'notify',
    sub_type: 'poke',
    group_id: 123,
    user_id: 20002,
    target_id: 99999,
  });
  assert.equal(calls.length, 0);
  cleanup();
});

test('戳一戳开关关掉不反应', async () => {
  const { pl, calls, cleanup } = makePipeline({ poke: false });
  await pl.handleNotice({
    post_type: 'notice',
    notice_type: 'notify',
    sub_type: 'poke',
    group_id: 123,
    user_id: 20002,
    target_id: SELF,
  });
  assert.equal(calls.length, 0);
  cleanup();
});

test('不认识的通知类型不报错也不发消息', async () => {
  const { pl, calls, cleanup } = makePipeline();
  await pl.handleNotice({ post_type: 'notice', notice_type: 'group_admin', group_id: 123 });
  await pl.handleNotice({ post_type: 'message', message_type: 'group' });
  await pl.handleNotice(null);
  assert.equal(calls.length, 0);
  cleanup();
});

test('协议端不支持戳一戳时退回文字', async () => {
  const calls = [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'notice2-'));
  const store = new Store(path.join(dir, 'memory.json'), silent).load();
  const client = {
    async call() {
      throw new Error('action not supported');
    },
    async sendGroupMsg(groupId, text) {
      calls.push({ groupId, text });
    },
    async sendGroupSegments() {},
    async sendPrivateMsg() {},
  };
  const pl = new Pipeline({
    cfg: {
      onebot: { selfId: SELF },
      limits: {},
      memory: {},
      behavior: {},
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

  await pl.handleNotice({
    post_type: 'notice',
    notice_type: 'notify',
    sub_type: 'poke',
    group_id: 123,
    user_id: 20002,
    target_id: SELF,
  });

  assert.equal(calls.length, 1);
  assert.match(calls[0].text, /戳/);
  fs.rmSync(dir, { recursive: true, force: true });
});
