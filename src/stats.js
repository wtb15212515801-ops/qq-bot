/**
 * 命中率统计：按小时记「收到多少条 / 回了多少条 / 放弃多少条」。
 * 桌面界面读这个文件画曲线。
 */

import fs from 'node:fs';
import path from 'node:path';

const KEEP_HOURS = 72;

function hourKey(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}`;
}

export class Stats {
  constructor({ file, logger = null }) {
    this.file = path.resolve(file);
    this.log = logger;
    this.data = { hours: {} };
    this.timer = null;
  }

  load() {
    try {
      if (fs.existsSync(this.file)) {
        const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        if (raw && typeof raw === 'object' && raw.hours) this.data = raw;
      }
    } catch (e) {
      try { fs.renameSync(this.file, `${this.file}.corrupt`); } catch { /* ignore */ }
      this.log?.warn(`统计文件损坏，已备份并重置：${e.message}`);
      this.data = { hours: {} };
    }
    return this;
  }

  bump(kind, now = Date.now()) {
    const key = hourKey(new Date(now));
    const b = (this.data.hours[key] ??= { received: 0, replied: 0, dropped: 0 });
    b[kind] = (b[kind] || 0) + 1;
    this.dirty();
  }

  /** 丢掉太老的桶，保持文件小 */
  prune(now = Date.now()) {
    const cutoff = hourKey(new Date(now - KEEP_HOURS * 3600 * 1000));
    let removed = 0;
    for (const k of Object.keys(this.data.hours)) {
      if (k < cutoff) {
        delete this.data.hours[k];
        removed += 1;
      }
    }
    return removed;
  }

  dirty() {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.save();
    }, 3000);
    this.timer.unref?.();
  }

  save() {
    try {
      this.prune();
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.data), 'utf8');
    } catch (e) {
      this.log?.warn(`写统计失败：${e.message}`);
    }
  }

  /** 最近 N 小时的序列，没有数据的钟点补 0 */
  series(hours = 24, now = Date.now()) {
    const out = [];
    for (let i = hours - 1; i >= 0; i -= 1) {
      const d = new Date(now - i * 3600 * 1000);
      const key = hourKey(d);
      const b = this.data.hours[key] || {};
      out.push({
        hour: key,
        label: key.slice(11) + ':00',
        received: b.received || 0,
        replied: b.replied || 0,
        dropped: b.dropped || 0,
      });
    }
    return out;
  }
}
