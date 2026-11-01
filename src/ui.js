/**
 * 给桌面应用喂数据的管道。
 * 每行是一事件，制表符分隔，C# 那边按 \t 拆。
 * 字段：时间 / 会话ID / 会话名 / 方向 / 说话人 / 内容
 */

import fs from 'node:fs';
import path from 'node:path';

export class UiFeed {
  constructor({ file, maxBytes = 400_000, logger = null }) {
    this.file = path.resolve(file);
    this.maxBytes = maxBytes;
    this.log = logger;
    this.buf = [];
    this.timer = null;

    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      if (!fs.existsSync(this.file)) fs.writeFileSync(this.file, '', 'utf8');
    } catch (e) {
      this.log?.warn(`UI 日志初始化失败：${e.message}`);
    }
  }

  emit({ chatId, chatName, kind = 'sys', who = '', text = '' }) {
    const clean = (s) => String(s ?? '').replace(/[\t\r\n]+/g, ' ').slice(0, 400);
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const time = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;

    const line = [time, clean(chatId), clean(chatName), clean(kind), clean(who), clean(text)].join('\t');
    this.buf.push(line);

    if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = null;
        this.flush();
      }, 300);
      this.timer.unref?.();
    }
  }

  flush() {
    if (!this.buf.length) return;
    const data = this.buf.join('\n') + '\n';
    this.buf = [];
    try {
      fs.appendFileSync(this.file, data, 'utf8');
      this.rotateIfNeeded();
    } catch (e) {
      this.log?.warn(`UI 日志写入失败：${e.message}`);
    }
  }

  rotateIfNeeded() {
    try {
      const st = fs.statSync(this.file);
      if (st.size < this.maxBytes) return;

      const lines = fs.readFileSync(this.file, 'utf8').split('\n').filter(Boolean);
      // 截断后必须真的小于上限，否则每次 flush 都会重写一遍整个文件
      const target = this.maxBytes * 0.8;
      let keep = Math.min(800, lines.length);

      while (keep > 1) {
        const body = lines.slice(-keep).join('\n') + '\n';
        if (body.length <= target) {
          fs.writeFileSync(this.file, body, 'utf8');
          return;
        }
        keep = Math.floor(keep / 2);
      }

      // 连单行都超限：只留最后一行并截短，保证文件一定变小
      const last = lines[lines.length - 1] || '';
      fs.writeFileSync(this.file, last.slice(0, Math.max(80, Math.floor(target))) + '\n', 'utf8');
    } catch {
      /* ignore */
    }
  }
}
