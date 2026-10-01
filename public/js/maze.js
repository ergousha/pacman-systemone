// 19 x 21 maze.
//   #  wall          .  dot            o  power pellet
//   _  void (off-maze, not walkable)   ' ' empty corridor
//   -  ghost-house door (ghosts only)  G  ghost-house floor
//   P  Pac-Man start
// Row 9 has open ends on both sides: a wrap-around tunnel.
export const LAYOUT = [
  '###################',
  '#........#........#',
  '#o##.###.#.###.##o#',
  '#.................#',
  '#.##.#.#####.#.##.#',
  '#....#...#...#....#',
  '####.### # ###.####',
  '___#.#       #.#___',
  '####.# ##-## #.####',
  '    .  #GGG#  .    ',
  '####.# ##### #.####',
  '___#.#       #.#___',
  '####.# ##### #.####',
  '#........#........#',
  '#.##.###.#.###.##.#',
  '#o.#.....P.....#.o#',
  '##.#.#.#####.#.#.##',
  '#....#...#...#....#',
  '#.######.#.######.#',
  '#.................#',
  '###################',
];

export const ROWS = LAYOUT.length;
export const COLS = LAYOUT[0].length;

export const DIRS = {
  up: { dr: -1, dc: 0 },
  down: { dr: 1, dc: 0 },
  left: { dr: 0, dc: -1 },
  right: { dr: 0, dc: 1 },
};

// Classic ghost tie-break order.
export const DIR_ORDER = ['up', 'left', 'down', 'right'];

export const OPPOSITE = { up: 'down', down: 'up', left: 'right', right: 'left' };

export const GHOST_EXIT = { r: 7, c: 9 };

export const GHOSTS = [
  { name: 'Blinky', color: '#c8584f', start: { r: 7, c: 9 }, inHouse: false, releaseTick: 0, scatter: { r: -2, c: 18 } },
  { name: 'Pinky', color: '#d884b4', start: { r: 9, c: 9 }, inHouse: true, releaseTick: 8, scatter: { r: -2, c: 0 } },
  { name: 'Clyde', color: '#d98c55', start: { r: 9, c: 10 }, inHouse: true, releaseTick: 30, scatter: { r: 22, c: 0 } },
];
