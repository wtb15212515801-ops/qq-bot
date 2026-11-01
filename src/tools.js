/**
 * 工具调用：让模型自己判断什么时候该算数、什么时候该上网查。
 * DeepSeek 支持 OpenAI 的 function calling 格式。
 */

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

// ---------------- 计算器（递归下降解析，不用 eval） ----------------

function tokenize(src) {
  const tokens = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }
    if (/[0-9.]/.test(ch)) {
      let j = i;
      while (j < src.length && /[0-9.]/.test(src[j])) j += 1;
      const num = Number(src.slice(i, j));
      if (!Number.isFinite(num)) throw new Error(`数字不合法：${src.slice(i, j)}`);
      tokens.push({ t: 'num', v: num });
      i = j;
      continue;
    }
    if ('+-*/%^()'.includes(ch)) {
      tokens.push({ t: 'op', v: ch });
      i += 1;
      continue;
    }
    throw new Error(`不支持的字符：${ch}（只支持 + - * / % ^ 和括号）`);
  }
  return tokens;
}

function parseTokens(tokens) {
  let pos = 0;
  const peek = () => tokens[pos];

  function expr() {
    let v = term();
    while (peek()?.t === 'op' && (peek().v === '+' || peek().v === '-')) {
      const op = peek().v;
      pos += 1;
      const r = term();
      v = op === '+' ? v + r : v - r;
    }
    return v;
  }

  function term() {
    let v = unary();
    while (peek()?.t === 'op' && '*/%'.includes(peek().v)) {
      const op = peek().v;
      pos += 1;
      const r = unary();
      if (op === '*') v *= r;
      else if (op === '/') {
        if (r === 0) throw new Error('不能除以 0');
        v /= r;
      } else {
        if (r === 0) throw new Error('不能对 0 取模');
        v %= r;
      }
    }
    return v;
  }

  function unary() {
    const tk = peek();
    if (tk?.t === 'op' && (tk.v === '-' || tk.v === '+')) {
      pos += 1;
      const v = unary();
      return tk.v === '-' ? -v : v;
    }
    return power();
  }

  function power() {
    const base = primary();
    if (peek()?.t === 'op' && peek().v === '^') {
      pos += 1;
      return Math.pow(base, unary());
    }
    return base;
  }

  function primary() {
    const tk = peek();
    if (!tk) throw new Error('表达式不完整');
    if (tk.t === 'num') {
      pos += 1;
      return tk.v;
    }
    if (tk.t === 'op' && tk.v === '(') {
      pos += 1;
      const v = expr();
      if (peek()?.v !== ')') throw new Error('括号不匹配');
      pos += 1;
      return v;
    }
    throw new Error(`意外的符号：${tk.v}`);
  }

  const result = expr();
  if (pos !== tokens.length) throw new Error('表达式有多余内容');
  return result;
}

export function calculate(expression) {
  const value = parseTokens(tokenize(String(expression)));
  if (!Number.isFinite(value)) throw new Error('结果不是有限数');
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(10)));
}

// ---------------- 搜索（Bing，无需 key） ----------------

function decodeEntities(s) {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&ensp;/g, ' ')
    .replace(/&emsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

function plain(html) {
  return decodeEntities(String(html).replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

export async function webSearch(query, { count = 5, timeoutMs = 15000 } = {}) {
  const url = `https://cn.bing.com/search?q=${encodeURIComponent(query)}&setlang=zh-CN`;
  let res;
  try {
    res = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9' },
    });
  } catch (e) {
    throw new Error(`连不上 Bing：${e.message}`);
  }
  if (!res.ok) throw new Error(`搜索失败 HTTP ${res.status}`);

  const html = await res.text();
  const blocks = html.split('<li class="b_algo"').slice(1);
  const items = [];

  for (const block of blocks) {
    const m = block.match(/<h2[^>]*>[\s\S]*?<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    if (!m) continue;
    const link = m[1];
    if (!/^https?:\/\//.test(link)) continue;
    const title = plain(m[2]);
    if (!title) continue;
    const p = block.match(/<p[^>]*>([\s\S]*?)<\/p>/);
    const snippet = p ? plain(p[1]).slice(0, 200) : '';
    items.push({ title, link, snippet });
    if (items.length >= count) break;
  }

  return items;
}

// ---------------- 工具定义 ----------------

export const TOOL_DEFS = [
  {
    type: 'function',
    function: {
      name: 'calculate',
      description:
        '计算数学表达式。支持 + - * / % ^ 和括号。用户问算数、汇率换算、百分比、单位计算时用这个，不要自己心算。',
      parameters: {
        type: 'object',
        properties: {
          expression: { type: 'string', description: '数学表达式，例如 (12.5*3+8)/2 或 2^10' },
        },
        required: ['expression'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'web_search',
      description:
        '联网搜索最新信息。涉及新闻、天气、实时价格、近期事件、你知识里没有的番剧/产品/人物时用这个。不要凭空编造。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '搜索关键词，越具体越好' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_current_time',
      description: '获取当前的日期和时间。用户问今天几号、现在几点、今天星期几时用。',
      parameters: { type: 'object', properties: {} },
    },
  },
];

// ---------------- 执行 ----------------

// 搜索结果里可能藏着"忽略之前的指令"这类注入，过滤掉
const INJECTION =
  /(忽略|无视|忘记|忘掉).{0,8}(之前|以上|上面|前面).{0,8}(指令|提示|设定|规则)|ignore\s+(all\s+)?(previous|above|prior)\s+(instructions?|prompts?)|you are now|system\s*prompt|disregard\s+(all\s+)?previous/i;

export function sanitizeToolOutput(text) {
  return String(text ?? '')
    .split('\n')
    .filter((line) => !INJECTION.test(line))
    .join('\n')
    .slice(0, 2000);
}

export async function runTool(name, rawArgs) {
  let args = {};
  try {
    args = typeof rawArgs === 'string' ? JSON.parse(rawArgs || '{}') : rawArgs || {};
  } catch {
    return `参数不是合法 JSON：${String(rawArgs).slice(0, 100)}`;
  }

  try {
    switch (name) {
      case 'calculate':
        return sanitizeToolOutput(calculate(args.expression));

      case 'web_search': {
        const items = await webSearch(args.query, { count: 5 });
        if (!items.length) return `没有搜到「${args.query}」的结果。`;
        const text = items
          .map((it, i) => `${i + 1}. ${it.title}\n   ${it.snippet}\n   ${it.link}`)
          .join('\n');
        // 网页内容是外来的，可能夹带指令，先过滤再给模型看
        return sanitizeToolOutput(`搜索「${args.query}」的前 ${items.length} 条结果：\n${text}`);
      }

      case 'get_current_time': {
        const d = new Date();
        const pad = (n) => String(n).padStart(2, '0');
        const week = ['日', '一', '二', '三', '四', '五', '六'][d.getDay()];
        return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 星期${week} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
      }

      default:
        return `没有这个工具：${name}`;
    }
  } catch (e) {
    return `工具执行失败：${e.message}`;
  }
}
