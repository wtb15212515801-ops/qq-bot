/**
 * 记忆维护：定期遗忘 + 整理。
 *
 * 从 brain.js 抽出来，只依赖传入的 brain 实例（读取 store / 配置 / 事实工具），
 * 不碰模型调用，方便单独测试。
 */

import { norm, similar } from './text.js';

const DAY = 86_400_000;

/** 这个群最后一次有动静的时间，用于淘汰长期沉寂的群 */
function stampOf(g) {
  return Math.max(
    Number(g.summaryAt) || 0,
    Number(g.lastSpokeAt) || 0,
    Number(g.lastProactiveAt) || 0,
    Number(g.moodAt) || 0
  );
}

/**
 * 记忆整理：去污染、去重、限长、清空壳群。
 */
export function tidy(brain, now = Date.now()) {
  const maxFacts = brain.cfg.memory?.maxFacts ?? 12;
  const maxGroups = brain.cfg.memory?.maxGroups ?? 120;
  const groups = brain.store.data.groups || {};

  let junk = 0;
  let dup = 0;
  let trimmed = 0;
  let droppedGroups = 0;

  for (const key of Object.keys(groups)) {
    const g = groups[key];
    const before = brain._facts(g);
    const seen = new Map();
    const kept = [];

    for (const f of before) {
      const text = String(f.text).trim().slice(0, 60);
      if (brain._junk(text)) {
        junk += 1;
        continue;
      }

      const n = norm(text);
      if (!n) {
        junk += 1;
        continue;
      }

      let hit = seen.get(n);
      if (!hit) {
        for (const [k, v] of seen) {
          if (similar(k, n)) {
            hit = v;
            break;
          }
        }
      }

      if (hit) {
        dup += 1;
        if (n.length > norm(hit.text).length) hit.text = text;
        hit.at = Math.min(hit.at || f.at || now, f.at || now);
        if (f.pinned) hit.pinned = true;
        continue;
      }

      const card = { ...f, text, at: f.at || now, pinned: f.pinned === true };
      seen.set(n, card);
      kept.push(card);
    }

    kept.sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || (b.at || 0) - (a.at || 0));
    if (kept.length > maxFacts) {
      trimmed += kept.length - maxFacts;
      kept.length = maxFacts;
    }
    kept.sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || (a.at || 0) - (b.at || 0));

    g.facts = kept;

    // 事件：去重 + 只留最近 12 条
    const keptEvents = [];
    for (const e of brain._events(g)) {
      const text = String(e.text || '').trim().slice(0, 60);
      if (!text || brain._junk(text)) continue;
      if (keptEvents.some((k) => similar(norm(k.text), norm(text)))) continue;
      keptEvents.push({ text, at: e.at || now });
    }
    if (Array.isArray(g.events) || keptEvents.length > 0) g.events = keptEvents.slice(-12);
  }

  // 群太多：丢掉最久没动静的
  const entries = Object.entries(groups);
  if (entries.length > maxGroups) {
    entries.sort((a, b) => stampOf(b[1]) - stampOf(a[1]));
    for (const [key] of entries.slice(maxGroups)) {
      delete groups[key];
      droppedGroups += 1;
    }
  }

  // 空壳群：没摘要、没事实，且三天没动静
  for (const key of Object.keys(groups)) {
    const g = groups[key];
    if (g.summary || (g.facts && g.facts.length)) continue;
    if (now - stampOf(g) > 3 * DAY) {
      delete groups[key];
      droppedGroups += 1;
    }
  }

  if (junk + dup + trimmed + droppedGroups > 0) brain.store.dirty();
  return { junk, dup, trimmed, groups: droppedGroups };
}

/**
 * 定期遗忘，模拟人的记忆衰减。
 */
export function forget(brain, now = Date.now()) {
  const days = brain.cfg.memory?.forgetDays ?? 14;
  const maxUsers = brain.cfg.memory?.maxUsers ?? 200;
  const cutoff = now - days * DAY;
  let facts = 0;
  let users = 0;
  let summaries = 0;
  let events = 0;

  // 1. 太久没被提起的事实，忘掉（置顶的除外）
  for (const g of Object.values(brain.store.data.groups || {})) {
    const list = brain._facts(g);
    const kept = list.filter((f) => {
      if (f.pinned === true) return true;
      // 用「最后一次被用到的时刻」而不是「记下的时刻」：经常被想起来的事实不会过期
      const stamp = Math.max(Number(f.lastUsed) || 0, Number(f.at) || 0);
      return stamp >= cutoff;
    });
    facts += list.length - kept.length;
    g.facts = kept;

    // 事件过期就忘：事件本来就该比事实忘得快
    if (Array.isArray(g.events)) {
      const keptEvents = g.events.filter((e) => (Number(e && e.at) || 0) >= cutoff);
      events += g.events.length - keptEvents.length;
      g.events = keptEvents;
    }

    // 2. 群彻底沉寂很久，连摘要也淡出
    if (g.summary && (g.summaryAt || 0) < now - days * 2 * DAY) {
      g.summary = '';
      summaries += 1;
    }
  }

  // 3. 用户档案：好感度回归、清理久未出现的人
  const all = brain.store.data.users || {};
  const toDelete = [];
  for (const [id, u] of Object.entries(all)) {
    const base = 30;
    u.affinity = Math.round((u.affinity ?? base) + (base - (u.affinity ?? base)) * 0.15);
    if ((u.lastAt || 0) < cutoff && (u.count || 0) < 5) toDelete.push(id);
  }
  for (const id of toDelete) {
    delete all[id];
    users += 1;
  }

  // 4. 还是太多，就按最后活跃时间砍掉最老的
  const rest = Object.entries(all);
  if (rest.length > maxUsers) {
    rest.sort((a, b) => (b[1].lastAt || 0) - (a[1].lastAt || 0));
    for (const [id] of rest.slice(maxUsers)) {
      delete all[id];
      users += 1;
    }
  }

  if (facts + users + summaries + events > 0) brain.store.dirty();
  return { facts, users, summaries, events };
}
