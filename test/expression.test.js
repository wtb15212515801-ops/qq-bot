import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StickerBook, decorateEmoji, hasEmoji, toFileUri } from '../src/expression.js';
import { calculate } from '../src/tools.js';

test('chance=0 不加 emoji', () => {
  assert.equal(decorateEmoji('吃薯片', { mood: 90, chance: 0 }), '吃薯片');
});

test('chance=1 一定加，且加在句尾', () => {
  const out = decorateEmoji('吃薯片', { mood: 90, chance: 1 });
  assert.notEqual(out, '吃薯片');
  assert.ok(out.startsWith('吃薯片'));
  assert.equal(hasEmoji(out), true);
});

test('已经有 emoji 就不重复加', () => {
  const s = '吃薯片😋';
  assert.equal(decorateEmoji(s, { mood: 90, chance: 1 }), s);
});

test('空句子不加', () => {
  assert.equal(decorateEmoji('', { mood: 90, chance: 1 }), '');
});

test('toFileUri 生成 NapCat 能认的格式', () => {
  const uri = toFileUri('data/stickers/happy/01.png');
  assert.match(uri, /^file:\/\/\/[A-Za-z]:\//);
  assert.ok(uri.endsWith('happy/01.png'));
});

test('图库按心情挑对应文件夹', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stk-'));
  for (const name of ['happy', 'sad', 'angry']) {
    fs.mkdirSync(path.join(dir, name));
    fs.writeFileSync(path.join(dir, name, 'a.png'), 'x');
  }
  const book = new StickerBook({ dir });
  book.scan(Date.now(), true);

  assert.equal(book.size, 3);
  assert.ok(book.pick(95).includes('happy'));
  assert.ok(book.pick(10).includes('angry'));

  fs.rmSync(dir, { recursive: true, force: true });
});

test('图库为空时 pick 返回 null', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stk-empty-'));
  const book = new StickerBook({ dir });
  book.scan(Date.now(), true);
  assert.equal(book.pick(50), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('计算器', () => {
  assert.equal(calculate('1+1'), '2');
  assert.equal(calculate('(12.5*3+8)/2'), '22.75');
  assert.equal(calculate('2^10'), '1024');
  assert.equal(calculate('-3+5'), '2');
  assert.throws(() => calculate('1/0'), /不能除以 0/);
  assert.throws(() => calculate('1+'), /表达式不完整|意外的符号/);
  assert.throws(() => calculate('alert(1)'), /不支持的字符/);
});
