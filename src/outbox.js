/**
 * 发件箱：桌面界面写、机器人读。
 *
 * 为什么用文件而不是让界面直连 OneBot：
 * 界面进程和机器人进程是分开的，机器人持有唯一的 WebSocket 连接。
 * 用一行一个 JSON 的文件做单向队列，简单、跨进程、崩了也不丢。
 */

import fs from 'node:fs';
import path from 'node:path';

export class Outbox {
  constructor({ file, logger = null, onSend, intervalMs = 800 }) {
    this.file = path.resolve(file);
    this.log = logger;
    this.onSend = onSend;
    this.intervalMs = intervalMs;
    this.offset = 0;
    this.timer = null;
    this.busy = false;
  }

  start() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      if (!fs.existsSync(this.file)) fs.writeFileSync(this.file, '', 'utf8');
      // 从文件末尾开始，避免重启后把历史命令重发一遍
      this.offset = fs.statSync(this.file).size;
    } catch (e) {
      this.log?.warn(`发件箱初始化失败：${e.message}`);
      return;
    }

    this.timer = setInterval(() => {
      this._tick().catch((e) => this.log?.warn(`发件箱处理失败：${e.message}`));
    }, this.intervalMs);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async _tick() {
    if (this.busy) return;

    let size;
    try {
      size = fs.statSync(this.file).size;
    } catch {
      return;
    }

    // 文件被清空或轮转，从头再来
    if (size < this.offset) this.offset = 0;
    if (size === this.offset) return;

    let chunk;
    try {
      const fd = fs.openSync(this.file, 'r');
      const buf = Buffer.alloc(size - this.offset);
      fs.readSync(fd, buf, 0, buf.length, this.offset);
      fs.closeSync(fd);
      this.offset = size;
      chunk = buf.toString('utf8');
    } catch (e) {
      this.log?.warn(`读发件箱失败：${e.message}`);
      return;
    }

    this.busy = true;
    try {
      for (const line of chunk.split('\n')) {
        const t = line.trim();
        if (!t) continue;
        let entry;
        try {
          entry = JSON.parse(t);
        } catch {
          this.log?.warn('发件箱里有一行不是合法 JSON，已跳过');
          continue;
        }
        try {
          await this.onSend(entry);
        } catch (e) {
          this.log?.warn(`手动消息发送失败：${e.message}`);
        }
      }
    } finally {
      this.busy = false;
    }

    // 发件箱也只增不减：处理完按大小清空，避免长期运行越来越大
    try {
      if (this.offset > 64 * 1024) {
        fs.truncateSync(this.file, 0);
        this.offset = 0;
      }
    } catch {
      /* ignore */
    }
  }
}
