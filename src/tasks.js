/**
 * 后台定时任务：记忆维护、记忆压缩、主动找话题。
 *
 * 从 pipeline.js 抽出来，只依赖传进来的 pipeline 实例（pl），
 * 这样 pipeline 专注「收消息 → 决策 → 回复」，这些慢节奏的事单独放。
 */

import { buildSystemPrompt } from './context.js';
import { filterOutput, isOutputBlocked } from './safety.js';
import { TOOL_DEFS } from './tools.js';

const HOUR = 3600 * 1000;

// ---------------- 记忆维护 ----------------

export function startMaintenance(pl) {
  const hours = pl.cfg.memory?.forgetEveryHours ?? 1;
  const every = Math.max(0.5, Number(hours)) * HOUR;
  pl.maintenanceTimer = setInterval(() => runMaintenance(pl), every);
  pl.log.info(`记忆维护已开：每 ${hours} 小时遗忘 + 整理一次`);

  // 更深一层的整理：用模型压缩事实卡，默认半天一次
  const ch = Math.max(1, Number(pl.cfg.memory?.consolidateEveryHours ?? 12));
  pl.consolidateTimer = setInterval(() => {
    runConsolidate(pl, 3).catch((e) => pl.log.warn(`记忆压缩失败：${e.message}`));
  }, ch * HOUR);
  pl.log.info(`记忆压缩已开：每 ${ch} 小时处理 3 个群`);
}

