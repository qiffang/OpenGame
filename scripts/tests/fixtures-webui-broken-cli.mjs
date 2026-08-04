/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

// A stand-in for the OpenGame CLI that ALWAYS fails, used by webui.test.js to
// exercise the generate-stage failure surface. It prints technical-looking
// detail to stderr (provider name, a fake stack, a path) precisely so the test
// can assert NONE of it leaks to the page.
process.stderr.write(
  'Error: ACP/claude backend failed\n' +
    '    at generate (/tmp/opengame/agent.js:42:7)\n' +
    'ENOENT: OPENGAME_ACP_PROVIDER unreachable\n',
);
process.exit(2);
