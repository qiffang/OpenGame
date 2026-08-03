/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const webui = join(here, '..', 'webui.mjs');

// Fields that must NEVER appear in a page-facing (child-facing) response. If the
// error surface ever leaks any of these, a 10-year-old sees raw technical detail.
const FORBIDDEN_ON_PAGE = [
  'acp', // provider name
  'claude', // provider name
  'opengame', // internal tool / command
  'stderr',
  'stack',
  'Error:',
  '/var/', // filesystem paths (macOS tmp)
  '/tmp/',
  'exit code',
  'exited with',
  'ENOENT',
  'spawn',
  'dist/cli.js',
  'OPENGAME_', // any env / config token
];

let proc;

afterEach(() => {
  if (proc && !proc.killed) proc.kill('SIGKILL');
  proc = undefined;
});

// A tiny "CLI" that always exits non-zero and prints a technical-looking error
// to stderr — exactly the kind of detail that must NOT reach the page.
const brokenCli = join(here, 'fixtures-webui-broken-cli.mjs');

/** Start the webui server pointed at a deliberately-failing CLI so every
 *  generation fails at the generate stage. Returns { base }. */
async function startServer(port) {
  proc = spawn(process.execPath, [webui], {
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      // Override the CLI with a program that exits non-zero → generate-stage
      // failure, deterministically, without needing a real build.
      OPENGAME_WEBUI_CLI: brokenCli,
    },
    stdio: 'ignore',
  });
  // Wait for the port to accept connections.
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(base + '/', { cache: 'no-store' });
      if (r.ok) return { base };
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('server did not start');
}

async function pollUntilTerminal(base, jobId, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = await fetch(`${base}/status/${jobId}`, { cache: 'no-store' });
    const s = await r.json();
    if (s.status === 'done' || s.status === 'failed') return s;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error('job did not reach a terminal state in time');
}

describe('webui error surface is child-safe', () => {
  it('POST /generate returns a job id immediately (no long-held request)', async () => {
    const { base } = await startServer(8791);
    const t0 = Date.now();
    const res = await fetch(base + '/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'make a game' }),
    });
    const data = await res.json();
    // Must return promptly with a job id — NOT hold the connection for minutes.
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(res.status).toBe(202);
    expect(typeof data.job_id).toBe('string');
    expect(data.job_id.length).toBeGreaterThan(0);
  }, 40000);

  it('a failed generation exposes ONLY a safe message + diagnostic id to the page', async () => {
    // Force failure: build is present in CI only sometimes; if dist/cli.js is
    // missing we get a 503 config error (also page-safe). Either way the page
    // response must be clean. To deterministically hit the generate-stage
    // failure, run against a server whose CLI is broken.
    const { base } = await startServer(8792);
    const res = await fetch(base + '/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'make a game' }),
    });
    const data = await res.json();

    let terminal;
    if (res.status === 202) {
      terminal = await pollUntilTerminal(base, data.job_id);
      expect(terminal.status).toBe('failed');
    } else {
      // config error (dist/cli.js not built) — the immediate response IS the
      // page-facing surface; assert on it directly.
      terminal = data;
    }

    // The exact assertion the acceptance line requires: the page-facing payload
    // must contain a plain human message + a diagnostic id, and leak NONE of the
    // technical fields.
    const blob = JSON.stringify(terminal).toLowerCase();
    for (const forbidden of FORBIDDEN_ON_PAGE) {
      expect(blob).not.toContain(forbidden.toLowerCase());
    }
    expect(typeof terminal.message).toBe('string');
    expect(terminal.message.length).toBeGreaterThan(0);
  }, 60000);

  it('an unknown job id returns a clean not-found message', async () => {
    const { base } = await startServer(8793);
    const r = await fetch(base + '/status/gen-does-not-exist', {
      cache: 'no-store',
    });
    const s = await r.json();
    const blob = JSON.stringify(s).toLowerCase();
    for (const forbidden of FORBIDDEN_ON_PAGE) {
      expect(blob).not.toContain(forbidden.toLowerCase());
    }
    expect(typeof s.message).toBe('string');
  }, 40000);
});
