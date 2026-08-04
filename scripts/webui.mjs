/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Minimal web UI for generating a single-file web game from a prompt, with NO
 * OpenAI/Anthropic API key — it drives the built OpenGame CLI over the ACP
 * backend (a locally installed Claude Code, spawned via acpmux).
 *
 * Generation takes a minute or two, so it runs as a BACKGROUND JOB rather than
 * inside one long-held HTTP request (a long request drops on browser/proxy idle
 * timeouts and the browser only sees a status-less `TypeError: network error`):
 *   1. GET  /                → the page (prompt box + generate button + iframe).
 *   2. POST /generate        → starts a job, returns { job_id } IMMEDIATELY.
 *   3. GET  /status/<job_id> → the page polls this; returns ONLY page-safe fields
 *                              { status, stage, message, diagnostic_id, game_url }.
 *   4. GET  /game/<id>/...   → serves the generated game for the <iframe>.
 *
 * Error surface has two audiences (kept strictly separate):
 *   - OPERATOR / server log: full detail — diagnostic_id, stage, exit code, and a
 *     short error summary — enough to locate a failure.
 *   - PAGE (a child is looking at it): ONLY a diagnostic_id + one plain sentence.
 *     The provider name, subprocess stderr, exit code, filesystem paths, stack
 *     traces, and the prompt are NEVER sent to the browser.
 *
 * This is a thin operator convenience on top of the already-merged ACP backend;
 * it does NOT change generation behavior. Usage:
 *   node scripts/webui.mjs            # listens on http://127.0.0.1:8787
 *   PORT=9000 node scripts/webui.mjs  # custom port
 */

import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, extname, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env['PORT'] || 8787);
const HOST = process.env['HOST'] || '127.0.0.1';
const REPO_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
// The built CLI. Overridable via OPENGAME_WEBUI_CLI (used by the self-test to
// point at a deliberately-failing program to exercise the failure surface).
const CLI = process.env['OPENGAME_WEBUI_CLI'] || join(REPO_ROOT, 'dist', 'cli.js');
// Which local coding agent acpmux should drive. Claude Code needs no proxy and
// emits text chunks natively, so it is the default for this no-key path.
const ACP_PROVIDER = process.env['OPENGAME_ACP_PROVIDER'] || 'claude';
// A single generation can take a while (the agent plans + writes files).
const GEN_TIMEOUT_MS = Number(
  process.env['OPENGAME_WEBUI_TIMEOUT_MS'] || 8 * 60 * 1000,
);
const GENERATE_ATTEMPTS = Number(
  process.env['OPENGAME_WEBUI_GENERATE_ATTEMPTS'] || 3,
);
const TERMINAL_CLI_ERROR_RE =
  /Connection closed mid-response|ACP turn ended with an error/i;
const RETRYABLE_CLI_ERROR_RE = /Connection closed mid-response/i;

// job_id → job record. `log` and `detail` are OPERATOR-ONLY (never sent to the
// page). `stage`/`status`/`message`/`diagnosticId`/`gameUrl` are page-safe.
const jobs = new Map();
// game id → workspace dir (only registered on success).
const games = new Map();

// The ONLY message a child ever sees on failure. Deliberately generic — no
// stage-specific or technical wording that could leak what went wrong.
const CHILD_SAFE_FAILURE = '生成没成功，换句话再试一次吧。';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'Cache-Control': 'no-store', ...headers });
  res.end(body);
}

function sendJSON(res, status, obj) {
  send(res, status, JSON.stringify(obj), {
    'Content-Type': 'application/json; charset=utf-8',
  });
}

// A short, unpredictable-enough id derived without Math.random (which the repo's
// scripts sandbox forbids) — a monotonic counter mixed with high-res time.
let idCounter = 0;
function newId(prefix) {
  idCounter += 1;
  const t = process.hrtime.bigint().toString(36);
  return `${prefix}-${t}-${idCounter.toString(36)}`;
}

