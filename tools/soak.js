/**
 * 压测：用 mock 模型灌大量消息，看有没有内存泄漏、卡死、状态膨胀。
 * 用法：node tools/soak.js [消息数] [群数]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.js';
import { createLogger } from '../src/logger.js';
import { LLM } from '../src/llm.js';
import { Store } from '../src/memory.js';
import { Pipeline } from '../src/pipeline.js';

const total = Number(process.argv[2] || 2000);
const groups = Number(process.argv[3] || 20);

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cfg = loadConfig(path.join(root, 'config.json'));
cfg.llm = { ...cfg.llm, provider: 'mock' };
cfg.timing.scale = 0;
cfg.behavior.replyLevel = 'active';
cfg.storage.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'soak-'));

const persona = {
  name: cfg.persona.name,
  aliases: cfg.persona.aliases,
  interests: cfg.persona.interests,
  text: fs.readFileSync(path.join(root, 'persona.md'), 'utf8'),
};

const logger = createLogger({ level: 'error' });
const store = new Store(path.join(cfg.storage.dir, 'memory.json'), logger).load();

let sent = 0;
const client = {
  async sendGroupMsg() { sent += 1; },
  async sendPrivateMsg() { sent += 1; },
  async sendGroupImage() { sent += 1; },
  async sendPrivateImage() { sent += 1; },
};

const pipeline = new Pipeline({ cfg, persona, llm: new LLM(cfg.llm, logger), client, store, logger });

const texts = [
  '今天好热啊',
  '有人要买薯片吗',
  `${persona.name}你在吗`,
  '明天去哪吃饭',
  '这个多少钱',
  '笑死',
  '我也想吃糊糊',
  '在干嘛呢',
  '好耶',
  '算一下 25*4',
];

const t0 = Date.now();
const heap0 = process.memoryUsage().heapUsed;

for (let i = 0; i < total; i += 1) {
  const gid = 900000 + (i % groups);
  const uid = 20000 + (i % 7);
  const text = texts[i % texts.length];
  try {
    await pipeline.handle({
      post_type: 'message',
      message_type: 'group',
      group_id: gid,
      user_id: uid,
      message_id: i,
      time: Math.floor(Date.now() / 1000),
      sender: { user_id: uid, nickname: '用户' + uid, card: '', role: 'member' },
      message: [{ type: 'text', data: { text } }],
    });
  } catch (e) {
    console.log(`第 ${i} 条抛错：${e.message}`);
    break;
  }
}

const dt = Date.now() - t0;
const heap1 = process.memoryUsage().heapUsed;

let limiterSize = 0;
for (const [, e] of pipeline.limiter.windows) limiterSize += e.hits.length;

console.log('=== 压测结果 ===');
console.log(`  消息 ${total} 条 / ${groups} 个群`);
console.log(`  耗时 ${dt}ms（平均 ${(dt / total).toFixed(2)}ms/条）`);
console.log(`  实际发出 ${sent} 条`);
console.log(`  堆内存 ${(heap0 / 1048576).toFixed(1)}MB → ${(heap1 / 1048576).toFixed(1)}MB`);
console.log(`  会话缓存 states.size = ${pipeline.states.size}（上限 60，未触发维护时可能更多）`);
console.log(`  记忆群记录 = ${Object.keys(store.data.groups).length} 个`);
console.log(`  用户记录 = ${Object.keys(store.data.users || {}).length} 个`);
console.log(`  限流器会话 = ${pipeline.limiter.windows.size} 个，累计命中 ${limiterSize}`);
console.log(`  判定缓存 = ${pipeline.lastJudgeAt.size} 个`);

// 跑一次维护，看能否回收
pipeline.runMaintenance(Date.now() + 10 * 60 * 60 * 1000);
console.log('=== 维护后 ===');
console.log(`  会话缓存 ${pipeline.states.size} 个`);
console.log(`  限流器会话 ${pipeline.limiter.windows.size} 个`);
console.log(`  判定缓存 ${pipeline.lastJudgeAt.size} 个`);

store.save();
fs.rmSync(cfg.storage.dir, { recursive: true, force: true });
