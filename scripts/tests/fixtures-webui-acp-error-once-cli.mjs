#!/usr/bin/env node
/**
 * Fails once with the transient ACP stream error seen in Web UI runs, then
 * succeeds on retry. The first attempt deliberately leaves a stale index.html
 * in its workspace; the Web UI must retry in a fresh workspace and not serve
 * that partial artifact.
 */
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const marker =
  process.env['OPENGAME_WEBUI_FIXTURE_MARKER'] ??
  join(process.cwd(), '.transient-acp-error-seen');

if (!existsSync(marker)) {
  writeFileSync(marker, 'seen\n');
  writeFileSync(
    join(process.cwd(), 'index.html'),
    '<!doctype html><title>stale partial</title><h1>stale attempt</h1>\n',
  );
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
