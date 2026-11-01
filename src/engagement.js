/**
 * 互动反馈学习：机器人回完一句后，对方 90 秒内有没有接着说。
 *
 * 这是画像里逻辑回归的唯一训练信号，单独放一层，
 * 主流程只负责在「收到消息」和「发送成功」时各调用一次。
 */

import { learn as learnEngage } from './profile.js';

/** 收到一条消息时：结算上一条回复的反馈，顺便清理过期样本 */
export function trackEngagement(pl, key, event, now) {
  const pk = `${key}:${event.userId}`;
  const pend = pl.pending.get(pk);
  if (pend) {
    const late = now - pend.at > 120_000;
    try {
      learnEngage(pend.profile, pend.features, late ? 0 : 1);
    } catch (e) {
      pl.log.debug(`画像学习失败：${e.message}`);
    }
    pl.pending.delete(pk);
  }

  // 长时间没回访的，判成「没接住」，顺便清理，避免 Map 无限涨
  let scanned = 0;
  for (const [k, v] of pl.pending) {
    if (scanned >= 40) break;
    scanned += 1;
    if (now - v.at > 10 * 60_000) {
      try { learnEngage(v.profile, v.features, 0); } catch { /* ignore */ }
      pl.pending.delete(k);
    }
  }
}

/** 回复成功后登记样本，等对方下一条消息来结算 */
export function rememberReply(pl, key, event, user, profile) {
  if (!profile) return;
  pl.pending.set(`${key}:${event.userId}`, {
    at: Date.now(),
    profile,
    features: {
      profile,
      affinity: user.affinity || 30,
      isQuestion: event.isQuestion === true,
      text: event.text || '',
    },
  });
}
