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

/* global window, document, KeyboardEvent */
import { chromium } from 'playwright';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const FRAMES = 30; // frames to capture per run
const FRAME_POLL_MS = 20; // how often Node polls the page's captured-frame count
const RUN_TIMEOUT_MS = 6000; // give up waiting for frames (static / dead scene)
const HOLD_MS = 250; // how long input keys are held down (spans several frames)
// Input counts as a real response only if the INPUT run diverges from the
// no-input baseline by at least this many frames MORE than the animation's own
// run-to-run noise floor. With RNG AND the clock frozen, two no-input runs are
// identical (noise floor 0), so this margin is just a guard against flakiness.
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

    // Init script runs BEFORE the page's own scripts and re-runs on EVERY
    // navigation (so it survives the reloads below). It instruments
    // requestAnimationFrame with a page-resident counter (so rafRuns/rafCount are
    // read from the SAME document we sampled, not a later un-instrumented reload)
    // and freezes Math.random to a deterministic PRNG. Combined with the fake
    // clock installed below, this makes two no-input runs BIT-IDENTICAL: same
    // seed, same virtual time, same rAF firing points. So the noise floor is a
    // true 0 and the ONLY thing that can make the input run diverge is the
    // keypress. Without this, a game that randomizes its scene or advances on
    // wall-clock time diverges from itself run-to-run and a genuinely interactive
    // game gets wrongly FAILED (the drowned-signal bug seen on real games).
    // Init script runs BEFORE the page's own scripts and re-runs on EVERY
    // navigation. It (a) freezes Math.random and Date/performance time to a fixed
    // per-load sequence so the animation is deterministic run-to-run — without
    // this a game with random or time-based motion diverges from itself and a
    // genuinely interactive game gets wrongly FAILED; and (b) instruments
    // requestAnimationFrame so that, right after the page's own draw callback runs
    // each frame, we capture a canvas fingerprint INTO the page keyed by frame
    // index. Capturing inside rAF (not by polling from Node) means run N's frame
    // K is sampled at the exact same animation point as run M's frame K, so two
    // no-input runs are identical and the noise floor is a true 0.
    await page.addInitScript(() => {
      let s = 0x2545f491;
      Math.random = () => {
        s ^= s << 13;
        s ^= s >>> 17;
        s ^= s << 5;
        s >>>= 0;
        return s / 0x100000000;
      };
      // Deterministic virtual clock advancing a fixed 16ms per frame.
      let vt = 0;
      const step = 16;
      try {
        performance.now = () => vt;
      } catch {
        /* performance.now may be read-only in some engines; ignore. */
      }
      const RealDate = Date;
      // eslint-disable-next-line no-global-assign
      Date = class extends RealDate {
        constructor(...a) {
          super(...(a.length ? a : [vt]));
        }
        static now() {
          return vt;
        }
      };

      window.__rafCount = 0;
      window.__frames = [];
      const origRaf = window.requestAnimationFrame.bind(window);
      const fp = () => {
        const c = document.querySelector('canvas');
        if (!c) return { fp: '', drew: false };
        const ctx = c.getContext('2d');
        if (!ctx) return { fp: '', drew: false };
        const w = c.width || 300,
          h = c.height || 150;
        if (w === 0 || h === 0) return { fp: '', drew: false };
        // Fingerprint the ENTIRE canvas, not a top-left crop — a game's player /
        // paddle / HUD is often at the bottom or right, and cropping would make
        // input there invisible. Sample on a fixed grid so the cost is bounded.
        const d = ctx.getImageData(0, 0, w, h).data;
        const stepX = Math.max(1, Math.floor(w / 64));
        const stepY = Math.max(1, Math.floor(h / 64));
        let hash = 0,
          nonZero = 0;
        const seen = new Set();
        for (let y = 0; y < h; y += stepY) {
          for (let x = 0; x < w; x += stepX) {
            const i = (y * w + x) * 4;
            if (d[i] || d[i + 1] || d[i + 2] || d[i + 3]) nonZero++;
            seen.add(`${d[i]},${d[i + 1]},${d[i + 2]}`);
            hash = (hash * 31 + d[i]) >>> 0;
            hash = (hash * 31 + d[i + 1]) >>> 0;
            hash = (hash * 31 + d[i + 2]) >>> 0;
          }
        }
        return { fp: String(hash), drew: nonZero > 0 && seen.size > 1 };
      };
      window.requestAnimationFrame = (cb) =>
        origRaf(() => {
          vt += step;
          window.__rafCount++;
          // Pass the DETERMINISTIC virtual timestamp to the game's callback, NOT
          // the real one. A game that drives motion off the rAF `t` argument
          // (requestAnimationFrame(t => ...)) would otherwise see real, jittery
          // timestamps and diverge run-to-run — the same false-negative class as
          // unseeded RNG. Feeding vt (which also backs performance.now/Date) keeps
          // every time source consistent and every no-input run identical.
          const r = cb(vt); // let the game draw this frame first
          window.__frames.push(fp()); // then fingerprint the result
          return r;
        });
    });

    await page.goto(url, { waitUntil: 'load', timeout: 15000 });
    result.loaded = true;
    result.hasCanvas = (await page.locator('canvas').count()) > 0;

    // Two NO-INPUT runs from the same fresh, deterministic state → identical, so
    // the noise floor is 0. Any residual signals real nondeterminism.
    const baseA = await runAndCollect(page);
    result.rafRuns = baseA.rafCount > 0;
    detail.rafCount = baseA.rafCount;
    result.canvasDrawsPixels = baseA.frames.some((f) => f.drew);

    await page.goto(url, { waitUntil: 'load', timeout: 15000 });
    const baseB = await runAndCollect(page);
    const noise = sequenceDivergence(baseA.frames, baseB.frames).divergentFrames;

    // INPUT run from the same fresh state. Keys are dispatched IN-PAGE as real
    // KeyboardEvents on both document and window, and HELD DOWN across several
    // frames (not tapped): a game that reads key STATE inside its loop must see
    // them held for ≥1 frame, and in-page dispatch avoids headless focus quirks
    // that can drop synthetic keystrokes.
    await page.goto(url, { waitUntil: 'load', timeout: 15000 });
    const withInput = await runAndCollect(page, async () => {
      await page.evaluate(() => {
        const KEYS = [
          { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
          { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
          { key: ' ', code: 'Space', keyCode: 32 },
        ];
        window.__heldKeys = KEYS;
        for (const k of KEYS) {
          for (const target of [document, window]) {
            target.dispatchEvent(
              new KeyboardEvent('keydown', { ...k, bubbles: true }),
            );
          }
        }
      });
      await page.waitForTimeout(HOLD_MS);
      await page.evaluate(() => {
        for (const k of window.__heldKeys || []) {
          for (const target of [document, window]) {
            target.dispatchEvent(
              new KeyboardEvent('keyup', { ...k, bubbles: true }),
            );
          }
        }
      });
    });
    const inputDiv = sequenceDivergence(
      baseA.frames,
      withInput.frames,
    ).divergentFrames;

    detail.noiseFloorFrames = noise;
    detail.inputDivergentFrames = inputDiv;
    // Input counts as a real response only if it diverges from the baseline
    // MEANINGFULLY MORE than the animation's own run-to-run noise floor. A
    // deterministic animation with no input handler has inputDiv ≈ noise → FAIL.
    result.respondsToInput =
      inputDiv >= noise + INPUT_MARGIN && inputDiv >= INPUT_MARGIN;

    result.noFatalError = jsErrors.length === 0;
    detail.jsErrors = jsErrors;
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

/** Let the page's own rAF loop run until it has captured FRAMES fingerprints
 *  (the init script pushes one per frame into window.__frames). Optionally fire an
 *  action once, at a fixed frame milestone. Returns { frames, rafCount }.
 *
 *  Sampling happens INSIDE the page's rAF (see addInitScript), so run N's frame K
 *  is captured at the same animation point as run M's frame K — with RNG and the
 *  virtual clock frozen, two no-input runs are identical. */
async function runAndCollect(page, action) {
  const actionAt = Math.floor(FRAMES / 3);
  let fired = false;
  const deadline = Date.now() + RUN_TIMEOUT_MS;
  while (true) {
    const count = await page.evaluate(() => window.__frames?.length || 0);
    if (action && !fired && count >= actionAt) {
      await action();
      fired = true;
    }
    if (count >= FRAMES) break;
    if (Date.now() > deadline) break; // static / dead scene: stop waiting
    await page.waitForTimeout(FRAME_POLL_MS);
  }
  return page.evaluate(() => ({
    frames: (window.__frames || []).slice(),
    rafCount: window.__rafCount || 0,
  }));
}

/** Count frames where the two equal-length sequences differ (by fingerprint). */
function sequenceDivergence(a, b) {
  const n = Math.min(a.length, b.length);
  let divergentFrames = 0;
  for (let i = 0; i < n; i++) if (a[i].fp !== b[i].fp) divergentFrames++;
  return { divergentFrames, ratio: n ? divergentFrames / n : 0 };
}

main();
