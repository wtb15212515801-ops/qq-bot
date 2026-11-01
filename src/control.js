/**
 * 控制通道：界面下指令，机器人执行。
 *
 * 和 outbox 一样是「一行一个 JSON」的文件队列，但方向相反：
 * 界面不需要知道机器人内存里有什么，只要写指令；机器人轮询执行。
 * 这样记忆的唯一写者仍然是机器人进程，不会和界面抢写 memory.json。
 */

import fs from 'node:fs';
import path from 'node:path';

export class Control {
  constructor({ file, logger = null, onCommand, intervalMs = 700 }) {
    this.file = path.resolve(file);
    this.log = logger;
    this.onCommand = onCommand;
    this.intervalMs = intervalMs;
    this.offset = 0;
    this.timer = null;
    this.busy = false;
  }

  start() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      if (!fs.existsSync(this.file)) fs.writeFileSync(this.file, '', 'utf8');
      this.offset = fs.statSync(this.file).size;
    } catch (e) {
      this.log?.warn(`控制通道初始化失败：${e.message}`);
      return;
    }

    this.timer = setInterval(() => {
      this._tick().catch((e) => this.log?.warn(`控制通道处理失败：${e.message}`));
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
      this.log?.warn(`读控制通道失败：${e.message}`);
      return;
    }

    this.busy = true;
    try {
      for (const line of chunk.split('\n')) {
        const t = line.trim();
        if (!t) continue;
        let cmd;
        try {
          cmd = JSON.parse(t);
        } catch {
          this.log?.warn('控制通道里有一行不是合法 JSON，已跳过');
          continue;
        }
        try {
          await this.onCommand(cmd);
        } catch (e) {
          this.log?.warn(`执行指令失败（${cmd.cmd}）：${e.message}`);
        }
      }
    } finally {
      this.busy = false;
    }

    // 控制文件只增不减：处理完顺手清掉，避免长期运行越滚越大
    try {
      if (this.offset > 64 * 1024) {
        fs.truncateSync(this.file, 0);
        this.offset = 0;
      }
    } catch {
      /* 清不掉就算了，不影响功能 */
    }
  }
}
