import { LAYOUT, ROWS, COLS, DIRS } from './maze.js';

export const CELL = 32;
const WALL = '#e6e5e0';
const DOT = '#1d1d1b';
const PAC = '#d6ad55';
const FRIGHT = '#5b6fd6';

export function setupCanvas(canvas) {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = COLS * CELL * dpr;
  canvas.height = ROWS * CELL * dpr;
  canvas.style.width = `${COLS * CELL}px`;
  canvas.style.height = `${ROWS * CELL}px`;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  return ctx;
}

// Position between prev and current tile; t in [0, 1]. Tunnel wraps snap.
function lerp(entity, t) {
  const { prev } = entity;
  if (!prev || Math.abs(prev.c - entity.c) > 1) return { x: entity.c, y: entity.r };
  return { x: prev.c + (entity.c - prev.c) * t, y: prev.r + (entity.r - prev.r) * t };
}

function drawMaze(ctx, game) {
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, COLS * CELL, ROWS * CELL);
  ctx.fillStyle = WALL;
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      if (LAYOUT[r][c] === '#') ctx.fillRect(c * CELL, r * CELL, CELL, CELL);
    }
  }
  ctx.fillStyle = '#e8b4cf';
  for (const k of game.door) {
    const r = Math.floor(k / COLS), c = k % COLS;
    ctx.fillRect(c * CELL, r * CELL + CELL / 2 - 2, CELL, 4);
  }
  ctx.fillStyle = DOT;
  const dot = (k, radius) => {
    ctx.beginPath();
    ctx.arc((k % COLS) * CELL + CELL / 2, Math.floor(k / COLS) * CELL + CELL / 2, radius, 0, Math.PI * 2);
    ctx.fill();
  };
  for (const k of game.dots) dot(k, 2.6);
  const pulse = 5 + Math.sin(performance.now() / 180) * 1.2;
  for (const k of game.pellets) dot(k, pulse);
}

function drawPacman(ctx, pac, t) {
  const { x, y } = lerp(pac, t);
  const cx = x * CELL + CELL / 2, cy = y * CELL + CELL / 2;
  const angle = { right: 0, down: Math.PI / 2, left: Math.PI, up: -Math.PI / 2 }[pac.dir ?? 'right'];
  const moving = pac.prev && (pac.prev.r !== pac.r || pac.prev.c !== pac.c);
  const mouth = moving ? 0.05 + 0.25 * Math.abs(Math.sin(t * Math.PI)) : 0.06;
  ctx.fillStyle = PAC;
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.arc(cx, cy, CELL * 0.42, angle + mouth * Math.PI, angle - mouth * Math.PI + Math.PI * 2);
  ctx.closePath();
  ctx.fill();
}

function drawGhost(ctx, g, t, powerTicks) {
  const { x, y } = lerp(g, t);
  const cx = x * CELL + CELL / 2, cy = y * CELL + CELL / 2;
  const w = CELL * 0.8, h = CELL * 0.82;
  const left = cx - w / 2, top = cy - h / 2, bottom = top + h;
  const flashing = g.frightened && powerTicks <= 8 && Math.floor(performance.now() / 200) % 2 === 0;
  ctx.fillStyle = g.frightened ? (flashing ? '#e8e8f4' : FRIGHT) : g.color;
  ctx.beginPath();
  ctx.arc(cx, top + w / 2, w / 2, Math.PI, 0);
  ctx.lineTo(left + w, bottom);
  const waves = 3, ww = w / waves;
  for (let i = 0; i < waves; i++) {
    const x0 = left + w - i * ww;
    ctx.lineTo(x0 - ww / 2, bottom - 4);
    ctx.lineTo(x0 - ww, bottom);
  }
  ctx.closePath();
  ctx.fill();

  const d = DIRS[g.dir ?? 'down'];
  if (g.frightened) {
    ctx.fillStyle = flashing ? '#c33' : '#fff';
    for (const ex of [-5, 5]) ctx.fillRect(cx + ex - 1.5, cy - 4, 3, 3);
    return;
  }
  for (const ex of [-5, 5]) {
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.ellipse(cx + ex, cy - 3, 4, 4.6, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#2a2a40';
    ctx.beginPath();
    ctx.arc(cx + ex + d.dc * 1.8, cy - 3 + d.dr * 1.8, 2, 0, Math.PI * 2);
    ctx.fill();
  }
}

export function draw(ctx, game, t) {
  drawMaze(ctx, game);
  for (const g of game.ghosts) drawGhost(ctx, g, t, game.powerTicks);
  if (game.status !== 'lost') drawPacman(ctx, game.pacman, t);
}
