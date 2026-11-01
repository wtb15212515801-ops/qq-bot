/**
 * 记忆检索：只把「真的相关」的事实和事件放进 prompt。
 *
 * 之前的问题：
 * - 事实数量 <= limit 时直接全给，完全不看相关性
 * - 没有相关事实时回退「前 N 条」，等于每次都塞一堆无关记忆
 * - 常见二元组（今天/什么）和稀有词同权，排序被口水词带偏
 *
 * 现在：IDF 加权 + 长度归一 + 绝对/相对双阈值 + 去重；一条都不相关就返回空。
 */

import { tokens, jaccard } from './text.js';

const DAY = 86_400_000;

function toText(item) {
  if (typeof item === 'string') return item.trim();
  if (item && typeof item.text === 'string') return item.text.trim();
  return '';
}

/**
 * @param {object} input
 * @param {Array<string|{text:string}>} input.facts
 * @param {Array<{text:string, at?:number}>} input.events
 * @param {string} input.query 当前对话（当前这句 + 最近几条 + 话题词）
 * @param {number} input.limitFacts
 * @param {number} input.limitEvents
 * @param {number} input.minScore 绝对阈值（低于它一律算不相关）
 * @param {number} input.relRatio 相对阈值（低于最高分的这个比例也丢掉）
 * @param {number} input.now
 * @returns {{facts: string[], events: object[]}}
 */
export function retrieve({
  facts = [],
  events = [],
  query = '',
  limitFacts = 6,
  limitEvents = 4,
  minScore = 0.45,
  relRatio = 0.35,
  now = Date.now(),
} = {}) {
  const queryTokens = tokens(query);
  if (!queryTokens.size) return { facts: [], events: [] };

  const factTexts = facts.map(toText).filter(Boolean);
  const eventList = (events || [])
    .map((e) => (typeof e === 'string' ? { text: e, at: 0 } : e))
    .filter((e) => e && typeof e.text === 'string' && e.text.trim());

  if (!factTexts.length && !eventList.length) return { facts: [], events: [] };

  // 语料 = 事实 + 事件，用来算 IDF：越常见的二元组权重越低
  const docs = [];
  for (const text of factTexts) docs.push(tokens(text));
  for (const e of eventList) docs.push(tokens(e.text));

  const df = new Map();
  for (const doc of docs) {
    for (const t of new Set(doc)) df.set(t, (df.get(t) || 0) + 1);
  }
  const total = docs.length;
  const idf = (t) => Math.log((total + 1) / ((df.get(t) || 0) + 1)) + 1;

  const scoredFacts = factTexts.map((text, index) => {
    const words = tokens(text);
    let sum = 0;
    for (const t of words) if (queryTokens.has(t)) sum += idf(t);
    // 长事实不该因为长而被判不相关，长度惩罚封顶到 6 个 token
    return { text, index, score: sum / Math.sqrt(Math.min(words.size || 1, 6)) };
  });

  const bestFact = scoredFacts.reduce((m, s) => Math.max(m, s.score), 0);

  // 事实不相关时不能提前返回：事件可能是 relevant 的（两者分开算）
  const picked =
    bestFact <= 0
      ? []
      : scoredFacts
          .filter((s) => s.score >= minScore && s.score >= bestFact * relRatio)
          .sort((a, b) => b.score - a.score || a.index - b.index)
          .slice(0, limitFacts)
          .sort((a, b) => a.index - b.index);

  const kept = [];
  const keptTokens = [];
  for (const item of picked) {
    const t = tokens(item.text);
    if (keptTokens.some((k) => jaccard(k, t) > 0.8)) continue;
    kept.push(item.text);
    keptTokens.push(t);
  }

  const scoredEvents = eventList.map((e, index) => {
    const words = tokens(e.text);
    let sum = 0;
    for (const t of words) if (queryTokens.has(t)) sum += idf(t);
    const base = sum / Math.sqrt(Math.min(words.size || 1, 6));
    const ageDays = Math.max(0, (now - (Number(e.at) || now)) / DAY);
    const recency = 1 + 0.3 * Math.exp(-ageDays / 7);
    return { event: e, index, score: base * recency };
  });

  const bestEvent = scoredEvents.reduce((m, s) => Math.max(m, s.score), 0);
  const eventsOut =
    bestEvent <= 0
      ? []
      : scoredEvents
          .filter((s) => s.score >= minScore * 0.9 && s.score >= bestEvent * relRatio)
          .sort((a, b) => b.score - a.score || a.index - b.index)
          .slice(0, limitEvents)
          .sort((a, b) => a.index - b.index)
          .map((s) => s.event);

  return { facts: kept, events: eventsOut };
}
