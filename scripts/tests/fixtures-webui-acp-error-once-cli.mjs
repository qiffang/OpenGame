#!/usr/bin/env node
/**
 * Fails once with the transient ACP stream error seen in Web UI runs, then
 * succeeds on retry by writing an index.html into the same workspace.
 */
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const marker = join(process.cwd(), '.transient-acp-error-seen');

if (!existsSync(marker)) {
  writeFileSync(marker, 'seen\n');
  console.error(
    'API Error: Connection closed mid-response. The response above may be incomplete.',
  );
  setInterval(() => {}, 1000);
} else {
  writeFileSync(
    join(process.cwd(), 'index.html'),
    '<!doctype html><title>retry succeeded</title><h1>ok</h1>\n',
  );
}
