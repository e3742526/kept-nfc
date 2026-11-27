import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { emptyTranslations, newIds, parsePo } from './check-i18n-extract.mjs';

const PO = `msgid ""
msgstr ""
"Language: ar\\n"

#: src/a.tsx
msgid "Save"
msgstr "حفظ"

#: src/b.tsx
msgctxt "Display button"
msgid "Last seen"
msgstr ""

#: src/c.tsx
msgid ""
"A long "
"message"
msgstr ""
"رسالة "
"طويلة"

#~ msgid "Gone"
#~ msgstr "ذهب"
`;

describe('parsePo', () => {
  it('reads live entries, contexts and multi-line strings, and skips the header and obsolete ones', () => {
    const m = parsePo(PO);
    expect([...m.keys()]).toEqual(['Save', 'Display button\u0004Last seen', 'A long message']);
    expect(m.get('Save')).toBe('حفظ');
    expect(m.get('Display button\u0004Last seen')).toBe('');
    expect(m.get('A long message')).toBe('رسالة طويلة');
  });

  it('unescapes quotes and newlines', () => {
    const m = parsePo('msgid "Say \\"hi\\"\\n"\nmsgstr "قل \\"أهلا\\"\\n"\n');
    expect(m.get('Say "hi"\n')).toBe('قل "أهلا"\n');
  });
});

describe('newIds and emptyTranslations', () => {
  const committed = new Map([
    ['a', 'أ'],
    ['b', ''],
  ]);
  it('flags an id the extract adds', () => {
    expect(
      newIds(
        new Map([
          ['a', ''],
          ['c', ''],
        ]),
        committed,
      ),
    ).toEqual(['c']);
  });
  it('flags an empty translation only for ids the source still uses', () => {
    expect(
      emptyTranslations(
        new Map([
          ['a', ''],
          ['b', ''],
        ]),
        committed,
      ),
    ).toEqual(['b']);
    expect(emptyTranslations(new Map([['a', '']]), committed)).toEqual([]);
  });
});

it('keeps English as the only committed app catalogue', () => {
  const root = new URL('../apps/web/src/locales/', import.meta.url);
  const languages = readdirSync(root).filter((locale) =>
    existsSync(new URL(`${locale}/messages.po`, root)),
  );
  expect(languages).toEqual(['en']);
  expect(parsePo(readFileSync(new URL('en/messages.po', root), 'utf8')).size).toBeGreaterThan(1000);
});
