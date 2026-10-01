// Turns a game position into a System One request, and a response back into a move.
import { Game } from './game.js';
import { OPPOSITE, DIR_ORDER } from './maze.js';

const key = Game.key;

// A safe region smaller than this means the ghosts can close the route off.
const TRAP_TILES = 8;
// Ghosts skip every fifth tick (see Game.moveGhost), so a tile d steps away
// takes them about 1.25·d ticks to reach.
const GHOST_TICKS_PER_TILE = 1.25;

const INSTRUCTIONS = [
  'You are playing Pac-Man. Choose the direction Pac-Man should move next.',
  'Each option starts with a verdict: SAFE, RISKY, TRAPPED or DEADLY.',
  '1. Never choose DEADLY or TRAPPED when a SAFE or RISKY option exists. Prefer SAFE over RISKY.',
  '2. Among the safest options, choose the one with the closest dot and the most dots ahead.',
  '3. Frightened ghosts are harmless and worth points; chasing one is good.',
].join('\n');

// Tiles Pac-Man can reach through `start` strictly before any dangerous ghost,
// given each tile's ghost arrival time. Pac-Man is on `start` after 1 step.
function safeRegion(game, start, here, ghostTime) {
  const region = new Map();
  if (1 >= (ghostTime.get(key(start.r, start.c)) ?? Infinity)) return region;
  region.set(key(start.r, start.c), 1);
  const queue = [start];
  while (queue.length) {
    const cur = queue.shift();
    const d = region.get(key(cur.r, cur.c));
    for (const dir of DIR_ORDER) {
      const n = game.neighbor(cur.r, cur.c, dir);
      const k = key(n.r, n.c);
      if (region.has(k) || here.has(k) || !game.walkable(n.r, n.c)) continue;
      if (d + 1 >= (ghostTime.get(k) ?? Infinity)) continue;
      region.set(k, d + 1);
      queue.push(n);
    }
  }
  return region;
}

// Look down each legal direction and summarise what is there.
export function analyzeMoves(game) {
  const pac = game.pacman;
  const here = new Set([key(pac.r, pac.c)]);
  const dangerous = game.dangerousGhosts();
  const edible = game.ghosts.filter((g) => g.frightened);
  const ghostDist = dangerous.map((g) => ({ g, dist: game.distances({ r: g.r, c: g.c }) }));
  const ghostTime = new Map();
  for (const { dist } of ghostDist) {
    for (const [k, d] of dist) {
      const t = Math.floor(d * GHOST_TICKS_PER_TILE);
      if (t < (ghostTime.get(k) ?? Infinity)) ghostTime.set(k, t);
    }
  }

  return game.legalMoves().map((dir) => {
    const n = game.neighbor(pac.r, pac.c, dir);
    const nk = key(n.r, n.c);
    const route = game.distances(n, here);

    let nearestDot = Infinity;
    let dotsWithin8 = 0;
    for (const k of [...game.dots, ...game.pellets]) {
      const d = route.get(k);
      if (d === undefined) continue;
      nearestDot = Math.min(nearestDot, d + 1);
      if (d + 1 <= 8) dotsWithin8++;
    }

    let ghostAhead = null;
    for (const g of dangerous) {
      const d = route.get(key(g.r, g.c));
      if (d !== undefined && (!ghostAhead || d + 1 < ghostAhead.steps)) ghostAhead = { name: g.name, steps: d + 1 };
    }
    let edibleAhead = null;
    for (const g of edible) {
      const d = route.get(key(g.r, g.c));
      if (d !== undefined && (!edibleAhead || d + 1 < edibleAhead.steps)) edibleAhead = { name: g.name, steps: d + 1 };
    }

    // How quickly can any dangerous ghost reach the tile we'd step onto?
    let threat = Infinity;
    for (const { dist } of ghostDist) threat = Math.min(threat, dist.get(nk) ?? Infinity);

    const region = safeRegion(game, n, here, ghostTime);
    let nearestSafeDot = Infinity;
    let safeDotsWithin8 = 0;
    for (const k of [...game.dots, ...game.pellets]) {
      const d = region.get(k);
      if (d === undefined) continue;
      nearestSafeDot = Math.min(nearestSafeDot, d);
      if (d <= 8) safeDotsWithin8++;
    }

    return {
      dir,
      nextTile: game.pellets.has(nk) ? 'power pellet' : game.dots.has(nk) ? 'dot' : 'empty',
      nearestDot: Number.isFinite(nearestDot) ? nearestDot : null,
      dotsWithin8,
      ghostAhead,
      edibleAhead,
      ghostCanReachNextTileIn: Number.isFinite(threat) ? threat : null,
      reverses: pac.dir === OPPOSITE[dir],
      safeTiles: region.size,
      nearestSafeDot: Number.isFinite(nearestSafeDot) ? nearestSafeDot : null,
      safeDotsWithin8,
    };
  });
}

function verdict(a) {
  if (a.safeTiles === 0) return 'DEADLY';
  if (a.safeTiles < TRAP_TILES) return 'TRAPPED';
  if (a.ghostCanReachNextTileIn !== null && a.ghostCanReachNextTileIn <= 3) return 'RISKY';
  return 'SAFE';
}

const RANK = { SAFE: 0, RISKY: 1, TRAPPED: 2, DEADLY: 3 };

// Prefer dots Pac-Man can reach ahead of the ghosts; when there are none,
// fall back to the plain nearest dot so the model still has a direction.
const dotSteps = (a) => a.nearestSafeDot ?? a.nearestDot;
const dotCount = (a) => (a.nearestSafeDot !== null ? a.safeDotsWithin8 : a.dotsWithin8);

