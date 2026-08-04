/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

// A stand-in for the OpenGame CLI that never exits, used by webui.test.js to
// exercise the generation TIMEOUT path (the server SIGKILLs it after
// OPENGAME_WEBUI_TIMEOUT_MS and the job must land in a child-safe failed state).
setInterval(() => {}, 1000);
