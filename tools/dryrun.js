/**
 * 离线模拟器：不需要 QQ、不需要 API Key，直接看决策和拟人化效果。
 * 用法：npm run dryrun
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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const GROUP = 888888;

const pick = (a, b) => (fs.existsSync(path.join(root, a)) ? a : b);
const configName = pick('config.json', 'config.example.json');
const personaName = pick('persona.md', 'persona.example.md');

const cfg = loadConfig(path.join(root, configName));
cfg.llm = { ...cfg.llm, provider: 'mock' };
cfg.timing.scale = 0;
cfg.behavior.spontaneousChance = 0;
// 模拟器里把所有消息挤在同一秒，冷却时间会挡掉后续回复，所以临时关掉
cfg.limits = { ...cfg.limits, minGapSeconds: 0 };
const BOT_QQ = Number(cfg.onebot.selfId) || 10001;
cfg.onebot.selfId = BOT_QQ;
cfg.storage.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqbot-dryrun-'));

const persona = {
  name: cfg.persona.name,
  aliases: cfg.persona.aliases,
  interests: cfg.persona.interests,
  text: fs.readFileSync(path.join(root, personaName), 'utf8').replace(/^\uFEFF/, ''),
};

console.log(`配置：${configName}  人设：${personaName}\n`);

const logger = createLogger({ level: 'info' });
const store = new Store(path.join(cfg.storage.dir, 'memory.json'), logger).load();

const sent = [];
const client = {
  async sendGroupMsg(groupId, text) {
    sent.push({ groupId, text });
    console.log(`      \u2192 发出到群 ${groupId}：${text}`);
  },
  async sendPrivateMsg(userId, text) {
    sent.push({ userId, text });
    console.log(`      \u2192 发出到私聊 ${userId}：${text}`);
  },
};

const llm = new LLM(cfg.llm, logger);
const pipeline = new Pipeline({ cfg, persona, llm, client, store, logger });
pipeline.setSelfId(BOT_QQ);
pipeline.stateFor(`g${GROUP}`).members.set(String(BOT_QQ), persona.name);

let id = 1000;
function groupMsg(userId, nickname, text, { at = [], reply = null } = {}) {
  id += 1;
  const message = [];
  if (reply) message.push({ type: 'reply', data: { id: reply } });
  for (const qq of at) message.push({ type: 'at', data: { qq } });
  message.push({ type: 'text', data: { text } });
  return {
    post_type: 'message',
    message_type: 'group',
    sub_type: 'normal',
    group_id: GROUP,
    user_id: userId,
    message_id: id,
    time: Math.floor(Date.now() / 1000),
    sender: { user_id: userId, nickname, card: nickname, role: 'member' },
    message,
  };
}

const script = [
  ['张三', 20001, '今天好热啊', {}],
  ['李四', 20002, '有人要买薯片吗 一起下单', {}],
  ['王五', 20003, '我要番茄味的', {}],
  ['张三', 20001, `${persona.name}你要不要`, { at: [BOT_QQ] }],
  ['李四', 20002, '它肯定又要吃', {}],
  ['王五', 20003, `${persona.name}昨天不是吃完了吗`, {}],
  ['张三', 20001, '那再给它留一包', {}],
  ['李四', 20002, '行', {}],
  ['王五', 20003, '笑死 它一直在那趴着', {}],
  ['张三', 20001, '起来吃东西了', { at: [BOT_QQ] }],
];

console.log('='.repeat(64));
console.log(`模拟群聊：${script.length} 条消息，机器人 QQ=${BOT_QQ}，回复阈值=${cfg.behavior.replyThreshold}`);
console.log('（延迟已缩放到 0，实际运行会按 config 里的 timing 等待）');
console.log('='.repeat(64));

for (const [nickname, userId, text, opts] of script) {
  console.log(`\n【群消息】${nickname}：${text}${opts.at ? '  (并 @ 了机器人)' : ''}`);
  await pipeline.handle(groupMsg(userId, nickname, text, opts));
  await new Promise((r) => setTimeout(r, 60));
}

console.log('\n' + '='.repeat(64));
console.log(`结果：收到 ${script.length} 条消息，实际回复 ${sent.length} 条`);

store.save();
fs.rmSync(cfg.storage.dir, { recursive: true, force: true });
