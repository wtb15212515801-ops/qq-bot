/**
 * 表情表达：emoji 和表情包图片。
 *
 * 设计原则：宁可少发，不要每句都带。
 * - emoji 只在没有 emoji 的句子里按概率补一个，且跟心情对得上
 * - 表情包有冷却时间，且必须有图库素材才会发
 */

import fs from 'node:fs';
import path from 'node:path';

const EMOJI_RE = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/u;

// 心情 → emoji 池
const EMOJI_BY_MOOD = [
  { min: 78, list: ['😆', '🥳', '😋', '✨', '🍟', '🤤'] },
  { min: 62, list: ['😊', '🙂', '😌', '🌸', '👌'] },
  { min: 45, list: ['😐', '😶', '🤔', '😅'] },
  { min: 30, list: ['😔', '🥲', '😞', '💧'] },
  { min: 0, list: ['😤', '🙄', '😑', '💢'] },
];

// 心情 → 表情包文件夹
const FOLDER_BY_MOOD = [
  { min: 78, name: 'happy' },
  { min: 58, name: 'calm' },
  { min: 42, name: 'shy' },
  { min: 26, name: 'sad' },
  { min: 0, name: 'angry' },
];

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);

function pickFrom(list) {
  return list[Math.floor(Math.random() * list.length)];
}

function bandFor(mood, bands) {
  const m = Number.isFinite(mood) ? mood : 60;
  for (const b of bands) if (m >= b.min) return b;
  return bands[bands.length - 1];
}

/** 句子已经有表情了就别再加 */
export function hasEmoji(text) {
  return EMOJI_RE.test(String(text || ''));
}

/**
 * 按概率给句子补一个 emoji。返回新句子（可能不变）。
 */
export function decorateEmoji(text, { mood = 60, chance = 0.3 } = {}) {
  const s = String(text || '');
  if (!s || chance <= 0) return s;
  if (hasEmoji(s)) return s;
  if (s.length < 2) return s;
  if (Math.random() > chance) return s;

  const band = bandFor(mood, EMOJI_BY_MOOD);
  return s + pickFrom(band.list);
}

export class StickerBook {
  constructor({ dir, logger = null }) {
    this.dir = path.resolve(dir);
    this.log = logger;
    this.cache = new Map();
    this.lastScan = 0;
    this.scanned = false;
  }

  /** 扫描图库；文件有增减时自动刷新（最多 30 秒查一次） */
  scan(now = Date.now(), force = false) {
    if (!force && this.scanned && now - this.lastScan < 30_000) return;
    this.lastScan = now;
    this.scanned = true;

    this.cache = new Map();
    let entries = [];
    try {
      entries = fs.readdirSync(this.dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      const folder = path.join(this.dir, ent.name);
      let files = [];
      try {
        files = fs
          .readdirSync(folder, { withFileTypes: true })
          .filter((f) => f.isFile() && IMAGE_EXT.has(path.extname(f.name).toLowerCase()))
          .map((f) => path.join(folder, f.name));
      } catch {
        continue;
      }
      if (files.length) this.cache.set(ent.name.toLowerCase(), files);
    }
  }

  /** 总共有多少张 */
  get size() {
    let n = 0;
    for (const list of this.cache.values()) n += list.length;
    return n;
  }

  /** 按心情挑一张，没有素材返回 null */
  pick(mood, now = Date.now()) {
    this.scan(now);
    if (!this.cache.size) return null;

    const band = bandFor(mood, FOLDER_BY_MOOD);
    let list = this.cache.get(band.name);

    // 对应心情没有素材就随便找一个有的
    if (!list || !list.length) {
      const all = [...this.cache.values()];
      list = all[Math.floor(Math.random() * all.length)];
    }
    if (!list || !list.length) return null;
    return pickFrom(list);
  }
}

/** 本地路径转成 NapCat 能识别的 file URI */
export function toFileUri(file) {
  const abs = path.resolve(file).replace(/\\/g, '/');
  return `file:///${abs.replace(/^\/+/, '')}`;
}