const PAGE = `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>OpenGame · 用一句话做游戏</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: system-ui, -apple-system, "PingFang SC", sans-serif;
         background: #0f1115; color: #e6e6e6; height: 100vh; display: flex; }
  #left { width: 380px; min-width: 320px; padding: 20px; display: flex; flex-direction: column;
          border-right: 1px solid #222; }
  #right { flex: 1; display: flex; flex-direction: column; }
  h1 { font-size: 18px; margin: 0 0 4px; }
  .hint { font-size: 12px; color: #8a8a8a; margin: 0 0 16px; line-height: 1.5; }
  textarea { flex: 0 0 auto; height: 120px; resize: vertical; background: #171a21; color: #e6e6e6;
             border: 1px solid #2a2f3a; border-radius: 8px; padding: 10px; font-size: 14px; }
  button { margin-top: 12px; padding: 10px 14px; font-size: 14px; border: 0; border-radius: 8px;
           background: #3b82f6; color: #fff; cursor: pointer; }
  button:disabled { background: #2a3550; cursor: not-allowed; }
  .examples { margin-top: 14px; font-size: 12px; color: #8a8a8a; }
  .examples button { background: #1b1f27; color: #cbd5e1; border: 1px solid #2a2f3a;
                     margin: 4px 4px 0 0; padding: 5px 8px; font-size: 12px; }
  #note { margin-top: 16px; flex: 1; overflow: auto; background: #0b0d11; border: 1px solid #1c2129;
          border-radius: 8px; padding: 12px; font-size: 13px; line-height: 1.6; color: #9aa4b2; }
  #frameWrap { flex: 1; display: flex; align-items: center; justify-content: center; background: #000; }
  iframe { width: 100%; height: 100%; border: 0; background: #000; }
  .placeholder { color: #55606e; font-size: 14px; }
  .bar { padding: 8px 12px; font-size: 12px; color: #8a8a8a; border-bottom: 1px solid #222;
         display: flex; gap: 12px; align-items: center; }
  .bar a { color: #60a5fa; text-decoration: none; }
  .diag { color: #55606e; font-size: 11px; margin-top: 8px; }
</style>
</head>
<body>
  <div id="left">
    <h1>用一句话做游戏</h1>
    <p class="hint">输入你想要的游戏，点「生成」。后台用本地 Claude Code 生成，<b>不需要任何 API key</b>。做一个游戏大概要一两分钟。</p>
    <textarea id="prompt" placeholder="例如：做一个躲避障碍物的小恐龙跳跃游戏，按空格跳，撞到就结束，右上角计分"></textarea>
    <button id="go">生成游戏</button>
    <div class="examples">
      示例：
      <button data-ex="做一个贪吃蛇游戏，方向键控制，吃到食物变长，撞墙或撞到自己就结束">贪吃蛇</button>
      <button data-ex="做一个打砖块游戏，鼠标控制挡板，把所有砖块打掉就赢">打砖块</button>
      <button data-ex="做一个小恐龙跳跃躲障碍的游戏，空格跳跃，右上角显示分数">恐龙跳</button>
    </div>
    <div id="note">准备好了，写一句你想玩的游戏吧。</div>
  </div>
  <div id="right">
    <div class="bar">
      <span id="status">还没开始</span>
      <a id="open" href="#" target="_blank" style="display:none">在新标签打开 ↗</a>
    </div>
    <div id="frameWrap"><div class="placeholder">做好的游戏会显示在这里，可以直接玩</div></div>
  </div>
<script>
  const $ = (s) => document.querySelector(s);
  const noteEl = $('#note');
  function note(text, diag) {
    noteEl.textContent = text;
    if (diag) {
      const d = document.createElement('div');
      d.className = 'diag';
      d.textContent = '出问题时可以把这个编号告诉大人：' + diag;
      noteEl.appendChild(d);
    }
  }
  document.querySelectorAll('.examples button').forEach((b) => {
    b.addEventListener('click', () => { $('#prompt').value = b.getAttribute('data-ex'); });
  });

  let polling = false;
  async function poll(jobId) {
    while (polling) {
      let s;
      try {
        const r = await fetch('/status/' + encodeURIComponent(jobId), { cache: 'no-store' });
        s = await r.json();
      } catch {
        // A single failed poll is fine — the job runs on the server regardless.
        await new Promise((r) => setTimeout(r, 1500));
        continue;
      }
      if (s.status === 'running') {
        $('#status').textContent = '正在做游戏…（大概一两分钟）';
        note('本地 Claude 正在写游戏代码，请稍等一会儿。');
        await new Promise((r) => setTimeout(r, 1500));
        continue;
      }
      polling = false;
      if (s.status === 'done' && s.game_url) {
        $('#status').textContent = '做好啦 ✓';
        note('游戏做好了，右边就能玩！');
        $('#frameWrap').innerHTML =
          '<iframe src="' + s.game_url + '" allow="autoplay; fullscreen"></iframe>';
        const open = $('#open'); open.href = s.game_url; open.style.display = 'inline';
      } else {
        // Failure: show ONLY the safe message + a diagnostic id. No technical detail.
        $('#status').textContent = '没成功';
        note(s.message || '生成没成功，换句话再试一次吧。', s.diagnostic_id);
      }
      $('#go').disabled = false;
    }
  }

  $('#go').addEventListener('click', async () => {
    const prompt = $('#prompt').value.trim();
    if (!prompt) { alert('先写一句你想玩的游戏'); return; }
    $('#go').disabled = true;
    $('#status').textContent = '开始做游戏…';
    note('正在启动…');
    let jobId;
    try {
      const res = await fetch('/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt }),
      });
      const data = await res.json();
      if (!res.ok || !data.job_id) {
        $('#status').textContent = '没成功';
        note(data.message || '暂时没法开始，等一下再试。', data.diagnostic_id);
        $('#go').disabled = false;
        return;
      }
      jobId = data.job_id;
    } catch {
      $('#status').textContent = '没成功';
      note('连不上本地的小服务，确认它还开着，然后再试一次。');
      $('#go').disabled = false;
      return;
    }
    polling = true;
    poll(jobId);
  });
</script>
</body>
</html>`;