export function runMaintenance(pl, now = Date.now()) {
  try {
    const forgot = pl.brain.forget(now);
    const tidied = pl.brain.tidy(now);

    // 清掉长时间没动静的群状态，释放内存
    let evicted = 0;
    for (const [key, state] of pl.states) {
      if (now - (state.lastMessageAt || 0) > 6 * HOUR) {
        pl.states.delete(key);
        evicted += 1;
      }
    }

    // 群缓存总量兜底：超过 60 个就丢掉最久没动静的
    const MaxStates = 60;
    if (pl.states.size > MaxStates) {
      const sorted = [...pl.states.entries()].sort(
        (a, b) => (a[1].lastMessageAt || 0) - (b[1].lastMessageAt || 0)
      );
      const drop = pl.states.size - MaxStates;
      for (let i = 0; i < drop; i += 1) pl.states.delete(sorted[i][0]);
      evicted += drop;
    }

    // 判定时间戳缓存同样会随群数增长
    let prunedJudges = 0;
    for (const [k, at] of pl.lastJudgeAt) {
      if (now - at > 6 * HOUR) {
        pl.lastJudgeAt.delete(k);
        prunedJudges += 1;
      }
    }

    pl.limiter.prune(now);
    pl.privateLimiter.prune(now);

    pl.store.save();
    const heapMb = (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(1);
    pl.log.info(
      `记忆维护：忘掉 ${forgot.facts} 条事实、${forgot.users} 个人、${forgot.summaries} 条摘要；` +
        `整理掉 ${tidied.junk} 条污染、${tidied.dup} 条重复、${tidied.trimmed} 条超量、${tidied.groups} 个空群；` +
        `释放 ${evicted} 个群缓存；当前 ${pl.states.size} 个群在内存，堆内存 ${heapMb}MB`
    );
    if (prunedJudges) pl.log.debug(`清理 ${prunedJudges} 条过期的判定记录`);
  } catch (e) {
    pl.log.warn(`记忆维护失败：${e.message}`);
  }
}

/** 挑几个事实卡比较多的群，交给模型压缩 */
export async function runConsolidate(pl, limit = 3) {
  const groups = pl.store.data.groups || {};
  const now = Date.now();
  const candidates = Object.entries(groups)
    .filter(([, g]) => (Array.isArray(g.facts) ? g.facts.length : 0) >= 5)
    .filter(([, g]) => now - (g.consolidatedAt || 0) > 8 * HOUR)
    .sort((a, b) => (a[1].consolidatedAt || 0) - (b[1].consolidatedAt || 0))
    .slice(0, limit);

  for (const [key, g] of candidates) {
    try {
      await pl.brain.consolidate(key);
    } catch (e) {
      pl.log.warn(`压缩 ${key} 失败：${e.message}`);
    }
    g.consolidatedAt = now;
  }

  if (candidates.length) pl.store.dirty();
  return candidates.length;
}

// ---------------- 主动找话题 ----------------

export function startProactive(pl) {
  const p = pl.cfg.proactive;
  if (!p?.enabled) return;
  const every = Math.max(10, p.checkEverySeconds ?? 60) * 1000;
  pl.proactiveTimer = setInterval(() => {
    proactiveTick(pl).catch((e) => pl.log.warn(`主动发言失败：${e.message}`));
  }, every);
  pl.log.info(`主动模式已开：冷场 ${p.idleMinutes} 分钟后可能自己起话题`);
}

export function inActiveHours(pl, now) {
  const [from, to] = pl.cfg.proactive.activeHours ?? ['09:00', '23:30'];
  const d = new Date(now);
  const m = d.getHours() * 60 + d.getMinutes();
  const parse = (s) => Number(String(s).split(':')[0]) * 60 + Number(String(s).split(':')[1]);
  const a = parse(from);
  const b = parse(to);
  return a <= b ? m >= a && m < b : m >= a || m < b;
}

export async function proactiveTick(pl) {
  const p = pl.cfg.proactive;
  const now = Date.now();
  if (!inActiveHours(pl, now)) return;

  for (const [key, state] of pl.states) {
    if (!key.startsWith('g')) continue;
    const gid = key.slice(1);
    if (!pl.cfg.groups?.[gid]) continue; // 只对配置过的群主动

    const idleMs = now - (state.lastMessageAt || 0);
    if (idleMs < (p.idleMinutes ?? 45) * 60_000) continue;

    const rec = pl.store.group(key);
    if (now - (rec.lastProactiveAt || 0) < (p.minIntervalMinutes ?? 90) * 60_000) continue;
    if (pl.inflight.has(key)) continue;

    const limiter = pl.limiter;
    if (!limiter.check(key, now).ok) continue;

    if (Math.random() > (p.chance ?? 0.4)) continue;

    await startTopic(pl, key, state, gid, now);
  }
}

async function startTopic(pl, key, state, gid, now) {
  pl.inflight.add(key);
  try {
    const mem = pl.brain.get(key);
    const group = pl.cfg.groups?.[gid] ?? {};
    const system = buildSystemPrompt({
      persona: pl.persona,
      group,
      memory: mem,
      mood: mem.mood,
      users: pl.brain.friends(),
    });

    const idleMin = Math.round((now - state.lastMessageAt) / 60_000);
    const user = [
      `群里已经安静了 ${idleMin} 分钟，没人说话。你想找点话说。`,
      '可以提一句你还记得的事，或者说说你现在的状态、突然想到的东西。',
      '不要像客服一样问「大家有什么想聊的吗」，要像随口冒出来的一句。',
      '只输出你要发的那一句，不要带名字和时间。',
    ].join('\n');

    const raw = await pl.llm.chatWithTools({
      system,
      user,
      tools: pl.cfg.tools?.enabled === false ? null : TOOL_DEFS,
    });
    const text = filterOutput(raw, { botName: pl.persona.name });
    if (!text || isOutputBlocked(text, pl.cfg)) return;

    pl.log.info(`主动开口（安静 ${idleMin} 分钟）：${text}`);
    const sent = await pl.speak({ groupId: gid }, text);
    if (!sent) return; // 没发出去就不占额度、不记时间

    pl.limiter.commit(key, now);
    state.lastSpokeAt = Date.now();
    pl.store.group(key).lastProactiveAt = Date.now();
    pl.store.dirty();
  } catch (e) {
    pl.log.warn(`起话题失败：${e.message}`);
  } finally {
    pl.inflight.delete(key);
  }
}
