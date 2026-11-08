import test from 'node:test';
import assert from 'node:assert/strict';
import { detectDisplay } from '../../core/display.mjs';

const sdk16 = { LV_COLOR_DEPTH: '16', LV_COLOR_FORMAT_RGB565: 'y' };

function detect(overrides = {}) {
  return detectDisplay({
    root: 'D:/p',
    config: {},
    sdkconfig: {},
    cli: {},
    sourceText: '',
    ...overrides,
  });
}

test('CLI width/height beat config and sdkconfig', () => {
  const r = detect({
    config: { display: { width: 800, height: 480, colorDepth: 16 } },
    sdkconfig: sdk16,
    cli: { width: 240, height: 320 },
  });
  assert.equal(r.ok, true);
  assert.deepEqual([r.width, r.height, r.colorDepth, r.source], [240, 320, 16, 'cli']);
  assert.equal(r.problem, null);
  assert.ok(Array.isArray(r.warnings));
});

test('config beats sdkconfig for resolution', () => {
  const r = detect({
    config: { display: { width: 320, height: 240, colorDepth: 16 } },
    sdkconfig: { ...sdk16, LCD_H_RES: '800', LCD_V_RES: '480' },
  });
  assert.equal(r.ok, true);
  assert.deepEqual([r.width, r.height, r.source], [320, 240, 'config']);
});

test('config 240x320 beats sdkconfig 800x480', () => {
  const r = detect({
    config: { display: { width: 240, height: 320, colorDepth: 16 } },
    sdkconfig: { ...sdk16, LCD_H_RES: '800', LCD_V_RES: '480' },
  });
  assert.deepEqual([r.width, r.height, r.source], [240, 320, 'config']);
});

test('missing resolution fails without a 240x320 fallback', () => {
  const r = detect({ sdkconfig: sdk16 });
  assert.equal(r.ok, false);
  assert.equal(r.width, null);
  assert.equal(r.height, null);
  assert.match(r.problem, /--width/);
  assert.match(r.problem, /--height/);
  assert.match(r.problem, /lvglui\.json/);
  assert.match(r.problem, /init/);
});

test('ambiguous source macros fail', () => {
  const r = detect({
    sourceText: [
      '#define BSP_LCD_H_RES 240',
      '#define BSP_LCD_V_RES 320',
      '#define LCD_H_RES 800',
      '#define LCD_V_RES 480',
      '',
    ].join('\n'),
  });
  assert.equal(r.ok, false);
  assert.match(r.problem, /multiple|ambiguous/i);
});

test('two source families with identical values are still ambiguous', () => {
  const r = detect({
    sdkconfig: sdk16,
    sourceText: [
      '#define BSP_LCD_H_RES 240',
      '#define BSP_LCD_V_RES 320',
      '#define LV_HOR_RES_MAX 240',
      '#define LV_VER_RES_MAX 320',
      '',
    ].join('\n'),
  });
  assert.equal(r.ok, false);
  assert.match(r.problem, /multiple|ambiguous/i);
});

test('unique source macro pair supplies the resolution', () => {
  const r = detect({
    sdkconfig: { LV_COLOR_DEPTH: '16' },
    sourceText: '#define BSP_LCD_H_RES 240\n#define BSP_LCD_V_RES 320\n',
  });
  assert.equal(r.ok, true);
  assert.deepEqual([r.width, r.height, r.source], [240, 320, 'source']);
  assert.equal(r.problem, null);
  assert.ok(Array.isArray(r.warnings));
});

test('source macros are ignored with a warning when CLI wins', () => {
  const r = detect({
    sdkconfig: sdk16,
    cli: { width: 800, height: 480 },
    sourceText: '#define LCD_H_RES 240\n#define LCD_V_RES 320\n',
  });
  assert.equal(r.source, 'cli');
  assert.match(r.warnings.join(' '), /ignored/);
  assert.match(r.warnings.join(' '), /LCD_H_RES/);
});

test('commented-out source macros are ignored', () => {
  const r = detect({
    sdkconfig: sdk16,
    cli: { width: 240, height: 320 },
    sourceText: '// #define LCD_H_RES 800\n/* #define LCD_V_RES 480 */\n',
  });
  assert.equal(r.ok, true);
  assert.equal(r.source, 'cli');
  assert.match(r.warnings.join(' '), /not usable|ignored/);
});

test('non-integer source macro values are ignored', () => {
  const r = detect({
    sourceText: '#define BSP_LCD_H_RES (240)\n#define BSP_LCD_V_RES 320U\n',
  });
  assert.equal(r.ok, false);
  assert.match(r.problem, /--width/);
  assert.match(r.warnings.join(' '), /not usable|ignored/);
});

test('a source half pair is not a resolution', () => {
  const r = detect({
    sdkconfig: sdk16,
    sourceText: '#define LCD_H_RES 800\n',
  });
  assert.equal(r.ok, false);
  assert.match(r.problem, /--width/);
});

test('CLI half pair fails instead of falling back to lower sources', () => {
  const r = detect({
    config: { display: { width: 800, height: 480, colorDepth: 16 } },
    sdkconfig: sdk16,
    cli: { width: 240 },
  });
  assert.equal(r.ok, false);
  assert.match(r.problem, /--width/);
  assert.match(r.problem, /--height/);
  assert.match(r.problem, /together/);
});

