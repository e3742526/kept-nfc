import { AMOUNT_STRING, DEVICE_PHOTO_PROPOSAL_LIMIT, newId, normalize } from '@kept/shared';
import { Trans, useLingui } from '@lingui/react/macro';
import { useRef, useState } from 'react';
import { Checkbox } from 'react-aria-components';
import { inventoryPaths } from '@/api/inventory/paths';
import type { ThingView } from '@/api/inventory/types';
import { useErrorText } from '@/components/page';
import { Button } from '@/components/ui/button';
import { useConfirm } from '@/components/ui/confirm';
import { Select, SelectItem } from '@/components/ui/select';
import { TextField } from '@/components/ui/text-field';
import { usePlatform } from './adapters';
import { ScreenHeader } from './back-button';
import type { Connection, PendingCapture } from './bridge';
import { CategoryPicker } from './category-picker';
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
  const [intent, setIntent] = useState(fields.captureIntent ?? 'record');
  const current = useRef(draft);
  const writes = useRef(Promise.resolve());
  const finishing = useRef(false);
  const [error, setError] = useState<unknown>();
  const [busy, setBusy] = useState(false);
  const [group, setGroup] = useState('');
  const location = cache?.locations.find((loc) => loc.id === fields.locationId);
  const account = location?.ownerAccountId;
  const destination =
    cache?.things.find(({ id }) => id === fields.boxId) ??
    cache?.places.find(({ id }) => id === fields.placeId);
  const path =
    destination && cache
      ? [...inventoryPath(cache, destination), destination.name].filter(Boolean).join(' › ')
      : (location?.name ?? t`Destination`);
  const availableTags = cache?.tags?.filter((tag) => tag.accountId === account) ?? [];
  const photos = entry.capture.files.filter(({ file }) => file.role === 'photo');
  const contents =
    cache?.things.filter(
      (thing) =>
        thing.reviewState === 'confirmed' &&
        thing.locationId === fields.locationId &&
        (fields.boxId ? thing.containerId === fields.boxId : thing.placeId === fields.placeId),
    ) ?? [];

  function persist(next: PhotoReviewDraft, captureIntent = intent) {
    setError(undefined);
    current.current = next;
    setDraft(next);
    const save = writes.current.then(async () => {
      await platform.outbox.retarget(
        connection,
        entry.capture.id,
        JSON.stringify({ ...fields, captureIntent, review: next }),
      );
    });
    writes.current = save.catch(setError);
    return save;
  }

  function update(entries: ReviewEntry[]) {
    if (finishing.current) return;
    void persist({ accepted: false, entries }).catch(() => {});
  }

  function replace(id: string, patch: Partial<ReviewEntry>) {
    if (current.current)
      update(current.current.entries.map((row) => (row.id === id ? { ...row, ...patch } : row)));
  }

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
      (row.existing && !row.existing.update) ||
      (row.name.trim() &&
        (row.existing?.update ||
          !row.quantity ||
          (AMOUNT_STRING.test(row.quantity) && Number(row.quantity) > 0)))
    );
  }

  if (!draft || draft.accepted)
    return <ScreenHeader title={<Trans>Photo review</Trans>} onBack={onBack} />;
  const included = draft.entries.filter((row) => row.include);
  const targetIds = included.flatMap(({ existing }) => (existing ? [existing.id] : []));
  const canAccept =
    included.length > 0 &&
    included.every(validEntry) &&
    new Set(targetIds).size === targetIds.length;

  function finish(work: () => Promise<void>) {
    if (finishing.current) return;
    finishing.current = true;
    setBusy(true);
    void work()
      .catch(setError)
      .finally(() => {
        setBusy(false);
        finishing.current = false;
      });
  }

  function accept() {
    if (!canAccept) return;
    const entries = draft?.entries ?? [];
    finish(async () => {
      try {
        await persist({
          accepted: true,
          acceptedAt: new Date().toISOString(),
          entries: entries.map((row) => {
            const name = row.name.trim();
            const note = row.note?.trim() || null;
            return {
              ...row,
              name,
              ...(row.existing?.update
                ? {
                    existing: { ...row.existing, update: { ...row.existing.update, name, note } },
                  }
                : {}),
            };
          }),
        });
        onSaved();
      } catch (failed) {
        const reopened = { accepted: false, entries };
        current.current = reopened;
        setDraft(reopened);
        throw failed;
      }
    });
  }

  function openPhoto(index: number) {
    const photo = photos[index];
    if (photo)
      void platform.media
        .openPending(connection, { id: entry.capture.id, file: photo.file.id })
        .catch(setError);
  }

  async function updateExisting(row: ReviewEntry, target: string) {
    if (!online || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      const thing = await platform.transport.request<ThingView>(
        connection,
        inventoryPaths.thing(target),
      );
      if (
        !(await confirm({
          title: t`Update ${thing.name ?? t`Item`}?`,
          body: row.claimCode
            ? t`Saving will update the name, any description you enter, and add selected categories. The quantity and location will stay as recorded. The label you chose is not added to an existing item. It stays an unused blank label you can scan later.`
            : t`Saving will update the name, any description you enter, and add selected categories. The quantity and location will stay as recorded.`,
          confirmLabel: t`Review update`,
          cancelLabel: t`Cancel`,
        }))
      )
        return;
      replace(row.id, {
        claimCode: undefined,
        claimNfcVerified: undefined,
        existing: {
          id: target,
          update: {
            key: newId(),
            rowVersion: thing.rowVersion,
            name: row.name,
            note: row.note ?? null,
          },
        },
      });
    } catch (failed) {
      setError(failed);
    } finally {
      setBusy(false);
    }
  }

  function saveForLater() {
    const next = current.current;
    if (!next) return;
    finish(async () => {
      await persist(next);
      onBack();
    });
  }

  return (
    <section className="grid gap-3">
      <ScreenHeader title={<Trans>Photo review</Trans>} backDisabled={busy} onBack={saveForLater} />
      <p className="m-0 text-small">
        <Trans>Destination</Trans> <bdi>{path}</bdi>
      </p>
      {photos.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {photos.map(({ file }, index) => (
            <Button key={file.id} variant="secondary" size="small" onPress={() => openPhoto(index)}>
              {photos.length === 1 ? t`Open original photo` : t`Open original photo ${index + 1}`}
            </Button>
          ))}
        </div>
      )}
      <Select
        label={t`Action`}
        selectedKey={intent}
        isDisabled={busy}
        items={[
          { id: 'record', label: t`Record existing contents` },
          { id: 'add', label: t`Add contents` },
        ]}
        onSelectionChange={(key) => {
          const next = key === 'add' ? 'add' : 'record';
          setIntent(next);
          if (current.current) void persist(current.current, next).catch(() => {});
        }}
      >
        {(option) => <SelectItem id={option.id}>{option.label}</SelectItem>}
      </Select>
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
      {draft.entries.map((row) => {
        const name = normalize(row.name);
        const matches = contents.filter(
          (item) =>
            item.id === row.existing?.id || (name && item.name && normalize(item.name) === name),
        );
        const association = row.existing && !row.existing.update;
        return (
          <div key={row.id} className="kept-card">
            <div className="flex items-center justify-between gap-2">
              <Checkbox
                className="flex min-h-10 items-center gap-2 text-start"
                isSelected={row.include}
                isDisabled={busy}
                onChange={(include) => replace(row.id, { include })}
              >
                {({ isSelected }) => (
                  <>
                    <span aria-hidden>{isSelected ? '✓' : '□'}</span>
                    <Trans>Include</Trans> <bdi>{row.name}</bdi>
                  </>
                )}
              </Checkbox>
              <Button
                variant="ghost"
                size="small"
                isDisabled={busy}
                aria-label={row.name ? t`Remove proposal ${row.name}` : t`Remove proposal`}
                onPress={() => update(draft.entries.filter(({ id }) => id !== row.id))}
              >
                <Trans>Remove</Trans>
              </Button>
            </div>
            <TextField
              label={t`Name`}
              value={row.name}
              isDisabled={busy || !!association}
              inputProps={{ maxLength: 200 }}
              onChange={(name) => replace(row.id, { name })}
            />
            {matches.length > 0 && (
              <details open={row.existing ? true : undefined}>
                <summary className="min-h-10 text-small">
                  <Trans>Possible matches in this destination</Trans>
                </summary>
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="secondary"
                    size="small"
                    isDisabled={busy}
                    aria-pressed={!row.existing}
                    onPress={() => replace(row.id, { existing: undefined })}
                  >
                    <Trans>Create a new entry</Trans>
                  </Button>
                  {matches.map((item) => (
                    <div className="grid gap-1" key={item.id}>
                      <bdi>{item.name}</bdi>
                      <Button
                        variant="secondary"
                        size="small"
                        isDisabled={busy}
                        aria-pressed={association && row.existing?.id === item.id}
                        onPress={() => replace(row.id, { existing: { id: item.id } })}
                      >
                        <Trans>Attach photos only</Trans>
                      </Button>
                      <Button
                        variant="secondary"
                        size="small"
                        isDisabled={busy || !online}
                        aria-pressed={row.existing?.id === item.id && !!row.existing.update}
                        onPress={() => void updateExisting(row, item.id)}
                      >
                        <Trans>Update existing record</Trans>
                      </Button>
                    </div>
                  ))}
                </div>
              </details>
            )}
            {!association && account && (
              <CategoryPicker
                connection={connection}
                accountId={account}
                online={online}
                canCreate={location.role !== 'viewer'}
                options={availableTags}
                selected={row.tags}
                suggestions={row.categories}
                disabled={busy}
                onChange={(tags) => replace(row.id, { tags })}
              />
            )}
            <details>
              <summary className="min-h-10 text-small">
                <Trans>Details</Trans>
              </summary>
              <div className="grid gap-2">
                {!association && (
                  <TextField
                    label={t`Description (optional)`}
                    value={row.note ?? fields.note ?? ''}
                    isDisabled={busy}
                    inputProps={{ maxLength: 500 }}
                    onChange={(note) => replace(row.id, { note })}
                  />
                )}
                {!row.existing && (
                  <TextField
                    label={t`Quantity (optional)`}
                    value={row.quantity}
                    description={
                      row.estimatedQuantity ? t`AI estimate: ${row.estimatedQuantity}` : undefined
                    }
                    isDisabled={busy}
                    inputProps={{ inputMode: 'decimal', maxLength: 17 }}
                    onChange={(quantity) => replace(row.id, { quantity })}
                  />
                )}
                {row.evidence?.map(
                  (index) =>
                    photos[index] && (
                      <Button
                        key={index}
                        size="small"
                        variant="secondary"
                        onPress={() => openPhoto(index)}
                      >
                        {t`Open supporting photo ${index + 1}`}
                      </Button>
                    ),
                )}
              </div>
            </details>
          </div>
        );
      })}
      <Button
        variant="secondary"
        isDisabled={busy || draft.entries.length >= DEVICE_PHOTO_PROPOSAL_LIMIT}
        onPress={() => update([...draft.entries, emptyEntry()])}
      >
        <Trans>Add entry</Trans>
      </Button>
      {included.length > 1 && targetIds.length === 0 && (
        <details className="kept-card">
          <summary className="min-h-10 text-small">
            <Trans>Combine into one entry</Trans>
          </summary>
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
              update([
                ...draft.entries.filter((row) => !row.include),
                {
                  ...emptyEntry(group.trim()),
                  tags: [...new Set(included.flatMap((row) => row.tags))].slice(0, 50),
                  categories: [...new Set(included.flatMap((row) => row.categories))],
                  evidence: [...new Set(included.flatMap((row) => row.evidence ?? []))],
                },
              ]);
              setGroup('');
            }}
          >
            <Trans>Combine selected</Trans>
          </Button>
        </details>
      )}
      {new Set(targetIds).size !== targetIds.length && (
        <p role="alert">
          <Trans>Select each existing record only once.</Trans>
        </p>
      )}
      {error ? <p role="alert">{errorText(error)}</p> : null}
      <Button variant="primary" isPending={busy} isDisabled={!canAccept} onPress={accept}>
        <Trans>Save selected entries</Trans>
      </Button>
      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" isDisabled={busy} onPress={saveForLater}>
          <Trans>Save review for later</Trans>
        </Button>
        <Button
          variant="ghost"
          isDisabled={busy}
          onPress={() =>
            finish(async () => {
              if (
                !(await confirm({
                  title: t`Discard this draft?`,
                  confirmLabel: t`Discard draft`,
                  destructive: true,
                }))
              )
                return;
              await writes.current;
              await platform.outbox.discard(connection, entry.capture.id);
              onSaved();
            })
          }
        >
          <Trans>Discard draft</Trans>
        </Button>
      </div>
    </section>
  );
}
