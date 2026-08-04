/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  CountTokensParameters,
  CountTokensResponse,
  EmbedContentParameters,
  EmbedContentResponse,
  GenerateContentParameters,
  GenerateContentResponse,
} from '@google/genai';
import { DEFAULT_QWEN_MODEL } from '../config/models.js';
import type { Config } from '../config/config.js';
import { LoggingContentGenerator } from './loggingContentGenerator/index.js';

/**
 * Interface abstracting the core functionalities for generating content and counting tokens.
 */
export interface ContentGenerator {
  generateContent(
    request: GenerateContentParameters,
    userPromptId: string,
  ): Promise<GenerateContentResponse>;

  generateContentStream(
    request: GenerateContentParameters,
    userPromptId: string,
  ): Promise<AsyncGenerator<GenerateContentResponse>>;

  countTokens(request: CountTokensParameters): Promise<CountTokensResponse>;

  embedContent(request: EmbedContentParameters): Promise<EmbedContentResponse>;

  useSummarizedThinking(): boolean;
}

export enum AuthType {
  USE_OPENAI = 'openai',
  QWEN_OAUTH = 'qwen-oauth',
  USE_GEMINI = 'gemini',
  USE_VERTEX_AI = 'vertex-ai',
  USE_ANTHROPIC = 'anthropic',
  // Drive the LLM through an ACP (Agent Client Protocol) backend — a locally
  // installed coding agent (Codex / Claude Code) spawned via acpmux — instead of
  // a hosted HTTP API. This path deliberately requires NO OpenAI/Anthropic/Gemini
  // API key: the local agent owns its own auth. See acpContentGenerator/.
  USE_ACP = 'acp',
}

export type ContentGeneratorConfig = {
  model: string;
  apiKey?: string;
  baseUrl?: string;
  vertexai?: boolean;
  authType?: AuthType | undefined;
  enableOpenAILogging?: boolean;
  openAILoggingDir?: string;
  timeout?: number; // Timeout configuration in milliseconds
  maxRetries?: number; // Maximum retries for failed requests
  disableCacheControl?: boolean; // Disable cache control for DashScope providers
  samplingParams?: {
    top_p?: number;
    top_k?: number;
    repetition_penalty?: number;
    presence_penalty?: number;
    frequency_penalty?: number;
    temperature?: number;
    max_tokens?: number;
  };
  reasoning?:
    | false
    | {
        effort?: 'low' | 'medium' | 'high';
        budget_tokens?: number;
      };
  proxy?: string | undefined;
  userAgent?: string;
  // Schema compliance mode for tool definitions
  schemaCompliance?: 'auto' | 'openapi_30';
  // ACP backend (AuthType.USE_ACP) settings. No API key is used on this path.
  acp?: {
    // Which local coding agent acpmux should drive: 'codex' | 'claude'.
    provider: string;
    // Path to the acpmux binary (defaults to 'acpmux' on PATH).
    acpmuxPath: string;
    // Extra argv tokens passed to the selected acpmux provider via
    // repeated --provider-arg flags.
    providerArgs?: string[];
    // ACP session mode to set after session/new, e.g. 'yolo'.
    mode?: 'yolo';
    // Explicit model override (OPENGAME_ACP_MODEL) or undefined to use the
    // agent's own default. Never the provider name.
    model?: string;
  };
};

