import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { UiFeed } from '../src/ui.js';

const silent = { info() {}, warn() {}, debug() {}, error() {} };
const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ui-')), 'ui.log');

test('初始化会创建文件', () => {
  const file = tmpFile();
  // eslint-disable-next-line no-new
  new UiFeed({ file, logger: silent });
  assert.equal(fs.existsSync(file), true);
  fs.rmSync(path.dirname(file), { recursive: true, force: true });
});

test('emit + flush 写出制表符分隔的行', () => {
  const file = tmpFile();
  const feed = new UiFeed({ file, logger: silent });
  feed.emit({ chatId: 'g1', chatName: '群 · 测试', kind: 'in', who: '张三', text: '早' });
  feed.flush();

  const line = fs.readFileSync(file, 'utf8').trim();
  const cols = line.split('\t');
  assert.equal(cols.length, 6);
  assert.equal(cols[1], 'g1');
  assert.equal(cols[3], 'in');
  assert.equal(cols[5], '早');
  fs.rmSync(path.dirname(file), { recursive: true, force: true });
});

test('换行和制表符会被压平，不会破行', () => {
  const file = tmpFile();
  const feed = new UiFeed({ file, logger: silent });
  feed.emit({ chatId: 'g1', chatName: '群', kind: 'in', who: '甲', text: '第一行\n第二行\t带制表符' });
  feed.flush();

  const content = fs.readFileSync(file, 'utf8');
  assert.equal(content.split('\n').filter(Boolean).length, 1, '应该只有一行');
  assert.ok(!content.includes('\t\t'));
  fs.rmSync(path.dirname(file), { recursive: true, force: true });
});

test('空缓冲 flush 不报错也不写东西', () => {
  const file = tmpFile();
  const feed = new UiFeed({ file, logger: silent });
  assert.doesNotThrow(() => feed.flush());
  assert.equal(fs.readFileSync(file, 'utf8'), '');
  fs.rmSync(path.dirname(file), { recursive: true, force: true });
});

test('超过上限会轮转，并且确实变小', () => {
  const file = tmpFile();
  const feed = new UiFeed({ file, maxBytes: 2000, logger: silent });

  for (let i = 0; i < 200; i += 1) {
    feed.emit({ chatId: 'g1', chatName: '群', kind: 'in', who: '甲', text: 'x'.repeat(80) });
  }
  feed.flush();

  const size = fs.statSync(file).size;
  assert.ok(size <= 2000, `轮转后应该小于上限，实际 ${size}`);
  assert.ok(size > 0, '不能把内容全删掉');
  fs.rmSync(path.dirname(file), { recursive: true, force: true });
});

test('轮转后保留的是最新的行', () => {
  const file = tmpFile();
  const feed = new UiFeed({ file, maxBytes: 1500, logger: silent });

  for (let i = 0; i < 100; i += 1) {
    feed.emit({ chatId: 'g1', chatName: '群', kind: 'in', who: '甲', text: '第' + i + '条' });
  }
  feed.flush();

  const content = fs.readFileSync(file, 'utf8');
  assert.ok(content.includes('第99条'), '最新的一条应该在');
  assert.ok(!content.includes('第0条'), '最旧的应该被丢掉');
  fs.rmSync(path.dirname(file), { recursive: true, force: true });
});

test('反复 flush 不会无限重写（轮转后不再触发）', () => {
  const file = tmpFile();
  const feed = new UiFeed({ file, maxBytes: 1200, logger: silent });

  for (let round = 0; round < 5; round += 1) {
    for (let i = 0; i < 40; i += 1) {
      feed.emit({ chatId: 'g1', chatName: '群', kind: 'in', who: '甲', text: 'y'.repeat(60) });
    }
    feed.flush();
    assert.ok(fs.statSync(file).size <= 1200, `第 ${round} 轮后仍超上限`);
  }
  fs.rmSync(path.dirname(file), { recursive: true, force: true });
});
