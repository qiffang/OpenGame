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
 * Flow:
 *   1. GET  /            → a page with a prompt box + "generate" button.
 *   2. POST /generate    → spawns `opengame -p "<prompt>" --yolo` with
 *                          OPENGAME_PROVIDER=acp in a fresh per-run workspace,
 *                          streams progress, and returns the generated game id.
 *   3. GET  /game/<id>/  → serves the generated game so the browser can play it
 *                          in an <iframe>.
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
const CLI = join(REPO_ROOT, 'dist', 'cli.js');
// Which local coding agent acpmux should drive. Claude Code needs no proxy and
// emits text chunks natively, so it is the default for this no-key path.
const ACP_PROVIDER = process.env['OPENGAME_ACP_PROVIDER'] || 'claude';
// A single generation can take a while (the agent plans + writes files).
const GEN_TIMEOUT_MS = Number(process.env['OPENGAME_WEBUI_TIMEOUT_MS'] || 8 * 60 * 1000);

// In-memory registry of completed generations: id → workspace dir.
const games = new Map();

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
  #log { margin-top: 16px; flex: 1; overflow: auto; background: #0b0d11; border: 1px solid #1c2129;
         border-radius: 8px; padding: 10px; font: 12px/1.5 ui-monospace, Menlo, monospace;
         white-space: pre-wrap; color: #9aa4b2; }
  #frameWrap { flex: 1; display: flex; align-items: center; justify-content: center; background: #000; }
  iframe { width: 100%; height: 100%; border: 0; background: #000; }
  .placeholder { color: #55606e; font-size: 14px; }
  .bar { padding: 8px 12px; font-size: 12px; color: #8a8a8a; border-bottom: 1px solid #222;
         display: flex; gap: 12px; align-items: center; }
  .bar a { color: #60a5fa; text-decoration: none; }
</style>
</head>
<body>
  <div id="left">
    <h1>用一句话做游戏</h1>
    <p class="hint">输入你想要的游戏，点「生成」。后台用本地 Claude Code 生成，<b>不需要任何 API key</b>。</p>
    <textarea id="prompt" placeholder="例如：做一个躲避障碍物的小恐龙跳跃游戏，按空格跳，撞到就结束，右上角计分"></textarea>
    <button id="go">生成游戏</button>
    <div class="examples">
      示例：
      <button data-ex="做一个贪吃蛇游戏，方向键控制，吃到食物变长，撞墙或撞到自己就结束">贪吃蛇</button>
      <button data-ex="做一个打砖块游戏，鼠标控制挡板，把所有砖块打掉就赢">打砖块</button>
      <button data-ex="做一个小恐龙跳跃躲障碍的游戏，空格跳跃，右上角显示分数">恐龙跳</button>
    </div>
    <div id="log">准备就绪。</div>
  </div>
  <div id="right">
    <div class="bar">
      <span id="status">尚未生成</span>
      <a id="open" href="#" target="_blank" style="display:none">在新标签打开 ↗</a>
    </div>
    <div id="frameWrap"><div class="placeholder">生成后游戏会显示在这里，可以直接玩</div></div>
  </div>
<script>
  const $ = (s) => document.querySelector(s);
  const logEl = $('#log');
  function log(line) { logEl.textContent += '\\n' + line; logEl.scrollTop = logEl.scrollHeight; }
  document.querySelectorAll('.examples button').forEach((b) => {
    b.addEventListener('click', () => { $('#prompt').value = b.getAttribute('data-ex'); });
  });
  $('#go').addEventListener('click', async () => {
    const prompt = $('#prompt').value.trim();
    if (!prompt) { alert('先输入一句想要的游戏'); return; }
    $('#go').disabled = true;
    $('#status').textContent = '生成中…（本地 Claude 正在写代码，可能要一两分钟）';
    logEl.textContent = '开始生成：' + prompt;
    try {
      const res = await fetch('/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt }),
      });
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      let gameUrl = null;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf('\\n')) >= 0) {
          const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
          if (!line.trim()) continue;
          let evt; try { evt = JSON.parse(line); } catch { continue; }
          if (evt.type === 'log') log(evt.line);
          else if (evt.type === 'done') { gameUrl = evt.url; }
          else if (evt.type === 'error') { log('❌ ' + evt.message); }
        }
      }
      if (gameUrl) {
        $('#status').textContent = '生成完成 ✓';
        $('#frameWrap').innerHTML = '<iframe src="' + gameUrl + '" allow="autoplay; fullscreen"></iframe>';
        const open = $('#open'); open.href = gameUrl; open.style.display = 'inline';
        log('✓ 完成，游戏已加载到右侧');
      } else {
        $('#status').textContent = '生成失败';
        log('没有生成出可玩的游戏文件，看上面的日志。');
      }
    } catch (e) {
      $('#status').textContent = '出错';
      log('❌ ' + String(e));
    } finally {
      $('#go').disabled = false;
    }
  });
