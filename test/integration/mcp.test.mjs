// End-to-end MCP test: spawn the stdio server, negotiate a protocol, list the
// tools, and (when the real project is present) read a warm render as an image.
//
// Every stdout line must be one JSON-RPC response; the server must not print
// logs there. Diagnostics belong in tool content or in build.log.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { spawn } from 'node:child_process';

const PROJECT_DIR = 'D:/esps3_test/my_lcd';
const SERVER = path.resolve(import.meta.dirname, '../../cli/lvglui-mcp.mjs');
const ROOT = path.resolve(import.meta.dirname, '../..');
const SKIP = fs.existsSync(PROJECT_DIR) ? false : `${PROJECT_DIR} not found`;

function startServer() {
  const child = spawn(process.execPath, [SERVER], {
    cwd: ROOT,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const pending = new Map();
  const lines = [];
  let nextId = 1;
  let stderr = '';

  const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  rl.on('line', (line) => {
    lines.push(line);
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg && Object.prototype.hasOwnProperty.call(msg, 'id') && pending.has(msg.id)) {
      const entry = pending.get(msg.id);
      pending.delete(msg.id);
      entry.resolve(msg);
    }
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });

  return {
    child,
    get stderr() {
      return stderr;
    },
    get lines() {
      return lines;
    },
    request(method, params) {
      const id = nextId++;
      const promise = new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`timeout waiting for ${method}; stderr=${stderr}`));
        }, 120_000);
        pending.set(id, {
          resolve: (msg) => {
            clearTimeout(timer);
            resolve(msg);
          },
          reject: (error) => {
            clearTimeout(timer);
            reject(error);
          },
        });
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      return promise;
    },
    close() {
      child.stdin.end();
      return new Promise((resolve) => child.once('exit', resolve));
    },
  };
}

test('MCP negotiates 2025-03-26, lists seven tools and answers ping', async () => {
  const srv = startServer();
  try {
    const init = await srv.request('initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'test', version: '0' },
    });
    assert.equal(init.jsonrpc, '2.0');
    assert.equal(init.error, undefined);
    assert.equal(init.result.protocolVersion, '2025-03-26');
    assert.equal(init.result.serverInfo.name, 'lvglui');
    assert.ok(init.result.capabilities.tools);

    const ping = await srv.request('ping', {});
    assert.deepEqual(ping.result, {});

    const list = await srv.request('tools/list', {});
    const names = list.result.tools.map((tool) => tool.name).sort();
    assert.deepEqual(names, [
      'build_ui',
      'detect_project',
      'doctor',
      'font',
      'init_ui',
      'preview_ui',
      'render_ui',
    ]);
    assert.ok(list.result.tools.every((tool) => tool.inputSchema?.type === 'object'));
  } finally {
    await srv.close();
    assert.equal(srv.stderr, '', `server wrote to stderr:\n${srv.stderr}`);
  }
});

test('MCP falls back to the latest version and stays silent for notifications', async () => {
  const srv = startServer();
  try {
    const init = await srv.request('initialize', {
      protocolVersion: '1999-01-01',
      capabilities: {},
    });
    assert.equal(init.result.protocolVersion, '2025-06-18');

    const unknown = await srv.request('no/such/method', {});
    assert.equal(unknown.error.code, -32601);

    const bad = await srv.request('tools/call', {});
    assert.equal(bad.error.code, -32602);

    const before = srv.lines.length;
    srv.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'ping' })}\n`);
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(srv.lines.length, before, 'notification must not produce a response');
  } finally {
    await srv.close();
  }
});

test('MCP detect_project finds the real project UI and entry', { skip: SKIP }, async () => {
  const srv = startServer();
  try {
    await srv.request('initialize', { protocolVersion: '2025-03-26', capabilities: {} });
    const res = await srv.request('tools/call', {
      name: 'detect_project',
      arguments: { project: PROJECT_DIR },
    });
    assert.equal(res.error, undefined);
    assert.equal(res.result.isError, false);
    const text = res.result.content.find((part) => part.type === 'text');
    assert.ok(text, 'missing text content');
    const body = JSON.parse(text.text);
    assert.equal(body.root, 'D:\\esps3_test\\my_lcd');
    assert.equal(body.entry, 'sensor_ui_create');
    assert.equal(body.uiDir, 'D:\\esps3_test\\my_lcd\\components\\app_ui');
  } finally {
    await srv.close();
  }
});

test('MCP render_ui returns an image plus tree metadata', { skip: SKIP, timeout: 5 * 60 * 1000 }, async () => {
  const srv = startServer();
  try {
    await srv.request('initialize', { protocolVersion: '2025-03-26', capabilities: {} });
    const res = await srv.request('tools/call', {
      name: 'render_ui',
      arguments: { project: PROJECT_DIR, width: 240, height: 320, frames: 12, rebuild: false },
    });
    assert.equal(res.error, undefined, JSON.stringify(res));
    if (res.result.isError) {
      assert.fail(res.result.content.map((part) => part.text).join('\n'));
    }
    const image = res.result.content.find((part) => part.type === 'image');
    assert.ok(image, 'render result has no image content');
    assert.equal(image.mimeType, 'image/png');
    assert.ok(image.data.length > 1000, 'image data is too small');
    const text = res.result.content.find((part) => part.type === 'text');
    const body = JSON.parse(text.text);
    assert.equal(body.ok, true);
    assert.equal(body.width, 240);
    assert.equal(body.height, 320);
    assert.ok(body.names.includes('val_temp'));
    assert.equal(body.tree.nodes, 18);
  } finally {
    await srv.close();
  }
});