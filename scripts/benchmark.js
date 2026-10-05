// What does the model add over plain code? Three experiments, all against the
// `rule` baseline (the model's own instructions applied literally as a sort):
//   1. Decisions: one fixed set of positions, asked at each information level.
//   2. Steering: change the policy in prose only, and see whether choices follow.
//   3. Games: full games per agent and level.
//   node scripts/benchmark.js [--model nimble] [--samples 150] [--games 5] [--seed 1] [--levels full,facts,raw] [--json out.json]
import { writeFileSync } from 'node:fs';
import { Game } from '../public/js/game.js';
import { analyzeMoves, buildRequest, heuristicDecision, parseMove, ruleDecision, verdict, RANK, LEVELS } from '../public/js/agent.js';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]]] : acc), []),
);
const model = args.model ?? 'nimble';
const samples = Number(args.samples ?? 150);
const games = Number(args.games ?? 5);
const seed0 = Number(args.seed ?? 1);
const levels = (args.levels ?? LEVELS.join(',')).split(',');
const host = process.env.OLLAMA_HOST ?? 'http://localhost:11434';
const LIVES = 3;
const COLLECT_GAMES = 5;

const STEER_INSTRUCTIONS = [
  'You are playing Pac-Man. Choose the direction Pac-Man should move next.',
  'House rule for this run: ignore dots entirely. Always choose the option with the most tiles reachable before any dangerous ghost.',
].join('\n');

const log = (msg) => process.stderr.write(`${msg}\n`);
const pct = (x, n) => (n ? `${((100 * x) / n).toFixed(1)}%` : '–');
const ruleMove = (game, analysis) => ruleDecision(analysis, game.powerTicks).answers.move.choice;
const rankOf = (analysis, dir) => RANK[verdict(analysis.find((a) => a.dir === dir))];

async function ask(body) {
  const t0 = performance.now();
  const res = await fetch(`${host}/v1/systemone`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error ?? res.statusText);
  return { json, ms: performance.now() - t0 };
}

// Evenly spaced picks, so every phase of the game is represented.
const spread = (list, n) => (list.length <= n ? list : Array.from({ length: n }, (_, i) => list[Math.floor((i * list.length) / n)]));

// Positions Pac-Man meets while the rule agent plays, with every request variant prebuilt.
function collectPositions() {
  const out = [];
  for (let seed = seed0; seed < seed0 + COLLECT_GAMES; seed++) {
    const game = new Game({ seed, lives: LIVES });
    while (game.status === 'playing') {
      let dir = game.autoDirection();
      if (game.needsDecision()) {
        const analysis = analyzeMoves(game);
        dir = ruleMove(game, analysis);
        out.push({
          analysis,
          rule: dir,
          legal: game.legalMoves(),
          requests: Object.fromEntries(levels.map((level) => [level, buildRequest(game, model, { level, includeBoard: false })])),
          plain: buildRequest(game, model, { level: 'facts', includeBoard: false }).body,
          steer: buildRequest(game, model, { level: 'facts', includeBoard: false, instructions: STEER_INSTRUCTIONS }).body,
        });
      }
      game.step(dir);
    }
  }
  return out;
}

async function decisionExperiment(positions) {
  const rows = [];
  for (const level of levels) {
    let asked = 0, agree = 0, contested = 0, worse = 0, cutOff = 0, ms = 0;
    for (const [i, p] of positions.entries()) {
      const { body, forced } = p.requests[level];
      if (forced) continue;
      const { json, ms: t } = await ask(body);
      const dir = parseMove(json, p.legal);
      asked++;
      ms += t;
      agree += dir === p.rule;
      const ranks = p.analysis.map((a) => RANK[verdict(a)]);
      const best = Math.min(...ranks);
      if (Math.max(...ranks) > best) {
        contested++;
        worse += rankOf(p.analysis, dir) > best;
        cutOff += rankOf(p.analysis, dir) >= RANK.TRAPPED && best < RANK.TRAPPED;
      }
      if ((i + 1) % 25 === 0) log(`  decisions/${level}: ${i + 1}/${positions.length}`);
    }
    rows.push({ level, asked, agree, contested, worse, cutOff, msPerCall: asked ? ms / asked : 0 });
  }
  return rows;
}

// Positions where "most room" and the rule's choice disagree, so following the prose shows.
async function steeringExperiment(all) {
  const conflicts = spread(all.filter((p) => {
    const most = Math.max(...p.analysis.map((a) => a.safeTiles));
    const top = p.analysis.filter((a) => a.safeTiles === most);
    return top.length === 1 && top[0].dir !== p.rule;
  }), samples);
  const target = (p) => p.analysis.reduce((a, b) => (b.safeTiles > a.safeTiles ? b : a)).dir;
  const result = { positions: conflicts.length, rule: 0, plain: 0, steered: 0 };
  for (const [i, p] of conflicts.entries()) {
    const plain = parseMove((await ask(p.plain)).json, p.legal);
    const steered = parseMove((await ask(p.steer)).json, p.legal);
    result.plain += plain === target(p);
    result.steered += steered === target(p);
    if ((i + 1) % 25 === 0) log(`  steering: ${i + 1}/${conflicts.length}`);
  }
  return result;
}

