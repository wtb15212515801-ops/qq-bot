// 假的 NapCat：不开 QQ 也能把「收消息 → 决策 → 生成 → 发消息」整条链路跑一遍。
// 用法：node tools/fakenapcat.mjs 39998
//      然后把 config.json 的 onebot.url 指向 ws://127.0.0.1:39998，另开一个窗口跑 node main.js
import http from 'node:http';
import crypto from 'node:crypto';

const PORT = Number(process.argv[2] || 39998);
const SELF = 10001;

function encode(str) {
  const payload = Buffer.from(str, 'utf8');
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x81, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

function decodeFrame(buf) {
  if (buf.length < 2) return null;
  const b1 = buf[1];
  const opcode = buf[0] & 0x0f;
  const masked = (b1 & 0x80) !== 0;
  let len = b1 & 0x7f;
  let offset = 2;
  if (len === 126) {
    if (buf.length < 4) return null;
    len = buf.readUInt16BE(2);
    offset = 4;
  } else if (len === 127) {
    if (buf.length < 10) return null;
    len = Number(buf.readBigUInt64BE(2));
    offset = 10;
  }
  let maskKey = null;
  if (masked) {
    if (buf.length < offset + 4) return null;
    maskKey = buf.subarray(offset, offset + 4);
    offset += 4;
  }
  if (buf.length < offset + len) return null;
  const payload = Buffer.from(buf.subarray(offset, offset + len));
  if (maskKey) for (let i = 0; i < payload.length; i += 1) payload[i] ^= maskKey[i % 4];
  return { opcode, payload, consumed: offset + len };
}

const server = http.createServer();

server.on('upgrade', (req, socket) => {
  console.log('[FakeNapCat] 收到 WS 握手:', req.url);
  const key = req.headers['sec-websocket-key'];
  const accept = crypto
    .createHash('sha1')
    .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
    .digest('base64');

  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
  );

  let buf = Buffer.alloc(0);
  const send = (obj) => socket.write(encode(JSON.stringify(obj)));

  socket.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      const frame = decodeFrame(buf);
      if (!frame) break;
      buf = buf.subarray(frame.consumed);
      if (frame.opcode === 8) {
        socket.end();
        return;
      }
      if (frame.opcode !== 1) continue;

      const msg = JSON.parse(frame.payload.toString('utf8'));
      console.log('[FakeNapCat] ← action:', msg.action, JSON.stringify(msg.params ?? {}).slice(0, 120));

      if (msg.action === 'get_login_info') {
        send({ status: 'ok', retcode: 0, data: { user_id: SELF, nickname: process.env.BOT_NAME || 'BOT' }, echo: msg.echo });
      } else if (msg.action === 'get_group_list') {
        send({
          status: 'ok',
          retcode: 0,
          data: [
            { group_id: 888888, group_name: '测试用群', member_count: 12 },
            { group_id: 999999, group_name: '另一个群', member_count: 3 },
          ],
          echo: msg.echo,
        });
      } else if (msg.action === 'send_group_msg' || msg.action === 'send_private_msg') {
        const text = (msg.params.message ?? [])
          .filter((s) => s.type === 'text')
          .map((s) => s.data.text)
          .join('');
        console.log(`[FakeNapCat] ★ 机器人发出：${text}`);
        send({ status: 'ok', retcode: 0, data: { message_id: Date.now() }, echo: msg.echo });
      } else {
        send({ status: 'ok', retcode: 0, data: {}, echo: msg.echo });
      }
    }
  });

  // 连上 1 秒后，模拟群友 @ 机器人
  setTimeout(() => {
    console.log('[FakeNapCat] → 推送群消息事件');
    send({
      post_type: 'message',
      message_type: 'group',
      sub_type: 'normal',
      time: Math.floor(Date.now() / 1000),
      self_id: SELF,
      group_id: 888888,
      user_id: 20001,
      message_id: 5001,
      sender: { user_id: 20001, nickname: '张三', card: '张三', role: 'member' },
      message: [
        { type: 'at', data: { qq: String(SELF) } },
        { type: 'text', data: { text: ' 今晚八点打本你来不来' } },
      ],
      raw_message: '',
    });
  }, 1000);
});

server.listen(PORT, '127.0.0.1', () => console.log(`[FakeNapCat] listening on ${PORT}`));

setTimeout(() => {
  console.log('[FakeNapCat] 退出');
  process.exit(0);
}, 14000);