export function createContentGeneratorConfig(
  config: Config,
  authType: AuthType | undefined,
  generationConfig?: Partial<ContentGeneratorConfig>,
): ContentGeneratorConfig {
  let newContentGeneratorConfig: Partial<ContentGeneratorConfig> = {
    ...(generationConfig || {}),
    authType,
    proxy: config?.getProxy(),
  };

  if (authType === AuthType.QWEN_OAUTH) {
    // For Qwen OAuth, we'll handle the API key dynamically in createContentGenerator
    // Set a special marker to indicate this is Qwen OAuth
    return {
      ...newContentGeneratorConfig,
      model: DEFAULT_QWEN_MODEL,
      apiKey: 'QWEN_OAUTH_DYNAMIC_TOKEN',
    } as ContentGeneratorConfig;
  }

  if (authType === AuthType.USE_ACP) {
    // ACP path: the local coding agent (Codex / Claude Code) owns its own auth,
    // so we deliberately do NOT read or require OPENAI_API_KEY / OPENAI_BASE_URL /
    // OPENAI_MODEL (or any other hosted-API key). Reading them here would let a
    // stray key silently redirect us to a hosted API — exactly the failure this
    // path exists to avoid. Configuration comes only from the ACP-specific env.
    const provider = (
      newContentGeneratorConfig.acp?.provider ||
      process.env['OPENGAME_ACP_PROVIDER'] ||
      'codex'
    ).toLowerCase();
    if (provider !== 'codex' && provider !== 'claude') {
      throw new Error(
        `Unsupported OPENGAME_ACP_PROVIDER: ${provider}. Expected 'codex' or 'claude'.`,
      );
    }
    // The ACP model override is ONLY the explicitly-configured OPENGAME_ACP_MODEL.
    // We must NOT fall back to the provider name ('codex'/'claude') — that is not a
    // real model, and sending session/set_config_option(model='codex') makes the
    // agent try to use a model literally named "codex" and the turn errors. When no
    // model is set, we leave it undefined so the transport skips set_config_option
    // and the agent uses its own default model.
    const acpModel = process.env['OPENGAME_ACP_MODEL'] || undefined;
    const approvalMode = (
      config as { getApprovalMode?: () => string } | undefined
    )?.getApprovalMode?.();
    const acpMode = approvalMode === 'yolo' ? 'yolo' : undefined;
    const providerArgs =
      newContentGeneratorConfig.acp?.providerArgs ??
      (provider === 'claude' && acpMode === 'yolo'
        ? ['--permission-mode', 'bypassPermissions']
        : []);
    return {
      ...newContentGeneratorConfig,
      // No apiKey / baseUrl on this path.
      apiKey: undefined,
      baseUrl: undefined,
      // Top-level model is a display/config label only (some call sites read it);
      // it is NOT sent to the agent unless acp.model is set.
      model: newContentGeneratorConfig.model || acpModel || provider,
      acp: {
        provider,
        acpmuxPath:
          newContentGeneratorConfig.acp?.acpmuxPath ||
          process.env['OPENGAME_ACPMUX_PATH'] ||
          'acpmux',
        providerArgs,
        mode: newContentGeneratorConfig.acp?.mode ?? acpMode,
        model: acpModel,
      },
    } as ContentGeneratorConfig;
  }

  if (authType === AuthType.USE_OPENAI) {
    newContentGeneratorConfig = {
      ...newContentGeneratorConfig,
      apiKey: newContentGeneratorConfig.apiKey || process.env['OPENAI_API_KEY'],
      baseUrl:
        newContentGeneratorConfig.baseUrl || process.env['OPENAI_BASE_URL'],
      model: newContentGeneratorConfig.model || process.env['OPENAI_MODEL'],
    };

    if (!newContentGeneratorConfig.apiKey) {
      throw new Error('OPENAI_API_KEY environment variable not found.');
    }

    return {
      ...newContentGeneratorConfig,
      model: newContentGeneratorConfig?.model || 'qwen3-coder-plus',
    } as ContentGeneratorConfig;
  }

  if (authType === AuthType.USE_ANTHROPIC) {
    newContentGeneratorConfig = {
      ...newContentGeneratorConfig,
      apiKey:
        newContentGeneratorConfig.apiKey || process.env['ANTHROPIC_API_KEY'],
      baseUrl:
        newContentGeneratorConfig.baseUrl || process.env['ANTHROPIC_BASE_URL'],
      model: newContentGeneratorConfig.model || process.env['ANTHROPIC_MODEL'],
    };

    if (!newContentGeneratorConfig.apiKey) {
      throw new Error('ANTHROPIC_API_KEY environment variable not found.');
    }

    if (!newContentGeneratorConfig.baseUrl) {
      throw new Error('ANTHROPIC_BASE_URL environment variable not found.');
    }

    if (!newContentGeneratorConfig.model) {
      throw new Error('ANTHROPIC_MODEL environment variable not found.');
    }
  }

  if (authType === AuthType.USE_GEMINI) {
    newContentGeneratorConfig = {
      ...newContentGeneratorConfig,
      apiKey: newContentGeneratorConfig.apiKey || process.env['GEMINI_API_KEY'],
      model: newContentGeneratorConfig.model || process.env['GEMINI_MODEL'],
    };

    if (!newContentGeneratorConfig.apiKey) {
      throw new Error('GEMINI_API_KEY environment variable not found.');
    }

    if (!newContentGeneratorConfig.model) {
      throw new Error('GEMINI_MODEL environment variable not found.');
    }
  }

  if (authType === AuthType.USE_VERTEX_AI) {
    newContentGeneratorConfig = {
      ...newContentGeneratorConfig,
      apiKey: newContentGeneratorConfig.apiKey || process.env['GOOGLE_API_KEY'],
      model: newContentGeneratorConfig.model || process.env['GOOGLE_MODEL'],
    };

    if (!newContentGeneratorConfig.apiKey) {
      throw new Error('GOOGLE_API_KEY environment variable not found.');
    }

    if (!newContentGeneratorConfig.model) {
      throw new Error('GOOGLE_MODEL environment variable not found.');
    }
  }

  return newContentGeneratorConfig as ContentGeneratorConfig;
}