async function play(seed, choose) {
  const game = new Game({ seed, lives: LIVES });
  let calls = 0, ms = 0;
  while (game.status === 'playing') {
    let dir = game.autoDirection();
    if (game.needsDecision()) {
      const r = await choose(game);
      dir = r.dir;
      if (r.ms !== undefined) {
        calls++;
        ms += r.ms;
      }
    }
    game.step(dir);
  }
  return { won: game.status === 'won', dots: game.totalDots - game.dotsRemaining, total: game.totalDots, deaths: LIVES - game.lives, calls, ms };
}

function seededRandom(seed) {
  let a = seed >>> 0;
  return () => (a = (Math.imul(a, 1664525) + 1013904223) >>> 0) / 4294967296;
}

async function gameExperiment() {
  const agents = [
    ['random', (seed) => { const rnd = seededRandom(seed); return (g) => { const l = g.legalMoves(); return { dir: l[Math.floor(rnd() * l.length)] }; }; }],
    ['heuristic', () => (g) => ({ dir: parseMove(heuristicDecision(analyzeMoves(g)), g.legalMoves()) })],
    ['rule', () => (g) => ({ dir: ruleMove(g, analyzeMoves(g)) })],
    ...levels.map((level) => [`${model} (${level})`, () => async (g) => {
      const { body, forced } = buildRequest(g, model, { level, includeBoard: false });
      if (forced) return { dir: forced };
      const { json, ms } = await ask(body);
      return { dir: parseMove(json, g.legalMoves()), ms };
    }]),
  ];
  const rows = [];
  for (const [name, make] of agents) {
    const runs = [];
    for (let seed = seed0; seed < seed0 + games; seed++) {
      runs.push(await play(seed, make(seed)));
      log(`  games/${name}: seed ${seed} ${runs.at(-1).won ? 'won' : 'lost'}`);
    }
    const sum = (f) => runs.reduce((s, r) => s + f(r), 0);
    rows.push({ agent: name, games: runs.length, wins: sum((r) => r.won), dots: sum((r) => r.dots), total: sum((r) => r.total), deaths: sum((r) => r.deaths), msPerCall: sum((r) => r.calls) ? sum((r) => r.ms) / sum((r) => r.calls) : 0 });
  }
  return rows;
}

const all = collectPositions();
const positions = spread(all, samples);
log(`collected ${all.length} positions from ${COLLECT_GAMES} rule games; using ${positions.length}`);

const decisions = await decisionExperiment(positions);
const steering = await steeringExperiment(all);
const gameRows = games > 0 ? await gameExperiment() : [];

const out = [];
out.push(`## Decisions (${positions.length} positions, ${model})\n`);
out.push('| level | asked | agrees with rule | contested | less safe than best | TRAPPED/DEADLY when avoidable | ms/call |');
out.push('|---|---|---|---|---|---|---|');
for (const r of decisions) out.push(`| ${r.level} | ${r.asked} | ${pct(r.agree, r.asked)} | ${r.contested} | ${pct(r.worse, r.contested)} | ${pct(r.cutOff, r.contested)} | ${Math.round(r.msPerCall)} |`);
out.push(`\n## Steering in prose (facts level, ${steering.positions} positions where "most room" ≠ rule)\n`);
out.push('| policy | picks the most-room option |');
out.push('|---|---|');
out.push(`| rule (code, unchanged) | ${pct(steering.rule, steering.positions)} |`);
out.push(`| ${model}, plain instructions | ${pct(steering.plain, steering.positions)} |`);
out.push(`| ${model}, "most room" house rule | ${pct(steering.steered, steering.positions)} |`);
if (gameRows.length) {
  out.push(`\n## Games (seeds ${seed0}–${seed0 + games - 1})\n`);
  out.push('| agent | wins | dots eaten | lives lost | ms/call |');
  out.push('|---|---|---|---|---|');
  for (const r of gameRows) out.push(`| ${r.agent} | ${r.wins}/${r.games} | ${pct(r.dots, r.total)} | ${r.deaths} | ${r.msPerCall ? Math.round(r.msPerCall) : '–'} |`);
}
console.log(out.join('\n'));
if (args.json) writeFileSync(args.json, JSON.stringify({ model, samples: positions.length, decisions, steering, games: gameRows }, null, 2));
