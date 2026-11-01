/**
 * 查看机器人记住了什么。
 *
 * 用法：
 *   node tools/memory.js                # 列出所有群/私聊的记忆
 *   node tools/memory.js 578710075      # 只看某个群
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig, resolvePath } from '../src/config.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pick = (a, b) => (fs.existsSync(path.join(root, a)) ? a : b);

const cfg = loadConfig(path.join(root, pick('config.json', 'config.example.json')));
const file = path.join(resolvePath(cfg, cfg.storage?.dir || 'data'), 'memory.json');

if (!fs.existsSync(file)) {
  console.log(`还没有记忆文件：${file}\n先跑一会儿机器人，攒够消息它会自动总结。`);
  process.exit(0);
}

const data = JSON.parse(fs.readFileSync(file, 'utf8'));
const groups = data.groups || {};
const filter = process.argv[2];

const keys = Object.keys(groups).filter((k) => !filter || k.includes(filter));

if (!keys.length) {
  console.log('没有匹配的记忆。');
  process.exit(0);
}

for (const key of keys) {
  const g = groups[key];
  const name = key.startsWith('g') ? `群 ${key.slice(1)}` : `私聊 ${key.slice(1)}`;
  const mood = g.mood ?? 60;

  console.log('\n' + '='.repeat(56));
  console.log(`${name}   消息 ${g.messageCount || 0} 条   心情 ${mood}/100`);
  console.log('='.repeat(56));

  if (g.summary) {
    console.log('\n【群近况】\n' + g.summary);
  } else {
    console.log('\n【群近况】还没总结过（每攒够 N 条自动总结一次）');
  }

  if (g.facts?.length) {
    console.log('\n【记得的事】');
    g.facts.forEach((f) => console.log('  · ' + f));
  } else {
    console.log('\n【记得的事】暂无');
  }

  const bar = '█'.repeat(Math.round(mood / 5)) + '░'.repeat(20 - Math.round(mood / 5));
  console.log(`\n【心情】${bar} ${mood}`);
}

console.log();