/** Recursively find the entry HTML of a generated game under `dir`. Prefers a
 *  top-level index.html, else the shallowest *.html file. */
async function findGameEntry(dir) {
  let best = null; // { rel, score }
  async function walk(d, depth, relParts) {
    let entries;
    try {
      entries = await readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith('.') || e.name === 'node_modules') continue;
      const rel = [...relParts, e.name];
      if (e.isDirectory()) {
        await walk(join(d, e.name), depth + 1, rel);
      } else if (extname(e.name).toLowerCase() === '.html') {
        const isIndex = e.name.toLowerCase() === 'index.html';
        const score = depth * 10 + (isIndex ? 0 : 1);
        if (!best || score < best.score) best = { rel: rel.join('/'), score };
      }
    }
  }
  await walk(dir, 0, []);
  return best?.rel || null;
}

// ---- operator-side logging (never sent to the page) --------------------------
function jobLog(job, line) {
  job.log.push(line);
  // Mirror to the server console so an operator can follow along / grep later.
  console.log(`[${job.id}] ${line}`);
}

function failJob(job, stage, detail) {
  job.status = 'failed';
  job.stage = stage;
  job.message = CHILD_SAFE_FAILURE; // page-safe, generic
  job.detail = detail; // OPERATOR-ONLY
  jobLog(job, `FAILED at stage=${stage}: ${detail}`);
}

/** Start a generation job in the background. Returns the job record immediately;
 *  the caller responds to the client without waiting for generation. */
function startJob(prompt) {
  const job = {
    id: newId('gen'),
    status: 'running',
    stage: 'starting',
    message: '',
    detail: '',
    gameUrl: null,
    log: [],
  };
  jobs.set(job.id, job);

  runGeneration(job, prompt)
    .catch((e) => failJob(job, job.stage || 'starting', `unexpected: ${String(e)}`));
  return job;
}

async function runGeneration(job, prompt, attempt = 1) {
  const workspace = await mkdtemp(join(tmpdir(), 'opengame-web-'));
  job.stage = 'generate';
  jobLog(job, `workspace=${workspace}`);
  jobLog(job, `backend=ACP/${ACP_PROVIDER} (no API key)`);
  jobLog(job, `generate attempt=${attempt}/${GENERATE_ATTEMPTS}`);

  const env = {
    ...process.env,
    OPENGAME_PROVIDER: 'acp',
    OPENGAME_ACP_PROVIDER: ACP_PROVIDER,
  };
  const child = spawn(process.execPath, [CLI, '-p', prompt, '--yolo'], {
    cwd: workspace,
    env,
  });

  let timedOut = false;
  let terminalFailure = false;
  let terminalFailureLine = '';
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill('SIGKILL');
  }, GEN_TIMEOUT_MS);

  const relay = (buf) => {
    for (const line of buf.toString('utf8').split('\n')) {
      if (!line.trim()) continue;
      jobLog(job, `cli: ${line}`);
      if (!terminalFailure && TERMINAL_CLI_ERROR_RE.test(line)) {
        terminalFailure = true;
        terminalFailureLine = line;
        clearTimeout(timer);
        child.kill('SIGKILL');
      }
    }
  };
  child.stdout.on('data', relay);
  child.stderr.on('data', relay);

  child.on('error', (e) => {
    clearTimeout(timer);
    // e.g. CLI binary missing / not executable.
    failJob(job, 'generate', `spawn error: ${String(e)}`);
  });

  child.on('close', async (code) => {
    clearTimeout(timer);
    if (terminalFailure) {
      if (
        RETRYABLE_CLI_ERROR_RE.test(terminalFailureLine) &&
        attempt < GENERATE_ATTEMPTS
      ) {
        jobLog(
          job,
          `retrying generate after terminal ACP error (${attempt + 1}/${GENERATE_ATTEMPTS})`,
        );
        runGeneration(job, prompt, attempt + 1).catch((e) =>
          failJob(job, 'generate', `retry setup failed: ${String(e)}`),
        );
        return;
      }
      failJob(job, 'generate', `cli terminal error: ${terminalFailureLine}`);
      return;
    }
    if (timedOut) {
      failJob(job, 'generate', `timeout after ${GEN_TIMEOUT_MS}ms`);
      return;
    }
    if (code !== 0) {
      failJob(job, 'generate', `cli exited with code ${code}`);
      return;
    }
    job.stage = 'collect';
    let entry;
    try {
      entry = await findGameEntry(workspace);
    } catch (e) {
      failJob(job, 'collect', `scan error: ${String(e)}`);
      return;
    }
    if (!entry) {
      failJob(job, 'collect', `no .html produced (cli exit ${code})`);
      return;
    }
    games.set(job.id, workspace);
    job.status = 'done';
    job.stage = 'done';
    job.gameUrl = `/game/${job.id}/${entry}`;
    jobLog(job, `game entry=${entry}`);
  });
}

