import { newId, normalize, TAG_LIMITS } from '@kept/shared';
import { Trans, useLingui } from '@lingui/react/macro';
import { useEffect, useState } from 'react';
import { Checkbox } from 'react-aria-components';
import { inventoryPaths, qs } from '@/api/inventory/paths';
import type { CreateRegistryResult, Page, Tag, ThingTag } from '@/api/inventory/types';
import { useErrorText } from '@/components/page';
import { Button } from '@/components/ui/button';
import { useConfirm } from '@/components/ui/confirm';
import { TextField } from '@/components/ui/text-field';
import { usePlatform } from './adapters';
import type { Connection } from './bridge';

export function equivalentCategory(first: string, second: string): boolean {
  const a = normalize(first);
  const b = normalize(second);
  const plural = (word: string) =>
    word.endsWith('y')
      ? `${word.slice(0, -1)}ies`
      : /(?:ch|sh|s|x|z)$/.test(word)
        ? `${word}es`
        : `${word}s`;
  return (
    a === b || (/^[a-z ]+$/.test(a) && /^[a-z ]+$/.test(b) && (plural(a) === b || plural(b) === a))
  );
}

type Category = Pick<ThingTag, 'id' | 'name' | 'colour'>;
const recentCategories = new Map<string, Category[]>();

