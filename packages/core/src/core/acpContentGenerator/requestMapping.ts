/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { GenerateContentParameters } from '@google/genai';

/**
 * Compose ACP text chunks into a single string while PRESERVING chunk
 * boundaries.
 *
 * Each ACP `agent_message_chunk` is a complete semantic block (the acpmux
 * providers emit block-granular chunks, not partial-message deltas). If two
 * distinct chunks are concatenated with no separator, semantically-separate
 * lines can be glued into one — the exact `no_per_event_verdict` failure fixed
 * in canon9 #66. The concern is stronger for tool/verdict output than for prose:
 * a glued line breaks downstream line- or event-based parsing.
 *
 * Rule: preserve any boundary a chunk already carries (a chunk ending in a
 * newline, or the next starting with one, already separates). Otherwise, since
 * the chunk is a complete block, insert a single newline between them so blocks
 * never run together. Empty chunks are skipped without emitting a separator.
 */
export function composeChunks(chunks: ReadonlyArray<{ text: string }>): string {
  let out = '';
  for (const { text } of chunks) {
    if (!text) continue;
    if (out.length === 0) {
      out = text;
      continue;
    }
    const boundaryPresent = out.endsWith('\n') || text.startsWith('\n');
    out += boundaryPresent ? text : '\n' + text;
  }
  return out;
}

/**
 * Flatten a Gemini-shaped request into a single prompt string for the ACP turn.
 *
 * v1 scope: text only. We concatenate the text parts of every content in order,
 * tagging roles so the agent sees the conversation. Non-text parts (inline data,
 * function calls/responses) are not forwarded to the agent in v1 — the caller is
 * expected to use the ACP path for text-driven generation; a full multimodal /
 * tool round-trip is a follow-up.
 */
export function flattenRequestToPrompt(
  request: GenerateContentParameters,
): string {
  const segments: string[] = [];

  const sys = extractText(
    (request.config as { systemInstruction?: unknown })?.systemInstruction,
  );
  if (sys) segments.push(`System:\n${sys}`);

  const contents = normalizeContents(request.contents);
  for (const content of contents) {
    const role =
      typeof (content as { role?: unknown })?.role === 'string'
        ? (content as { role: string }).role === 'model'
          ? 'Assistant'
          : 'User'
        : 'User';
    const text = extractText(content);
    if (text) segments.push(`${role}:\n${text}`);
  }

  return segments.join('\n\n');
}

function normalizeContents(contents: unknown): unknown[] {
  if (contents === undefined || contents === null) return [];
  return Array.isArray(contents) ? contents : [contents];
}

/** Recursively pull text out of a Content / Part / string union. */
function extractText(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value
      .map((v) => extractText(v))
      .filter((s) => s.length > 0)
      .join('\n');
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    if (typeof obj.text === 'string') return obj.text;
    if (obj.parts !== undefined) return extractText(obj.parts);
  }
  return '';
}
