/**
 * 用真实大模型试一句，验证 API Key 和人设。
 * 不连 QQ，只调模型。
 *
 * 用法：
 *   node tools/test-llm.js
 *   node tools/test-llm.js 今天吃薯片了吗
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig } from '../src/config.js';
import { LLM } from '../src/llm.js';
import { createLogger } from '../src/logger.js';
import { buildSystemPrompt, buildUserPrompt, GroupState } from '../src/context.js';
import { filterOutput, isOutputBlocked } from '../src/safety.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pick = (a, b) => (fs.existsSync(path.join(root, a)) ? a : b);

const cfg = loadConfig(path.join(root, pick('config.json', 'config.example.json')));
const persona = {
  name: cfg.persona.name,
  aliases: cfg.persona.aliases,
  interests: cfg.persona.interests,
  text: fs.readFileSync(path.join(root, pick('persona.md', 'persona.example.md')), 'utf8').replace(/^\uFEFF/, ''),
};

const text = process.argv.slice(2).join(' ').trim() || `${persona.name}在吗`;

const groupKey = Object.keys(cfg.groups || {})[0];
const group = cfg.groups?.[groupKey] ?? {};

const now = Date.now();
const state = new GroupState();
state.add({
  id: 1,
  userId: '20001',
  nickname: '群友',
  text,
  time: now,
  receivedAt: now,
});

const trigger = state.messages[0];
const system = buildSystemPrompt({ persona, group });
const user = buildUserPrompt({ state, trigger, botName: persona.name, maxMessages: 10 });

const llm = new LLM(cfg.llm, createLogger({ level: 'warn' }));

console.log(`\n你说：${text}`);

const t0 = Date.now();
let reply;
try {
  reply = await llm.chat({ system, user });
} catch (e) {
  console.error(`\n调用失败：${e.message}`);
  console.error(`
排查：
  1. llm.apiKey 是否正确、有没有过期
  2. DeepSeek 账户里有没有余额（平台左侧「充值」）
  3. 网络能不能访问 api.deepseek.com
`);
  process.exit(1);
}

const ms = Date.now() - t0;
const cleaned = filterOutput(reply, { botName: persona.name });

console.log(`\n原始输出：${reply}`);
console.log(`过滤后：${cleaned}`);
console.log(`状态：${isOutputBlocked(cleaned, cfg) ? '❌ 命中屏蔽词，会被丢弃' : '✅ 会正常发出'}`);
console.log(`\n耗时 ${ms} ms\n`);
