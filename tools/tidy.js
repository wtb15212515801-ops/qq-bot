/**
 * 记忆整理体检：对现有 memory.json 跑一遍 tidy + forget，打印前后对比。
 * 用法：node tools/tidy.js [--apply]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLogger } from '../src/logger.js';
import { Store } from '../src/memory.js';
import { Brain } from '../src/brain.js';

const apply = process.argv.includes('--apply');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cfg = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8'));
const log = createLogger({ level: 'warn' });

const store = new Store(path.join(root, 'data', 'memory.json'), log).load();
const brain = new Brain({ cfg, llm: null, store, logger: log });

function snapshot() {
  const groups = store.data.groups || {};
  let facts = 0;
  const per = {};
  for (const [k, g] of Object.entries(groups)) {
    const list = Array.isArray(g.facts) ? g.facts : [];
    facts += list.length;
    per[k] = list.length;
  }
  return { groups: Object.keys(groups).length, facts, per, users: Object.keys(store.data.users || {}).length };
}

const before = snapshot();
console.log('=== 整理前 ===');
console.log(`  群 ${before.groups} 个 / 事实 ${before.facts} 条 / 用户 ${before.users} 个`);
for (const [k, v] of Object.entries(before.per)) console.log(`    ${k}: ${v} 条事实`);

const tidied = brain.tidy();
const forgot = brain.forget();

const after = snapshot();
console.log('=== 整理后 ===');
console.log(`  群 ${after.groups} 个 / 事实 ${after.facts} 条 / 用户 ${after.users} 个`);
for (const [k, v] of Object.entries(after.per)) console.log(`    ${k}: ${v} 条事实`);

console.log('=== 明细 ===');
console.log(`  删除污染事实 ${tidied.junk} 条`);
console.log(`  合并重复事实 ${tidied.dup} 条`);
console.log(`  超出上限裁剪 ${tidied.trimmed} 条`);
console.log(`  清空空群 ${tidied.groups} 个`);
console.log(`  过期遗忘 ${forgot.facts} 条 / 用户 ${forgot.users} 个 / 摘要 ${forgot.summaries} 条`);

if (apply) {
  store.save();
  const size = fs.statSync(path.join(root, 'data', 'memory.json')).size;
  console.log(`=== 已写回，文件 ${(size / 1024).toFixed(1)} KB ===`);
} else {
  console.log('=== 预演模式，未写盘（加 --apply 才写） ===');
}

for (const [k, g] of Object.entries(store.data.groups || {})) {
  const list = (g.facts || []).map((f) => (typeof f === 'string' ? f : f.text));
  console.log(`\n[${k}] 摘要：${(g.summary || '（无）').slice(0, 60)}`);
  for (const t of list) console.log(`   · ${t}`);
}