test('CLI rejects non-positive and non-integer sizes', () => {
  for (const cli of [
    { width: 0, height: 320 },
    { width: 240.5, height: 320 },
    { width: '240', height: '320' },
  ]) {
    const r = detect({ sdkconfig: sdk16, cli });
    assert.equal(r.ok, false);
    assert.match(r.problem, /--width/);
    assert.match(r.problem, /positive integer/);
  }
});

test('config half pair fails instead of falling back to sdkconfig', () => {
  const r = detect({
    config: { display: { width: 240 } },
    sdkconfig: { ...sdk16, LCD_H_RES: '800', LCD_V_RES: '480' },
  });
  assert.equal(r.ok, false);
  assert.match(r.problem, /config\.display\.width/);
  assert.match(r.problem, /config\.display\.height/);
  assert.match(r.problem, /together/);
});

test('config rejects non-positive sizes', () => {
  const r = detect({ config: { display: { width: 0, height: 320, colorDepth: 16 } } });
  assert.equal(r.ok, false);
  assert.match(r.problem, /config\.display\.width/);
  assert.match(r.problem, /positive integer/);
});

test('a half-present sdkconfig pair names the missing key', () => {
  const r = detect({ sdkconfig: { BSP_LCD_H_RES: 240, LV_COLOR_DEPTH: '16' } });
  assert.equal(r.ok, false);
  assert.match(r.problem, /BSP_LCD_V_RES/);
  assert.match(r.problem, /missing|required/i);
});

test('sdkconfig uses the first complete pair in order', () => {
  const r = detect({
    sdkconfig: {
      LV_DISPLAY_DEFAULT_WIDTH: '480',
      LV_DISPLAY_DEFAULT_HEIGHT: '272',
      LCD_H_RES: '800',
      LCD_V_RES: '480',
      BSP_LCD_H_RES: '240',
      BSP_LCD_V_RES: '320',
      LV_COLOR_DEPTH: '16',
    },
  });
  assert.equal(r.ok, true);
  assert.deepEqual([r.width, r.height, r.source], [480, 272, 'sdkconfig']);
});

test('sdkconfig LCD_H_RES pair wins over the BSP pair', () => {
  const r = detect({
    sdkconfig: {
      LCD_H_RES: '800',
      LCD_V_RES: '480',
      BSP_LCD_H_RES: '240',
      BSP_LCD_V_RES: '320',
      LV_COLOR_DEPTH: '16',
    },
  });
  assert.equal(r.ok, true);
  assert.deepEqual([r.width, r.height, r.source], [800, 480, 'sdkconfig']);
});

test('accepts the Map shape returned by parseSdkconfig', () => {
  const sdkconfig = new Map([
    ['LV_COLOR_DEPTH', 16],
    ['LV_COLOR_FORMAT_RGB565', 1],
    ['LCD_H_RES', 800],
    ['LCD_V_RES', 480],
  ]);
  const r = detect({ sdkconfig });
  assert.equal(r.ok, true);
  assert.deepEqual([r.width, r.height, r.colorDepth, r.source], [800, 480, 16, 'sdkconfig']);
});

test('config 16-bit with sdkconfig 24 or 32-bit fails as a conflict', () => {
  for (const depth of ['24', '32']) {
    const r = detect({
      config: { display: { width: 240, height: 320, colorDepth: 16 } },
      sdkconfig: { LV_COLOR_DEPTH: depth },
    });
    assert.equal(r.ok, false);
    assert.match(r.problem, /16/);
    assert.match(r.problem, new RegExp(depth));
    assert.match(r.problem, /conflict/i);
  }
});

test('config non-16 color depth fails', () => {
  const r = detect({
    config: { display: { width: 240, height: 320, colorDepth: 24 } },
    sdkconfig: sdk16,
  });
  assert.equal(r.ok, false);
  assert.match(r.problem, /24/);
  assert.match(r.problem, /16/);
});

test('config 16-bit passes when sdkconfig does not declare a color depth', () => {
  const r = detect({
    config: { display: { width: 240, height: 320, colorDepth: 16 } },
    sdkconfig: {},
  });
  assert.equal(r.ok, true);
  assert.equal(r.colorDepth, 16);
  assert.match(r.warnings.join(' '), /sdkconfig/);
  assert.match(r.warnings.join(' '), /color depth/i);
});

test('neither config nor sdkconfig declaring a color depth fails', () => {
  const r = detect({
    config: { display: { width: 240, height: 320 } },
    sdkconfig: {},
  });
  assert.equal(r.ok, false);
  assert.match(r.problem, /16-bit|only 16/i);
  assert.match(r.problem, /LV_COLOR_FORMAT_DEFAULT/);
});

test('sdkconfig LV_COLOR_FORMAT_RGB565=y alone selects 16-bit', () => {
  const r = detect({
    sdkconfig: { LCD_H_RES: '240', LCD_V_RES: '320', LV_COLOR_FORMAT_RGB565: 'y' },
  });
  assert.equal(r.ok, true);
  assert.deepEqual([r.width, r.height, r.colorDepth, r.source], [240, 320, 16, 'sdkconfig']);
});

test('sdkconfig non-16 LV_COLOR_DEPTH fails', () => {
  const r = detect({
    sdkconfig: { LCD_H_RES: '240', LCD_V_RES: '320', LV_COLOR_DEPTH: '8' },
  });
  assert.equal(r.ok, false);
  assert.match(r.problem, /8/);
  assert.match(r.problem, /16/);
});