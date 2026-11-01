const fs = require('fs');
const path = require('path');

const chat = process.argv[2] || 'all';
const file = path.join(__dirname, '..', 'data', 'memory.json');

const out = { summary: '', facts: [], events: [], mood: 60, count: 0 };

try {
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  const g = (data.groups || {})[chat];
  if (g) {
    out.summary = g.summary || '';
    out.facts = (g.facts || [])
      .map((f) => (typeof f === 'string' ? { text: f, at: g.summaryAt || 0, pinned: false } : f && f.text ? { text: f.text, at: Number(f.at) || 0, pinned: f.pinned === true } : null))
      .filter(Boolean)
      .slice(0, 20);
    out.mood = typeof g.mood === 'number' ? g.mood : 60;
    out.count = g.messageCount || 0;
    out.moodAt = Number(g.moodAt) || 0;
    out.events = (g.events || [])
      .map((e) => (typeof e === 'string' ? { text: e, at: 0 } : e && e.text ? { text: e.text, at: Number(e.at) || 0 } : null))
      .filter(Boolean)
      .slice(-12);
  }
} catch (e) {
  /* 还没有记忆文件 */
}

process.stdout.write(JSON.stringify(out));
