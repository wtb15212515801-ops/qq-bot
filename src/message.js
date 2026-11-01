/**
 * OneBot 11 消息段 <-> 纯文本。
 * QQ 的消息是「段数组」，模型只看得懂文字，所以这里做一次归一化。
 */

export function flattenSegments(segments, { selfId = 0, resolveName } = {}) {
  const out = {
    text: '',
    atSelf: false,
    atList: [],
    replyId: null,
    hasImage: false,
    images: [],
  };

  if (typeof segments === 'string') {
    out.text = segments;
    return out;
  }

  for (const seg of segments ?? []) {
    const type = seg?.type;
    const data = seg?.data ?? {};

    switch (type) {
      case 'text':
        out.text += data.text ?? '';
        break;

      case 'at': {
        const qq = String(data.qq ?? '');
        if (qq === 'all') {
          out.text += '@全体成员 ';
          break;
        }
        if (qq === String(selfId)) out.atSelf = true;
        out.atList.push(qq);
        const name = resolveName ? resolveName(qq) : null;
        out.text += `@${name || qq} `;
        break;
      }

      case 'reply':
        out.replyId = data.id != null ? String(data.id) : null;
        break;

      case 'image':
        out.hasImage = true;
        out.text += '[图片]';
        if (data.url) out.images.push(data.url);
        else if (data.file) out.images.push(data.file);
        break;

      case 'face':
        out.text += '[表情]';
        break;

      case 'mface':
        out.text += '[表情包]';
        break;

      case 'record':
        out.text += '[语音]';
        break;

      case 'video':
        out.text += '[视频]';
        break;

      case 'file':
        out.text += '[文件]';
        break;

      case 'json':
      case 'xml':
        out.text += '[卡片消息]';
        break;

      case 'forward':
        out.text += '[聊天记录]';
        break;

      case 'poke':
        out.text += '[戳一戳]';
        break;

      default:
        out.text += `[${type ?? '未知'}]`;
    }
  }

  out.text = out.text.replace(/\s+/g, ' ').trim();
  return out;
}

export function toSegments(text) {
  return [{ type: 'text', data: { text: String(text) } }];
}

export function formatClock(ms) {
  const d = new Date(ms);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}
