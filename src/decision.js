/**
 * 参与决策层：这条消息到底该不该回。
 * 这是「群聊像真人」最关键的一层——70% 的真人感来自「什么时候不说话」。
 */

import { relevance } from './cognition.js';

const QUESTION_MARK = /[?？]/u;
const QUESTION_WORDS =
  /(吗|呢|怎么|怎样|如何|为什么|为啥|啥|什么|哪|谁|多少|几点|能不能|可不可以|是不是|有没有|求推荐|有人吗)/u;

// 短促的反应词：如果紧跟在自己发言之后，就是在夸你 / 接你的话
const REACTION_RE =
  /^(?:6{3,}|哈{2,}|笑死|笑嘻|好耶|绝了|awsl|可以啊|牛啊|(?:好|太|真|超|这么)?(?:可爱|厉害|强|棒|赞|牛(?!奶|肉|排|皮|仔|油)))/iu;

export function containsAlias(text, aliases = []) {
  const t = String(text || '').toLowerCase();
  if (!t) return false;
  return aliases.some((a) => a && t.includes(String(a).toLowerCase()));
}

export function isQuestion(text) {
  const s = String(text || '').trim();
  if (!s || s.length > 120) return false;
  return QUESTION_MARK.test(s) || QUESTION_WORDS.test(s);
}

export function keywordHits(text, words = []) {
  const t = String(text || '');
  return words.filter((w) => w && t.includes(w));
}

/**
 * @returns {{score:number, threshold:number, reasons:string[], spontaneous:boolean, shouldReply:boolean}}
 */
export function evaluateDecision({ event, state, persona, behavior, now = Date.now(), cognition = null }) {
  const reasons = [];
  let score = 0;
  const text = event.text || '';

  if (event.atSelf) {
    // 被 @ 是最高优先级，任何档位都要回
    score += 20;
    reasons.push('被@');
  }

  if (event.replyToSelf) {
    score += 18;
    reasons.push('被回复');
  }

  if (!event.atSelf && containsAlias(text, persona.aliases)) {
    // 直接叫名字等于点名，同样要回；不能被阈值挡住
    score += 14;
    reasons.push('提到我');
  }

  if (isQuestion(text)) {
    // 有人在问问题，接一句很自然
    score += 4;
    reasons.push('问句');
  }

  const hits = keywordHits(text, persona.interests);
  if (hits.length) {
    // 聊到它关心的东西，它会忍不住凑过去
    score += Math.min(7, 4.2 + (hits.length - 1) * 1.8);
    reasons.push(`话题:${hits.join('/')}`);
  }

  // 刚说完就被夸 / 被接话：这类短促反应要接住，不然很像机器人
  const sinceSpoke = now - (state.lastSpokeAt || 0);
  const trimmed = text.trim();
  if (sinceSpoke < 60_000 && trimmed.length > 0 && trimmed.length <= 12 && REACTION_RE.test(trimmed)) {
    score += 9;
    reasons.push('在夸我');
  }

  // 冷场一段时间后，小概率主动插一句；聊到它关心的东西时更忍不住
  let spontaneous = false;
  const idleMs = now - (state.lastSpokeAt || 0);
  const cooldownMs = (behavior.spontaneousCooldownSec ?? 180) * 1000;
  let chance = behavior.spontaneousChance ?? 0;
  if (hits.length) chance = Math.min(0.5, chance * 2.5);
  if (!event.atSelf && idleMs > cooldownMs && Math.random() < chance) {
    spontaneous = true;
    score += 9;
    reasons.push(hits.length ? '想插话(话题相关)' : '随机插话');
  }

  // 认知层信号：在聊什么、在跟谁说、有没有人一直刷
  if (cognition) {
    if (cognition.directedElsewhere) {
      // 明显在 @ 别人 / 跟别人说话，别抢话
      score -= 3;
      reasons.push('在跟别人说');
    }

    const rel = relevance(text, cognition.topics || []);
    if (rel > 0) {
      // 接着刚才的话题说，比突然插一句自然
      score += rel * 2.2;
      reasons.push('接着聊');
    }

    if (cognition.speakerStreak >= 4) {
      // 同一个人连着刷四条，先让子弹飞一会儿
      score -= 1.2;
      reasons.push('一人刷屏');
    }

    if (cognition.directedAtBot && !event.atSelf) {
      // 最近三句里提到过我，接话的把握更大
      score += 1.2;
      reasons.push('刚在说我');
    }
  }

  // 抖动：让同样的输入不会每次都做同样判断
  score += Math.random() * 1.2;

  const threshold = behavior.replyThreshold ?? 8.5;

  return {
    score: Number(score.toFixed(2)),
    threshold,
    reasons,
    spontaneous,
    shouldReply: score >= threshold,
  };
}
