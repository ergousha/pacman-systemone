# Pac-Man × Ollama System One

Pac-Man played by a local decision model. At every junction the game sends
the position to Ollama's System One API (`/v1/systemone`) as a `choice`
question. The model returns a probability for each legal direction, and
Pac-Man takes the most likely one. Everything runs on your machine.

![Pac-Man × Ollama System One screenshot](docs/screenshot.png)

## Requirements

- Ollama **0.35+** (`ollama --version`)
- A System One decision model: `ollama pull nimble` (Nimble 9B; Tev1 4B / 0.8B also work)
- Node.js 18+ (no npm dependencies)

## Run

```sh
npm start            # → http://localhost:3000
```

Environment variables: `PORT` (default `3000`), `OLLAMA_HOST` (default `http://localhost:11434`).

Controls:

- **Player**: Ollama System One, a heuristic baseline (no LLM), or yourself on the arrow keys / WASD.
- **Space**: start or pause.
- **Replay**: re-runs the last game, waiting as long as the model took on each decision, so you see it at real-time speed. The ⤓ / ⤒ buttons save and load replays as JSON.
- **What the model saw**: shows the exact request for the current move.
- **Send ASCII board**: also sends the maze as text. This is off by default because it adds ~220 tokens (~350 ms per call on Nimble) without better play in testing.

## How a decision works

```jsonc
// POST /v1/systemone
{
  "model": "nimble",
  "state": { "pacman": { "row": 15, "col": 9, "facing": "left" }, "ghosts": [ ... ], "dots_remaining": 133, ... },
  "questions": {
    "move": {
      "type": "choice",
      "instructions": "You are playing Pac-Man. Choose the direction ...",
      "criteria": {
        "up":   "SAFE. Move up. Plenty of room ahead of the ghosts. Nearest dot 1 step(s) (closest of all options). 12 dots within 8 steps (most of all options).",
        "down": "TRAPPED. Move down. Ghosts can cut this route off: only 3 tiles reachable ahead of them. Nearest dot 2 step(s). 2 dots within 8 steps. Reverses direction."
      }
    }
  }
}
// → { "answers": { "move": { "type": "choice", "choice": "up", "probabilities": { "up": 0.94, "down": 0.06 }, "confidence": 0.67 } } }
```

Only legal directions are offered. The model isn't trained on Pac-Man, so
the game does the spatial reasoning and the model weighs the conclusions. Each
option's description starts with a verdict:

- **SAFE**: plenty of tiles Pac-Man can reach before any ghost can.
- **RISKY**: a ghost is near the next tile, but there is room to escape.
- **TRAPPED**: fewer than 8 tiles reachable ahead of the ghosts; they can cut the route off.
- **DEADLY**: a ghost reaches the next tile first.

Then it lists the nearest dot and dot count along that route. Labels such as
"closest of all options" are only given among the options with the best
verdict, so the model doesn't have to compare numbers across options. The
instructions refer to the same verdict words.

Safety is decided by the code, not the model: TRAPPED and DEADLY options are
left out whenever a SAFE or RISKY one exists. If only one move is left, Pac-Man
takes it without asking the model (System One needs at least two options).

The model is only asked at decision points: junctions, corners, the first
move, or when a ghost is within 4 tiles. In straight corridors Pac-Man keeps
going. The game is turn-based, so the world waits while the model thinks.

## Project layout

```
server.js            static server + /api/systemone proxy + /api/status
public/js/maze.js    layout and ghost config
public/js/game.js    deterministic engine (seeded; same seed + moves ⇒ same game)
public/js/agent.js   request builder (full/facts/raw levels), response parser, heuristic and rule baselines
public/js/render.js  canvas drawing
public/js/main.js    UI, game loop, replay
scripts/simulate.js  headless games
scripts/benchmark.js model vs. rule baseline across information levels
test/                node:test suite
```

## Headless play & tests

```sh
npm test
node scripts/simulate.js --agent heuristic --games 10
node scripts/simulate.js --agent rule --games 10
node scripts/simulate.js --agent ollama --model nimble --games 3 [--board on] [--level full|facts|raw]
npm run bench -- --samples 150 --games 5 [--json out.json]
```

On an M-series Mac, over seeds 1–10, Nimble wins 9 of 10 games (99.8% of dots
eaten on average), at ~500 ms per model call (warm).

## What does the model add?

`scripts/benchmark.js` compares the model with `rule`, a no-LLM agent that
applies the model's own instructions literally as a sort: safest verdict, then
closest edible ghost, closest dot, most dots, not reversing. It tests three
information levels (`--level` in `simulate.js`):

- **full**: the default request, with verdicts and cross-option labels. Unsafe options are filtered out by the code.
- **facts**: the same per-option numbers for every legal move, with no verdicts, labels or filtering.
- **raw**: bare directions. The model only has the state JSON and the ASCII board.

Nimble, 150 positions taken from 5 rule games, then 5 full games per agent (seeds 1–5):

| level | agrees with rule | less safe than best¹ | TRAPPED/DEADLY when avoidable¹ |
|---|---|---|---|
| full | 77.0% | 14.3% | 0.0% (filtered by code) |
| facts | 68.0% | 20.8% | 11.1% |
| raw | 54.0% | 25.0% | 13.9% |

¹ Among positions where the options' verdicts differ.

| agent | wins | dots eaten | lives lost | ms/call |
|---|---|---|---|---|
| random | 0/5 | 23.2% | 15 | – |
| heuristic | 4/5 | 98.9% | 8 | – |
| **rule** | **5/5** | **100.0%** | **7** | – |
| Nimble (full) | 4/5 | 99.6% | 6 | 512 |
| Nimble (facts) | 0/5 | 49.3% | 15 | 436 |
| Nimble (raw) | 0/5 | 13.3% | 15 | 603 |

The model plays well only when the code has already analysed the position and
labelled each option. At that point a few lines of code play at least as well,
faster. With the same numbers but no verdicts (facts), it loses every game. With
only the board (raw), it eats fewer dots than random moves.

What the model does offer is a policy you can change in prose. The steering
test uses the 150 facts-level positions where the option with the most room
ahead of the ghosts is not the rule's choice. Adding one sentence to the
instructions ("ignore dots; choose the option with the most tiles reachable
before any ghost") moves Nimble from 15.3% to 51.3% most-room picks, with no
code change. `rule` stays at 0% until someone edits it. Even so, the model
follows the new instruction only about half the time.
