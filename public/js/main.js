import { Game } from './game.js';
import { setupCanvas, draw } from './render.js';
import { buildRequest, heuristicDecision, parseMove } from './agent.js';

const $ = (id) => document.getElementById(id);
const els = Object.fromEntries(
  ['agent', 'model', 'speed', 'board', 'start', 'reset', 'replay', 'download', 'upload', 'canvas', 'banner', 'moveCount', 'json', 'meta', 'request', 'caption', 'score', 'lives', 'dots', 'tick'].map((id) => [id, $(id)]),
);

const MODEL_LABELS = { nimble: 'Nimble 9B', tev1: 'Tev1' };
const ctx = setupCanvas(els.canvas);

let game;
let recording;
let runId = 0;
let paused = true;
let replaying = false;
let looping = false; // a live play() loop exists for the current game
let decisions = 0;
let lastStepAt = 0;
let queuedKey = null;
let ollama = { ok: false };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stepMs = () => Number(els.speed.value);

// ---------- rendering ----------

function frame(now) {
  const t = Math.min(1, (now - lastStepAt) / stepMs());
  draw(ctx, game, t);
  requestAnimationFrame(frame);
}

function highlight(json) {
  const esc = json.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  return esc.replace(/"(?:\\.|[^"\\])*"|-?\d+(?:\.\d+)?(?:e[+-]?\d+)?|\btrue\b|\bfalse\b|\bnull\b/g, (m) => `<span class="tok">${m}</span>`);
}

const round2 = (_k, v) => (typeof v === 'number' && !Number.isInteger(v) ? Math.round(v * 100) / 100 : v);

function showDecision(entry, n, total) {
  els.moveCount.textContent = total ? `Move ${n} of ${total}` : `Move ${n}`;
  if (!entry) return;
  if (entry.error) {
    els.json.innerHTML = `<span class="error">${entry.error}</span>`;
    els.meta.textContent = '';
    return;
  }
  els.json.innerHTML = highlight(JSON.stringify({ answers: entry.response.answers }, round2, 2));
  const usage = entry.response.usage?.input_tokens ? ` · ${entry.response.usage.input_tokens} input tokens` : '';
  els.meta.textContent = entry.latencyMs ? `${entry.source} · ${Math.round(entry.latencyMs)} ms${usage}` : entry.source;
  if (entry.request) els.request.innerHTML = highlight(JSON.stringify(entry.request, null, 2));
}

function updateHud() {
  els.score.textContent = game.score;
  els.lives.textContent = '●'.repeat(Math.max(game.lives, 0)) || '–';
  els.dots.textContent = `${game.dotsRemaining}/${game.totalDots}`;
  els.tick.textContent = game.tick;
}

function banner(text, ms) {
  els.banner.textContent = text;
  els.banner.hidden = !text;
  if (ms) setTimeout(() => { if (els.banner.textContent === text) els.banner.hidden = true; }, ms);
}

function modelLabel(name) {
  const base = name.split(':')[0];
  return MODEL_LABELS[base] ?? name;
}

function updateCaption() {
  const who = els.agent.value === 'ollama' ? `${modelLabel(els.model.value)} running locally via Ollama ${ollama.version ?? ''}`.trim()
    : els.agent.value === 'heuristic' ? 'Heuristic baseline (no LLM)'
    : 'You, on the arrow keys';
  els.caption.textContent = replaying ? `${recording.label}, replayed at real-time speed.` : `${who}.`;
}

function setButtons() {
  els.start.textContent = paused ? (looping ? 'Resume' : 'Start') : 'Pause';
  els.start.disabled = game.status !== 'playing';
  const hasRecording = recording && recording.steps.length > 0;
  els.replay.disabled = !hasRecording || (!paused && !replaying);
  els.download.disabled = !hasRecording;
}

// ---------- decisions ----------

