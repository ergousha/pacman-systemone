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
        "up":   "Move up. Next tile: dot. Nearest dot 1 steps; 6 dots within 8 steps. No dangerous ghost down this route.",
        "down": "Move down. Next tile: empty. ... DANGER: a ghost can reach that tile in 1 step(s)."
      }
    }
  }
}
// → { "answers": { "move": { "type": "choice", "choice": "up", "probabilities": { "up": 0.94, "down": 0.06 }, "confidence": 0.67 } } }
```

Only legal directions are offered. Each option's description is computed
with a BFS down that route (nearest dot, dot density, ghosts ahead, how soon a
ghost can reach the next tile). This gives the classifier concrete facts to
weigh instead of making it read the maze spatially.

The model is only asked at decision points: junctions, corners, the first
move, or when a ghost is within 4 tiles. In straight corridors Pac-Man keeps
going. The game is turn-based, so the world waits while the model thinks.

## Project layout

```
server.js            static server + /api/systemone proxy + /api/status
public/js/maze.js    layout and ghost config
public/js/game.js    deterministic engine (seeded; same seed + moves ⇒ same game)
public/js/agent.js   request builder, response parser, heuristic baseline
public/js/render.js  canvas drawing
public/js/main.js    UI, game loop, replay
scripts/simulate.js  headless games
test/                node:test suite
```

## Headless play & tests

```sh
npm test
node scripts/simulate.js --agent heuristic --games 10
node scripts/simulate.js --agent ollama --model nimble --games 3 [--board on]
```

On an M-series Mac, Nimble clears ~80–90% of the maze before losing its three
lives, at ~500 ms per decision (warm).
