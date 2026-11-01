/**
 * 轻量理解层：不额外调用模型，靠文本统计和对话结构回答三个问题：
 *
 * 1. 现在在聊什么（关键词）
 * 2. 有没有一个还没人接的问题
 * 3. 这句话是在跟我说，还是在跟别人说
 *
 * 它只产出信号，不替模型做决定：决策层拿它加减分，prompt 拿它补充上下文。
 * 全部是纯函数，方便单测，也不增加任何 API 成本。
 */

import { tokens, looksQuestion } from './text.js';
import { retrieve } from './retrieval.js';

export { tokens, looksQuestion };

/**
 * 按「出现次数 × 时间衰减」给窗口内的词打分。
 * @returns {Map<string, number>}
 */
export function scoreKeywords(messages = [], { now = Date.now(), windowMs = 6 * 60_000 } = {}) {
  const scores = new Map();
  for (const m of messages) {
    const text = m?.text;
    if (!text) continue;
    const at = m.receivedAt || m.time || now;
    const age = Math.max(0, now - at);
    if (age > windowMs) continue;

    const weight = 1 / (1 + age / 240_000);
    for (const token of tokens(text)) {
      scores.set(token, (scores.get(token) || 0) + weight);
    }
  }
  return scores;
}

/** 当前话题：出现至少两次（含衰减）的词，按权重取前几个。 */
export function topKeywords(messages = [], { now = Date.now(), windowMs = 6 * 60_000, limit = 5 } = {}) {
  const scores = scoreKeywords(messages, { now, windowMs });
  return [...scores.entries()]
    .filter(([token, score]) => score >= 1.0 && token.length >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([token]) => token);
}

/** 一段话和当前话题的贴合程度，0~1。 */
export function relevance(text, keywords = []) {
  const list = keywords.filter(Boolean);
  if (!list.length) return 0;
  const words = tokens(text);
  if (!words.size) return 0;

  let hit = 0;
  for (const keyword of list) if (words.has(keyword)) hit += 1;
  return Math.min(1, hit / Math.min(3, list.length));
}

/**
 * 兼容旧接口：只挑事实，内部走 retrieval（IDF + 阈值 + 去重）。
 * 不相关时返回空数组，不再「反正不够就全给」。
 */
export function pickRelevantFacts(facts = [], contextText = '', limit = 8) {
  return retrieve({ facts, query: contextText, limitFacts: limit }).facts;
}

function isBotMessage(m, botId) {
  return botId !== 0 && String(m?.userId) === String(botId);
}

/** 这句是不是明显在跟「别人」说（@了别人 / 「张三 你…」）。 */
function directedElsewhere(text, botAliases = []) {
  const s = String(text || '').trim();
  if (!s) return false;

  const at = /^\[?@([^\s\]：:,，]{1,12})/.exec(s);
  if (at) return !botAliases.some((a) => a && at[1].includes(a));

  const named = /^([^\s，,：:!?！？]{1,8})[，,\s]*(你|您)(?!们)/.exec(s);
  if (named) return !botAliases.some((a) => a && named[1].includes(a));

  return false;
}

/**
 * 一次对话窗口的结构化理解。
 *
 * @returns {{
 *   topics: string[],
 *   openQuestion: {text:string, from:string, ageMs:number} | null,
 *   directedAtBot: boolean,
 *   directedElsewhere: boolean,
 *   speakerStreak: number,
 *   ratePerMinute: number,
 *   botSpokeRecently: boolean,
 * }}
 */
export function analyzeConversation({
  messages = [],
  botId = 0,
  botAliases = [],
  now = Date.now(),
  windowMs = 6 * 60_000,
  topicLimit = 5,
} = {}) {
  const recent = messages
    .filter((m) => m && (now - (m.receivedAt || m.time || 0)) <= windowMs)
    .slice(-14);

  // 话题只看「当前这句之前」的记录：否则这句话一定会和自己相关，
  // 等于给每条消息都白送一次「接着聊」加分。
  const topicMessages = recent.length > 1 ? recent.slice(0, -1) : [];
  const topics = topKeywords(topicMessages, { now, windowMs, limit: topicLimit });

  // 最后一个「人」问的问题，后面没有机器人回过，就算还挂着
  let openQuestion = null;
  for (let i = recent.length - 1; i >= 0; i -= 1) {
    const m = recent[i];
    if (!m.text || isBotMessage(m, botId)) continue;
    const asks = typeof m.isQuestion === 'boolean' ? m.isQuestion : looksQuestion(m.text);
    if (!asks) continue;

    const answered = recent.slice(i + 1).some((x) => isBotMessage(x, botId));
    if (!answered) {
      openQuestion = {
        text: String(m.text).slice(0, 60),
        from: m.nickname || String(m.userId),
        userId: String(m.userId),
        ageMs: Math.max(0, now - (m.receivedAt || m.time || now)),
      };
    }
    break;
  }

  const tail = recent.slice(-3);
  const directedAtBot = tail.some(
    (m) => m.atSelf === true || m.replyToSelf === true || botAliases.some((a) => a && String(m.text || '').includes(a))
  );

  const lastHuman = [...recent].reverse().find((m) => !isBotMessage(m, botId));
  const elsewhere = lastHuman ? directedElsewhere(lastHuman.text, botAliases) : false;

  // 连续同一个人的条数（从末尾往前数，跳过机器人）
  let speakerStreak = 0;
  let streakUser = null;
  for (let i = recent.length - 1; i >= 0; i -= 1) {
    const m = recent[i];
    if (isBotMessage(m, botId)) continue;
    if (streakUser === null) {
      streakUser = String(m.userId);
      speakerStreak = 1;
      continue;
    }
    if (String(m.userId) !== streakUser) break;
    speakerStreak += 1;
  }

  const minuteAgo = now - 60_000;
  const ratePerMinute = recent.filter((m) => (m.receivedAt || m.time || 0) >= minuteAgo).length;
  const botSpokeRecently = recent.some(
    (m) => isBotMessage(m, botId) && now - (m.receivedAt || m.time || 0) <= 90_000
  );

  return {
    topics,
    openQuestion,
    directedAtBot,
    directedElsewhere: elsewhere,
    speakerStreak,
    ratePerMinute,
    botSpokeRecently,
  };
}
