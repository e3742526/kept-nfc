import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { groupName, integrationGroups, integrations, wordsOf } from './data/integrations';
import { LANGS } from './i18n';
import * as words from './words';

// No middle dot in any language (#478): a comma, a colon or separate items instead.
const MIDDLE_DOT = '·';

function strings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (value && typeof value === 'object') return Object.values(value).flatMap(strings);
  return [];
}

describe('the components’ words', () => {
  const tables = Object.entries(words).filter(([name]) => name !== 'default');

  it.each(tables)('%s has words for every language', (_name, table) => {
    expect(Object.keys(table)).toEqual(['en']);
  });

  it.each(tables)('%s has no middle dot in any language', (_name, table) => {
    for (const lang of LANGS) {
      const t = (table as Record<string, unknown>)[lang];
      const texts = typeof t === 'function' ? [(t as (c: string) => string)('0')] : strings(t);
      for (const text of texts) expect(text, lang).not.toContain(MIDDLE_DOT);
    }
  });

  it('keeps the hero’s three facts and the integrations link’s number in every language', () => {
    for (const lang of LANGS) {
      expect(words.hero[lang]?.facts, lang).toHaveLength(3);
      expect(words.integrations[lang]?.all('37'), lang).toContain('37');
      expect(words.tryMap[lang]?.credit, lang).toHaveLength(2);
    }
  });
});

describe('the integrations’ words', () => {
  it('keeps the English copy for every group and entry', () => {
    for (const group of integrationGroups) expect(groupName(group, 'en')).toMatch(/\S/);
    for (const item of integrations) {
      expect(wordsOf(item, 'en').name).toMatch(/\S/);
      expect(wordsOf(item, 'en').body).toMatch(/\S/);
    }
  });
});

it('keeps the API reference in the documentation sidebar', () => {
  const config = readFileSync(new URL('../astro.config.mjs', import.meta.url), 'utf8');
  expect(config).toContain("sidebar: { label: 'API reference' }");
});
