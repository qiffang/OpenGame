/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const gate = join(here, '..', 'liveness-gate.mjs');
const fixtures = join(here, '..', 'liveness-fixtures');

function runGate(html) {
  try {
    const stdout = execFileSync('node', [gate, join(fixtures, html)], {
      encoding: 'utf8',
    });
    return { code: 0, out: JSON.parse(stdout) };
  } catch (e) {
    return { code: e.status ?? 1, out: e.stdout ? JSON.parse(e.stdout) : {} };
  }
}

// These fixtures are the discriminating power of the gate: it must REJECT each
// so a real interactive game is not confused with them.
describe('liveness-gate is discriminating (rejects non-interactive artifacts)', () => {
  it('FAILs a blank canvas (nothing drawn)', () => {
    const { code, out } = runGate('blank.html');
    expect(code).toBe(1);
    expect(out.verdict).toBe('FAIL');
    expect(out.canvasDrawsPixels).toBe(false);
  }, 60000);

  it('FAILs a static canvas (drawn once, no loop)', () => {
    const { code, out } = runGate('static.html');
    expect(code).toBe(1);
    expect(out.verdict).toBe('FAIL');
    expect(out.rafRuns).toBe(false);
  }, 60000);

  it('FAILs an animated canvas with NO input handler', () => {
    const { code, out } = runGate('animated-no-input.html');
    expect(code).toBe(1);
    expect(out.verdict).toBe('FAIL');
    expect(out.rafRuns).toBe(true);
    expect(out.respondsToInput).toBe(false);
  }, 60000);

  it('FAILs a fake-button artifact (handler exists but does nothing)', () => {
    const { code, out } = runGate('fake-button.html');
    expect(code).toBe(1);
    expect(out.verdict).toBe('FAIL');
    expect(out.respondsToInput).toBe(false);
  }, 60000);
});