// Lead with the verdict, then the facts. Comparisons ("closest", "most") are
// made only among the options with the best verdict, so the model doesn't
// have to compare numbers and isn't drawn to a trapped route.
function describe(a, all, powerTicks) {
  const v = verdict(a);
  const best = Math.min(...all.map((o) => RANK[verdict(o)]));
  const peers = all.filter((o) => RANK[verdict(o)] === best);
  const isPeer = peers.includes(a) && peers.length > 1;
  const parts = [`${v}. Move ${a.dir}.`];

  if (v === 'DEADLY') parts.push('A ghost reaches the next tile first.');
  else if (v === 'TRAPPED') {
    const widest = isPeer && a.safeTiles === Math.max(...peers.map((o) => o.safeTiles)) ? ' (largest escape of all options)' : '';
    parts.push(`Ghosts can cut this route off: only ${a.safeTiles} tiles reachable ahead of them${widest}.`);
  } else if (v === 'RISKY') parts.push(`A ghost is ${a.ghostCanReachNextTileIn} steps from the next tile, but there is an escape route.`);
  else parts.push('Plenty of room ahead of the ghosts.');

  const edible = all.filter((o) => o.edibleAhead && o.edibleAhead.steps <= powerTicks);
  if (edible.includes(a) && a.edibleAhead.steps === Math.min(...edible.map((o) => o.edibleAhead.steps))) {
    parts.push(`Frightened ghost ${a.edibleAhead.name} ${a.edibleAhead.steps} steps away (closest edible ghost): chase it for points.`);
  }

  if (dotSteps(a) === null) parts.push('No dots this way.');
  else {
    const withDots = peers.filter((o) => dotSteps(o) !== null);
    const closest = isPeer && dotSteps(a) === Math.min(...withDots.map(dotSteps)) ? ' (closest of all options)' : '';
    const most = isPeer && dotCount(a) > 0 && dotCount(a) === Math.max(...withDots.map(dotCount)) ? ' (most of all options)' : '';
    const risk = a.nearestSafeDot === null ? ', but a ghost may get there first' : '';
    parts.push(`Nearest dot ${dotSteps(a)} step(s)${closest}${risk}.`);
    parts.push(`${dotCount(a)} dots within 8 steps${most}.`);
  }
  if (a.reverses) parts.push('Reverses direction.');
  return parts.join(' ');
}

export function buildRequest(game, model, { includeBoard = true } = {}) {
  const analysis = analyzeMoves(game);
  const pac = game.pacman;
  const state = {
    board: game.board(),
    legend: '@ = Pac-Man, B/P/C = dangerous ghosts Blinky/Pinky/Clyde (lowercase = frightened, edible), . = dot, o = power pellet, # = wall. The row-9 corridor wraps left/right.',
    pacman: { row: pac.r, col: pac.c, facing: pac.dir ?? 'none' },
    ghosts: game.ghosts.map((g) => ({ name: g.name, row: g.r, col: g.c, state: g.inHouse ? 'in house' : g.frightened ? 'frightened' : game.mode })),
    power_mode_steps_left: game.powerTicks,
    dots_remaining: game.dotsRemaining,
    lives: game.lives,
    score: game.score,
  };
  if (!includeBoard) {
    delete state.board;
    delete state.legend;
  }
  // Safety is the code's call: drop TRAPPED/DEADLY options whenever a SAFE or
  // RISKY one exists (and DEADLY whenever a TRAPPED one does). The model then
  // chooses among what's left.
  const best = Math.min(...analysis.map((a) => RANK[verdict(a)]));
  const offered = analysis.filter((a) => RANK[verdict(a)] <= Math.max(best, RANK.RISKY));
  const criteria = Object.fromEntries(offered.map((a) => [a.dir, describe(a, offered, game.powerTicks)]));
  return {
    analysis,
    // System One needs at least two candidates; with one, there's no choice to ask about.
    forced: offered.length === 1 ? offered[0].dir : null,
    body: {
      model,
      state,
      questions: { move: { type: 'choice', instructions: INSTRUCTIONS, criteria } },
    },
  };
}

// Pick a legal move from a System One response, tolerating odd answers.
export function parseMove(response, legal) {
  const ans = response?.answers?.move;
  if (!ans) return null;
  if (legal.includes(ans.choice)) return ans.choice;
  const probs = ans.probabilities ?? {};
  return legal.reduce((best, d) => ((probs[d] ?? -1) > (probs[best] ?? -1) ? d : best), legal[0]) ?? null;
}

// No-LLM baseline that scores the same analysis the model sees. Returns a
// response shaped like System One's so the UI can treat both the same way.
export function heuristicDecision(analysis) {
  const scores = analysis.map((a) => {
    let s = 0;
    if (a.ghostCanReachNextTileIn !== null) s -= a.ghostCanReachNextTileIn <= 1 ? 100 : a.ghostCanReachNextTileIn <= 2 ? 40 : 0;
    if (a.ghostAhead) s -= Math.max(0, 12 - a.ghostAhead.steps) * 4;
    if (a.edibleAhead) s += Math.max(0, 15 - a.edibleAhead.steps) * 3;
    s += a.nearestDot !== null ? 20 / a.nearestDot : -10;
    s += a.dotsWithin8;
    if (a.reverses) s -= 3;
    return s;
  });
  const max = Math.max(...scores);
  const exps = scores.map((s) => Math.exp((s - max) / 5));
  const total = exps.reduce((x, y) => x + y, 0);
  const probabilities = Object.fromEntries(analysis.map((a, i) => [a.dir, +(exps[i] / total).toFixed(2)]));
  const best = analysis[scores.indexOf(max)].dir;
  return { answers: { move: { type: 'choice', choice: best, probabilities, confidence: probabilities[best] } } };
}
