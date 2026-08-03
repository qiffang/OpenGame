/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ACPContentGenerator } from './acpContentGenerator.js';
import type { ContentGeneratorConfig } from '../contentGenerator.js';
import { AuthType } from '../contentGenerator.js';
import type { Config } from '../../config/config.js';

/**
 * Write a fake "acpmux" that speaks just enough newline-delimited JSON-RPC for
 * one ACP turn: it answers `initialize`, `session/new`, and `session/prompt`,
 * and in between emits `session/update` `agent_message_chunk` notifications for
 * each text piece in ACP_FAKE_CHUNKS (newline-separated). The chunks may include
 * text that LOOKS like a tool call — the point is that the ContentGenerator must
 * still surface them as plain text parts, never as Gemini functionCall parts.
 */
interface FakeOpts {
  chunks?: string[];
  stopReason?: string; // default 'end_turn'
  // If set, the agent sends a reverse session/request_permission and only
  // completes the prompt AFTER the client answers it (proves we don't hang).
  requestPermission?: boolean;
}

function writeFakeAcpmux(optsOrChunks: string[] | FakeOpts): string {
  const opts: FakeOpts = Array.isArray(optsOrChunks)
    ? { chunks: optsOrChunks }
    : optsOrChunks;
  const dir = mkdtempSync(join(tmpdir(), 'acpmux-fake-'));
  const path = join(dir, 'acpmux');
  const script = `#!/usr/bin/env node
const chunks = ${JSON.stringify(opts.chunks ?? [])};
const stopReason = ${JSON.stringify(opts.stopReason ?? 'end_turn')};
const requestPermission = ${JSON.stringify(!!opts.requestPermission)};
let buf = '';
let permId = 9001;
let pendingPromptId = null;
function finishPrompt() {
  for (const text of chunks) {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 's1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } } }) + '\\n');
  }
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: pendingPromptId, result: { stopReason } }) + '\\n');
  pendingPromptId = null;
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
    if (msg.method === 'initialize') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1 } }) + '\\n');
    } else if (msg.method === 'session/new') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 's1' } }) + '\\n');
    } else if (msg.method === 'session/set_config_option') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} }) + '\\n');
    } else if (msg.method === 'session/prompt') {
      pendingPromptId = msg.id;
      if (requestPermission) {
        // Reverse request agent->client; block until client answers.
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: permId, method: 'session/request_permission', params: { sessionId: 's1', options: [{ optionId: 'allow' }, { optionId: 'reject' }] } }) + '\\n');
      } else {
        finishPrompt();
      }
    } else if (msg.id !== undefined && msg.method === undefined && (msg.result !== undefined || msg.error !== undefined)) {
      // Client's response to our reverse request → now finish the prompt.
      if (msg.id === permId && pendingPromptId !== null) finishPrompt();
    }
  }
});
`;
  writeFileSync(path, script);
  chmodSync(path, 0o755);
  return path;
}

function makeGenerator(acpmuxPath: string): ACPContentGenerator {
  const config = {
    authType: AuthType.USE_ACP,
    model: 'codex',
    acp: { provider: 'codex', acpmuxPath },
  } as ContentGeneratorConfig;
  const gcConfig = {
    getWorkingDir: () => process.cwd(),
  } as unknown as Config;
  return new ACPContentGenerator(config, gcConfig);
}

const textRequest = {
  model: 'codex',
  contents: [{ role: 'user', parts: [{ text: 'make a game' }] }],
} as never;

describe('ACPContentGenerator — plan A: agent-autonomous, no functionCall round-trip', () => {
  it('never emits functionCall parts (the agent runs its own tools via acpmux)', async () => {
    // The chunks include text that resembles a tool call. Under plan A this must
    // NOT be turned into a Gemini functionCall part — OpenGame's tool scheduler
    // must not receive a tool-call to (double-)execute. This locks the A
    // invariant as a test, not a coincidence of the current implementation.
    const acpmux = writeFakeAcpmux([
      'I will write the file now.',
      '{"tool":"write_file","path":"game.js"}',
    ]);
    const gen = makeGenerator(acpmux);
    const resp = await gen.generateContent(textRequest, 'p1');

    const parts = resp.candidates?.[0]?.content?.parts ?? [];
    const hasFunctionCall = parts.some(
      (p) => (p as { functionCall?: unknown }).functionCall !== undefined,
    );
    expect(hasFunctionCall).toBe(false);
    // The tool-looking text is preserved as plain text, boundary-separated.
    const text = parts.map((p) => (p as { text?: string }).text ?? '').join('');
    expect(text).toContain('write_file');
    expect(text).toContain('\n'); // two chunks kept their boundary
  });

  it('streams one response per chunk, all text, no functionCall parts', async () => {
    const acpmux = writeFakeAcpmux(['chunk one', 'chunk two']);
    const gen = makeGenerator(acpmux);
    const stream = await gen.generateContentStream(textRequest, 'p1');
    let sawFunctionCall = false;
    let combined = '';
    for await (const resp of stream) {
      for (const p of resp.candidates?.[0]?.content?.parts ?? []) {
        if ((p as { functionCall?: unknown }).functionCall !== undefined) {
          sawFunctionCall = true;
        }
        combined += (p as { text?: string }).text ?? '';
      }
    }
    expect(sawFunctionCall).toBe(false);
    expect(combined).toContain('chunk one');
    expect(combined).toContain('chunk two');
  });

  it('embedContent fails clearly (not on the ACP path)', async () => {
    const acpmux = writeFakeAcpmux([]);
    const gen = makeGenerator(acpmux);
    await expect(
      gen.embedContent({ model: 'codex', contents: [] } as never),
    ).rejects.toThrow(/not supported on the ACP backend/);
  });

  it('answers the agent reverse session/request_permission (does not hang)', async () => {
    // Blocker 1: ACP is bidirectional — acpmux forwards session/request_permission
    // FROM the agent and blocks until the client answers. The fake agent only
    // completes the prompt AFTER we respond, so if the transport didn't answer the
    // reverse request this test would hang (and time out) rather than resolve.
    const acpmux = writeFakeAcpmux({
      requestPermission: true,
      chunks: ['done after permission'],
    });
    const gen = makeGenerator(acpmux);
    const resp = await gen.generateContent(textRequest, 'p1');
    const text = (resp.candidates?.[0]?.content?.parts ?? [])
      .map((p) => (p as { text?: string }).text ?? '')
      .join('');
    expect(text).toContain('done after permission');
  }, 15000);

  it('fail-closed: a cancelled stopReason is an error, not a success', async () => {
    // Blocker 2: cancelled / unknown stopReason must NOT return as a normal
    // completion.
    const acpmux = writeFakeAcpmux({ stopReason: 'cancelled', chunks: ['x'] });
    const gen = makeGenerator(acpmux);
    await expect(gen.generateContent(textRequest, 'p1')).rejects.toThrow(
      /cancelled/i,
    );
  });

  it('fail-closed: an unknown stopReason is a malformed_response error', async () => {
    const acpmux = writeFakeAcpmux({
      stopReason: 'weird_reason',
      chunks: ['x'],
    });
    const gen = makeGenerator(acpmux);
    await expect(gen.generateContent(textRequest, 'p1')).rejects.toThrow(
      /unexpected stopReason/i,
    );
  });
});
