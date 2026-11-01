/**
 * 打印模型实际会看到的完整 prompt。
 * 调人设的时候，先看这个，比瞎改参数有用。
 *
 * 用法：node tools/prompt.js
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig, resolvePath } from '../src/config.js';
import { buildSystemPrompt, buildUserPrompt, GroupState } from '../src/context.js';
import { Store } from '../src/memory.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pick = (a, b) => (fs.existsSync(path.join(root, a)) ? a : b);

const cfg = loadConfig(path.join(root, pick('config.json', 'config.example.json')));
const persona = {
  name: cfg.persona.name,
  aliases: cfg.persona.aliases,
  interests: cfg.persona.interests,
  text: fs.readFileSync(path.join(root, pick('persona.md', 'persona.example.md')), 'utf8').replace(/^\uFEFF/, ''),
};

// 读真实记忆，prompt 预览才不失真
const silent = { debug() {}, info() {}, warn() {}, error() {}, child() { return silent; } };
const store = new Store(
  path.join(resolvePath(cfg, cfg.storage?.dir || 'data'), 'memory.json'),
  silent
).load();

const GROUP = Object.keys(cfg.groups || {})[0] ?? '123456789';
const group = cfg.groups?.[GROUP] ?? {};
const g = store.group(`g${GROUP}`);
const memory = { summary: g.summary || '', facts: (g.facts || []).slice(0, 12), mood: g.mood ?? 60 };

const now = Date.now();
const state = new GroupState();
const lines = [
  ['20001', '张三', '今晚有人补番吗'],
  ['20002', '李四', '在补芙莉莲 看到一半了'],
  ['20003', '王五', '这番后劲是真大'],
];
lines.forEach(([userId, nickname, text], i) => {
  state.add({
    id: i + 1,
    userId,
    nickname,
    text,
    time: now - (lines.length - i) * 60_000,
    receivedAt: now - (lines.length - i) * 60_000,
  });
});

const trigger = {
  id: 99,
  userId: '20001',
  nickname: '张三',
  text: '阿柊你看到哪了',
  time: now,
  receivedAt: now,
  atSelf: false,
  selfId: 0,
};
state.add(trigger);

const system = buildSystemPrompt({ persona, group, memory, mood: memory.mood });
const user = buildUserPrompt({ state, trigger, botName: persona.name, maxMessages: cfg.behavior.maxContextMessages });

const bar = '─'.repeat(60);
console.log(`\n${bar}\nSYSTEM\n${bar}`);
console.log(system);
console.log(`\n${bar}\nUSER\n${bar}`);
console.log(user);
console.log(`\n${bar}`);
console.log(`system ${system.length} 字 / user ${user.length} 字`);
console.log(`等价 token 量级：约 ${Math.ceil((system.length + user.length) / 1.6)} tokens\n`);
