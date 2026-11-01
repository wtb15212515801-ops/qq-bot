// 机器人没运行时，直接从磁盘清长期记忆（摘要 / 事实 / 事件 / 心情）。
// 用法：node tools/memclear.cjs <g123|p456|*>
const fs = require('fs');
const path = require('path');

const chat = process.argv[2] || '*';
const file = path.join(__dirname, '..', 'data', 'memory.json');
const now = Date.now();

try {
  if (!fs.existsSync(file)) {
    process.stdout.write(JSON.stringify({ ok: true, cleared: 0 }));
    process.exit(0);
  }

  const data = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  const groups = data.groups || {};
  const keys = chat === '*' ? Object.keys(groups) : [chat];
  let cleared = 0;

  for (const key of keys) {
    const g = groups[key];
    if (!g) continue;
    g.summary = '';
    g.summaryAt = 0;
    g.facts = [];
    if (Array.isArray(g.events)) g.events = [];
    g.mood = 60;
    g.moodAt = now;
    g.summarizedCount = g.messageCount || 0;
    cleared += 1;
  }

  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, file);

  process.stdout.write(JSON.stringify({ ok: true, cleared }));
} catch (e) {
  process.stdout.write(JSON.stringify({ ok: false, error: String((e && e.message) || e) }));
  process.exitCode = 1;
}
