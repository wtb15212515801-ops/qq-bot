/**
 * 图片理解：把 QQ 图片下载下来，交给多模态模型描述成一句话。
 * DeepSeek 的 chat 接口接受 image_url（base64 data URI）。
 */

const MAX_BYTES = 4 * 1024 * 1024;

/** 按文件头判断真实格式；图片服务器的 content-type 经常是错的 */
function sniffMime(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return 'image/gif';
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[8] === 0x57 && buf[9] === 0x45) return 'image/webp';
  if (buf[0] === 0x42 && buf[1] === 0x4d) return 'image/bmp';
  return null;
}

export async function describeImage({
  baseUrl,
  apiKey,
  model,
  url,
  prompt = '用一句话描述这张图的主要内容，30 字以内，不要客套',
  timeoutMs = 25000,
}) {
  if (!url) throw new Error('没有图片地址');

  let buf;
  let mime = 'image/jpeg';
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(15000),
      headers: {
        // 很多图床（含维基、QQ 图床）没 UA 会直接 400
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
        Accept: 'image/*,*/*;q=0.8',
      },
    });
    if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}`);
    mime = res.headers.get('content-type') || 'image/jpeg';
    buf = Buffer.from(await res.arrayBuffer());
  } catch (e) {
    throw new Error(`图片下载失败：${e.message}`);
  }

  if (buf.length > MAX_BYTES) throw new Error(`图片太大（${Math.round(buf.length / 1024)}KB）`);

  // 以文件头为准：图床返回的 content-type 经常是 octet-stream，直接塞进 data URI 会失败
  const sniffed = sniffMime(buf);
  if (sniffed) mime = sniffed;
  else if (!/^image\//i.test(mime)) throw new Error(`下载到的不是图片（${mime}）`);

  const dataUrl = `data:${mime};base64,${buf.toString('base64')}`;

  const body = {
    model,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url: dataUrl } },
        ],
      },
    ],
    max_tokens: 120,
    temperature: 0.2,
  };

  const res = await fetch(`${String(baseUrl).replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`视觉接口 ${res.status}: ${text.slice(0, 120)}`);
  }

  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content;
  return String(content ?? '').trim();
}