async function decide() {
  const includeBoard = els.board.checked;
  const { body, analysis, forced } = buildRequest(game, els.model.value, { includeBoard });
  const legal = game.legalMoves();
  if (els.agent.value === 'heuristic') {
    const response = heuristicDecision(analysis);
    return { dir: parseMove(response, legal), response, request: body, source: 'heuristic' };
  }
  if (forced) {
    const response = { answers: { move: { type: 'choice', choice: forced, probabilities: { [forced]: 1 }, confidence: 1 } } };
    return { dir: forced, response, request: body, source: 'only safe move' };
  }
  const t0 = performance.now();
  const res = await fetch('/api/systemone', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const response = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
  const latencyMs = performance.now() - t0;
  if (!res.ok || response.error) return { error: `Ollama error: ${response.error ?? res.statusText}` };
  const dir = parseMove(response, legal);
  if (!dir) return { error: `Unexpected response:\n${JSON.stringify(response, null, 2)}` };
  return { dir, response, request: body, latencyMs, source: modelLabel(els.model.value) };
}

function keyboardDirection() {
  const legal = game.legalMoves();
  if (queuedKey && legal.includes(queuedKey)) return queuedKey;
  const { dir } = game.pacman;
  return dir && legal.includes(dir) ? dir : null;
}

// ---------- game loop ----------

async function whilePaused(id) {
  while (paused && id === runId) await sleep(50);
  return id === runId;
}

function handleEvents(events) {
  for (const e of events) {
    if (e.type === 'death' && game.status === 'playing') banner(`Caught by ${e.ghost}!`, 900);
    if (e.type === 'eat-ghost') banner(`+${e.points}`, 500);
  }
  if (game.status === 'won') banner('Maze cleared!');
  if (game.status === 'lost') banner('Game over');
  if (game.status === 'timeout') banner('Out of time');
}

function applyStep(dir) {
  const events = game.step(dir);
  lastStepAt = performance.now();
  handleEvents(events);
  updateHud();
  return events;
}

async function play(id) {
  while (game.status === 'playing') {
    if (!(await whilePaused(id))) return;
    let dir = game.autoDirection();
    let entry = null;
    if (els.agent.value === 'keyboard') {
      dir = keyboardDirection();
    } else if (game.needsDecision()) {
      entry = await decide().catch((err) => ({ error: err.message }));
      if (id !== runId) return;
      if (paused) continue; // paused mid-request: ask again on resume
      if (entry.error) {
        showDecision(entry, decisions);
        paused = true;
        setButtons();
        continue;
      }
      decisions++;
      showDecision(entry, decisions);
      dir = entry.dir;
    }
    recording.steps.push(entry ? { dir, response: entry.response, latencyMs: entry.latencyMs ?? 0, source: entry.source } : { dir });
    applyStep(dir);
    await sleep(stepMs());
  }
  looping = false;
  paused = true;
  setButtons();
}

async function replay(rec) {
  const id = ++runId;
  looping = false;
  replaying = true;
  paused = false;
  game = new Game({ seed: rec.seed, maxTicks: rec.maxTicks });
  lastStepAt = performance.now();
  banner('');
  updateHud();
  updateCaption();
  setButtons();
  els.start.disabled = false;
  els.start.textContent = 'Pause';
  const total = rec.steps.filter((s) => s.response).length;
  let n = 0;
  for (const s of rec.steps) {
    if (!(await whilePaused(id))) return;
    if (s.response) {
      n++;
      showDecision({ response: s.response, latencyMs: s.latencyMs, source: s.source }, n, total);
      await sleep(s.latencyMs); // real-time: wait as long as the model took
      if (!(await whilePaused(id))) return;
    }
    applyStep(s.dir);
    await sleep(stepMs());
  }
  replaying = false;
  paused = true;
  updateCaption();
  setButtons();
}

function newGame() {
  runId++;
  looping = false;
  replaying = false;
  paused = true;
  decisions = 0;
  queuedKey = null;
  const seed = Math.floor(Math.random() * 1e9);
  game = new Game({ seed });
  recording = { version: 1, seed, maxTicks: game.maxTicks, agent: els.agent.value, model: els.model.value, label: '', steps: [] };
  lastStepAt = performance.now();
  banner('');
  els.json.textContent = '';
  els.meta.textContent = '';
  els.request.textContent = '';
  els.moveCount.textContent = 'Press Start';
  updateHud();
  updateCaption();
  setButtons();
}

function toggleStart() {
  if (replaying) {
    paused = !paused;
    els.start.textContent = paused ? 'Resume' : 'Pause';
    return;
  }
  if (game.status !== 'playing') return;
  if (!looping) {
    looping = true;
    recording.agent = els.agent.value;
    recording.model = els.model.value;
    recording.label = els.caption.textContent.replace(/\.$/, '');
    paused = false;
    play(runId);
  } else {
    paused = !paused;
  }
  setButtons();
}

// ---------- wiring ----------

els.start.addEventListener('click', toggleStart);
els.reset.addEventListener('click', newGame);
els.replay.addEventListener('click', () => replay(recording));
els.agent.addEventListener('change', updateCaption);
els.model.addEventListener('change', updateCaption);

els.download.addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(recording)], { type: 'application/json' });
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `pacman-replay-${recording.seed}.json` });
  a.click();
  URL.revokeObjectURL(a.href);
});

els.upload.addEventListener('change', async () => {
  const file = els.upload.files[0];
  if (!file) return;
  try {
    const rec = JSON.parse(await file.text());
    if (!Array.isArray(rec.steps) || typeof rec.seed !== 'number') throw new Error('not a replay file');
    recording = rec;
    replay(rec);
  } catch (err) {
    alert(`Could not load replay: ${err.message}`);
  }
  els.upload.value = '';
});

const KEYS = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right', w: 'up', s: 'down', a: 'left', d: 'right' };
window.addEventListener('keydown', (e) => {
  if (e.key === ' ' && e.target === document.body) {
    e.preventDefault();
    toggleStart();
    return;
  }
  const dir = KEYS[e.key];
  if (!dir || els.agent.value !== 'keyboard') return;
  e.preventDefault();
  queuedKey = dir;
  if (!looping && !replaying && game.status === 'playing') toggleStart();
});

async function loadStatus() {
  try {
    ollama = await (await fetch('/api/status')).json();
  } catch {
    ollama = { ok: false, error: 'Server not reachable' };
  }
  const models = ollama.ok ? ollama.models : [];
  const preferred = ['nimble', 'tev1'];
  const sorted = [...models].sort((a, b) => {
    const rank = (m) => { const i = preferred.findIndex((p) => m.startsWith(p)); return i < 0 ? 99 : i; };
    return rank(a) - rank(b) || a.localeCompare(b);
  });
  if (!sorted.some((m) => m.startsWith('nimble'))) sorted.unshift('nimble');
  els.model.innerHTML = sorted.map((m) => `<option value="${m}">${m}</option>`).join('');

  if (!ollama.ok) {
    els.agent.value = 'heuristic';
    els.json.innerHTML = `<span class="error">${ollama.error}\nStart Ollama (0.35+) and reload, or play with the heuristic.</span>`;
  } else if (!models.some((m) => m.startsWith('nimble'))) {
    els.json.innerHTML = `<span class="error">Model "nimble" not found.\nRun: ollama pull nimble</span>`;
  }
  updateCaption();
}

newGame();
requestAnimationFrame(frame);
loadStatus();
