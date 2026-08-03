/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  chmodSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ACPTurn } from './acpTransport.js';

/**
 * A fake acpmux that, on session/prompt, sends ONE reverse request of a chosen
 * kind (permission / fs-read / fs-write) to the client, records the client's
 * response, then finishes the turn. It also records the ORDER of received
 * methods so a test can assert set_config_option arrived before session/prompt.
 * The client's response to the reverse request is written to RESP_FILE as JSON.
 */
function writeFakeAcpmux(reverse: {
  method: string;
  params: Record<string, unknown>;
  respFile: string;
  orderFile: string;
}): string {
  const dir = mkdtempSync(join(tmpdir(), 'acpmux-fake-tx-'));
  const path = join(dir, 'acpmux');
  const script = `#!/usr/bin/env node
const fs = require('fs');
const reverse = ${JSON.stringify(reverse)};
let buf = '';
let rid = 7001;
let promptId = null;
const order = [];
function finish() {
  fs.writeFileSync(reverse.orderFile, JSON.stringify(order));
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: promptId, result: { stopReason: 'end_turn' } }) + '\\n');
}
process.stdin.on('data', (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.method) order.push(msg.method);
    if (msg.method === 'initialize') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1 } }) + '\\n');
    } else if (msg.method === 'session/new') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 's1' } }) + '\\n');
    } else if (msg.method === 'session/set_config_option') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} }) + '\\n');
    } else if (msg.method === 'session/prompt') {
      promptId = msg.id;
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: rid, method: reverse.method, params: { sessionId: 's1', ...reverse.params } }) + '\\n');
    } else if (msg.id === rid && msg.method === undefined) {
      // Client's response to our reverse request.
      fs.writeFileSync(reverse.respFile, JSON.stringify({ result: msg.result, error: msg.error }));
      finish();
    }
  }
});
`;
  writeFileSync(path, script);
  chmodSync(path, 0o755);
  return path;
}

function readJson(p: string): { result?: unknown; error?: unknown } {
  return JSON.parse(readFileSync(p, 'utf8'));
}

describe('ACPTurn — reverse fs / permission handling (bidirectional ACP)', () => {
  it('reads a file inside the workspace and returns its content', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'acp-cwd-'));
    writeFileSync(join(cwd, 'inside.txt'), 'hello-inside');
    const respFile = join(cwd, 'resp.json');
    const orderFile = join(cwd, 'order.json');
    const acpmux = writeFakeAcpmux({
      method: 'fs/read_text_file',
      params: { path: 'inside.txt' },
      respFile,
      orderFile,
    });
    const turn = new ACPTurn({ provider: 'codex', acpmuxPath: acpmux, cwd });
    await turn.run('x', () => {});
    const resp = readJson(respFile);
    expect((resp.result as { content?: string })?.content).toBe('hello-inside');
    expect(resp.error).toBeUndefined();
  }, 15000);

  it('rejects a read that escapes the workspace with an error (no hang)', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'acp-cwd-'));
    const respFile = join(cwd, 'resp.json');
    const orderFile = join(cwd, 'order.json');
    const acpmux = writeFakeAcpmux({
      method: 'fs/read_text_file',
      params: { path: '../../etc/hosts' },
      respFile,
      orderFile,
    });
    const turn = new ACPTurn({ provider: 'codex', acpmuxPath: acpmux, cwd });
    await turn.run('x', () => {});
    const resp = readJson(respFile);
    expect(resp.error).toBeDefined();
  }, 15000);

  it('rejects a read through a symlink that escapes the workspace', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'acp-outside-'));
    writeFileSync(join(outside, 'secret.txt'), 'top-secret');
    const cwd = mkdtempSync(join(tmpdir(), 'acp-cwd-'));
    // A symlink INSIDE cwd that points OUTSIDE it — a string-prefix check would
    // wrongly allow this; realpath resolution must reject it.
    symlinkSync(outside, join(cwd, 'link'));
    const respFile = join(cwd, 'resp.json');
    const orderFile = join(cwd, 'order.json');
    const acpmux = writeFakeAcpmux({
      method: 'fs/read_text_file',
      params: { path: 'link/secret.txt' },
      respFile,
      orderFile,
    });
    const turn = new ACPTurn({ provider: 'codex', acpmuxPath: acpmux, cwd });
    await turn.run('x', () => {});
    const resp = readJson(respFile);
    expect(resp.error).toBeDefined();
  }, 15000);

  it('permission policy=deny returns a cancelled outcome (not selected)', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'acp-cwd-'));
    const respFile = join(cwd, 'resp.json');
    const orderFile = join(cwd, 'order.json');
    const acpmux = writeFakeAcpmux({
      method: 'session/request_permission',
      params: { options: [{ optionId: 'allow' }, { optionId: 'reject' }] },
      respFile,
      orderFile,
    });
    const turn = new ACPTurn({
      provider: 'codex',
      acpmuxPath: acpmux,
      cwd,
      permissionPolicy: 'deny',
    });
    await turn.run('x', () => {});
    const resp = readJson(respFile) as {
      result?: { outcome?: { outcome?: string } };
    };
    expect(resp.result?.outcome?.outcome).toBe('cancelled');
  }, 15000);

  it('permission policy=allow selects an allow option', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'acp-cwd-'));
    const respFile = join(cwd, 'resp.json');
    const orderFile = join(cwd, 'order.json');
    const acpmux = writeFakeAcpmux({
      method: 'session/request_permission',
      params: { options: [{ optionId: 'allow' }, { optionId: 'reject' }] },
      respFile,
      orderFile,
    });
    const turn = new ACPTurn({ provider: 'codex', acpmuxPath: acpmux, cwd });
    await turn.run('x', () => {});
    const resp = readJson(respFile) as {
      result?: { outcome?: { outcome?: string; optionId?: string } };
    };
    expect(resp.result?.outcome?.outcome).toBe('selected');
    expect(resp.result?.outcome?.optionId).toBe('allow');
  }, 15000);

  it('sends session/set_config_option(model) BEFORE session/prompt', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'acp-cwd-'));
    const respFile = join(cwd, 'resp.json');
    const orderFile = join(cwd, 'order.json');
    const acpmux = writeFakeAcpmux({
      method: 'session/request_permission',
      params: { options: [{ optionId: 'allow' }] },
      respFile,
      orderFile,
    });
    const turn = new ACPTurn({
      provider: 'codex',
      acpmuxPath: acpmux,
      cwd,
      model: 'gpt-5-codex',
    });
    await turn.run('x', () => {});
    const order = JSON.parse(readFileSync(orderFile, 'utf8')) as string[];
    const cfgIdx = order.indexOf('session/set_config_option');
    const promptIdx = order.indexOf('session/prompt');
    expect(cfgIdx).toBeGreaterThanOrEqual(0);
    expect(cfgIdx).toBeLessThan(promptIdx);
  }, 15000);
});
