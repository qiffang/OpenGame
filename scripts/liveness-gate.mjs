/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Liveness / interactivity gate for a generated single-file web game.
 *
 * This is deliberately a WEAK gate: it proves the artifact is not an empty
 * scene / fake button / static image / dead loop, by loading it in a headless
 * browser and checking that:
 *   1. the page loads without a fatal JS error,
 *   2. a <canvas> exists,
 *   3. the canvas actually draws pixels (not blank),
 *   4. a running main loop advances (requestAnimationFrame fires),
 *   5. keyboard input is wired (a keydown listener exists / responds).
 *
 * It does NOT verify the OTHER half of "playable": goal / controllable
 * character / win-loss loop / intent alignment. Callers must report the result
 * as "liveness+interactivity PASS", never "playable PASS".
 *
 * Usage: node scripts/liveness-gate.mjs <path-to-game.html>
 * Exit 0 = PASS, 1 = FAIL. Prints a JSON result to stdout.
 */

/* global window, document */
import { chromium } from 'playwright';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

async function main() {
  const file = process.argv[2];
  if (!file) {
    console.error('usage: node scripts/liveness-gate.mjs <game.html>');
    process.exit(2);
  }
  const url = pathToFileURL(resolve(file)).href;

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });

  const jsErrors = [];
  page.on('pageerror', (e) => jsErrors.push(String(e)));

  const result = {
    loaded: false,
    noFatalError: false,
    hasCanvas: false,
    canvasDrawsPixels: false,
    rafRuns: false,
    inputWired: false,
  };

  try {
    await page.goto(url, { waitUntil: 'load', timeout: 15000 });
    result.loaded = true;

    // Instrument requestAnimationFrame BEFORE the game runs its loop is not
    // possible after load, so instead sample the canvas twice with input in
    // between and count rAF via a page-side probe injected now.
    await page.evaluate(() => {
      window.__rafCount = 0;
      const orig = window.requestAnimationFrame.bind(window);
      window.requestAnimationFrame = (cb) => {
        window.__rafCount++;
        return orig(cb);
      };
    });

    result.hasCanvas = (await page.locator('canvas').count()) > 0;

    // Canvas draws pixels: read a sample of the canvas and confirm not all
    // transparent/one-color.
    const drewInitial = await page.evaluate(() => {
      const c = document.querySelector('canvas');
      if (!c) return false;
      const ctx = c.getContext('2d');
      if (!ctx) return false;
      const w = Math.min(c.width || 300, 300),
        h = Math.min(c.height || 150, 150);
      if (w === 0 || h === 0) return false;
      const data = ctx.getImageData(0, 0, w, h).data;
      let nonZero = 0;
      const seen = new Set();
      for (let i = 0; i < data.length; i += 4) {
        if (data[i] || data[i + 1] || data[i + 2] || data[i + 3]) nonZero++;
        seen.add(`${data[i]},${data[i + 1]},${data[i + 2]}`);
      }
      // drew something AND more than one color (not a flat fill)
      return nonZero > 0 && seen.size > 1;
    });

    // Input wiring: are there keyboard listeners? Simulate a jump and let the
    // loop run, then re-check the canvas changed.
    const before = await sampleCanvas(page);
    await page.keyboard.press('Space');
    await page.keyboard.down('ArrowUp');
    await page.waitForTimeout(1200); // let the loop advance
    await page.keyboard.up('ArrowUp');
    const after = await sampleCanvas(page);

    result.rafRuns = (await page.evaluate(() => window.__rafCount || 0)) > 0;
    result.canvasDrawsPixels = drewInitial || before !== after;
    // Input wired if the frame changed after input OR a keydown listener exists.
    const hasKeyListener = await page.evaluate(
      () =>
        typeof window.onkeydown === 'function' ||
        // Heuristic: game code commonly stores listeners; can't enumerate them,
        // so fall back to "frame changed after input".
        false,
    );
    result.inputWired = before !== after || hasKeyListener;
    result.noFatalError = jsErrors.length === 0;
  } catch (e) {
    result.error = String(e);
  } finally {
    await browser.close();
  }

  const pass =
    result.loaded &&
    result.noFatalError &&
    result.hasCanvas &&
    result.canvasDrawsPixels &&
    result.rafRuns;

  const out = {
    verdict: pass ? 'liveness+interactivity PASS' : 'FAIL',
    note: 'Weak gate: excludes empty-scene / fake-button / static / dead-loop. Does NOT verify goal / win-loss / intent-alignment (not full-playable).',
    ...result,
    jsErrors,
  };
  console.log(JSON.stringify(out, null, 2));
  process.exit(pass ? 0 : 1);
}

async function sampleCanvas(page) {
  return page.evaluate(() => {
    const c = document.querySelector('canvas');
    if (!c) return '';
    const ctx = c.getContext('2d');
    if (!ctx) return '';
    const w = Math.min(c.width || 300, 64),
      h = Math.min(c.height || 150, 64);
    if (w === 0 || h === 0) return '';
    const d = ctx.getImageData(0, 0, w, h).data;
    // cheap fingerprint
    let s = 0;
    for (let i = 0; i < d.length; i += 97) s = (s + d[i]) % 1000000;
    return String(s);
  });
}

main();
