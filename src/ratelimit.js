/**
 * 频率控制：冷却时间 + 每分钟/每小时上限。
 * 既是拟真需要（真人不会每 3 秒一条），也是保命需要（QQ 风控）。
 */
export class RateLimiter {
  constructor(cfg = {}) {
    this.cfg = {
      minGapSeconds: cfg.minGapSeconds ?? 15,
      maxPerMinute: cfg.maxPerMinute ?? 3,
      maxPerHour: cfg.maxPerHour ?? 12,
    };
    this.windows = new Map();
  }

  _entry(key) {
    if (!this.windows.has(key)) this.windows.set(key, { hits: [], last: 0 });
    return this.windows.get(key);
  }

  check(key, now = Date.now()) {
    const e = this._entry(key);
    e.hits = e.hits.filter((t) => now - t < 3_600_000);

    if (e.last && now - e.last < this.cfg.minGapSeconds * 1000) {
      return { ok: false, reason: `冷却中（${this.cfg.minGapSeconds}s）` };
    }
    const perMinute = e.hits.filter((t) => now - t < 60_000).length;
    if (perMinute >= this.cfg.maxPerMinute) return { ok: false, reason: '每分钟上限' };
    if (e.hits.length >= this.cfg.maxPerHour) return { ok: false, reason: '每小时上限' };

    return { ok: true };
  }

  commit(key, now = Date.now()) {
    const e = this._entry(key);
    e.hits.push(now);
    e.last = now;
  }

  /** 清理一小时没动静的会话记录，避免 Map 无限增长 */
  prune(now = Date.now()) {
    let removed = 0;
    for (const [key, e] of this.windows) {
      const recent = e.hits.filter((t) => now - t < 3_600_000);
      if (!recent.length && now - (e.last || 0) > 3_600_000) {
        this.windows.delete(key);
        removed += 1;
      }
    }
    return removed;
  }
}
