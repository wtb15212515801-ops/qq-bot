import fs from 'node:fs';
import path from 'node:path';

/**
 * 极简持久化：JSON 文件 + 防抖写盘。
 * 够用了，不要一上来就上数据库。
 */
export class Store {
  constructor(file, logger) {
    this.file = path.resolve(file);
    this.log = logger;
    this.data = { version: 1, groups: {}, stats: { replied: 0, dropped: 0 } };
    this.timer = null;
  }

  load() {
    try {
      if (fs.existsSync(this.file)) {
        const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        this.data = { ...this.data, ...raw };
        this.data.groups ??= {};
        this.data.stats ??= { replied: 0, dropped: 0 };
      }
    } catch (e) {
      // 损坏的文件留个副本，别让下一次落盘直接覆盖掉还能救的数据
      try { fs.renameSync(this.file, `${this.file}.corrupt`); } catch { /* ignore */ }
      this.log?.warn(`记忆文件损坏，已备份为 memory.json.corrupt 并重置：${e.message}`);
      this.data = { version: 1, groups: {}, stats: { replied: 0, dropped: 0 } };
    }
    return this;
  }

  group(key) {
    this.data.groups[key] ??= {
      summary: '',
      facts: [],
      summarizedCount: 0,
      lastSpokeAt: 0,
      lastProactiveAt: 0,
      messageCount: 0,
      mood: 60,
      moodAt: 0,
    };
    return this.data.groups[key];
  }

  bump(key, field, by = 1) {
    const g = this.group(key);
    g[field] = (g[field] || 0) + by;
    this.dirty();
  }

  dirty() {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.save();
    }, 2000);
    this.timer.unref?.();
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8');
      fs.renameSync(tmp, this.file);
    } catch (e) {
      this.log?.error(`写记忆失败：${e.message}`);
    }
  }
}
