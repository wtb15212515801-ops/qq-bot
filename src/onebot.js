import { EventEmitter } from 'node:events';
import { toSegments } from './message.js';

/**
 * OneBot 11 客户端（正向 WebSocket）。
 * 连到 NapCat 暴露的 ws 端口，收事件、调 API。
 */
export class OneBotClient extends EventEmitter {
  constructor({ url, accessToken = '', reconnectMs = 3000 }, logger) {
    super();
    this.url = url;
    this.accessToken = accessToken;
    this.reconnectMs = reconnectMs;
    this.log = logger;
    this.ws = null;
    this.pending = new Map();
    this.echoSeq = 0;
    this.closedByUser = false;
    this.backoff = reconnectMs;
    this.selfId = 0;
    this.gen = 0;
  }

  get connected() {
    return this.ws?.readyState === 1;
  }

  connect() {
    this.closedByUser = false;
    this._open();
  }

  close() {
    this.closedByUser = true;
    this.gen += 1; // 让旧连接的 handler 全部失效
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
  }

  _target() {
    if (!this.accessToken) return this.url;
    const u = new URL(this.url);
    u.searchParams.set('access_token', this.accessToken);
    return u.toString();
  }

  _open() {
    // 已经主动关闭了就别再被遗留的定时器拉起来
    if (this.closedByUser) return;

    const gen = ++this.gen;

    // 关掉上一条（可能是半死不活的）连接
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }

    let ws;
    try {
      ws = new WebSocket(this._target());
    } catch (e) {
      this.log?.error(`WebSocket 地址不合法：${this.url} — ${e.message}`);
      this._scheduleReconnect();
      return;
    }

    this.ws = ws;

    let opened = false;
    let reconnectScheduled = false;

    const stale = () => gen !== this.gen;

    const scheduleReconnect = () => {
      if (stale() || reconnectScheduled) return;
      reconnectScheduled = true;
      this._failAllPending(new Error('连接已断开'));
      this.emit('disconnected');
      this._scheduleReconnect();
    };

    ws.addEventListener('open', () => {
      if (stale()) return;
      opened = true;
      this.backoff = this.reconnectMs;
      this.log?.info(`已连接 OneBot：${this.url}`);
      this.emit('ready');
    });

    ws.addEventListener('message', (ev) => {
      if (stale()) return;

      let payload;
      try {
        payload = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data));
      } catch {
        this.log?.warn('收到非 JSON 数据，已忽略');
        return;
      }

      if (payload.echo != null && this.pending.has(payload.echo)) {
        const { resolve, reject, timer } = this.pending.get(payload.echo);
        clearTimeout(timer);
        this.pending.delete(payload.echo);
        if (payload.status === 'failed' || (payload.retcode != null && payload.retcode !== 0)) {
          reject(new Error(`API 失败 retcode=${payload.retcode} ${payload.wording ?? ''}`));
        } else {
          resolve(payload.data);
        }
        return;
      }

      if (payload.self_id) this.selfId = payload.self_id;
      this.emit('event', payload);
    });

    ws.addEventListener('close', (ev) => {
      if (stale()) return;
      this.log?.warn(`连接断开（code=${ev.code}）`);
      scheduleReconnect();
    });

    ws.addEventListener('error', () => {
      if (stale()) return;
      // 注意：Node 的 WebSocket 在「连不上」时只发 error、不发 close，这里必须自己兜底
      this.log?.debug('WebSocket error 事件');
      if (!opened) scheduleReconnect();
    });
  }

  _scheduleReconnect() {
    if (this.closedByUser) return;
    const wait = this.backoff;
    this.backoff = Math.min(this.backoff * 1.6, 30000);
    this.log?.info(`${Math.round(wait / 1000)} 秒后重连…`);
    // 不要 unref：这是让进程活下去的句柄
    setTimeout(() => this._open(), wait);
  }

  _failAllPending(err) {
    for (const [, { reject, timer }] of this.pending) {
      clearTimeout(timer);
      reject(err);
    }
    this.pending.clear();
  }

  call(action, params = {}, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      if (!this.connected) {
        reject(new Error(`未连接，无法调用 ${action}`));
        return;
      }
      const echo = `e${++this.echoSeq}`;
      const timer = setTimeout(() => {
        this.pending.delete(echo);
        reject(new Error(`调用 ${action} 超时`));
      }, timeoutMs);

      this.pending.set(echo, { resolve, reject, timer });

      try {
        this.ws.send(JSON.stringify({ action, params, echo }));
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(echo);
        reject(e);
      }
    });
  }

  sendGroupMsg(groupId, text) {
    return this.call('send_group_msg', { group_id: Number(groupId), message: toSegments(text) });
  }

  /** 直接发消息段数组，用于 @ 人这类富文本 */
  sendGroupSegments(groupId, segments) {
    return this.call('send_group_msg', { group_id: Number(groupId), message: segments });
  }

  sendPrivateMsg(userId, text) {
    return this.call('send_private_msg', { user_id: Number(userId), message: toSegments(text) });
  }

  /** 发图片（表情包），file 用 toFileUri() 转出来的地址 */
  sendGroupImage(groupId, fileUri) {
    return this.call('send_group_msg', {
      group_id: Number(groupId),
      message: [{ type: 'image', data: { file: fileUri } }],
    });
  }

  sendPrivateImage(userId, fileUri) {
    return this.call('send_private_msg', {
      user_id: Number(userId),
      message: [{ type: 'image', data: { file: fileUri } }],
    });
  }

  async getLoginInfo() {
    const data = await this.call('get_login_info', {});
    if (data?.user_id) this.selfId = data.user_id;
    return data;
  }
}
