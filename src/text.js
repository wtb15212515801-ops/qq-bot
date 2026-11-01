/**
 * 文本切分：中文二元组 + 英文单词。
 * 单独放一层，避免「理解层」和「检索层」互相 import。
 */

export const STOPWORDS = new Set([
  '这个', '那个', '什么', '怎么', '就是', '不是', '可以', '我们', '你们', '他们',
  '自己', '现在', '今天', '明天', '昨天', '一个', '一下', '没有', '知道', '觉得',
  '真的', '不过', '然后', '还是', '因为', '所以', '但是', '如果', '已经', '这样',
  '那样', '感觉', '应该', '可能', '一点', '有点', '比较', '非常', '东西', '时候',
  '地方', '事情', '其实', '而且', '或者', '还有', '只是', '起来', '出来', '进去',
  '一样', '一起', '一直', '一定', '不太', '不会', '不能', '是不是', '有没有',
  '哈哈哈', '哈哈', '呵呵', '嗯嗯', '好的', '收到', '谢谢', '拜拜',
]);

const CJK_RUN = /[\u4e00-\u9fa5]+/g;
const LATIN_WORD = /[a-z][a-z0-9_]{1,}/g;
const QUESTION_MARK = /[?？]/u;
const QUESTION_WORDS =
  /(吗|呢|怎么|怎样|如何|为什么|为啥|啥|什么|哪|谁|多少|几点|能不能|可不可以|是不是|有没有|求推荐|有人吗)/u;

/** 把一段话切成可比较的 token：中文二元组 + 英文单词。 */
export function tokens(text) {
  const out = new Set();
  const s = String(text || '').toLowerCase();
  if (!s) return out;

  for (const run of s.match(CJK_RUN) || []) {
    if (run.length === 1) continue;
    for (let i = 0; i < run.length - 1; i += 1) {
      const gram = run.slice(i, i + 2);
      if (!STOPWORDS.has(gram)) out.add(gram);
    }
  }
  for (const word of s.match(LATIN_WORD) || []) {
    if (!STOPWORDS.has(word)) out.add(word);
  }
  return out;
}

/** 问句判断（和决策层保持一致，这里独立一份避免循环依赖）。 */
export function looksQuestion(text) {
  const s = String(text || '').trim();
  if (!s || s.length > 120) return false;
  return QUESTION_MARK.test(s) || QUESTION_WORDS.test(s);
}

/** 归一化：去掉空白和标点，用来判重 */
export function norm(text) {
  return String(text)
    .replace(/[\s，。！？、,.!?~～…·「」『』“”"'（）()【】\[\]:：;；-]/g, '')
    .toLowerCase();
}

/** 字符二元组 */
export function bigrams(s) {
  const set = new Set();
  for (let i = 0; i < s.length - 1; i += 1) set.add(s.slice(i, i + 2));
  return set;
}

/** 两条文本是不是在说同一件事（包含关系或二元组重合度 > 0.6） */
export function similar(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  if (a.length >= 4 && b.length >= 4 && (a.includes(b) || b.includes(a))) return true;

  const A = bigrams(a);
  const B = bigrams(b);
  if (!A.size || !B.size) return false;

  let inter = 0;
  for (const x of A) if (B.has(x)) inter += 1;

  const union = A.size + B.size - inter;
  return union > 0 && inter / union >= 0.55;
}

/** 两个 token 集合的 Jaccard 相似度 */
export function jaccard(a, b) {
  if (!a || !b || !a.size || !b.size) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter += 1;
  return inter / (a.size + b.size - inter);
}
