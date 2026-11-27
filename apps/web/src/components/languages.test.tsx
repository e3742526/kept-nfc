/**
 * #450: the language pickers search by own name, English name and the interface's name for a
 * language, and typing never changes the language until one is chosen.
 */
import { render, screen, within } from '@testing-library/react';
import US from 'country-flag-icons/react/3x2/US';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { LanguagesMultiSelect } from '@/components/languages';
import { renderUI } from '@/test/render';

function Several({ start, onChange }: { start: string[]; onChange?: (tags: string[]) => void }) {
  const [value, setValue] = useState(start);
  return (
    <>
      <LanguagesMultiSelect
        label="Languages spoken here"
        value={value}
        onChange={(tags) => {
          onChange?.(tags);
          setValue(tags);
        }}
      />
      <button type="button">Elsewhere</button>
    </>
  );
}

const optionNames = () =>
  within(screen.getByRole('listbox'))
    .getAllByRole('option')
    .map((o) => o.textContent);

describe('LanguagesMultiSelect with the keyboard', () => {
  it('adds the first match with Enter alone', async () => {
    const onChange = vi.fn();
    const { user } = await renderUI(<Several start={['en']} onChange={onChange} />);
    await user.tab();
    await user.keyboard('german{Enter}');
    expect(onChange).toHaveBeenCalledExactlyOnceWith(['en', 'de']);
  });
});

describe('LanguagesMultiSelect', () => {
  it('shows every chosen language, with its flag, and describes the box with them', async () => {
    await renderUI(<Several start={['fr', 'ar-EG', 'pt']} />);
    const box = screen.getByRole('combobox', { name: 'Languages spoken here' });
    expect(box).toHaveValue('');
    const described = document.getElementById(box.getAttribute('aria-describedby') ?? '');
    expect(described).toHaveTextContent('Français');
    expect(described).toHaveTextContent('العربية');
    expect(described?.querySelectorAll('svg[data-flag]')).toHaveLength(2);
    expect(within(described as HTMLElement).getByText('العربية')).toHaveAttribute('dir', 'rtl');
  });

  it('searches, and chooses several without closing', async () => {
    const onChange = vi.fn();
    const { user } = await renderUI(<Several start={[]} onChange={onChange} />);
    const box = screen.getByRole('combobox');
    await user.click(box);
    expect(screen.getByRole('listbox')).toHaveAttribute('aria-multiselectable', 'true');
    await user.keyboard('german');
    expect(optionNames()).toEqual(['Deutsch']);
    await user.click(screen.getByRole('option', { name: 'Deutsch' }));
    expect(onChange).toHaveBeenLastCalledWith(['de']);
    expect(screen.getByRole('listbox')).toBeInTheDocument();
  });

  it('removes one from the list, keeping stored region tags and other tags', async () => {
    const onChange = vi.fn();
    const { user } = await renderUI(<Several start={['ar-EG', 'fr', 'pt']} onChange={onChange} />);
    await user.click(screen.getByRole('combobox'));
    await user.click(screen.getByRole('option', { name: 'Français' }));
    expect(onChange).toHaveBeenLastCalledWith(['ar-EG', 'pt']);
  });

  it('keeps the choices when the box is cleared and left, and empties the box', async () => {
    const onChange = vi.fn();
    const { user } = await renderUI(<Several start={['it']} onChange={onChange} />);
    const box = screen.getByRole('combobox');
    await user.click(box);
    await user.keyboard('fre');
    await user.clear(box);
    await user.click(screen.getByText('Elsewhere'));
    expect(box).toHaveValue('');
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByText('Italiano')).toBeInTheDocument();
  });

  it('empties the box when left with a query in it', async () => {
    const { user } = await renderUI(<Several start={['it']} />);
    const box = screen.getByRole('combobox');
    await user.click(box);
    await user.keyboard('fre');
    await user.click(screen.getByText('Elsewhere'));
    expect(box).toHaveValue('');
  });
});

describe('English interface', () => {
  it('shows no language picker, and English has the US flag', async () => {
    {
      const languages = await import('@/components/languages');
      const { renderUI: renderFresh } = await import('@/test/render');
      const { container } = await renderFresh(
        <>
          <languages.LanguageSelect label="Language" value="en" onChange={() => {}} />
          <languages.LanguageName locale="en" />
        </>,
      );
      expect(screen.queryByRole('combobox', { name: 'Language' })).toBeNull();
      const { container: us } = render(<US />);
      expect(container.querySelector('[data-flag="en"]')?.innerHTML).toBe(
        us.querySelector('svg')?.innerHTML,
      );
      // A location's AI languages still choose from every language.
      expect(languages.LANGUAGES).toHaveLength(8);
      expect(languages.UI_LANGUAGES.map(({ id }) => id)).toEqual(['en']);
    }
  });
});
