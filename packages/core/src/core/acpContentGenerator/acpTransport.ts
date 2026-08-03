/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Minimal ACP (Agent Client Protocol) client over acpmux.
 *
 * Spawns `acpmux --provider <codex|claude>` and speaks newline-delimited
 * JSON-RPC 2.0 over its stdio:
 *
 *   initialize → session/new → session/prompt
 *   (collecting `session/update` notifications for streamed text chunks)
 *
 * The local coding agent owns its own auth, so NO API key is involved. This
 * mirrors the proven transport used by the tianxi studio (acp-transport.ts /
 * acp-codex.ts) but is trimmed to what the ContentGenerator path needs.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import {
  createInterface,
  type Interface as ReadlineInterface,
} from 'node:readline';

/** Categories a caller can map to a diagnostic. Stable troubleshooting contract. */
export type ACPFailureCategory =
  | 'acpmux_not_found'
  | 'agent_not_logged_in_or_unavailable'
  | 'turn_failed'
  | 'timeout_or_cancelled'
  | 'malformed_response';

/** A classified ACP failure. `safeMessage` never embeds raw agent stderr. */
export class ACPError extends Error {
  constructor(
    readonly category: ACPFailureCategory,
    readonly safeMessage: string,
    /** Bounded, best-effort detail for logs — may be empty. */
    readonly detail?: string,
  ) {
    super(safeMessage);
    this.name = 'ACPError';
  }
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id?: number | string;
  result?: unknown;
  error?: { code: number; message: string };
  method?: string;
  params?: Record<string, unknown>;
}

const STDERR_MAX_BYTES = 16 * 1024;

/** One text chunk emitted by the agent, in arrival order. Boundaries preserved. */
export interface ACPTextChunk {
  text: string;
}

export interface ACPTransportConfig {
  provider: string; // 'codex' | 'claude'
  acpmuxPath: string; // path or bare 'acpmux'
  cwd: string;
}

/**
 * Runs a single ACP turn: spawn → initialize → session/new → session/prompt.
 * Emits each `agent_message_chunk` text to `onChunk` in arrival order WITHOUT
 * concatenating them — boundary preservation is the caller's contract (a
 * separatorless join here would recreate the canon9 chunk-boundary erasure that
 * glues distinct semantic blocks into one line). Resolves when the turn ends.
 */
export class ACPTurn {
  #child: ChildProcess | null = null;
  #reader: ReadlineInterface | null = null;
  #stderrReader: ReadlineInterface | null = null;
  readonly #stderrLines: string[] = [];
  #stderrBytes = 0;
  #nextId = 1;
  readonly #pending = new Map<
    number | string,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  readonly #listeners: Array<
    (method: string, params: Record<string, unknown>) => void
  > = [];
  #closed = false;

  constructor(private readonly config: ACPTransportConfig) {}

