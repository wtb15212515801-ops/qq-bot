import test from 'node:test';
import assert from 'node:assert';
import { OneBotClient } from '../src/onebot.js';

const silent = { info() {}, warn() {}, debug() {}, error() {} };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** 假 WebSocket：手动触发 open/message/close/error */
class FakeWS {
  static instances = [];

  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.sent = [];
    this.listeners = {};
    FakeWS.instances.push(this);
  }

  addEventListener(type, fn) {
    (this.listeners[type] ||= []).push(fn);
  }

  send(data) {
    this.sent.push(data);
  }

  close() {
    this.readyState = 3;
    this.trigger('close', { code: 1000 });
  }

  trigger(type, ev) {
    for (const fn of this.listeners[type] || []) fn(ev);
  }

  open() {
    this.readyState = 1;
    this.trigger('open', {});
  }

  message(obj) {
    this.trigger('message', { data: JSON.stringify(obj) });
  }
}

function withFakeWS(fn) {
  const orig = globalThis.WebSocket;
  FakeWS.instances = [];
  globalThis.WebSocket = FakeWS;
  return Promise.resolve(fn()).finally(() => {
    globalThis.WebSocket = orig;
  });
}

function makeClient(over = {}) {
  return new OneBotClient(
    { url: 'ws://127.0.0.1:3001', accessToken: 'tok', reconnectMs: 20, ...over },
    silent
  );
}

test('连接时带上 access_token', async () => {
  await withFakeWS(async () => {
    const c = makeClient();
    c.connect();
    const ws = FakeWS.instances[0];
    assert.ok(ws.url.includes('access_token=tok'), ws.url);
    c.close();
  });
});

test('open 后 connected 为真并触发 ready', async () => {
  await withFakeWS(async () => {
    const c = makeClient();
    let ready = 0;
    c.on('ready', () => (ready += 1));
    c.connect();
    const ws = FakeWS.instances[0];

    assert.equal(c.connected, false);
    ws.open();
    assert.equal(c.connected, true);
    assert.equal(ready, 1);
    c.close();
  });
});

test('call 发出带 echo 的请求并按 echo 回来', async () => {
  await withFakeWS(async () => {
    const c = makeClient();
    c.connect();
    const ws = FakeWS.instances[0];
    ws.open();

    const p = c.sendGroupMsg(123, '早');
    const payload = JSON.parse(ws.sent[0]);
    assert.equal(payload.action, 'send_group_msg');
    assert.equal(payload.params.group_id, 123);
    assert.equal(payload.params.message[0].data.text, '早');

    ws.message({ echo: payload.echo, status: 'ok', retcode: 0, data: { message_id: 9 } });
    assert.deepEqual(await p, { message_id: 9 });
    c.close();
  });
});

test('未连接时调用直接失败', async () => {
  await withFakeWS(async () => {
    const c = makeClient();
    await assert.rejects(() => c.sendGroupMsg(1, 'x'), /未连接/);
    c.close();
  });
});

test('调用超时会 reject 而不是永远挂着', async () => {
  await withFakeWS(async () => {
    const c = makeClient();
    c.connect();
    FakeWS.instances[0].open();
    await assert.rejects(() => c.call('get_login_info', {}, 30), /超时/);
    c.close();
  });
});

test('retcode 非 0 会 reject', async () => {
  await withFakeWS(async () => {
    const c = makeClient();
    c.connect();
    const ws = FakeWS.instances[0];
    ws.open();

    const p = c.sendGroupMsg(1, 'x');
    const payload = JSON.parse(ws.sent[0]);
    ws.message({ echo: payload.echo, status: 'failed', retcode: 100, wording: '被禁言' });
    await assert.rejects(() => p, /被禁言|retcode/);
    c.close();
  });
});

test('断线会触发 disconnected 并自动重连', async () => {
  await withFakeWS(async () => {
    const c = makeClient({ reconnectMs: 15 });
    let down = 0;
    c.on('disconnected', () => (down += 1));

    c.connect();
    FakeWS.instances[0].open();
    FakeWS.instances[0].close();

    assert.equal(down, 1);
    await wait(80);
    assert.ok(FakeWS.instances.length >= 2, '应该新建了连接');
    c.close();
  });
});

test('主动 close 之后不再重连', async () => {
  await withFakeWS(async () => {
    const c = makeClient({ reconnectMs: 15 });
    c.connect();
    FakeWS.instances[0].open();

    const count = FakeWS.instances.length;
    c.close();
    await wait(80);
    assert.equal(FakeWS.instances.length, count, '不该再新建连接');
  });
});

test('连接失败（只发 error 不发 close）也会重连', async () => {
  await withFakeWS(async () => {
    const c = makeClient({ reconnectMs: 15 });
    c.connect();
    FakeWS.instances[0].trigger('error', {});

    await wait(80);
    assert.ok(FakeWS.instances.length >= 2);
    c.close();
  });
});

test('断线时未完成的调用会失败，不会内存泄漏', async () => {
  await withFakeWS(async () => {
    const c = makeClient({ reconnectMs: 15 });
    c.connect();
    const ws = FakeWS.instances[0];
    ws.open();

    const p = c.sendGroupMsg(1, 'x');
    ws.close();

    await assert.rejects(() => p);
    assert.equal(c.pending.size, 0, 'pending 应该被清空');
    c.close();
  });
});

test('收到非 JSON 数据不会崩', async () => {
  await withFakeWS(async () => {
    const c = makeClient();
    c.connect();
    const ws = FakeWS.instances[0];
    ws.open();
    assert.doesNotThrow(() => ws.trigger('message', { data: '这不是 JSON' }));
    c.close();
  });
});
