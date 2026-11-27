import { describe, expect, it } from 'vitest';
import { resolveLabelTemplate, supportsDrawerTemplate } from './thermal-labels.js';

describe('built-in label templates', () => {
  it('resolves supported drawers and falls back consistently for other stock', () => {
    expect(resolveLabelTemplate('thermal_50x20', { template: 'drawer' })).toBe('drawer');
    expect(resolveLabelTemplate('thermal_40x20', { template: 'drawer' })).toBe('standard');
    expect(resolveLabelTemplate('thermal_50x20', {})).toBe('standard');
    expect(supportsDrawerTemplate('letter_writable_12')).toBe(false);
  });
});
