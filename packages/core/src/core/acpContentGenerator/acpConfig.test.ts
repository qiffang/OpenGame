/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { AuthType, createContentGeneratorConfig } from '../contentGenerator.js';
import type { Config } from '../../config/config.js';

const fakeConfig = {
  getProxy: () => undefined,
} as unknown as Config;

const OPENAI_VARS = ['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_MODEL'];
const ACP_VARS = [
  'OPENGAME_ACP_PROVIDER',
  'OPENGAME_ACP_MODEL',
  'OPENGAME_ACPMUX_PATH',
];

describe('createContentGeneratorConfig — ACP no-key gate (contract #1)', () => {
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of [...OPENAI_VARS, ...ACP_VARS]) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('resolves ACP config with NO apiKey even when a (bogus) OpenAI key is set', () => {
    // The discriminating input: OpenAI env is present and WRONG. A path that
    // reads OPENAI_* would silently pick it up and redirect to a hosted API.
    process.env['OPENAI_API_KEY'] = 'sk-bogus-should-never-be-read';
    process.env['OPENAI_BASE_URL'] = 'https://evil.example/v1';
    process.env['OPENAI_MODEL'] = 'gpt-should-not-be-used';
    process.env['OPENGAME_ACP_PROVIDER'] = 'codex';

    const cfg = createContentGeneratorConfig(fakeConfig, AuthType.USE_ACP);

    expect(cfg.authType).toBe(AuthType.USE_ACP);
    expect(cfg.apiKey).toBeUndefined();
    expect(cfg.baseUrl).toBeUndefined();
    expect(cfg.acp?.provider).toBe('codex');
    // Must NOT have adopted any OpenAI value.
    expect(cfg.baseUrl).not.toBe('https://evil.example/v1');
    expect(cfg.model).not.toBe('gpt-should-not-be-used');
  });

  it('does not require any API key to build the ACP config', () => {
    // No OPENAI_* and no OPENAI key at all — ACP must still resolve (unlike the
    // OpenAI branch which throws without a key).
    process.env['OPENGAME_ACP_PROVIDER'] = 'claude';
    const cfg = createContentGeneratorConfig(fakeConfig, AuthType.USE_ACP);
    expect(cfg.acp?.provider).toBe('claude');
    expect(cfg.apiKey).toBeUndefined();
  });

  it('defaults provider to codex and acpmuxPath to "acpmux"', () => {
    const cfg = createContentGeneratorConfig(fakeConfig, AuthType.USE_ACP);
    expect(cfg.acp?.provider).toBe('codex');
    expect(cfg.acp?.acpmuxPath).toBe('acpmux');
  });

  it('does NOT set acp.model to the provider name (no OPENGAME_ACP_MODEL)', () => {
    // Regression: acp.model must be undefined when no explicit model is set — NOT
    // the provider name 'codex'. Sending set_config_option(model='codex') makes the
    // agent try to use a model literally named "codex" and the turn errors.
    const cfg = createContentGeneratorConfig(fakeConfig, AuthType.USE_ACP);
    expect(cfg.acp?.model).toBeUndefined();
  });

  it('sets acp.model ONLY from OPENGAME_ACP_MODEL when explicitly configured', () => {
    process.env['OPENGAME_ACP_PROVIDER'] = 'claude';
    process.env['OPENGAME_ACPMUX_PATH'] = '/opt/acpmux';
    process.env['OPENGAME_ACP_MODEL'] = 'claude-sonnet';
    const cfg = createContentGeneratorConfig(fakeConfig, AuthType.USE_ACP);
    expect(cfg.acp?.acpmuxPath).toBe('/opt/acpmux');
    expect(cfg.acp?.model).toBe('claude-sonnet');
  });

  it('fails closed on an unsupported provider (no silent fallback)', () => {
    process.env['OPENGAME_ACP_PROVIDER'] = 'gpt4';
    expect(() =>
      createContentGeneratorConfig(fakeConfig, AuthType.USE_ACP),
    ).toThrow(/Unsupported OPENGAME_ACP_PROVIDER/);
  });

  it('OpenAI path is unchanged: still throws without OPENAI_API_KEY', () => {
    // Regression guard: adding USE_ACP must not weaken the USE_OPENAI branch.
    expect(() =>
      createContentGeneratorConfig(fakeConfig, AuthType.USE_OPENAI),
    ).toThrow(/OPENAI_API_KEY/);
  });
});
