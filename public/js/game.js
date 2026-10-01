// Deterministic, turn-based Pac-Man engine. One step() = one tile of movement.
// Given the same seed and the same sequence of Pac-Man directions, a game
// replays identically — that's what makes the replay feature work.
import { LAYOUT, ROWS, COLS, DIRS, DIR_ORDER, OPPOSITE, GHOSTS, GHOST_EXIT } from './maze.js';

const POWER_TICKS = 30;
const MODE_SCHEDULE = [['scatter', 20], ['chase', 80], ['scatter', 20], ['chase', 80], ['scatter', 15], ['chase', Infinity]];

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const key = (r, c) => r * COLS + c;

export class Game {
  constructor({ seed = 1, lives = 3, maxTicks = 2000 } = {}) {
    this.seed = seed;
    this.rng = mulberry32(seed);
    this.maxTicks = maxTicks;
    this.lives = lives;
    this.score = 0;
    this.tick = 0;
    this.status = 'playing'; // playing | won | lost | timeout
    this.powerTicks = 0;
    this.ghostCombo = 0;
    this.modeIndex = 0;
    this.modeTicks = 0;

    this.walls = new Set();
    this.void = new Set();
    this.door = new Set();
    this.house = new Set();
    this.dots = new Set();
    this.pellets = new Set();
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        const ch = LAYOUT[r][c];
        const k = key(r, c);
        if (ch === '#') this.walls.add(k);
        else if (ch === '_') this.void.add(k);
        else if (ch === '-') this.door.add(k);
        else if (ch === 'G') this.house.add(k);
        else if (ch === '.') this.dots.add(k);
        else if (ch === 'o') this.pellets.add(k);
        else if (ch === 'P') this.pacStart = { r, c };
      }
    }
    this.totalDots = this.dots.size + this.pellets.size;
    this.resetPositions();
  }

  get mode() {
    return MODE_SCHEDULE[this.modeIndex][0];
  }

  get dotsRemaining() {
    return this.dots.size + this.pellets.size;
  }

  resetPositions() {
    this.pacman = { ...this.pacStart, dir: null, prev: { ...this.pacStart } };
    this.ghosts = GHOSTS.map((g) => ({
      name: g.name,
      color: g.color,
      scatter: g.scatter,
      r: g.start.r,
      c: g.start.c,
      prev: { ...g.start },
      dir: null,
      inHouse: g.inHouse,
      releaseTick: this.tick + g.releaseTick,
      frightened: false,
      start: g.start,
    }));
    this.powerTicks = 0;
  }

  // Neighbor in direction, with horizontal wrap-around through the tunnel.
  neighbor(r, c, dir) {
    const d = DIRS[dir];
    return { r: r + d.dr, c: (c + d.dc + COLS) % COLS };
  }

  walkable(r, c, ghost = null) {
    if (r < 0 || r >= ROWS) return false;
    const k = key(r, c);
    if (this.walls.has(k) || this.void.has(k)) return false;
    if (this.house.has(k) || this.door.has(k)) return !!(ghost && ghost.inHouse);
    return true;
  }

  legalMoves(r = this.pacman.r, c = this.pacman.c) {
    return DIR_ORDER.filter((d) => {
      const n = this.neighbor(r, c, d);
      return this.walkable(n.r, n.c);
    });
  }

  // BFS over Pac-Man-walkable tiles. `blocked` tiles are never entered.
  distances(from, blocked = null) {
    const dist = new Map([[key(from.r, from.c), 0]]);
    const queue = [from];
    while (queue.length) {
      const cur = queue.shift();
      const d = dist.get(key(cur.r, cur.c));
      for (const dir of DIR_ORDER) {
        const n = this.neighbor(cur.r, cur.c, dir);
        const k = key(n.r, n.c);
        if (dist.has(k) || (blocked && blocked.has(k)) || !this.walkable(n.r, n.c)) continue;
        dist.set(k, d + 1);
        queue.push(n);
      }
    }
    return dist;
  }

  dangerousGhosts() {
    return this.ghosts.filter((g) => !g.frightened && !g.inHouse);
  }

  // A decision point is anywhere Pac-Man has a real choice: a junction, a
  // corner or dead end, the very first move, or a nearby ghost that might
  // warrant turning back.
  needsDecision() {
    const { r, c, dir } = this.pacman;
    const legal = this.legalMoves();
    if (!dir) return true;
    const forward = legal.filter((d) => d !== OPPOSITE[dir]);
    if (forward.length !== 1 || forward[0] !== dir) return true;
    const dist = this.distances({ r, c });
    return this.dangerousGhosts().some((g) => (dist.get(key(g.r, g.c)) ?? 99) <= 4);
  }

  autoDirection() {
    const legal = this.legalMoves();
    const { dir } = this.pacman;
    if (dir && legal.includes(dir)) return dir;
    const forward = legal.filter((d) => d !== OPPOSITE[dir]);
    return forward[0] ?? legal[0] ?? null;
  }

  step(dir) {
    if (this.status !== 'playing') return [];
    const events = [];
    const pac = this.pacman;
    pac.prev = { r: pac.r, c: pac.c };
    for (const g of this.ghosts) g.prev = { r: g.r, c: g.c };

    if (dir && this.legalMoves().includes(dir)) {
      const n = this.neighbor(pac.r, pac.c, dir);
      pac.r = n.r;
      pac.c = n.c;
      pac.dir = dir;
    } else if (dir) {
      pac.dir = dir; // bumping a wall: face it, stay put
    }

    const k = key(pac.r, pac.c);
    if (this.dots.delete(k)) {
      this.score += 10;
      events.push({ type: 'dot' });
    } else if (this.pellets.delete(k)) {
      this.score += 50;
      this.powerTicks = POWER_TICKS;
      this.ghostCombo = 0;
      for (const g of this.ghosts) {
        if (g.inHouse) continue;
        g.frightened = true;
        if (g.dir) g.dir = OPPOSITE[g.dir];
      }
      events.push({ type: 'power' });
    }

    if (this.resolveCollisions(events)) return this.finishStep(events);

    this.advanceMode();
    for (const g of this.ghosts) this.moveGhost(g);

    this.resolveCollisions(events);
    return this.finishStep(events);
  }

  finishStep(events) {
    this.tick++;
    if (this.powerTicks > 0 && --this.powerTicks === 0) {
      for (const g of this.ghosts) g.frightened = false;
    }
    if (this.status === 'playing' && this.dotsRemaining === 0) {
      this.status = 'won';
      events.push({ type: 'won' });
    } else if (this.status === 'playing' && this.tick >= this.maxTicks) {
      this.status = 'timeout';
      events.push({ type: 'timeout' });
    }
    return events;
  }

  advanceMode() {
    if (this.powerTicks > 0) return; // mode timer pauses while frightened
    this.modeTicks++;
    if (this.modeTicks >= MODE_SCHEDULE[this.modeIndex][1]) {
      this.modeIndex++;
      this.modeTicks = 0;
      for (const g of this.ghosts) if (!g.inHouse && g.dir) g.dir = OPPOSITE[g.dir];
    }
  }

  // Returns true if Pac-Man died.
  resolveCollisions(events) {
    const pac = this.pacman;
    for (const g of this.ghosts) {
      const same = g.r === pac.r && g.c === pac.c;
      const swapped = g.r === pac.prev.r && g.c === pac.prev.c && g.prev.r === pac.r && g.prev.c === pac.c;
      if (!same && !swapped) continue;
      if (g.frightened) {
        this.ghostCombo++;
        const points = 100 * 2 ** this.ghostCombo;
        this.score += points;
        events.push({ type: 'eat-ghost', ghost: g.name, points });
        Object.assign(g, { r: g.start.r, c: g.start.c, prev: { ...g.start }, dir: null, inHouse: true, frightened: false, releaseTick: this.tick + 10 });
        continue;
      }
      this.lives--;
      events.push({ type: 'death', ghost: g.name });
      if (this.lives <= 0) {
        this.status = 'lost';
        events.push({ type: 'lost' });
      } else {
        this.resetPositions();
      }
      return true;
    }
    return false;
  }

  ghostTarget(g) {
    const pac = this.pacman;
    if (g.inHouse) return GHOST_EXIT;
    if (this.mode === 'scatter') return g.scatter;
    if (g.name === 'Pinky') {
      const d = DIRS[pac.dir ?? 'left'];
      return { r: pac.r + 4 * d.dr, c: pac.c + 4 * d.dc };
    }
    if (g.name === 'Clyde') {
      const dist2 = (g.r - pac.r) ** 2 + (g.c - pac.c) ** 2;
      return dist2 > 64 ? pac : g.scatter;
    }
    return pac;
  }

  moveGhost(g) {
    if (g.inHouse && this.tick < g.releaseTick) return;
    // Ghosts are a touch slower than Pac-Man, and much slower when frightened.
    if (g.frightened ? this.tick % 2 === 1 : this.tick % 5 === 4) return;

    let options = DIR_ORDER.filter((d) => {
      if (g.dir && d === OPPOSITE[g.dir]) return false;
      const n = this.neighbor(g.r, g.c, d);
      return this.walkable(n.r, n.c, g);
    });
    if (!options.length) {
      options = DIR_ORDER.filter((d) => {
        const n = this.neighbor(g.r, g.c, d);
        return this.walkable(n.r, n.c, g);
      });
    }
    if (!options.length) return;

    let choice;
    if (g.frightened) {
      choice = options[Math.floor(this.rng() * options.length)];
    } else {
      const t = this.ghostTarget(g);
      let best = Infinity;
      for (const d of options) {
        const n = this.neighbor(g.r, g.c, d);
        const dist = (n.r - t.r) ** 2 + (n.c - t.c) ** 2;
        if (dist < best) {
          best = dist;
          choice = d;
        }
      }
    }
    const n = this.neighbor(g.r, g.c, choice);
    g.r = n.r;
    g.c = n.c;
    g.dir = choice;
    if (g.inHouse && g.r === GHOST_EXIT.r && g.c === GHOST_EXIT.c) g.inHouse = false;
  }

  // ASCII snapshot for the model. Pac-Man is @; ghosts are uppercase
  // initials when dangerous, lowercase when frightened.
  board() {
    const rows = LAYOUT.map((row) => row.replace(/[P.o]/g, ' ').replace(/_/g, '#').replace(/G/g, ' ').split(''));
    for (const k of this.dots) rows[Math.floor(k / COLS)][k % COLS] = '.';
    for (const k of this.pellets) rows[Math.floor(k / COLS)][k % COLS] = 'o';
    for (const g of this.ghosts) {
      const ch = g.name[0];
      rows[g.r][g.c] = g.frightened ? ch.toLowerCase() : ch;
    }
    rows[this.pacman.r][this.pacman.c] = '@';
    return rows.map((r) => r.join(''));
  }

  static key = key;
}
