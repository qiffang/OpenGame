/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  type CountTokensParameters,
  type CountTokensResponse,
  type EmbedContentParameters,
  type EmbedContentResponse,
  FinishReason,
  type GenerateContentParameters,
  GenerateContentResponse,
  type Part,
} from '@google/genai';
import type { Config } from '../../config/config.js';
import type {
  ContentGenerator,
  ContentGeneratorConfig,
} from '../contentGenerator.js';
import { getDefaultTokenizer } from '../../utils/request-tokenizer/index.js';
import { ACPError, ACPTurn, type ACPTextChunk } from './acpTransport.js';
import { flattenRequestToPrompt, composeChunks } from './requestMapping.js';

/**
 * A ContentGenerator backed by a local coding agent (Codex / Claude Code) driven
 * over ACP via acpmux. No hosted API key is used.
 *
 * Scope (v1): the main text-generation path. The agent runs with its OWN local
 * tools (it edits files / runs builds directly through acpmux), so we do not (yet)
 * round-trip Gemini functionCalls back to OpenGame's tool scheduler — that
 * bidirectional tool bridge is a follow-up. `embedContent` fails clearly (it is
 * not on the default game-generation path; smart-edit is off by default).
 */
export class ACPContentGenerator implements ContentGenerator {
  constructor(
    private readonly config: ContentGeneratorConfig,
    private readonly gcConfig: Config,
  ) {}

  private acp() {
    const acp = this.config.acp;
    if (!acp) {
      throw new ACPError(
        'turn_failed',
        'ACP content generator was created without ACP configuration.',
      );
    }
    return acp;
  }

  async generateContent(
    request: GenerateContentParameters,
    _userPromptId: string,
  ): Promise<GenerateContentResponse> {
    const acp = this.acp();
    const prompt = flattenRequestToPrompt(request);

    const chunks: ACPTextChunk[] = [];
    const turn = new ACPTurn({
      provider: acp.provider,
      acpmuxPath: acp.acpmuxPath,
      cwd: this.gcConfig.getWorkingDir(),
      model: acp.model,
    });

    const abortSignal = (request.config as { abortSignal?: AbortSignal })
      ?.abortSignal;
    const { stopReason } = await turn.run(
      prompt,
      (chunk) => chunks.push(chunk),
      abortSignal,
    );

    return this.buildResponse(chunks, stopReason);
  }

  async generateContentStream(
    request: GenerateContentParameters,
    _userPromptId: string,
  ): Promise<AsyncGenerator<GenerateContentResponse>> {
    const acp = this.acp();
    const prompt = flattenRequestToPrompt(request);
    const cwd = this.gcConfig.getWorkingDir();
    const model = acp.model;
    const abortSignal = (request.config as { abortSignal?: AbortSignal })
      ?.abortSignal;

    const buildResponse = this.buildResponse.bind(this);
    async function* stream(): AsyncGenerator<GenerateContentResponse> {
      const queue: ACPTextChunk[] = [];
      let done = false;
      let failure: unknown;
      let stopReason = 'end_turn';
      let notify: (() => void) | null = null;

      const turn = new ACPTurn({
        provider: acp.provider,
        acpmuxPath: acp.acpmuxPath,
        cwd,
        model,
      });
      const runPromise = turn
        .run(
          prompt,
          (chunk) => {
            queue.push(chunk);
            notify?.();
          },
          abortSignal,
        )
        .then((r) => {
          stopReason = r.stopReason;
        })
        .catch((e) => {
          failure = e;
        })
        .finally(() => {
          done = true;
          notify?.();
        });

      // Drain chunks as they arrive. Each ACP chunk becomes its own streamed
      // GenerateContentResponse — boundaries are preserved 1:1, never glued.
      while (true) {
        if (queue.length > 0) {
          const chunk = queue.shift()!;
          yield buildResponse([chunk], undefined);
          continue;
        }
        if (done) break;
        await new Promise<void>((resolve) => {
          notify = () => {
            notify = null;
            resolve();
          };
        });
      }

      await runPromise;
      if (failure) throw failure;
      // Terminal response carries the finish reason (no extra text).
      yield buildResponse([], stopReason);
    }

    return stream();
  }

  async countTokens(
    request: CountTokensParameters,
  ): Promise<CountTokensResponse> {
    // Real token counting — this feeds the session-token-limit budget gate in
    // client.ts, so a fake value would corrupt planning. Reuse the same
    // high-performance tokenizer the OpenAI path uses.
    const tokenizer = getDefaultTokenizer();
    const result = await tokenizer.calculateTokens(request, {
      textEncoding: 'cl100k_base',
    });
    return { totalTokens: result.totalTokens };
  }

  async embedContent(
    _request: EmbedContentParameters,
  ): Promise<EmbedContentResponse> {
    // The ACP path drives a coding agent, not an embedding model. embedContent is
    // only reached via smart-edit, which is disabled by default and off the
    // game-generation path. Fail clearly rather than return a fake vector that
    // would silently corrupt any downstream retrieval.
    throw new ACPError(
      'turn_failed',
      'embedContent is not supported on the ACP backend (no embedding model). ' +
        'Disable features that require embeddings, or use an API-key backend for them.',
    );
  }

  useSummarizedThinking(): boolean {
    return false;
  }

  private buildResponse(
    chunks: ACPTextChunk[],
    stopReason: string | undefined,
  ): GenerateContentResponse {
    const response = new GenerateContentResponse();
    const parts: Part[] = [];
    const text = composeChunks(chunks);
    if (text.length > 0) {
      parts.push({ text });
    }
    response.candidates = [
      {
        content: { parts, role: 'model' as const },
        finishReason:
          stopReason === undefined
            ? undefined
            : stopReason === 'cancelled'
              ? FinishReason.OTHER
              : FinishReason.STOP,
        index: 0,
      },
    ];
    return response;
  }
}
