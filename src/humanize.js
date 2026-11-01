/**
 * 拟人化：延迟、打字时间、把一段话拆成多条短消息。
 * 这些参数比 prompt 更影响「像不像真人」。
 */

export const rand = (min, max) => min + Math.random() * (max - min);

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));

/** 读消息的延迟：假装刚看到 */
export function readDelay(timing) {
  const scale = timing.scale ?? 1;
  return Math.round(rand(timing.readDelayMs[0], timing.readDelayMs[1]) * scale);
}

/** 打字延迟：按字数算，封顶 */
export function typingDelay(text, timing) {
  const scale = timing.scale ?? 1;
  const perChar = rand(timing.typingMsPerChar[0], timing.typingMsPerChar[1]);
  const ms = Math.min(timing.typingMaxMs, text.length * perChar);
  return Math.round(ms * scale);
}

/** 两条消息之间的停顿 */
export function gapDelay(timing) {
  const scale = timing.scale ?? 1;
  return Math.round(rand(timing.gapBetweenSegmentsMs[0], timing.gapBetweenSegmentsMs[1]) * scale);
}

/**
 * 把一段回复切成多条，模拟真人连着发几条短消息。
 * 优先在标点处切，切不动就硬切。
 */
export function splitReply(text, timing) {
  const clean = String(text ?? '')
    .replace(/\r/g, '')
    .replace(/\n+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!clean) return [];

  const maxChars = timing.maxCharsPerSegment ?? 45;
  const maxSegments = timing.maxSegments ?? 3;

  const parts = hardSplit(clean, maxChars);

  // 段数超了就合并到上一段，避免刷屏
  while (parts.length > maxSegments) {
    const last = parts.pop();
    parts[parts.length - 1] += last;
  }

  return parts.filter(Boolean);
}

function hardSplit(text, maxChars) {
  const out = [];
  let rest = text;

  while (rest.length > maxChars) {
    let cut = -1;
    for (const m of rest.matchAll(/[，,、；;。！？!?…~～]/gu)) {
      if (m.index + 1 > maxChars) break;
      cut = m.index + 1;
    }
    if (cut <= 0) cut = maxChars;
    // 别把 emoji 这类代理对从中间切开，否则会变成乱码
    if (cut > 1 && cut < rest.length) {
      const code = rest.charCodeAt(cut - 1);
      if (code >= 0xd800 && code <= 0xdbff) cut -= 1;
    }
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }

  if (rest) out.push(rest);
  return out;
}
