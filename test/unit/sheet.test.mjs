import assert from 'node:assert/strict';
import test from 'node:test';
import { composeSheet, SHEET_BACKGROUND, SHEET_MAX_WIDTH } from '../../core/sheet.mjs';

function solid(width, height, value) {
  const fb = Buffer.alloc(width * height * 2);
  for (let i = 0; i < width * height; i++) {
    fb[i * 2] = value & 0xff;
    fb[i * 2 + 1] = (value >> 8) & 0xff;
  }
  return { fb, width, height };
}

function pixelAt(fb, width, x, y) {
  const o = (y * width + x) * 2;
  return fb[o] | (fb[o + 1] << 8);
}

test('composeSheet rejects an empty list and malformed pages', () => {
  assert.equal(composeSheet([]), null);
  assert.throws(() => composeSheet([{ fb: Buffer.alloc(2), width: 2, height: 2 }]), /RGB565 buffer/);
});

test('one page is centred with the documented gap and background', () => {
  const page = solid(4, 6, 0x1234);
  const sheet = composeSheet([page]);
  assert.equal(sheet.cols, 1);
  assert.equal(sheet.rows, 1);
  assert.equal(sheet.gap, 8);
  assert.equal(sheet.scale, 1);
  assert.equal(sheet.width, 4 + 2 * 8);
  assert.equal(sheet.height, 6 + 2 * 8);
  assert.equal(pixelAt(sheet.fb, sheet.width, 0, 0), SHEET_BACKGROUND);
  assert.equal(pixelAt(sheet.fb, sheet.width, 8, 8), 0x1234);
  assert.equal(pixelAt(sheet.fb, sheet.width, 8 + 3, 8 + 5), 0x1234);
  assert.equal(pixelAt(sheet.fb, sheet.width, 8 + 4, 8), SHEET_BACKGROUND);
});

test('two pages sit side by side; five pages wrap to four columns', () => {
  const two = composeSheet([solid(2, 2, 1), solid(2, 2, 2)]);
  assert.equal(two.cols, 2);
  assert.equal(two.rows, 1);
  assert.equal(two.width, 2 * 2 + 3 * 8);
  assert.equal(two.height, 2 + 2 * 8);
  assert.equal(pixelAt(two.fb, two.width, 8, 8), 1);
  assert.equal(pixelAt(two.fb, two.width, 8 + 2 + 8, 8), 2);

  const five = composeSheet([1, 2, 3, 4, 5].map(() => solid(2, 2, 7)));
  assert.equal(five.cols, 4);
  assert.equal(five.rows, 2);
});

test('an oversized sheet is scaled down to the width cap with integer steps', () => {
  const sheet = composeSheet([solid(1000, 10, 1), solid(1000, 10, 2)], { maxWidth: 100 });
  assert.ok(sheet.width <= 100, `width ${sheet.width} should fit maxWidth`);
  assert.ok(sheet.scale > 1);
  assert.ok(sheet.height > 0);
});

test('the default width cap is exported for callers', () => {
  assert.equal(SHEET_MAX_WIDTH, 2048);
});