export function CategoryPicker({
  connection,
  accountId,
  online,
  canCreate,
  options,
  selected,
  suggestions = [],
  disabled,
  onChange,
}: {
  connection: Connection;
  accountId: string;
  online: boolean;
  canCreate: boolean;
  options: readonly Category[];
  selected: readonly string[];
  suggestions?: readonly string[];
  disabled?: boolean;
  onChange: (ids: string[]) => void;
}) {
  const { t } = useLingui();
  const { transport } = usePlatform();
  const confirm = useConfirm();
  const errorText = useErrorText();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [remote, setRemote] = useState<Tag[]>([]);
  const [known, setKnown] = useState<Category[]>([]);
  const [error, setError] = useState<unknown>();
  const [busy, setBusy] = useState(false);
  const query = search.trim();
  const path = inventoryPaths.accountRegistry(accountId, 'tags');
  const scope = JSON.stringify([
    connection.origin,
    connection.account,
    connection.epoch,
    accountId,
  ]);
  const recents = recentCategories.get(scope) ?? [];
  const categories = new Map(
    [...recents, ...options, ...known, ...remote].map((tag) => [tag.id, tag]),
  );
  const visible = [...categories.values()].filter(
    (tag) =>
      !query ||
      remote.some(({ id }) => id === tag.id) ||
      normalize(tag.name).includes(normalize(query)),
  );

  useEffect(() => {
    setRemote([]);
    if (!open || !online || !query) return;
    let active = true;
    const timer = window.setTimeout(() => {
      void transport
        .request<Page<Tag>>(connection, path + qs({ q: query, limit: 30 }))
        .then(({ items }) => {
          if (active) setRemote(items);
        })
        .catch((failed: unknown) => {
          if (active) setError(failed);
        });
    }, 150);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [connection, online, open, path, query, transport]);

  function pick(tag: Category) {
    if (selected.includes(tag.id) || selected.length >= TAG_LIMITS.perThing) return;
    recentCategories.set(scope, [tag, ...recents.filter(({ id }) => id !== tag.id)].slice(0, 8));
    setKnown((current) => [...current.filter(({ id }) => id !== tag.id), tag]);
    onChange([...selected, tag.id]);
  }

  async function create(name: string) {
    if (
      !name ||
      disabled ||
      busy ||
      !online ||
      !canCreate ||
      selected.length >= TAG_LIMITS.perThing
    )
      return;
    setBusy(true);
    setError(undefined);
    try {
      const { items } = await transport.request<Page<Tag>>(
        connection,
        path + qs({ q: name, limit: 30 }),
      );
      const equivalent = [...items, ...categories.values()].find((tag) =>
        equivalentCategory(tag.name, name),
      );
      if (equivalent) {
        pick(equivalent);
        return;
      }
      const near = items
        .slice(0, 5)
        .map((tag) => tag.name)
        .join(', ');
      if (
        !(await confirm({
          title: t`Create category ${name}?`,
          ...(near ? { body: t`Existing categories with similar names include ${near}.` } : {}),
          confirmLabel: t`Create`,
          cancelLabel: t`Cancel`,
        }))
      )
        return;
      const { item } = await transport.request<CreateRegistryResult<'tags'>>(connection, path, {
        method: 'POST',
        idempotencyKey: newId(),
        body: { name },
      });
      pick(item);
      setSearch('');
    } catch (failed) {
      setError(failed);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid gap-2">
      {selected.length > 0 && (
        <ul aria-label={t`Categories`} className="flex flex-wrap gap-1">
          {selected.map((id) => {
            const name = categories.get(id)?.name ?? t`Category`;
            return (
              <li key={id}>
                <Button
                  variant="secondary"
                  size="small"
                  isDisabled={disabled || busy}
                  aria-label={t`Remove category ${name}`}
                  onPress={() => onChange(selected.filter((key) => key !== id))}
                >
                  <bdi>{name}</bdi>
                  <span aria-hidden>×</span>
                </Button>
              </li>
            );
          })}
        </ul>
      )}
      <details open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
        <summary className="min-h-10 text-small font-semibold">
          <Trans>Categories</Trans>
        </summary>
        {open && (
          <div className="grid gap-2">
            <TextField
              label={t`Search categories`}
              value={search}
              onChange={setSearch}
              isDisabled={disabled || busy}
              inputProps={{ maxLength: 100 }}
            />
            {!online && (
              <p className="text-small text-ink-2">
                <Trans>Showing cached categories</Trans>
              </p>
            )}
            {!query && recents.length > 0 && (
              <div className="flex flex-wrap gap-1">
                <span className="w-full text-small">
                  <Trans>Recently used</Trans>
                </span>
                {recents
                  .filter(({ id }) => !selected.includes(id))
                  .map((tag) => (
                    <Button
                      key={tag.id}
                      variant="secondary"
                      size="small"
                      isDisabled={disabled || busy}
                      onPress={() => pick(tag)}
                    >
                      <bdi>{categories.get(tag.id)?.name ?? tag.name}</bdi>
                    </Button>
                  ))}
              </div>
            )}
            <div className="grid max-h-48 gap-1 overflow-auto">
              {(query ? visible : visible.slice(0, 30)).map((tag) => (
                <Checkbox
                  key={tag.id}
                  className="flex min-h-10 items-center gap-2 text-start"
                  isSelected={selected.includes(tag.id)}
                  isDisabled={
                    disabled ||
                    busy ||
                    (!selected.includes(tag.id) && selected.length >= TAG_LIMITS.perThing)
                  }
                  onChange={(checked) =>
                    checked ? pick(tag) : onChange(selected.filter((id) => id !== tag.id))
                  }
                >
                  {({ isSelected }) => (
                    <>
                      <span aria-hidden>{isSelected ? '✓' : '□'}</span>
                      <bdi>{tag.name}</bdi>
                    </>
                  )}
                </Checkbox>
              ))}
              {query && visible.length === 0 && (
                <p>
                  <Trans>No categories found.</Trans>
                </p>
              )}
            </div>
            {query && canCreate && !visible.some((tag) => equivalentCategory(tag.name, query)) && (
              <Button
                variant="secondary"
                size="small"
                isPending={busy}
                isDisabled={disabled || !online}
                onPress={() => void create(query)}
              >
                <Trans>Create</Trans> <bdi>{query}</bdi>
              </Button>
            )}
          </div>
        )}
      </details>
      {suggestions.length > 0 && (
        <div className="flex flex-wrap gap-2">
          <span className="w-full text-small">
            <Trans>Suggested categories</Trans>
          </span>
          {suggestions.map((name) => {
            const tag = [...categories.values()].find((candidate) =>
              equivalentCategory(candidate.name, name),
            );
            return (
              <Button
                key={name}
                variant="secondary"
                size="small"
                isDisabled={
                  disabled || busy || (tag ? selected.includes(tag.id) : !online || !canCreate)
                }
                onPress={() => (tag ? pick(tag) : void create(name))}
              >
                {!tag && <Trans>Create</Trans>} <bdi>{tag?.name ?? name}</bdi>
              </Button>
            );
          })}
        </div>
      )}
      {error ? <p role="alert">{errorText(error)}</p> : null}
    </div>
  );
}
