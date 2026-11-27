import { describe, expect, it } from 'vitest';
import { BOX_CONTENTS_LIMIT, parseBoxContents } from './box-contents';

describe('parseBoxContents', () => {
  it('reads one item per line, with a count before or after an x', () => {
    expect(
      parseBoxContents(
        '3 x HDMI cable\n\n  Power strip x2 \n- 2020 calendar\n4K monitor\n2 × USB hub',
      ),
    ).toEqual([
      { name: 'HDMI cable', quantity: '3' },
      { name: 'Power strip', quantity: '2' },
      { name: '2020 calendar' },
      { name: '4K monitor' },
      { name: 'USB hub', quantity: '2' },
    ]);
  });

  it('keeps a zero count in the name and stops at the limit', () => {
    expect(parseBoxContents('0 x spare fuse')).toEqual([{ name: '0 x spare fuse' }]);
    const many = Array.from({ length: BOX_CONTENTS_LIMIT + 5 }, (_, i) => `Item ${i}`).join('\n');
    expect(parseBoxContents(many)).toHaveLength(BOX_CONTENTS_LIMIT);
  });
});
