import { normalize } from '@kept/shared';
import { plural } from '@lingui/core/macro';
import { Trans, useLingui } from '@lingui/react/macro';
import { Check } from 'lucide-react';
import { useState } from 'react';
import { Checkbox } from 'react-aria-components';
import { Button } from '@/components/ui/button';
import type { PhotoSuggestion } from './capture-ai';
import { equivalentCategory } from './category-picker';

type Category = { id: string; name: string; colour: string | null };

/** One field the AI would fill on the Add form. A category without `tag` is created on accept. */
export type DetailRow = {
  key: string;
  field: 'name' | 'quantity' | 'note' | 'category';
  value: string;
  /** What the field holds now, when accepting replaces it. */
  replaces?: string;
  /** Notes already have text: accepting adds a line. */
  appends?: true;
  tag?: Category;
};

export type DetailDraft = {
  name: string;
  quantity: string;
  note: string;
  tags: readonly string[];
};

/** The item the photos show most: seen in the most photos, the first on a tie. */
export function leadSuggestion(items: readonly PhotoSuggestion[]): PhotoSuggestion | undefined {
  return items.reduce<PhotoSuggestion | undefined>(
    (best, item) =>
      !best || (item.evidence?.length ?? 0) > (best.evidence?.length ?? 0) ? item : best,
    undefined,
  );
}

/**
 * What the AI reading would change on the Add form, one row per field: only values that differ
 * from what is there. A category matches an existing one by name (plural or not); one that matches
 * none is offered only when this phone can create it.
 */
export function detailRowsFor(
  item: PhotoSuggestion,
  draft: DetailDraft,
  known: readonly Category[],
  canCreate: boolean,
): DetailRow[] {
  const rows: DetailRow[] = [];
  const name = item.name.trim();
  if (name && normalize(name) !== normalize(draft.name)) {
    const current = draft.name.trim();
    rows.push({ key: 'name', field: 'name', value: name, ...(current && { replaces: current }) });
  }
  if (item.quantity && String(item.quantity) !== draft.quantity.trim()) {
    const current = draft.quantity.trim();
    rows.push({
      key: 'quantity',
      field: 'quantity',
      value: String(item.quantity),
      ...(current && { replaces: current }),
    });
  }
  const description = item.description?.trim();
  if (
    description &&
    normalize(description) !== normalize(name) &&
    !normalize(draft.note).includes(normalize(description))
  )
    rows.push({
      key: 'note',
      field: 'note',
      value: description,
      ...(draft.note.trim() && { appends: true as const }),
    });
  const seen = new Set<string>();
  for (const category of item.categories ?? []) {
    const value = category.trim();
    const tag = known.find((candidate) => equivalentCategory(candidate.name, value));
    const key = `category:${tag?.id ?? normalize(value)}`;
    if (!value || seen.has(key) || (tag && draft.tags.includes(tag.id)) || (!tag && !canCreate))
      continue;
    seen.add(key);
    rows.push({ key, field: 'category', value: tag?.name ?? value, ...(tag && { tag }) });
  }
  return rows;
}

/**
 * The AI's suggestions for the Add form, itemized by field: tick some and use them, or accept
 * them all. Nothing is saved until the item is.
 */
export function DetailSuggestions({
  rows,
  others,
  disabled,
  onApply,
  onDismiss,
  onReviewItems,
}: {
  rows: readonly DetailRow[];
  /** Other items the photos seem to show besides this one. */
  others: number;
  disabled: boolean;
  onApply: (rows: DetailRow[]) => void;
  onDismiss: () => void;
  onReviewItems?: () => void;
}) {
  const { t } = useLingui();
  const [ticked, setTicked] = useState<ReadonlySet<string>>(new Set());
  const chosen = rows.filter(({ key }) => ticked.has(key));
  const selected = chosen.length;
  const labels = {
    name: t`Description`,
    quantity: t`Quantity`,
    note: t`Notes`,
    category: t`Category`,
  };

  return (
    <div className="kept-card grid gap-3">
      <h4 className="m-0 font-semibold">
        <Trans>Suggested details</Trans>
      </h4>
      {rows.length === 0 ? (
        <p role="status" className="m-0 text-small text-ink-2">
          <Trans>Nothing new to suggest.</Trans>
        </p>
      ) : (
        <ul className="m-0 grid list-none gap-1 p-0" aria-label={t`Suggestions`}>
          {rows.map((row) => {
            const current = row.replaces;
            return (
              <li key={row.key}>
                <Checkbox
                  className="flex min-h-11 items-start gap-2 text-start"
                  isSelected={ticked.has(row.key)}
                  isDisabled={disabled}
                  onChange={(on) =>
                    setTicked((previous) => {
                      const next = new Set(previous);
                      if (on) next.add(row.key);
                      else next.delete(row.key);
                      return next;
                    })
                  }
                >
                  {({ isSelected }) => (
                    <>
                      <span aria-hidden className="pt-0.5">
                        {isSelected ? '☑' : '☐'}
                      </span>
                      <span className="grid min-w-0 gap-0.5">
                        <span className="text-small text-ink-2">
                          {row.field === 'category' && !row.tag
                            ? t`New category`
                            : labels[row.field]}
                        </span>
                        <bdi className="break-words font-semibold">{row.value}</bdi>
                        {current && (
                          <span className="text-small text-ink-2">{t`Replaces: ${current}`}</span>
                        )}
                        {row.appends && (
                          <span className="text-small text-ink-2">
                            <Trans>Adds to notes</Trans>
                          </span>
                        )}
                      </span>
                    </>
                  )}
                </Checkbox>
              </li>
            );
          })}
        </ul>
      )}
      {others > 0 && (
        <p className="m-0 text-small text-ink-2">
          {plural(others, {
            one: 'The photos may show # more item.',
            other: 'The photos may show # more items.',
          })}
        </p>
      )}
      {onReviewItems && (
        <Button variant="secondary" isDisabled={disabled} onPress={onReviewItems}>
          {others > 0 ? <Trans>Review multiple items</Trans> : <Trans>Review item</Trans>}
        </Button>
      )}
      <div className="flex flex-wrap gap-2">
        {rows.length > 0 && (
          <Button isDisabled={disabled} onPress={() => onApply([...rows])}>
            <Check size={16} aria-hidden />
            <Trans>Accept all</Trans>
          </Button>
        )}
        {rows.length > 0 && (
          <Button
            variant="secondary"
            isDisabled={disabled || chosen.length === 0}
            onPress={() => onApply(chosen)}
          >
            {plural(selected, { one: 'Use # selected', other: 'Use # selected' })}
          </Button>
        )}
        <Button variant="ghost" isDisabled={disabled} onPress={onDismiss}>
          <Trans>Dismiss</Trans>
        </Button>
      </div>
    </div>
  );
}
