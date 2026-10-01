// Headless games, to check balance or benchmark a model.
//   node scripts/simulate.js [--agent heuristic|ollama] [--model nimble] [--games 5] [--seed 1] [--board on]
import { Game } from '../public/js/game.js';
import { buildRequest, heuristicDecision, parseMove } from '../public/js/agent.js';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]]] : acc), []),
);
const agent = args.agent ?? 'heuristic';
const model = args.model ?? 'nimble';
const games = Number(args.games ?? 5);
const seed0 = Number(args.seed ?? 1);
const includeBoard = args.board === 'on';
const host = process.env.OLLAMA_HOST ?? 'http://localhost:11434';

async function decide(game) {
  const { body, analysis, forced } = buildRequest(game, model, { includeBoard });
  if (agent === 'heuristic') return parseMove(heuristicDecision(analysis), game.legalMoves());
  if (forced) return forced;
  const res = await fetch(`${host}/v1/systemone`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error ?? res.statusText);
  return parseMove(json, game.legalMoves());
}

for (let i = 0; i < games; i++) {
  const game = new Game({ seed: seed0 + i });
  let decisions = 0;
  const t0 = Date.now();
  while (game.status === 'playing') {
    let dir = game.autoDirection();
    if (game.needsDecision()) {
      dir = await decide(game);
      decisions++;
    }
    game.step(dir);
  }
  const eaten = game.totalDots - game.dotsRemaining;
  const ms = Date.now() - t0;
  console.log(`seed ${game.seed}: ${game.status.padEnd(7)} score ${String(game.score).padStart(5)}  dots ${eaten}/${game.totalDots}  ticks ${game.tick}  decisions ${decisions}  ${agent === 'ollama' ? `${Math.round(ms / Math.max(decisions, 1))} ms/decision` : ''}`);
}
