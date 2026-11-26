/**
 * A roll of bin photos, sorted into bins. People photograph storage in one pass: the bin's label
 * (its QR code), then what is inside and around it, then the next bin's label. The label photos
 * divide the roll; this works out which bin every other photo belongs to, so a batch import can
 * show the plan, let the person fix it, and file each photo with its bin.
 *
 * - Photos are taken in time order (`takenAt`, then the order given; undated ones last).
 * - A photo whose codes include a bin code is a label photo of that bin.
 * - Photos between two label photos of the same bin are that bin's.
 * - Photos after the last label photo are its bin's; photos before the first are the first
 *   bin's, flagged (`guessed`).
 * - Photos between label photos of two different bins are cut at the longest pause between
 *   them: before it they are the earlier bin's, after it the later one's. All of them are flagged,
 *   since a person may shoot a bin's contents before its label.
 *
 * Pure: decoding the codes and the times is the caller's.
 */

export type BinPhoto = {
  /** The caller's handle for the photo (a file name, an index). */
  key: string;
  /** When it was taken, in ms since the epoch; null when unknown. */
  takenAt: number | null;
  /** Every code read from it (QR payloads, printed text), in any order. */
  codes: readonly string[];
};

export type BinPhotoGroup = {
  code: string;
  /** Every photo of the bin, in roll order. */
  photos: string[];
  /** The ones the code was read from. */
  labelPhotos: string[];
  /** The ones placed by a guess, for the person to check. */
  guessed: string[];
};

export type BinPhotoPlan = {
  groups: BinPhotoGroup[];
  /** Photos with no bin: only when no label was read at all. */
  unassigned: string[];
};

export type GroupOptions = {
  /** Which codes name a bin; any non-empty code by default. */
  isBinCode?: (code: string) => boolean;
};

export function groupBinPhotos(
  input: readonly BinPhoto[],
  { isBinCode = (c) => c.trim() !== '' }: GroupOptions = {},
): BinPhotoPlan {
  const roll = input
    .map((p, i) => ({ p, i }))
    .sort((x, y) => time(x.p) - time(y.p) || x.i - y.i)
    .map(({ p }) => ({ ...p, code: p.codes.find(isBinCode) ?? null }));

  const anchors = roll.flatMap((p, i) => (p.code === null ? [] : [i]));
  if (anchors.length === 0) return { groups: [], unassigned: roll.map((p) => p.key) };

  const binOf: string[] = new Array(roll.length);
  const guessed = new Set<number>();
  const assign = (from: number, to: number, code: string, guess: boolean) => {
    for (let k = from; k < to; k++) {
      binOf[k] = code;
      if (guess) guessed.add(k);
    }
  };

  const first = anchors[0] as number;
  const last = anchors[anchors.length - 1] as number;
  assign(0, first, roll[first]?.code as string, true);
  for (const [n, a] of anchors.entries()) {
    binOf[a] = roll[a]?.code as string;
    const b = anchors[n + 1];
    if (b === undefined || b === a + 1) continue;
    const before = roll[a]?.code as string;
    const after = roll[b]?.code as string;
    if (before === after) {
      assign(a + 1, b, before, false);
      continue;
    }
    // Cut at the longest pause; on a tie, the latest one (contents usually follow their label).
    let cut = b;
    let longest = -1;
    for (let k = a + 1; k <= b; k++) {
      const gap = time(roll[k]) - time(roll[k - 1]);
      if (Number.isFinite(gap) && gap >= longest) {
        longest = gap;
        cut = k;
      }
    }
    assign(a + 1, cut, before, true);
    assign(cut, b, after, true);
  }
  assign(last + 1, roll.length, roll[last]?.code as string, false);

  const groups = new Map<string, BinPhotoGroup>();
  for (const [k, p] of roll.entries()) {
    const code = binOf[k] as string;
    let g = groups.get(code);
    if (!g) {
      g = { code, photos: [], labelPhotos: [], guessed: [] };
      groups.set(code, g);
    }
    g.photos.push(p.key);
    if (p.code !== null) g.labelPhotos.push(p.key);
    if (guessed.has(k)) g.guessed.push(p.key);
  }
  return { groups: [...groups.values()], unassigned: [] };
}

const time = (p: { takenAt: number | null } | undefined) => p?.takenAt ?? Number.POSITIVE_INFINITY;
