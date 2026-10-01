// Turns a game position into a System One request, and a response back into a move.
import { Game } from './game.js';
import { OPPOSITE } from './maze.js';

const key = Game.key;

const INSTRUCTIONS = [
  'You are playing Pac-Man. Choose the direction Pac-Man should move next.',
  'Priorities, in order:',
  '1. Survive: never move onto or toward a tile a dangerous ghost can reach first. Frightened ghosts (lowercase on the board) are harmless and worth points.',
  '2. Eat dots: prefer routes where the nearest dot is closest and many dots lie ahead.',
  '3. Avoid needless reversals and dead ends.',
  'Each option describes what lies along that route.',
].join('\n');

// Look down each legal direction and summarise what is there.
export function analyzeMoves(game) {
  const pac = game.pacman;
  const here = new Set([key(pac.r, pac.c)]);
  const dangerous = game.dangerousGhosts();
  const edible = game.ghosts.filter((g) => g.frightened);
  const ghostDist = dangerous.map((g) => ({ g, dist: game.distances({ r: g.r, c: g.c }) }));

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

    return {
      dir,
      nextTile: game.pellets.has(nk) ? 'power pellet' : game.dots.has(nk) ? 'dot' : 'empty',
      nearestDot: Number.isFinite(nearestDot) ? nearestDot : null,
      dotsWithin8,
      ghostAhead,
      edibleAhead,
      ghostCanReachNextTileIn: Number.isFinite(threat) ? threat : null,
      reverses: pac.dir === OPPOSITE[dir],
    };
  });
}

function describe(a) {
  const parts = [`Move ${a.dir}. Next tile: ${a.nextTile}.`];
  if (a.nearestDot !== null) parts.push(`Nearest dot ${a.nearestDot} steps; ${a.dotsWithin8} dots within 8 steps.`);
  else parts.push('No dots reachable this way.');
  if (a.ghostAhead) parts.push(`Dangerous ghost ${a.ghostAhead.name} ${a.ghostAhead.steps} steps down this route.`);
  else parts.push('No dangerous ghost down this route.');
  if (a.ghostCanReachNextTileIn !== null && a.ghostCanReachNextTileIn <= 2) {
    parts.push(`DANGER: a ghost can reach that tile in ${a.ghostCanReachNextTileIn} step(s).`);
  }
  if (a.edibleAhead) parts.push(`Frightened ghost ${a.edibleAhead.name} ${a.edibleAhead.steps} steps away — edible.`);
  if (a.reverses) parts.push('This reverses direction.');
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
  const criteria = Object.fromEntries(analysis.map((a) => [a.dir, describe(a)]));
  return {
    analysis,
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
