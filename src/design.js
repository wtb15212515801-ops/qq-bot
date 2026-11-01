/**
 * 结构化「设计」：名字之外的说话方式、示例、禁区。
 *
 * 存在 data/design.json（界面里的「设计」表单写入），按 mtime 缓存，
 * 这样改完下一句回复就生效，不用重启。
 */

import fs from 'node:fs';
import path from 'node:path';

let cache = { mtime: -1, data: null };

export function loadDesign(dir = 'data') {
  try {
    const file = path.join(dir, 'design.json');
    const st = fs.statSync(file);
    if (cache.data && cache.mtime === st.mtimeMs) return cache.data;
    const data = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    cache = { mtime: st.mtimeMs, data };
    return data;
  } catch {
    return null;
  }
}

const LENGTH = {
  short: '每次只回一句，尽量 15 字以内',
  normal: '每次 1~2 句，40 字以内',
  long: '可以说两层意思，但不超过 80 字',
};

const TONE = {
  gentle: '语气温和，不怼人',
  normal: '正常聊天语气',
  edgy: '可以有点毒舌、会怼回去，但不过火',
};

const EMOJI = ['基本不用 emoji', '偶尔带一个 emoji', '经常带 emoji'];

export function designLines(design) {
  if (!design) return [];
  const s = design.style || {};
  const lines = [];

  if (design.tagline) lines.push(`- 定位：${design.tagline}`);
  if (LENGTH[s.length]) lines.push(`- 长度：${LENGTH[s.length]}`);
  if (TONE[s.tone]) lines.push(`- 语气：${TONE[s.tone]}`);
  if (Number.isInteger(s.emoji) && EMOJI[s.emoji]) lines.push(`- emoji：${EMOJI[s.emoji]}`);
  if (Array.isArray(s.catchphrases) && s.catchphrases.length) lines.push(`- 口头禅：${s.catchphrases.join('、')}`);
  if (Array.isArray(s.taboo) && s.taboo.length) lines.push(`- 不要聊：${s.taboo.join('、')}`);

  return lines;
}

export function designExamples(design) {
  return ((design && design.examples) || [])
    .filter((e) => e && (e.u || e.b))
    .slice(0, 5);
}
