/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config } from '../../config/config.js';
import type {
  ContentGenerator,
  ContentGeneratorConfig,
} from '../contentGenerator.js';
import { ACPContentGenerator } from './acpContentGenerator.js';

export { ACPError } from './acpTransport.js';
export type { ACPFailureCategory } from './acpTransport.js';

/**
 * Create a ContentGenerator that drives a local coding agent (Codex / Claude
 * Code) over ACP via acpmux. No API key is used on this path.
 */
export function createACPContentGenerator(
  config: ContentGeneratorConfig,
  gcConfig: Config,
): ContentGenerator {
  return new ACPContentGenerator(config, gcConfig);
}
