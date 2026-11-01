/**
 * 测模型压缩：拿真实的 memory.json 跑一次 consolidate，看看效果。
 * 用法：node tools/test-consolidate.js [群key] [--apply]
 */
import fs from 'node:fs';
import path from 'node:path';
import { createLogger } from '../src/logger.js';
import { Store } from '../src/memory.js';
import { Brain } from '../src/brain.js';
import { LLM } from '../src/llm.js';

const key = process.argv[2] || 'g1090200232';
const apply = process.argv.includes('--apply');
const root = path.resolve('.');
const cfg = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8'));
const log = createLogger({ level: 'warn' });

const store = new Store(path.join(root, 'data', 'memory.json'), log).load();
const llm = new LLM(cfg.llm, log);
const brain = new Brain({ cfg, llm, store, logger: log });

const g = store.group(key);
const before = (g.facts || []).map((f) => (typeof f === 'string' ? f : f.text));

console.log(`=== ${key} 压缩前 ${before.length} 条 ===`);
for (const t of before) console.log(`  · ${t}`);

const ok = await brain.consolidate(key);
const after = (g.facts || []).map((f) => (typeof f === 'string' ? f : f.text));

console.log(`\n=== 压缩后 ${after.length} 条（${ok ? '成功' : '未触发'}） ===`);
for (const t of after) console.log(`  · ${t}`);

if (apply) {
  store.save();
  console.log('\n已写回 memory.json');
} else {
  console.log('\n预演模式，未写盘（加 --apply 才写）');
}
