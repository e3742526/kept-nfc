import { AMOUNT_STRING, DEVICE_PHOTO_PROPOSAL_LIMIT, newId, normalize } from '@kept/shared';
import { Trans, useLingui } from '@lingui/react/macro';
import { useRef, useState } from 'react';
import { inventoryPaths, qs } from '@/api/inventory/paths';
import type { CreateRegistryResult, Page, Tag } from '@/api/inventory/types';
import { useErrorText } from '@/components/page';
import { Button } from '@/components/ui/button';
import { useConfirm } from '@/components/ui/confirm';
import { Select, SelectItem } from '@/components/ui/select';
import { TextField } from '@/components/ui/text-field';
import { usePlatform } from './adapters';
import { ScreenHeader } from './back-button';
import type { Connection, PendingCapture } from './bridge';
import { type InventoryCache, inventoryPath } from './inventory';
import { draftFields, type PhotoReviewDraft, type ReviewEntry } from './outbox';

export function PhotoReview({
  connection,
  cache,
  entry,
  online,
  onBack,
  onSaved,
}: {
  connection: Connection;
  cache?: InventoryCache;
  entry: PendingCapture;
  online: boolean;
  onBack: () => void;
  onSaved: () => void;
}) {
  const { t } = useLingui();
  const platform = usePlatform();
  const errorText = useErrorText();
  const confirm = useConfirm();
  const [fields] = useState(() => draftFields(entry.capture));
  const [draft, setDraft] = useState(fields.review);
  const current = useRef(draft);
  const writes = useRef(Promise.resolve());
  const [error, setError] = useState<unknown>();
  const [busy, setBusy] = useState(false);
  const [group, setGroup] = useState('');
  const [createdTags, setCreatedTags] = useState<{ id: string; name: string }[]>([]);
  const location = cache?.locations.find((loc) => loc.id === fields.locationId);
  const account = location?.ownerAccountId;
  const destination =
    cache?.things.find(({ id }) => id === fields.boxId) ??
    cache?.places.find(({ id }) => id === fields.placeId);
  const path =
    destination && cache
      ? [...inventoryPath(cache, destination), destination.name].filter(Boolean).join(' › ')
      : (location?.name ?? t`Destination`);
  const availableTags = [
    ...(cache?.tags?.filter((tag) => tag.accountId === account) ?? []),
    ...createdTags,
  ].filter((item, index, all) => all.findIndex((other) => item.id === other.id) === index);

  function persist(next: PhotoReviewDraft) {
    setError(undefined);
    current.current = next;
    setDraft(next);
    const save = writes.current.then(async () => {
      await platform.outbox.retarget(
        connection,
        entry.capture.id,
        JSON.stringify({ ...fields, review: next }),
      );
    });
    writes.current = save.catch(setError);
    return save;
  }
  function update(entries: ReviewEntry[]) {
    void persist({ accepted: false, entries }).catch(() => {});
  }
  const replace = (id: string, patch: Partial<ReviewEntry>) => {
    if (current.current)
      update(current.current.entries.map((row) => (row.id === id ? { ...row, ...patch } : row)));
  };
  const emptyEntry = (name = ''): ReviewEntry => ({
    id: newId(),
    tagRequestId: newId(),
    name,
    quantity: '',
    include: true,
    categories: [],
    tags: [],
  });
  function validEntry(row: ReviewEntry) {
    return (
      row.name.trim() &&
      (!row.quantity || (AMOUNT_STRING.test(row.quantity) && Number(row.quantity) > 0))
    );
  }

  if (!draft || draft.accepted)
    return <ScreenHeader title={<Trans>Photo review</Trans>} onBack={onBack} />;
  const included = draft.entries.filter((row) => row.include);
  const savedPhoto = entry.capture.files.find(({ file }) => file.role === 'photo');

  async function accept() {
    if (busy || !included.length || included.some((row) => !validEntry(row))) return;
    const entries = draft?.entries ?? [];
    setBusy(true);
    try {
      await persist({
        accepted: true,
        acceptedAt: new Date().toISOString(),
        entries: entries.map((row) => ({ ...row, name: row.name.trim() })),
      });
      onSaved();
    } catch {
      const reopened = { accepted: false, entries };
      current.current = reopened;
      setDraft(reopened);
    } finally {
      setBusy(false);
    }
  }

  async function addCategory(row: ReviewEntry, name: string) {
    if (!account || !online || busy) return;
    const existing = availableTags.find((tag) => normalize(tag.name) === normalize(name));
    if (existing) {
      replace(row.id, { tags: [...new Set([...row.tags, existing.id])] });
      return;
    }
    setBusy(true);
    try {
      const path = inventoryPaths.accountRegistry(account, 'tags');
      const { items } = await platform.transport.request<Page<Tag>>(
        connection,
        path + qs({ q: name, limit: 5 }),
      );
      const exact = items.find((tag) => normalize(tag.name) === normalize(name));
      if (exact) {
        setCreatedTags((tags) => [...tags, exact]);
        replace(row.id, { tags: [...new Set([...row.tags, exact.id])] });
        return;
      }
      setCreatedTags((tags) => [...tags, ...items]);
      const near = items.map((tag) => tag.name).join(', ');
      if (
        !(await confirm({
          title: t`Create category ${name}?`,
          ...(near ? { body: t`Existing categories with similar names include ${near}.` } : {}),
          confirmLabel: t`Create`,
          cancelLabel: t`Cancel`,
        }))
      )
        return;
      const result = await platform.transport.request<CreateRegistryResult<'tags'>>(
        connection,
        path,
        {
          method: 'POST',
          idempotencyKey: newId(),
          body: { name },
        },
      );
      setCreatedTags((tags) => [...tags, result.item]);
      replace(row.id, { tags: [...new Set([...row.tags, result.item.id])] });
    } catch (failed) {
      setError(failed);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="grid gap-3">
      <ScreenHeader
        title={<Trans>Photo review</Trans>}
        backDisabled={busy}
        onBack={() => {
          if (current.current)
            void persist(current.current)
              .then(onBack)
              .catch(() => {});
        }}
      />
      <p className="m-0 text-small">
        <Trans>Destination</Trans> <bdi>{path}</bdi>
      </p>
      {savedPhoto && (
        <Button
          variant="secondary"
          onPress={() => {
            void platform.media
              .openPending(connection, { id: entry.capture.id, file: savedPhoto.file.id })
              .catch(setError);
          }}
        >
          <Trans>Open original photo</Trans>
        </Button>
      )}
      <p className="m-0 text-small">
        {fields.captureIntent === 'add' ? t`Add contents` : t`Record existing contents`}
      </p>
      <div className="flex flex-wrap gap-2">
        <Button
          variant="secondary"
          isDisabled={busy}
          onPress={() => update(draft.entries.map((row) => ({ ...row, include: true })))}
        >
          <Trans>Select all</Trans>
        </Button>
        <Button
          variant="secondary"
          isDisabled={busy}
          onPress={() => update(draft.entries.map((row) => ({ ...row, include: false })))}
        >
          <Trans>Deselect all</Trans>
        </Button>
      </div>
      {draft.entries.map((row) => (
        <div key={row.id} className="kept-card">
          <label className="flex min-h-10 items-center gap-2 text-small">
            <input
              type="checkbox"
              checked={row.include}
              disabled={busy}
              onChange={(event) => replace(row.id, { include: event.target.checked })}
            />
            <Trans>Include</Trans> <bdi>{row.name}</bdi>
          </label>
          <TextField
            label={t`Description`}
            value={row.name}
            isDisabled={busy}
            inputProps={{ maxLength: 200 }}
            onChange={(name) => replace(row.id, { name })}
          />
          <TextField
            label={t`Quantity`}
            value={row.quantity}
            isDisabled={busy}
            inputProps={{ inputMode: 'decimal', maxLength: 16 }}
            onChange={(quantity) => replace(row.id, { quantity })}
          />
          {!!availableTags.length && (
            <Select
              label={t`Categories`}
              selectionMode="multiple"
              items={availableTags}
              isDisabled={busy}
              value={row.tags}
              onChange={(keys) => replace(row.id, { tags: keys.map(String).slice(0, 8) })}
            >
              {(tag) => (
                <SelectItem id={tag.id}>
                  <bdi>{tag.name}</bdi>
                </SelectItem>
              )}
            </Select>
          )}
          {row.categories.some(
            (name) => !availableTags.some((tag) => normalize(tag.name) === normalize(name)),
          ) && (
            <div className="grid gap-1">
              <span className="text-small">
                <Trans>Suggested categories</Trans>
              </span>
              {row.categories
                .filter(
                  (name) => !availableTags.some((tag) => normalize(tag.name) === normalize(name)),
                )
                .map((name) => (
                  <Button
                    key={name}
                    variant="secondary"
                    size="small"
                    isDisabled={!online || !account || busy}
                    onPress={() => void addCategory(row, name)}
                  >
                    <Trans>Create</Trans> <bdi>{name}</bdi>
                  </Button>
                ))}
            </div>
          )}
        </div>
      ))}
      <Button
        variant="secondary"
        isDisabled={busy || draft.entries.length >= DEVICE_PHOTO_PROPOSAL_LIMIT}
        onPress={() => update([...draft.entries, emptyEntry()])}
      >
        <Trans>Add entry</Trans>
      </Button>
      {included.length > 1 && (
        <div className="kept-card">
          <TextField
            label={t`Group description`}
            value={group}
            onChange={setGroup}
            inputProps={{ maxLength: 200 }}
          />
          <Button
            variant="secondary"
            isDisabled={busy || !group.trim()}
            onPress={() => {
              update([emptyEntry(group.trim())]);
              setGroup('');
            }}
          >
            <Trans>Combine into one entry</Trans>
          </Button>
        </div>
      )}
      {error ? <p role="alert">{errorText(error)}</p> : null}
      <Button
        variant="primary"
        isPending={busy}
        isDisabled={!included.length || included.some((row) => !validEntry(row))}
        onPress={() => void accept()}
      >
        <Trans>Save selected entries</Trans>
      </Button>
    </section>
  );
}