  async run(
    promptText: string,
    onChunk: (chunk: ACPTextChunk) => void,
    signal?: AbortSignal,
  ): Promise<{ stopReason: string }> {
    try {
      this.#spawn();
      await this.#initialize(signal);
      const session = (await this.#rpc(
        'session/new',
        { cwd: this.config.cwd },
        signal,
      )) as {
        sessionId: string;
      };
      const stopReason = await this.#promptAndCollect(
        session.sessionId,
        promptText,
        onChunk,
        signal,
      );
      return { stopReason };
    } finally {
      await this.#close();
    }
  }

  #spawn(): void {
    let child: ChildProcess;
    try {
      child = spawn(
        this.config.acpmuxPath,
        ['--provider', this.config.provider],
        { shell: false, stdio: ['pipe', 'pipe', 'pipe'] },
      );
    } catch {
      throw new ACPError(
        'acpmux_not_found',
        `acpmux could not be spawned (path: ${this.config.acpmuxPath}).`,
      );
    }

    child.once('error', (err: NodeJS.ErrnoException) => {
      // ENOENT here means the acpmux binary path is wrong / not installed.
      const category: ACPFailureCategory =
        err?.code === 'ENOENT' ? 'acpmux_not_found' : 'turn_failed';
      this.#rejectAll(
        new ACPError(
          category,
          category === 'acpmux_not_found'
            ? `acpmux not found at '${this.config.acpmuxPath}'. Install acpmux or set OPENGAME_ACPMUX_PATH.`
            : 'acpmux subprocess error.',
        ),
      );
    });

    child.once('close', () => {
      if (!this.#closed) {
        this.#rejectAll(
          new ACPError(
            'turn_failed',
            'acpmux exited before the turn completed.',
            this.#stderrLines.join('\n'),
          ),
        );
      }
    });

    this.#child = child;
    this.#reader = createInterface({ input: child.stdout! });
    this.#reader.on('line', (line) => this.#onLine(line));

    this.#stderrReader = createInterface({ input: child.stderr! });
    this.#stderrReader.on('line', (line) => {
      const lineBytes = Buffer.byteLength(line, 'utf8');
      if (this.#stderrBytes + lineBytes + 1 <= STDERR_MAX_BYTES) {
        this.#stderrLines.push(line);
        this.#stderrBytes += lineBytes + 1;
      }
    });
  }

  #onLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg: JsonRpcResponse;
    try {
      msg = JSON.parse(trimmed) as JsonRpcResponse;
    } catch {
      // Non-JSON line on stdout — ignore (agents may print banners).
      return;
    }
    if (
      msg.id !== undefined &&
      (msg.result !== undefined || msg.error !== undefined)
    ) {
      const pending = this.#pending.get(msg.id);
      if (!pending) return;
      this.#pending.delete(msg.id);
      if (msg.error) {
        pending.reject(
          new ACPError('turn_failed', `ACP RPC error: ${msg.error.message}`),
        );
      } else {
        pending.resolve(msg.result);
      }
      return;
    }
    if (msg.method && msg.params) {
      for (const listener of this.#listeners) listener(msg.method, msg.params);
    }
  }

  async #initialize(signal?: AbortSignal): Promise<void> {
    try {
      await this.#rpc(
        'initialize',
        {
          protocolVersion: 1,
          clientInfo: { name: 'opengame', version: '0.0.1' },
          clientCapabilities: {},
        },
        signal,
      );
    } catch (err) {
      // A failure at initialize typically means the agent isn't logged in /
      // available (acpmux started but the underlying agent rejected the handshake).
      if (err instanceof ACPError && err.category === 'turn_failed') {
        throw new ACPError(
          'agent_not_logged_in_or_unavailable',
          `The ${this.config.provider} agent is not available or not logged in.`,
          err.detail,
        );
      }
      throw err;
    }
  }

  #promptAndCollect(
    sessionId: string,
    promptText: string,
    onChunk: (chunk: ACPTextChunk) => void,
    signal?: AbortSignal,
  ): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      let settled = false;

      const cleanup = () => {
        settled = true;
        const idx = this.#listeners.indexOf(listener);
        if (idx >= 0) this.#listeners.splice(idx, 1);
        if (signal) signal.removeEventListener('abort', onAbort);
      };

      const listener = (method: string, params: Record<string, unknown>) => {
        if (settled) return;
        if (method !== 'session/update') return;
        if (params.sessionId !== sessionId) return;
        const update = params.update as Record<string, unknown> | undefined;
        if (!update) return;
        if (update.sessionUpdate === 'agent_message_chunk') {
          const content = update.content as Record<string, unknown> | undefined;
          if (content?.type === 'text' && typeof content.text === 'string') {
            // Emit as a discrete chunk. Boundaries are preserved by NOT joining
            // here; the caller decides how to compose (see #66 lesson).
            onChunk({ text: content.text });
          }
        }
      };

      const onAbort = () => {
        if (settled) return;
        cleanup();
        this.#rpc('session/cancel', { sessionId }).catch(() => {});
        reject(new ACPError('timeout_or_cancelled', 'ACP turn was cancelled.'));
      };

      this.#listeners.push(listener);
      if (signal?.aborted) {
        onAbort();
        return;
      }
      if (signal) signal.addEventListener('abort', onAbort, { once: true });

      this.#rpc('session/prompt', { sessionId, prompt: promptText }, signal)
        .then((result) => {
          if (settled) return;
          cleanup();
          const stopReason = (result as Record<string, unknown>)?.stopReason;
          if (stopReason === 'error') {
            reject(
              new ACPError('turn_failed', 'ACP turn ended with an error.'),
            );
          } else {
            resolve(typeof stopReason === 'string' ? stopReason : 'end_turn');
          }
        })
        .catch((err) => {
          if (settled) return;
          cleanup();
          reject(
            err instanceof ACPError
              ? err
              : new ACPError('turn_failed', 'ACP turn failed.', String(err)),
          );
        });
    });
  }

  #rpc(
    method: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (!this.#child?.stdin?.writable) {
      return Promise.reject(
        new ACPError('turn_failed', 'acpmux stdin is not writable.'),
      );
    }
    if (signal?.aborted) {
      return Promise.reject(
        new ACPError('timeout_or_cancelled', 'ACP turn was cancelled.'),
      );
    }
    const id = this.#nextId++;
    const msg = JSON.stringify({ jsonrpc: '2.0', id, method, params });
    return new Promise<unknown>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      const onAbort = () => {
        this.#pending.delete(id);
        reject(new ACPError('timeout_or_cancelled', 'ACP turn was cancelled.'));
      };
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
      this.#child!.stdin!.write(msg + '\n', (err) => {
        if (err) {
          if (signal) signal.removeEventListener('abort', onAbort);
          this.#pending.delete(id);
          reject(new ACPError('turn_failed', 'Write to acpmux failed.'));
        }
      });
    });
  }

  #rejectAll(err: Error): void {
    for (const { reject } of this.#pending.values()) reject(err);
    this.#pending.clear();
  }

  async #close(): Promise<void> {
    this.#closed = true;
    this.#reader?.close();
    this.#stderrReader?.close();
    try {
      this.#child?.stdin?.end();
    } catch {
      /* ignore */
    }
    this.#child?.kill();
    this.#child = null;
  }
}
