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
import { resolve as pathResolve, sep as pathSep, dirname } from 'node:path';
import { readFile, writeFile, realpath } from 'node:fs/promises';

/**
 * Policy for answering the agent's session/request_permission. Default 'allow'
 * (the agent runs under acpmux with its own sandbox); set 'deny' to refuse, which
 * returns a cancelled outcome so the provider can fail-converge instead of hang.
 */
export type ACPPermissionPolicy = 'allow' | 'deny';

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
  /** Extra argv tokens passed to acpmux via repeated --provider-arg flags. */
  providerArgs?: string[];
  cwd: string;
  /** Optional model name; applied via session/set_config_option after session/new. */
  model?: string;
  /** Optional ACP mode; yolo auto-approves supported agent tools. */
  mode?: 'yolo';
  /** How to answer agent permission requests. Default 'allow'. */
  permissionPolicy?: ACPPermissionPolicy;
}

/** Reads text-file content on behalf of the agent, scoped to the turn's cwd. */
type FsReader = (path: string) => Promise<string>;
/** Writes text-file content on behalf of the agent, scoped to the turn's cwd. */
type FsWriter = (path: string, content: string) => Promise<void>;

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
  readonly #fsReader: FsReader;
  readonly #fsWriter: FsWriter;

  constructor(
    private readonly config: ACPTransportConfig,
    // Overridable for tests; default to real fs (paths are pre-scoped to cwd).
    fs?: { read?: FsReader; write?: FsWriter },
  ) {
    this.#fsReader = fs?.read ?? ((p) => readFile(p, 'utf8'));
    this.#fsWriter =
      fs?.write ?? ((p, c) => writeFile(p, c, 'utf8').then(() => undefined));
  }

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
      if (this.config.mode) {
        await this.#rpc(
          'session/set_mode',
          {
            sessionId: session.sessionId,
            modeId: this.config.mode,
          },
          signal,
        );
      }
      // acpmux takes the model via session/set_config_option (configId "model"),
      // NOT session/new — set it here so OPENGAME_ACP_MODEL actually reaches the
      // agent instead of being silently dropped.
      if (this.config.model) {
        await this.#rpc(
          'session/set_config_option',
          {
            sessionId: session.sessionId,
            configId: 'model',
            value: this.config.model,
          },
          signal,
        );
      }
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
      const args = ['--provider', this.config.provider];
      for (const arg of this.config.providerArgs ?? []) {
        args.push('--provider-arg', arg);
      }
      child = spawn(this.config.acpmuxPath, args, {
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
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
    // Response to one of OUR outbound requests: id + (result | error).
    if (
      msg.id !== undefined &&
      msg.method === undefined &&
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
    // INBOUND REQUEST from the agent (id + method): ACP is bidirectional — acpmux
    // forwards session/request_permission, fs/read_text_file, fs/write_text_file
    // FROM the agent and BLOCKS until we answer. Dropping these to the notification
    // path (as before) hangs any permission-gated tool call the agent makes — which,
    // under plan A (the agent runs its own tools), is the common case, not an edge.
    if (msg.id !== undefined && msg.method) {
      void this.#handleInboundRequest(msg.id, msg.method, msg.params ?? {});
      return;
    }
    // Notification (method, no id): e.g. session/update.
    if (msg.method) {
      for (const listener of this.#listeners)
        listener(msg.method, msg.params ?? {});
    }
  }

  /**
   * Answer an agent→client request. We keep the client side minimal but correct:
   * grant permission (the agent runs under acpmux with its own sandbox/config),
   * and service fs read/write within the turn's cwd (path traversal outside cwd
   * is denied). Every branch SENDS a response so the agent never blocks forever.
   */
  async #handleInboundRequest(
    id: number | string,
    method: string,
    params: Record<string, unknown>,
  ): Promise<void> {
    try {
      let result: unknown;
      if (method === 'session/request_permission') {
        // Explicit policy (default 'allow'; 'deny' refuses). We never hang: either
        // path returns a concrete outcome. acpmux/the agent still enforces its own
        // sandbox — this only decides our answer.
        const policy = this.config.permissionPolicy ?? 'allow';
        const options =
          (params['options'] as Array<{ optionId?: string }>) ?? [];
        if (policy === 'deny') {
          this.#log(`permission: DENY (policy=deny)`);
          result = { outcome: { outcome: 'cancelled' } };
        } else {
          const allow =
            options.find((o) =>
              /allow|grant|yes|approve/i.test(o.optionId ?? ''),
            )?.optionId ?? options[0]?.optionId;
          this.#log(
            `permission: ${allow ? `ALLOW ${allow}` : 'CANCEL (no option)'}`,
          );
          result = allow
            ? { outcome: { outcome: 'selected', optionId: allow } }
            : { outcome: { outcome: 'cancelled' } };
        }
      } else if (method === 'fs/read_text_file') {
        const p = await this.#resolveInCwd(String(params['path'] ?? ''));
        result = { content: await this.#fsReader(p) };
      } else if (method === 'fs/write_text_file') {
        const p = await this.#resolveInCwd(String(params['path'] ?? ''));
        await this.#fsWriter(p, String(params['content'] ?? ''));
        result = {};
      } else {
        // Unknown inbound request — respond with an error rather than hang.
        this.#respond(id, undefined, {
          code: -32601,
          message: `unsupported request: ${method}`,
        });
        return;
      }
      this.#respond(id, result);
    } catch (err) {
      this.#respond(id, undefined, {
        code: -32000,
        message: err instanceof Error ? err.message : 'request failed',
      });
    }
  }

  /**
   * Resolve a path the agent asked us to read/write and confirm it stays inside
   * the turn's workspace — with SYMLINK safety, not just a string-prefix check.
   * A string check alone lets a symlink inside cwd point outside it; we realpath
   * the deepest existing ancestor so a symlink escape is rejected. Absolute paths,
   * `..` traversal, and symlink escapes all throw (the caller returns a JSON-RPC
   * error so the provider fail-converges instead of hanging).
   */
  async #resolveInCwd(p: string): Promise<string> {
    const baseReal = await realpath(pathResolve(this.config.cwd));
    const candidate = pathResolve(this.config.cwd, p);

    // Realpath the nearest existing ancestor (the target itself may not exist yet
    // for a write). This resolves any symlink components along the way.
    let probe = candidate;

    while (true) {
      try {
        const real = await realpath(probe);
        // Re-attach the not-yet-existing tail to the resolved ancestor.
        const tail = candidate.slice(probe.length);
        const finalReal = pathResolve(real + tail);
        if (
          finalReal !== baseReal &&
          !finalReal.startsWith(baseReal + pathSep)
        ) {
          throw new ACPError('turn_failed', `path escapes workspace: ${p}`);
        }
        return finalReal;
      } catch (err) {
        if (err instanceof ACPError) throw err;
        const parent = dirname(probe);
        if (parent === probe) {
          throw new ACPError('turn_failed', `cannot resolve path: ${p}`);
        }
        probe = parent;
      }
    }
  }

  #log(message: string): void {
    // Bounded, non-secret breadcrumb for troubleshooting the reverse-RPC path.
    if (process.env['OPENGAME_ACP_DEBUG']) {
      console.error(`[acp] ${message}`);
    }
  }

  #respond(
    id: number | string,
    result?: unknown,
    error?: { code: number; message: string },
  ): void {
    if (!this.#child?.stdin?.writable) return;
    const msg =
      error !== undefined
        ? { jsonrpc: '2.0', id, error }
        : { jsonrpc: '2.0', id, result: result ?? {} };
    this.#child.stdin.write(JSON.stringify(msg) + '\n');
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
          // Fail-closed: ONLY an explicit successful end is a success. A
          // `cancelled`, `error`, missing, or unknown stopReason must NOT be
          // returned as a normal completion (that would misreport an interrupted
          // or malformed turn as a successful generation).
          if (stopReason === 'end_turn') {
            resolve('end_turn');
          } else if (stopReason === 'cancelled') {
            reject(
              new ACPError('timeout_or_cancelled', 'ACP turn was cancelled.'),
            );
          } else if (stopReason === 'error') {
            reject(
              new ACPError('turn_failed', 'ACP turn ended with an error.'),
            );
          } else {
            reject(
              new ACPError(
                'malformed_response',
                `ACP turn returned an unexpected stopReason: ${String(stopReason)}`,
              ),
            );
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
