/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Liveness / interactivity gate for a generated single-file web game.
 *
 * A deliberately WEAK gate that proves the artifact is not empty-scene /
 * fake-button / static / dead-loop — by loading it in a headless browser and
 * requiring ALL of:
 *   1. loads without a fatal JS error,
 *   2. a <canvas> exists,
 *   3. the canvas draws pixels (not blank / not one flat color),
 *   4. a main loop runs (requestAnimationFrame fires),
 *   5. it responds to INPUT in a way that a no-input animation does NOT.
 *
 * (5) is the part that makes this "interactivity" and not just "canvas
 * liveness". A game that merely animates changes frames on its own, so
 * "frames changed after a keypress" proves nothing. Instead we compare two
 * runs of equal length: a NO-INPUT baseline vs an INPUT run. The gate passes
 * (5) only if the input run diverges from what the baseline would have produced
 * — i.e. the keypress caused a state change the animation alone would not.
 *
 * It does NOT verify the OTHER half of "playable": goal / controllable
 * character / win-loss loop / intent alignment. Callers MUST report the result
 * as "liveness+interactivity PASS", never "playable PASS".
 *
 * Usage: node scripts/liveness-gate.mjs <path-to-game.html>
 * Exit 0 = PASS, 1 = FAIL, 2 = usage error. Prints a JSON result to stdout.
 */

/* global window, document */
import { chromium } from 'playwright';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const FRAMES = 30; // frames to sample per run
const FRAME_MS = 40; // ~25fps sampling cadence
// Input counts as a real response only if the INPUT run diverges from the
// no-input baseline by at least this many frames MORE than the animation's own
// run-to-run noise floor. Chosen well below a real game's signal (typically the
// full run diverges) and above the timing noise of a deterministic animation.
const INPUT_MARGIN = 6;

async function main() {
  const file = process.argv[2];
  if (!file) {
    console.error('usage: node scripts/liveness-gate.mjs <game.html>');
    process.exit(2);
  }
  const url = pathToFileURL(resolve(file)).href;

  let browser;
  try {
    browser = await chromium.launch({ headless: true });
  } catch (e) {
    console.error(
      'Failed to launch Chromium. Install the browser with `npx playwright install chromium`.\n' +
        String(e),
    );
    process.exit(2);
  }

  const result = {
    loaded: false,
    noFatalError: false,
    hasCanvas: false,
    canvasDrawsPixels: false,
    rafRuns: false,
    respondsToInput: false,
  };
  const detail = {};

  try {
    const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
    const jsErrors = [];
    page.on('pageerror', (e) => jsErrors.push(String(e)));

    await page.goto(url, { waitUntil: 'load', timeout: 15000 });
    result.loaded = true;

    await page.evaluate(() => {
      window.__rafCount = 0;
      const orig = window.requestAnimationFrame.bind(window);
      window.requestAnimationFrame = (cb) => {
        window.__rafCount++;
        return orig(cb);
      };
    });

    result.hasCanvas = (await page.locator('canvas').count()) > 0;
    result.canvasDrawsPixels = await page.evaluate(canvasDrawsPixelsFn);

    // Establish the animation's inherent run-to-run NOISE FLOOR first: two
    // NO-INPUT runs from the same fresh state. A pure animation may still diverge
    // a little between runs because sampling isn't perfectly phase-aligned with
    // rAF; that noise must NOT be mistaken for input response.
    const baseA = await sampleSequence(page);
    result.rafRuns = (await page.evaluate(() => window.__rafCount || 0)) > 0;
    await page.goto(url, { waitUntil: 'load', timeout: 15000 });
    const baseB = await sampleSequence(page);
    const noise = sequenceDivergence(baseA, baseB).divergentFrames;

    // Now an INPUT run from the same fresh state.
    await page.goto(url, { waitUntil: 'load', timeout: 15000 });
    const withInput = await sampleSequence(page, async () => {
      await page.keyboard.press('Space');
      await page.keyboard.press('ArrowUp');
      await page.keyboard.press('ArrowRight');
    });
    const inputDiv = sequenceDivergence(baseA, withInput).divergentFrames;

    detail.noiseFloorFrames = noise;
    detail.inputDivergentFrames = inputDiv;
    // Input counts as a real response only if it diverges from the baseline
    // MEANINGFULLY MORE than the animation's own run-to-run noise floor. A
    // deterministic animation with no input handler has inputDiv ≈ noise → FAIL.
    result.respondsToInput =
      inputDiv >= noise + INPUT_MARGIN && inputDiv >= INPUT_MARGIN;

    result.noFatalError = jsErrors.length === 0;
    detail.jsErrors = jsErrors;
    detail.rafCount = await page.evaluate(() => window.__rafCount || 0);
  } catch (e) {
    detail.error = String(e);
  } finally {
    await browser.close();
  }

  // inputWired (respondsToInput) IS part of the pass predicate now.
  const pass =
    result.loaded &&
    result.noFatalError &&
    result.hasCanvas &&
    result.canvasDrawsPixels &&
    result.rafRuns &&
    result.respondsToInput;

  const out = {
    verdict: pass ? 'liveness+interactivity PASS' : 'FAIL',
    note:
      'Weak gate: excludes empty-scene / fake-button / static / dead-loop / ' +
      'animated-but-no-input. Does NOT verify goal / win-loss / intent-alignment ' +
      '(NOT full-playable). "respondsToInput" is measured as divergence of an ' +
      'INPUT run from a NO-INPUT baseline of equal length, so pure animation ' +
      'does not count as interactivity.',
    ...result,
    ...detail,
  };
  console.log(JSON.stringify(out, null, 2));
  process.exit(pass ? 0 : 1);
}

function canvasDrawsPixelsFn() {
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
  return nonZero > 0 && seen.size > 1;
}

/** Sample a sequence of canvas fingerprints over FRAMES, optionally firing an
 *  action after the first few frames. */
async function sampleSequence(page, action) {
  const seq = [];
  for (let i = 0; i < FRAMES; i++) {
    if (action && i === Math.floor(FRAMES / 3)) {
      await action();
    }
    seq.push(await page.evaluate(fingerprintCanvasFn));
    await page.waitForTimeout(FRAME_MS);
  }
  return seq;
}

function fingerprintCanvasFn() {
  const c = document.querySelector('canvas');
  if (!c) return '';
  const ctx = c.getContext('2d');
  if (!ctx) return '';
  const w = Math.min(c.width || 300, 96),
    h = Math.min(c.height || 150, 96);
  if (w === 0 || h === 0) return '';
  const d = ctx.getImageData(0, 0, w, h).data;
  let s = 0;
  for (let i = 0; i < d.length; i += 41) s = (s * 31 + d[i]) >>> 0;
  return String(s);
}

/** Count frames where the two equal-length sequences differ. */
function sequenceDivergence(a, b) {
  const n = Math.min(a.length, b.length);
  let divergentFrames = 0;
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) divergentFrames++;
  return { divergentFrames, ratio: n ? divergentFrames / n : 0 };
}

main();
