/**
 * 档位接话率体检：不用模型、不用 QQ，直接统计每个档位对各类消息的接话概率。
 * 用法：node tools/level-check.js
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.js';
import { evaluateDecision } from '../src/decision.js';
import { LEVEL_ORDER } from '../src/presets.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TRIALS = 400;

const baseCfg = loadConfig(path.join(root, 'config.json'));
const persona = {
  name: baseCfg.persona.name,
  aliases: baseCfg.persona.aliases,
  interests: baseCfg.persona.interests,
};

const samples = [
  { name: '@ 它', event: { text: '在吗', atSelf: true }, warm: false },
  { name: '叫名字', event: { text: `${persona.name}你在干嘛`, atSelf: false }, warm: false },
  { name: '普通问句', event: { text: '明天去哪吃饭', atSelf: false }, warm: false },
  { name: '聊兴趣', event: { text: '我想吃薯片', atSelf: false }, warm: false },
  { name: '普通闲聊', event: { text: '今天上班好累', atSelf: false }, warm: false },
  { name: '被夸', event: { text: '好可爱', atSelf: false }, warm: true },
];

function rate(behavior, sample) {
  const now = 10_000_000;
  const state = { lastSpokeAt: sample.warm ? now - 5_000 : 0 };
  let hit = 0;
  for (let i = 0; i < TRIALS; i += 1) {
    const d = evaluateDecision({
      event: { ...sample.event, replyToSelf: false },
      state,
      persona,
      behavior,
      now,
    });
    if (d.shouldReply) hit += 1;
  }
  return Math.round((hit / TRIALS) * 100);
}

/** 用临时目录生成只改了档位的配置，不污染项目目录 */
function loadLevel(level) {
  const raw = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8'));
  raw.behavior = { ...raw.behavior, replyLevel: level };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'level-'));
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, JSON.stringify(raw, null, 2));
  const c = loadConfig(file);
  fs.rmSync(dir, { recursive: true, force: true });
  return c;
}

/** 中文按两个字符宽度对齐 */
function width(s) {
  return [...String(s)].reduce((n, ch) => n + (ch.charCodeAt(0) > 255 ? 2 : 1), 0);
}

function pad(s, w) {
  return String(s) + ' '.repeat(Math.max(0, w - width(s)));
}

const header = ['档位', '阈值', ...samples.map((s) => s.name), '平均'];
// 每列按表头宽度和「100%」这类内容取最大，中文按双宽算
const colW = header.map((h) => Math.max(width(h), 6));

const rows = LEVEL_ORDER.map((lv) => {
  const c = loadLevel(lv);
  const cols = samples.map((s) => rate(c.behavior, s));
  const avg = Math.round(cols.reduce((a, x) => a + x, 0) / cols.length);
  return { lv, threshold: c.behavior.replyThreshold, cols, avg, limits: c.limits };
});

console.log(`接话率，每格采样 ${TRIALS} 次\n`);
console.log(header.map((h, i) => pad(h, colW[i])).join('  '));
console.log('-'.repeat(76));
for (const r of rows) {
  const cells = [pad(r.lv, colW[0]), pad(r.threshold, colW[1])];
  r.cols.forEach((v, i) => cells.push(pad(v + '%', colW[i + 2])));
  cells.push(pad(r.avg + '%', colW.at(-1)));
  console.log(cells.join('  '));
}

console.log('\n限流：');
for (const r of rows) {
  const l = r.limits;
  console.log(
    `  ${pad(r.lv, 8)}冷却 ${String(l.minGapSeconds).padStart(3)}s` +
      `  每分钟 ${String(l.maxPerMinute).padStart(2)}` +
      `  每小时 ${String(l.maxPerHour).padStart(2)}`
  );
}