</script>
</body>
</html>`;

/** Recursively find the entry HTML of a generated game under `dir`. Prefers a
 *  top-level index.html, else the shallowest *.html file. */
async function findGameEntry(dir) {
  let best = null; // { rel, depth }
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

function writeEvent(res, obj) {
  res.write(JSON.stringify(obj) + '\n');
}

async function handleGenerate(req, res) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  let prompt = '';
  try {
    prompt = String(JSON.parse(Buffer.concat(chunks).toString('utf8')).prompt || '').trim();
  } catch {
    return send(res, 400, 'bad json');
  }
  if (!prompt) return send(res, 400, 'empty prompt');
  if (!existsSync(CLI)) {
    return send(res, 500, `CLI not built at ${CLI}. Run: npm run build`);
  }

  res.writeHead(200, {
    'Content-Type': 'application/x-ndjson; charset=utf-8',
    'Cache-Control': 'no-store',
  });

  const workspace = await mkdtemp(join(tmpdir(), 'opengame-web-'));
  const id = workspace.split(sep).pop();
  writeEvent(res, { type: 'log', line: `工作目录：${workspace}` });
  writeEvent(res, { type: 'log', line: `后端：ACP / ${ACP_PROVIDER}（无 API key）` });

  // Drive the built CLI headlessly through the ACP backend. No API key is set;
  // the ACP path deliberately reads only OPENGAME_ACP_* (see contentGenerator.ts).
  const env = {
    ...process.env,
    OPENGAME_PROVIDER: 'acp',
    OPENGAME_ACP_PROVIDER: ACP_PROVIDER,
  };
  const args = [CLI, '-p', prompt, '--yolo'];
  const child = spawn(process.execPath, args, { cwd: workspace, env });

  let killedForTimeout = false;
  const timer = setTimeout(() => {
    killedForTimeout = true;
    child.kill('SIGKILL');
  }, GEN_TIMEOUT_MS);

  const relay = (buf) => {
    for (const line of buf.toString('utf8').split('\n')) {
      if (line.trim()) writeEvent(res, { type: 'log', line });
    }
  };
  child.stdout.on('data', relay);
  child.stderr.on('data', relay);

  child.on('error', (e) => {
    clearTimeout(timer);
    writeEvent(res, { type: 'error', message: `spawn failed: ${String(e)}` });
    res.end();
  });

  child.on('close', async (code) => {
    clearTimeout(timer);
    if (killedForTimeout) {
      writeEvent(res, { type: 'error', message: `生成超时（>${GEN_TIMEOUT_MS / 1000}s）` });
      return res.end();
    }
    const entry = await findGameEntry(workspace);
    if (!entry) {
      writeEvent(res, {
        type: 'error',
        message: `未找到生成的 .html 游戏文件（CLI 退出码 ${code}）`,
      });
      return res.end();
    }
    games.set(id, workspace);
    writeEvent(res, { type: 'log', line: `生成文件：${entry}` });
    writeEvent(res, { type: 'done', url: `/game/${id}/${entry}` });
    res.end();
  });
}

async function handleGameAsset(req, res, url) {
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
      return send(res, 200, PAGE, { 'Content-Type': 'text/html; charset=utf-8' });
    }
    if (req.method === 'POST' && url.pathname === '/generate') {
      return await handleGenerate(req, res);
    }
    if (req.method === 'GET' && url.pathname.startsWith('/game/')) {
      return await handleGameAsset(req, res, url);
    }
    return send(res, 404, 'not found');
  } catch (e) {
    if (!res.headersSent) send(res, 500, `server error: ${String(e)}`);
    else res.end();
  }
});

server.listen(PORT, HOST, () => {
  console.log(`OpenGame web UI → http://${HOST}:${PORT}  (backend: ACP/${ACP_PROVIDER}, no API key)`);
  if (!existsSync(CLI)) {
    console.log(`⚠  CLI not built yet. Run \`npm run build\` first (expected ${CLI}).`);
  }
});
