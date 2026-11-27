import { AMOUNT_STRING } from '@kept/shared';

/** At most this many lines become items when a box is created with its contents listed. */
export const BOX_CONTENTS_LIMIT = 50;

export type ContentLine = { name: string; quantity?: string };

const LEADING = /^(\d+(?:\.\d+)?)\s*[x×]\s+(.+)$/i;
const TRAILING = /^(.+?)\s+[x×]\s*(\d+(?:\.\d+)?)$/i;

/**
 * The items typed into a new box's contents, one per line. A count goes before or after the
 * name with an x ("3 x HDMI cable", "HDMI cable x3"), so a number that is part of a name
 * ("2020 calendar", "4K monitor") stays in the name. Blank lines are skipped; names are cut to
 * 200 characters, the description limit.
 */
export function parseBoxContents(text: string): ContentLine[] {
  const lines: ContentLine[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim().replace(/^[-*•]\s*/, '');
    if (!line) continue;
    const leading = LEADING.exec(line);
    const trailing = leading ? null : TRAILING.exec(line);
    const count = leading?.[1] ?? trailing?.[2];
    const name = (leading?.[2] ?? trailing?.[1] ?? line).trim().slice(0, 200);
    lines.push(
      count && AMOUNT_STRING.test(count) && Number(count) > 0 && name
        ? { name, quantity: count }
        : { name: line.slice(0, 200) },
    );
    if (lines.length === BOX_CONTENTS_LIMIT) break;
  }
  return lines;
}
