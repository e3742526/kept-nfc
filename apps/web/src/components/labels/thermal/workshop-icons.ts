import { type PrintRect, WORKSHOP_ICON_CODES, type WorkshopIcon } from '@kept/shared';

// Nine-dot silhouettes keep strokes legible on the small roll without loading image assets.
const glyphs: Record<WorkshopIcon, string> = {
  BIT: '..#...#../...#.#.../....#..../...#.#.../..#...#../...###.../...###.../...###.../...###...',
  HEX: '..#####../.#.....#./#.......#/#.......#/#.......#/#.......#/#.......#/.#.....#./..#####..',
  BLT: '..#####../..#####../....#..../...###.../....#..../...###.../....#..../...###.../....#....',
  TOL: '##...##../#....##../##..##.../.####..../...##..../..##...../.##....../##......./#........',
  CAB: '##.....##/##.....##/.#.....#./.##...##./..#####../....#..../....#..../...##..../...#.....',
  ELE: '.....##../....##.../...##..../..##...../.#######./....##.../...##..../..##...../.##......',
  MEA: '........./#########/##.#.#.##/##...#.##/##.#...##/#########/........./........./.........',
  ROT: '..#####../.##...##./##.....##/#...#...#/#..###..#/#...#...#/##.....##/.##...##./..#####..',
  ADH: '....#..../...##..../...##..../..####.../..#..#.../.##..##../.#....#../.######../.######..',
  WSH: '..#####../.#######./#########/###...###/###...###/###...###/#########/.#######./..#####..',
  DRL: '....#..../...###.../..##.#.../..#.##.../..##.#.../..#.##.../...###.../...###.../...###...',
  MSC: '........./........./........./##.##.##./##.##.##./........./........./........./.........',
};

const rules: [WorkshopIcon, RegExp][] = [
  ['HEX', /\b(hex\s+bits?|allen|torx)\b/i],
  ['DRL', /\b(drill\s+bits?|drills?|augers?)\b/i],
  ['BIT', /\b(driver\s+bits?|bits?|phillips|pozidriv|robertson)\b/i],
  ['WSH', /\b(washers?|spacers?|shims?)\b/i],
  ['ROT', /\b(rotary|cut[- ]?off|abrasives?|discs?)\b/i],
  ['ADH', /\b(adhesives?|glue|superglue|epoxy|sealants?)\b/i],
  ['MEA', /\b(measuring|measurement|calipers?|rulers?|gauges?)\b/i],
  ['CAB', /\b(cables?|cords?|zip ties?|usb|hdmi)\b/i],
  ['ELE', /\b(electric\w*|terminals?|fuses?|resistors?|switches?|wire)\b/i],
  ['BLT', /\b(nuts?|bolts?|fasteners?|screws?|rivets?)\b/i],
  ['TOL', /\b(tools?|sockets?|wrenches?|pliers?|adapters?)\b/i],
];

export function suggestWorkshopIcon(
  identifier: string,
  ...categoryAndContents: string[]
): WorkshopIcon {
  const prefix = identifier.split('-')[0]?.toUpperCase();
  const category = categoryAndContents[0]?.trim().toUpperCase();
  const description = categoryAndContents
    .join(' ')
    .normalize('NFKD')
    .replace(/\p{Mark}/gu, '')
    .replace(/[\p{Pd}_]+/gu, ' ');
  return (
    WORKSHOP_ICON_CODES.find((key) => key === category) ??
    WORKSHOP_ICON_CODES.find((key) => key === prefix) ??
    rules.find(([, matches]) => matches.test(description))?.[0] ??
    'MSC'
  );
}

export function workshopInk(ink: PrintRect[], icon: WorkshopIcon, box: PrintRect) {
  const dot = Math.floor(Math.min(box.w, box.h) / 9);
  if (dot < 1) return;
  const x = box.x + Math.floor((box.w - 9 * dot) / 2);
  const y = box.y + Math.floor((box.h - 9 * dot) / 2);
  glyphs[icon].split('/').forEach((line, row) => {
    for (const run of line.matchAll(/#+/g)) {
      ink.push({ x: x + run.index * dot, y: y + row * dot, w: run[0].length * dot, h: dot });
    }
  });
}
