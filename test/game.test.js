import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Game } from '../public/js/game.js';
import { LAYOUT, COLS } from '../public/js/maze.js';
import { analyzeMoves, buildRequest, heuristicDecision, parseMove } from '../public/js/agent.js';

test('layout is rectangular', () => {
  for (const row of LAYOUT) assert.equal(row.length, COLS, row);
});

test('every dot is reachable from the start', () => {
  const g = new Game();
  const dist = g.distances(g.pacStart);
  for (const k of [...g.dots, ...g.pellets]) assert.ok(dist.has(k), `unreachable tile ${Math.floor(k / COLS)},${k % COLS}`);
});

test('no dead ends in the corridors', () => {
  const g = new Game();
  for (const k of g.distances(g.pacStart).keys()) {
    const r = Math.floor(k / COLS), c = k % COLS;
    assert.ok(g.legalMoves(r, c).length >= 2, `dead end at ${r},${c}`);
  }
});

function play(seed, pickDir = (game) => parseMove(heuristicDecision(analyzeMoves(game)), game.legalMoves())) {
  const game = new Game({ seed });
  const dirs = [];
  while (game.status === 'playing') {
    const dir = game.needsDecision() ? pickDir(game) : game.autoDirection();
    dirs.push(dir);
    game.step(dir);
  }
  return { game, dirs };
}

test('ghosts leave the house', () => {
  const game = new Game();
  for (let i = 0; i < 60 && game.status === 'playing'; i++) game.step(game.autoDirection());
  assert.ok(game.ghosts.every((g) => !g.inHouse) || game.lives < 3);
});

test('games are deterministic and replayable', () => {
  const { game, dirs } = play(42);
  const replay = new Game({ seed: 42 });
  for (const d of dirs) replay.step(d);
  assert.equal(replay.score, game.score);
  assert.equal(replay.status, game.status);
  assert.equal(replay.tick, game.tick);
});

test('heuristic agent finishes games and scores points', () => {
  for (const seed of [1, 2, 3, 4, 5]) {
    const { game } = play(seed);
    assert.notEqual(game.status, 'playing');
    assert.ok(game.score > 0);
  }
});

test('request has a choice question over legal moves only', () => {
  const g = new Game();
  const { body } = buildRequest(g, 'nimble');
  assert.deepEqual(Object.keys(body.questions.move.criteria).sort(), g.legalMoves().sort());
  assert.equal(body.state.board.length, LAYOUT.length);
});

test('parseMove falls back to the most probable legal move', () => {
  const r = { answers: { move: { choice: 'up', probabilities: { up: 0.7, left: 0.2, right: 0.1 } } } };
  assert.equal(parseMove(r, ['left', 'right']), 'left');
  assert.equal(parseMove(r, ['up', 'left']), 'up');
  assert.equal(parseMove({}, ['up']), null);
});

test('deadly moves are not offered when a safer one exists', () => {
  const g = new Game();
  Object.assign(g.ghosts[0], { r: 15, c: 7 }); // Blinky, one tile past Pac-Man's left neighbour
  const { body, forced } = buildRequest(g, 'nimble');
  const { criteria } = body.questions.move;
  assert.deepEqual(Object.keys(criteria), ['right']);
  assert.equal(forced, 'right');
  assert.match(criteria.right, /^RISKY\./); // the ghost is 3 tiles from there, but behind Pac-Man
});
