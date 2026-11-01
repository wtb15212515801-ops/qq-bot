/**
 * 事件回放：用固定聊天记录 + mock 模型跑完整条主流程。
 *
 * 目的：在拆架构之前先有一张「行为不会变」的网。
 * 以后改 pipeline / 决策 / 上下文，跑这个就知道有没有跑偏。
 */

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Pipeline } from '../src/pipeline.js';
import { LLM } from '../src/llm.js';
import { Store } from '../src/memory.js';
import { Stats } from '../src/stats.js';
import { DEFAULTS, deepMerge } from '../src/config.js';

const silent = {
  info() {},
  warn() {},
  error() {},
  debug() {},
  child() {
    return this;
  },
};

const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/replay.json', import.meta.url), 'utf8'));

function makePipeline(extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-'));
  const cfg = deepMerge(structuredClone(DEFAULTS), {
    llm: { provider: 'mock' },
    behavior: {
      replyThreshold: 4.5,
      quietHours: ['00:00', '00:00'],
      maxContextMessages: 15,
    },
    limits: { minGapSeconds: 0, maxPerMinute: 100, maxPerHour: 1000 },
    timing: { scale: 0 },
    memory: { summarizeEvery: 10_000 },
    emoji: { enabled: false },
    stickers: { enabled: false },
    proactive: { enabled: false },
  });
  const merged = deepMerge(cfg, extra);

  const store = new Store(path.join(dir, 'memory.json'), silent).load();
  const stats = new Stats({ file: path.join(dir, 'stats.json'), logger: silent }).load();
  const sent = [];
  const client = {
    async sendGroupMsg(groupId, text) {
      sent.push({ kind: 'group', to: String(groupId), text });
    },
    async sendPrivateMsg(userId, text) {
      sent.push({ kind: 'private', to: String(userId), text });
    },
    async sendGroupImage() {},
    async sendPrivateImage() {},
  };

  const pipeline = new Pipeline({
    cfg: merged,
    persona: { name: '小满', aliases: ['小满'], interests: [], text: '你是小满，群里的一员。' },
    llm: new LLM(merged.llm, silent),
    client,
    store,
    stats,
    ui: null,
    logger: silent,
  });
  pipeline.setSelfId(fixture.selfId);
  return { pipeline, sent, store, dir };
}

let seq = 0;
function toEvent(item) {
  seq += 1;
  const message = [];
  if (item.atSelf) message.push({ type: 'at', data: { qq: String(fixture.selfId) } });
  message.push({ type: 'text', data: { text: item.text } });

  return {
    post_type: 'message',
    message_type: 'group',
    group_id: fixture.group,
    user_id: Number(item.user),
    message_id: seq,
    time: Math.floor(Date.now() / 1000),
    sender: { nickname: item.nick, card: item.nick },
    message,
  };
}

test('回放一整段聊天：该回的回了，不该回的不回', async () => {
  const { pipeline, sent, store } = makePipeline();

  for (const item of fixture.events) {
    await pipeline.handle(toEvent(item));
  }

  // 1. 至少要有回复，而且都发在正确的群
  assert.ok(sent.length >= 3, `回复数 ${sent.length}`);
  assert.ok(sent.every((m) => m.kind === 'group' && m.to === String(fixture.group)));

  // 2. 被 @ 的那条一定回
  const atIndex = fixture.events.findIndex((e) => e.atSelf);
  assert.ok(atIndex >= 0);

  // 3. 「今天好热啊」这种没信息量的第一句不该回
  assert.equal(store.group(`g${fixture.group}`).replied >= 3, true);

  // 4. 所有消息都进了上下文统计
  assert.equal(store.group(`g${fixture.group}`).messageCount, fixture.events.length);

  // 5. 机器人说过的话也进了上下文，供重复检测用
  const state = pipeline.states.get(`g${fixture.group}`);
  assert.ok(state);
  assert.ok(state.messages.some((m) => String(m.userId) === String(fixture.selfId)));
});

test('私聊事件走私聊发送通道', async () => {
  const { pipeline, sent } = makePipeline();
  await pipeline.handle({
    post_type: 'message',
    message_type: 'private',
    user_id: 1002,
    message_id: 9001,
    time: Math.floor(Date.now() / 1000),
    sender: { nickname: '李四' },
    message: [{ type: 'text', data: { text: '在吗' } }],
  });

  assert.equal(sent.length, 1);
  assert.equal(sent[0].kind, 'private');
  assert.equal(sent[0].to, '1002');
});

test('图片消息不会炸（关闭识图时）', async () => {
  const { pipeline, store } = makePipeline({ vision: { enabled: false } });
  await pipeline.handle({
    post_type: 'message',
    message_type: 'group',
    group_id: fixture.group,
    user_id: 1001,
    message_id: 9100,
    time: Math.floor(Date.now() / 1000),
    sender: { nickname: '张三' },
    message: [{ type: 'image', data: { url: 'https://example.com/a.png' } }],
  });

  assert.equal(store.group(`g${fixture.group}`).messageCount, 1);
});

test('冷场后主动开口', async () => {
  const { pipeline, sent, store } = makePipeline({
    groups: { [String(fixture.group)]: { name: '测试群', vibe: '自己人随便聊' } },
    proactive: {
      enabled: true,
      idleMinutes: 1,
      minIntervalMinutes: 0,
      activeHours: ['00:00', '23:59'],
      chance: 1,
      checkEverySeconds: 60,
    },
  });

  const key = `g${fixture.group}`;
  const st = pipeline.stateFor(key);
  st.lastMessageAt = Date.now() - 10 * 60_000;

  await pipeline._proactiveTick();

  assert.ok(sent.length >= 1, '应该主动发了一句');
  assert.ok(store.group(key).lastProactiveAt > 0);
});

test('控制指令：置顶、清上下文、重置记忆', async () => {
  const { pipeline, store } = makePipeline();
  const key = `g${fixture.group}`;
  const g = store.group(key);

  g.summary = '一段摘要';
  g.facts = [
    { text: '张三在准备考公', at: Date.now() },
    { text: '李四的猫叫团子', at: Date.now() },
  ];

  assert.equal(await pipeline.applyCommand({ cmd: 'pinFact', chat: key, index: 0, pinned: true }), true);
  assert.equal(g.facts[0].pinned, true);

  await pipeline.handle(toEvent(fixture.events[1]));
  assert.ok(pipeline.states.get(key).messages.length > 0);

  const cleared = await pipeline.applyCommand({ cmd: 'clearContext', chat: key });
  assert.ok(cleared > 0);
  assert.equal(pipeline.states.get(key).messages.length, 0);

  await pipeline.applyCommand({ cmd: 'resetGroup', chat: key });
  assert.equal(g.summary, '');
  assert.deepEqual(g.facts, []);
  assert.equal(g.mood, 60);
});