export async function createContentGenerator(
  config: ContentGeneratorConfig,
  gcConfig: Config,
  isInitialAuth?: boolean,
): Promise<ContentGenerator> {
  if (config.authType === AuthType.USE_ACP) {
    // ACP path: spawn a local coding agent (Codex / Claude Code) via acpmux.
    // No API key is used or required here.
    const { createACPContentGenerator } =
      await import('./acpContentGenerator/index.js');
    const generator = createACPContentGenerator(config, gcConfig);
    return new LoggingContentGenerator(generator, gcConfig);
  }

  if (config.authType === AuthType.USE_OPENAI) {
    if (!config.apiKey) {
      throw new Error('OPENAI_API_KEY environment variable not found.');
    }

    // Import OpenAIContentGenerator dynamically to avoid circular dependencies
    const { createOpenAIContentGenerator } =
      await import('./openaiContentGenerator/index.js');

    // Always use OpenAIContentGenerator, logging is controlled by enableOpenAILogging flag
    const generator = createOpenAIContentGenerator(config, gcConfig);
    return new LoggingContentGenerator(generator, gcConfig);
  }

  if (config.authType === AuthType.QWEN_OAUTH) {
    // Import required classes dynamically
    const { getQwenOAuthClient: getQwenOauthClient } =
      await import('../qwen/qwenOAuth2.js');
    const { QwenContentGenerator } =
      await import('../qwen/qwenContentGenerator.js');

    try {
      // Get the Qwen OAuth client (now includes integrated token management)
      // If this is initial auth, require cached credentials to detect missing credentials
      const qwenClient = await getQwenOauthClient(
        gcConfig,
        isInitialAuth ? { requireCachedCredentials: true } : undefined,
      );

      // Create the content generator with dynamic token management
      const generator = new QwenContentGenerator(qwenClient, config, gcConfig);
      return new LoggingContentGenerator(generator, gcConfig);
    } catch (error) {
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  if (config.authType === AuthType.USE_ANTHROPIC) {
    if (!config.apiKey) {
      throw new Error('ANTHROPIC_API_KEY environment variable not found.');
    }

    const { createAnthropicContentGenerator } =
      await import('./anthropicContentGenerator/index.js');

    const generator = createAnthropicContentGenerator(config, gcConfig);
    return new LoggingContentGenerator(generator, gcConfig);
  }

  if (
    config.authType === AuthType.USE_GEMINI ||
    config.authType === AuthType.USE_VERTEX_AI
  ) {
    const { createGeminiContentGenerator } =
      await import('./geminiContentGenerator/index.js');
    const generator = createGeminiContentGenerator(config, gcConfig);
    return new LoggingContentGenerator(generator, gcConfig);
  }

  throw new Error(
    `Error creating contentGenerator: Unsupported authType: ${config.authType}`,
  );
}
