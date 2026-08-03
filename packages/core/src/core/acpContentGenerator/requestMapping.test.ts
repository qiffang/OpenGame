/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { composeChunks, flattenRequestToPrompt } from './requestMapping.js';

describe('composeChunks — chunk-boundary preservation (canon9 #66 regression)', () => {
  it('inserts a newline between two block-granular chunks that carry no boundary', () => {
    // This is the exact failure #66 fixed: two distinct semantic blocks arriving
    // as separate chunks must NOT be glued into one line. A separatorless join
    // would produce 'EVENT aINTEGRATED b' and break line/event parsing.
    const out = composeChunks([{ text: 'EVENT a' }, { text: 'INTEGRATED b' }]);
    expect(out).toBe('EVENT a\nINTEGRATED b');
    // Discriminating: the two logical lines are still separable by '\n'.
    expect(out.split('\n')).toEqual(['EVENT a', 'INTEGRATED b']);
    // A glued (buggy) join would put them on one line.
    expect(out).not.toBe('EVENT aINTEGRATED b');
  });

  it('does not double a boundary already present at the end of a chunk', () => {
    const out = composeChunks([{ text: 'line1\n' }, { text: 'line2' }]);
    expect(out).toBe('line1\nline2');
  });

  it('does not double a boundary already present at the start of the next chunk', () => {
    const out = composeChunks([{ text: 'line1' }, { text: '\nline2' }]);
    expect(out).toBe('line1\nline2');
  });

  it('keeps a single chunk verbatim', () => {
    expect(composeChunks([{ text: 'only' }])).toBe('only');
  });

  it('skips empty chunks without emitting a stray separator', () => {
    const out = composeChunks([{ text: 'a' }, { text: '' }, { text: 'b' }]);
    expect(out).toBe('a\nb');
  });

  it('preserves boundaries across three intermixed prose/verdict blocks', () => {
    const out = composeChunks([
      { text: 'thinking about the page' },
      { text: 'wrote semantic/projects/drive9.md' },
      { text: 'EVENT evt_1 INTEGRATED pages: semantic/projects/drive9.md' },
    ]);
    const lines = out.split('\n');
    // The verdict line must be independently parseable (anchored at line start).
    expect(lines.some((l) => l.startsWith('EVENT evt_1 INTEGRATED'))).toBe(
      true,
    );
  });
});

describe('flattenRequestToPrompt', () => {
  it('flattens system + user/model turns into a labeled text prompt', () => {
    const prompt = flattenRequestToPrompt({
      model: 'x',
      config: { systemInstruction: 'be helpful' },
      contents: [
        { role: 'user', parts: [{ text: 'make a game' }] },
        { role: 'model', parts: [{ text: 'ok' }] },
      ],
    } as never);
    expect(prompt).toContain('System:\nbe helpful');
    expect(prompt).toContain('User:\nmake a game');
    expect(prompt).toContain('Assistant:\nok');
  });

  it('handles a bare string content', () => {
    const prompt = flattenRequestToPrompt({
      model: 'x',
      contents: 'hello',
    } as never);
    expect(prompt).toContain('hello');
  });
});
