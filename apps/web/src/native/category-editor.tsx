import { newId } from '@kept/shared';
import { Trans, useLingui } from '@lingui/react/macro';
import { useEffect, useState } from 'react';
import { inventoryPaths, qs } from '@/api/inventory/paths';
import type { Page, Tag, ThingTag } from '@/api/inventory/types';
import { useErrorText } from '@/components/page';
import { Button } from '@/components/ui/button';
import { useConfirm } from '@/components/ui/confirm';
import { TextField } from '@/components/ui/text-field';
import { usePlatform } from './adapters';
import type { Connection } from './bridge';

export function CategoryEditor({
  connection,
  accountId,
  online,
  manage,
  things,
  assigned,
  onChange,
  onPick,
}: {
  connection: Connection;
  accountId: string;
  online: boolean;
  manage: boolean;
  things?: string[];
  assigned?: ThingTag[];
  onChange?: () => void;
  onPick?: (tag: Tag) => void;
}) {
  const { t } = useLingui();
  const { transport } = usePlatform();
  const errorText = useErrorText();
  const confirm = useConfirm();
  const [search, setSearch] = useState('');
  const [name, setName] = useState('');
  const [editing, setEditing] = useState<Tag>();
  const [page, setPage] = useState<Page<Tag>>();
  const [error, setError] = useState<unknown>();
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const path = inventoryPaths.accountRegistry(accountId, 'tags');
  const query = search.trim();
  const starters = [t`Tools`, t`Electronics`, t`Kitchen`, t`Documents`];
  // biome-ignore lint/correctness/useExhaustiveDependencies: revision refreshes the active query after a write.
  useEffect(() => {
    if (!online) return;
    let active = true;
    setPage(undefined);
    setError(undefined);
    const timer = window.setTimeout(() => {
      void transport
        .request<Page<Tag>>(connection, path + qs({ q: query || undefined, limit: 30 }))
        .then((result) => {
          if (active) setPage(result);
        })
        .catch((failed: unknown) => {
          if (active) setError(failed);
        });
    }, 150);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [connection, online, path, query, revision, transport]);

  async function perform(work: () => Promise<unknown>) {
    if (!online || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      await work();
      setRevision((value) => value + 1);
      onChange?.();
    } catch (failed) {
      setError(failed);
    } finally {
      setBusy(false);
    }
  }

  function assign(tag: Tag, remove: boolean) {
    if (!things?.length) return;
    void perform(() =>
      transport.request(connection, inventoryPaths.thingsTags, {
        method: 'POST',
        idempotencyKey: newId(),
        body: { thingIds: things, ...(remove ? { remove: [tag.id] } : { add: [tag.id] }) },
      }),
    );
  }

  return (
    <section className="kept-card">
      <h3 className="kept-card-title">
        <Trans>Categories</Trans>
      </h3>
      {!online ? (
        <p>
          <Trans>Needs a connection</Trans>
        </p>
      ) : (
        <>
          <TextField label={t`Search categories`} value={search} onChange={setSearch} />
          {manage && (
            <form
              className="grid gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                const next = name.trim();
                if (!next) return;
                void perform(async () => {
                  await transport.request(
                    connection,
                    editing ? inventoryPaths.registryItem('tags', editing.id) : path,
                    {
                      method: editing ? 'PATCH' : 'POST',
                      ...(editing ? { ifMatch: editing.rowVersion } : { idempotencyKey: newId() }),
                      body: { name: next },
                    },
                  );
                  setEditing(undefined);
                  setName('');
                });
              }}
            >
              <TextField
                label={editing ? t`Rename` : t`New category`}
                value={name}
                onChange={setName}
                inputProps={{ maxLength: 100 }}
              />
              <div className="flex flex-wrap gap-2">
                <Button type="submit" isDisabled={!name.trim()} isPending={busy}>
                  <Trans>Save</Trans>
                </Button>
                {editing && (
                  <Button
                    variant="secondary"
                    onPress={() => {
                      setEditing(undefined);
                      setName('');
                    }}
                  >
                    <Trans>Cancel</Trans>
                  </Button>
                )}
              </div>
            </form>
          )}
          {manage && !editing && (
            <details>
              <summary className="min-h-10 text-small">
                <Trans>Starter categories</Trans>
              </summary>
              <div className="flex flex-wrap gap-2">
                {starters.map((label) => (
                  <Button
                    key={label}
                    variant="secondary"
                    size="small"
                    onPress={() => setName(label)}
                  >
                    {label}
                  </Button>
                ))}
              </div>
            </details>
          )}
          {page?.items.length === 0 && (
            <p>
              <Trans>No categories found.</Trans>
            </p>
          )}
          {page?.items.map((tag) => {
            const attached = assigned?.some(({ id }) => id === tag.id);
            return (
              <div className="flex flex-wrap items-center gap-2" key={tag.id}>
                <Button variant="secondary" isDisabled={!onPick} onPress={() => onPick?.(tag)}>
                  <bdi>{tag.name}</bdi>
                  {tag.thingCount !== undefined ? ` · ${tag.thingCount}` : ''}
                </Button>
                {things?.length ? (
                  <Button variant="ghost" isDisabled={busy} onPress={() => assign(tag, !!attached)}>
                    {attached ? t`Remove` : t`Assign`}
                  </Button>
                ) : null}
                {things?.length && !assigned ? (
                  <Button variant="ghost" isDisabled={busy} onPress={() => assign(tag, true)}>
                    <Trans>Remove</Trans>
                  </Button>
                ) : null}
                {manage && (
                  <>
                    <Button
                      variant="ghost"
                      isDisabled={busy}
                      onPress={() => {
                        setEditing(tag);
                        setName(tag.name);
                      }}
                    >
                      <Trans>Rename</Trans>
                    </Button>
                    <Button
                      variant="ghost"
                      isDisabled={busy}
                      onPress={() => {
                        void confirm({
                          title: t`Delete category?`,
                          body: t`Inventory entries will stay in SheepKeep.`,
                          confirmLabel: t`Delete`,
                          cancelLabel: t`Cancel`,
                          destructive: true,
                        }).then((ok) => {
                          if (ok)
                            void perform(() =>
                              transport.request(
                                connection,
                                inventoryPaths.registryItem('tags', tag.id),
                                { method: 'DELETE', ifMatch: tag.rowVersion },
                              ),
                            );
                        });
                      }}
                    >
                      <Trans>Delete</Trans>
                    </Button>
                  </>
                )}
              </div>
            );
          })}
          {page?.next_cursor && (
            <Button
              variant="secondary"
              isPending={busy}
              onPress={() => {
                setBusy(true);
                void transport
                  .request<Page<Tag>>(
                    connection,
                    path + qs({ q: query || undefined, cursor: page.next_cursor, limit: 30 }),
                  )
                  .then((next) =>
                    setPage((prior) =>
                      prior === page ? { ...next, items: [...prior.items, ...next.items] } : prior,
                    ),
                  )
                  .catch(setError)
                  .finally(() => setBusy(false));
              }}
            >
              <Trans>Load more</Trans>
            </Button>
          )}
        </>
      )}
      {error ? <p role="alert">{errorText(error)}</p> : null}
    </section>
  );
}