async function handleGenerate(req, res) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  let prompt = '';
  try {
    prompt = String(
      JSON.parse(Buffer.concat(chunks).toString('utf8')).prompt || '',
    ).trim();
  } catch {
    return sendJSON(res, 400, {
      message: '请求格式不对，刷新页面再试一次。',
      diagnostic_id: newId('req'),
    });
  }
  if (!prompt) {
    return sendJSON(res, 400, { message: '先写一句你想玩的游戏。' });
  }
  if (!existsSync(CLI)) {
    const diagnosticId = newId('cfg');
    console.log(
      `[${diagnosticId}] CLI not built at ${CLI}; run \`npm run build\` first`,
    );
    // Page-safe wording; the path / build hint stays in the server log only.
    return sendJSON(res, 503, {
      message: '本地还没准备好，请先按说明构建一次，再试。',
      diagnostic_id: diagnosticId,
    });
  }
  const job = startJob(prompt);
  // Respond IMMEDIATELY — generation continues in the background.
  return sendJSON(res, 202, { job_id: job.id, status: 'running' });
}

function handleStatus(res, url) {
  const jobId = decodeURIComponent(url.pathname.slice('/status/'.length));
  const job = jobs.get(jobId);
  if (!job) {
    return sendJSON(res, 404, {
      status: 'unknown',
      message: '找不到这次生成，重新点一下生成吧。',
    });
  }
  // ONLY page-safe fields. Never job.log / job.detail (operator-only).
  return sendJSON(res, 200, {
    status: job.status, // running | done | failed
    stage: job.stage, // coarse label, no technical payload
    message: job.message || '',
    diagnostic_id: job.status === 'failed' ? job.id : undefined,
    game_url: job.gameUrl || undefined,
  });
}

async function handleGameAsset(res, url) {
  // /game/<id>/<relpath...>
  const rest = url.pathname.slice('/game/'.length);
  const slash = rest.indexOf('/');
  if (slash < 0) return send(res, 404, 'not found');
  const id = rest.slice(0, slash);
  const relRaw = decodeURIComponent(rest.slice(slash + 1)) || 'index.html';
  const root = games.get(id);
  if (!root) return send(res, 404, 'unknown game');

  // Contain the path inside the game workspace (no traversal / absolute escape).
  const full = normalize(join(root, relRaw));
  if (full !== root && !full.startsWith(root + sep)) {
    return send(res, 403, 'forbidden');
  }
  try {
    const st = await stat(full);
    if (st.isDirectory()) return send(res, 403, 'forbidden');
    const body = await readFile(full);
    const type = MIME[extname(full).toLowerCase()] || 'application/octet-stream';
    return send(res, 200, body, { 'Content-Type': type });
  } catch {
    return send(res, 404, 'not found');
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (req.method === 'GET' && url.pathname === '/') {
      return send(res, 200, PAGE, {
        'Content-Type': 'text/html; charset=utf-8',
      });
    }
    if (req.method === 'POST' && url.pathname === '/generate') {
      return await handleGenerate(req, res);
    }
    if (req.method === 'GET' && url.pathname.startsWith('/status/')) {
      return handleStatus(res, url);
    }
    if (req.method === 'GET' && url.pathname.startsWith('/game/')) {
      return await handleGameAsset(res, url);
    }
    return send(res, 404, 'not found');
  } catch (e) {
    // Last-resort catch: the page never sees this detail.
    const diagnosticId = newId('srv');
    console.log(`[${diagnosticId}] unhandled: ${String(e)}`);
    if (!res.headersSent) {
      sendJSON(res, 500, {
        message: '出了点小问题，等一下再试。',
        diagnostic_id: diagnosticId,
      });
    } else {
      res.end();
    }
  }
});

server.listen(PORT, HOST, () => {
  console.log(
    `OpenGame web UI → http://${HOST}:${PORT}  (backend: ACP/${ACP_PROVIDER}, no API key)`,
  );
  if (!existsSync(CLI)) {
    console.log(
      `⚠  CLI not built yet. Run \`npm run build\` first (expected ${CLI}).`,
    );
  }
});

// Exported for the self-test (import without starting a second server is not
// needed — the test drives the HTTP surface — but these help unit-level checks).
export { CHILD_SAFE_FAILURE, newId };
