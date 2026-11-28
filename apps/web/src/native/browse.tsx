import { builtinType, type SnapThing } from '@kept/shared';
import { Trans, useLingui } from '@lingui/react/macro';
import { CornerDownLeft, MessageSquare, Package, Plus } from 'lucide-react';
import { useEffect, useState } from 'react';
import { inventoryPaths, qs } from '@/api/inventory/paths';
import type { Brand, Page, ThingRow } from '@/api/inventory/types';
import { useErrorText } from '@/components/page';
import { PhotoImage } from '@/components/photo-image';
import { useTypeName } from '@/components/things/names';
import { Button } from '@/components/ui/button';
import { Select, SelectItem } from '@/components/ui/select';
import { TextField } from '@/components/ui/text-field';
import { sep } from '@/lib/format';
import { usePlatform } from './adapters';
import { ScreenHeader } from './back-button';
import type { Connection } from './bridge';
import { CategoryEditor } from './category-editor';
import type { Destination } from './destination';
import {
  type InventoryCache,
  inventoryPath,
  inventorySearchTerm,
  localInventorySearch,
  previewUrl,
} from './inventory';
import type { Target } from './labels';
import { isAuthRefusal, isRestoreEpochMismatch } from './outbox';
import { PhotoSearchActions, type VisualSearchIntent } from './visual-search';

type Option = { id: string; name: string };
type BrowsePage = Page<ThingRow> & { total?: number; categoryInheritedIds?: string[] };
type Sort = 'name' | 'recorded' | 'updated' | 'lastSeen' | 'location';
export type BrowseFilters = {
  q: string;
  rooms: string[];
  tags: string[];
  bins: string[];
  types: string[];
  brands: string[];
  categoryMode: 'any' | 'all';
  groupMode: 'any' | 'all';
  nested: boolean;
  inherit: boolean;
  untagged: boolean;
  state: 'all' | 'unplaced' | 'uncertain' | 'archived';
  mode: 'all' | 'bins' | 'categories';
  sort: Sort;
  grid: boolean;
};
export const browseDefaults: BrowseFilters = {
  q: '',
  rooms: [],
  tags: [],
  bins: [],
  types: [],
  brands: [],
  categoryMode: 'any',
  groupMode: 'all',
  nested: true,
  inherit: false,
  untagged: false,
  state: 'all',
  mode: 'all',
  sort: 'name',
  grid: false,
};

function ancestry(cache: InventoryCache, thing: SnapThing, chain = new Set<string>()) {
  const bins: SnapThing[] = [];
  let found = thing;
  while (found.containerId && !chain.has(found.containerId)) {
    const parent = cache.things.find((bin) => bin.id === found.containerId);
    if (!parent) break;
    chain.add(parent.id);
    bins.push(parent);
    found = parent;
  }
  const rooms: string[] = [];
  for (let id = found.placeId; id && !rooms.includes(id); ) {
    rooms.push(id);
    id = cache.places.find((room) => room.id === id)?.parentId ?? null;
  }
  return { rooms, bins };
}

function matchTags(ids: string[], selected: string[], all: boolean) {
  return all ? selected.every((id) => ids.includes(id)) : selected.some((id) => ids.includes(id));
}

export function cachedBrowse(cache: InventoryCache, f: BrowseFilters) {
  const search = inventorySearchTerm(f.q);
  const textMatches = search
    ? new Set(localInventorySearch(cache, search, Infinity).map(({ id }) => id))
    : null;
  return cache.things
    .filter((thing) => {
      if (thing.reviewState === 'draft' || (f.mode === 'bins' && !thing.isContainer)) return false;
      const { rooms, bins } = ancestry(cache, thing);
      const matches: boolean[] = [];
      if (f.rooms.length)
        matches.push(f.rooms.some((id) => (f.nested ? rooms.includes(id) : thing.placeId === id)));
      if (f.bins.length)
        matches.push(
          f.bins.some((id) =>
            f.nested ? bins.some((box) => box.id === id) : thing.containerId === id,
          ),
        );
      if (f.types.length) matches.push(!!thing.typeId && f.types.includes(thing.typeId));
      const has = (row: SnapThing) => matchTags(row.tagIds ?? [], f.tags, f.categoryMode === 'all');
      if (f.tags.length || f.untagged) {
        matches.push(
          (f.untagged && !thing.tagIds?.length) ||
            (f.tags.length > 0 && (has(thing) || (f.inherit && bins.some(has)))),
        );
      }
      if (f.state !== 'all')
        matches.push(
          f.state === 'unplaced'
            ? cache.places.some((p) => p.id === thing.placeId && p.isUnplaced)
            : f.state === 'uncertain'
              ? thing.locationUncertain
              : thing.lifecycle === 'archived',
        );
      if (textMatches) matches.push(textMatches.has(thing.id));
      return (
        !matches.length || (f.groupMode === 'all' ? matches.every(Boolean) : matches.some(Boolean))
      );
    })
    .sort((a, b) => {
      if (f.sort === 'lastSeen') return (b.lastSeenAt ?? '').localeCompare(a.lastSeenAt ?? '');
      if (f.sort === 'location')
        return inventoryPath(cache, a)
          .join(' › ')
          .localeCompare(inventoryPath(cache, b).join(' › '));
      return (a.name ?? '').localeCompare(b.name ?? '');
    });
}

function MultiFilter({
  label,
  options,
  selected,
  update,
}: {
  label: string;
  options: Option[];
  selected: string[];
  update: (ids: string[]) => void;
}) {
  if (!options.length) return null;
  return (
    <Select
      label={label}
      selectionMode="multiple"
      items={options}
      value={selected}
      onChange={(keys) => update(keys.map(String))}
    >
      {(item) => (
        <SelectItem id={item.id} textValue={item.name}>
          <bdi>{item.name}</bdi>
        </SelectItem>
      )}
    </Select>
  );
}

export function Browse({
  connection,
  online,
  cache,
  filters: f,
  onFilters,
  onBack,
  onOpen,
  onCreateContainer,
  onAddToBox,
  onPhotoSearch,
  onRooms,
  onAssistant,
  onAuthError,
  onInventoryChanged,
}: {
  connection: Connection;
  online: boolean;
  cache: InventoryCache;
  filters: BrowseFilters;
  onFilters: (next: BrowseFilters) => void;
  onBack: () => void;
  onOpen: (target: Target) => void;
  onCreateContainer?: () => void;
  onAddToBox: (destination: Destination) => void;
  onPhotoSearch: (mode: VisualSearchIntent['mode']) => void;
  onRooms: () => void;
  onAssistant: () => void;
  onAuthError: (reason: 'expired' | 'restored') => void;
  onInventoryChanged: () => void;
}) {
  const { t } = useLingui();
  const typeName = useTypeName();
  const { transport } = usePlatform();
  const errorText = useErrorText();
  const [page, setPage] = useState<BrowsePage>();
  const [error, setError] = useState<unknown>();
  const [revision, setRevision] = useState(0);
  const [advanced, setAdvanced] = useState(false);
  const [brands, setBrands] = useState<Brand[]>([]);
  const [account, setAccount] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const rooms = cache.places.filter((p) => p.kindKey === 'room' && !p.isUnplaced);
  const boxes = cache.things
    .filter((thing) => thing.isContainer && thing.name)
    .map((box) => ({ id: box.id, name: box.name ?? '' }));
  const accounts = [
    ...new Map(
      cache.locations.filter((l) => l.ownerAccountId).map((l) => [l.ownerAccountId, l]),
    ).values(),
  ];
  const owner = accounts.find((l) => l.ownerAccountId === account) ?? accounts[0];
  const tagOptions = cache.tags ?? [];
  const accountId = owner?.ownerAccountId;
  useEffect(() => {
    setBrands([]);
    if (!accountId || !advanced || !online) return;
    let active = true;
    void transport
      .request<Page<Brand>>(
        connection,
        inventoryPaths.accountRegistry(accountId, 'brands') + qs({ limit: 80 }),
      )
      .then((result) => {
        if (active) setBrands(result.items);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [accountId, advanced, online, connection, transport]);
  const query = qs({
    count: 1,
    limit: 40,
    q: inventorySearchTerm(f.q),
    roomId: f.rooms,
    binId: f.bins,
    tagId: f.tags,
    typeId: f.types,
    brandId: f.brands,
    all: f.categoryMode === 'all' ? 'tagId' : undefined,
    match: f.groupMode === 'any' ? 'any' : undefined,
    nested: f.nested ? 1 : undefined,
    categoryContents: f.inherit ? 1 : undefined,
    uncategorized: f.untagged ? 1 : undefined,
    unplaced: f.state === 'unplaced' ? 1 : undefined,
    state: f.state === 'uncertain' || f.state === 'archived' ? f.state : undefined,
    container: f.mode === 'bins' ? 1 : undefined,
    sort: f.sort,
  });
  const update = (patch: Partial<BrowseFilters>) => onFilters({ ...f, ...patch });
  // biome-ignore lint/correctness/useExhaustiveDependencies: revision refreshes the active query after a write.
  useEffect(() => {
    setPage(undefined);
    setError(undefined);
    if (!online) return;
    let active = true;
    const timer = window.setTimeout(() => {
      void transport
        .request<BrowsePage>(connection, inventoryPaths.things + query)
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
  }, [online, transport, connection, query, revision]);
  useEffect(() => {
    if (isAuthRefusal(error)) onAuthError('expired');
    else if (isRestoreEpochMismatch(error)) onAuthError('restored');
  }, [error, onAuthError]);
  const useCache = !online || !!error || (!!page && page.total === undefined);
  const displayedSort =
    useCache && (f.sort === 'recorded' || f.sort === 'updated') ? 'name' : f.sort;
  const needsOnlineFilter = useCache && f.brands.length > 0;
  const remembered = useCache && !needsOnlineFilter ? cachedBrowse(cache, f) : [];
  const rows = useCache
    ? remembered.map((thing) => ({
        id: thing.id,
        typeId: thing.typeId,
        name: thing.name,
        locationId: thing.locationId,
        shortCode: thing.shortCode,
        path: inventoryPath(cache, thing).join(' › '),
        thumb: undefined,
        thumbnailRotation: undefined,
        tags: tagOptions.filter(({ id }) => thing.tagIds?.includes(id)),
        ancestors: ancestry(cache, thing).bins.map(({ id }) => id),
      }))
    : (page?.items.map((thing) => ({
        id: thing.id,
        typeId: thing.type?.id,
        name: thing.name,
        locationId: thing.locationId,
        shortCode: thing.shortCode,
        path: [
          cache.locations.find((l) => l.id === thing.locationId)?.name,
          ...thing.path.map((p) => p.name),
        ]
          .filter(Boolean)
          .join(' › '),
        thumb: previewUrl(thing.thumbUrl, connection.origin),
        thumbnailRotation: thing.thumbnailRotation,
        tags: thing.tags,
        ancestors: thing.path.map(({ id }) => id),
      })) ?? []);
  const count = needsOnlineFilter ? undefined : useCache ? remembered.length : page?.total;
  const options = [
    { id: 'all', name: t`All` },
    { id: 'unplaced', name: t`Unplaced` },
    { id: 'uncertain', name: t`Missing` },
    { id: 'archived', name: t`Archived` },
  ];
  return (
    <section className="grid gap-3">
      <ScreenHeader
        title={
          f.state === 'uncertain' && f.mode === 'all' ? (
            <Trans>Missing items</Trans>
          ) : f.mode === 'bins' ? (
            <Trans>Containers</Trans>
          ) : f.mode === 'categories' ? (
            <Trans>Categories</Trans>
          ) : (
            <Trans>Items</Trans>
          )
        }
        onBack={onBack}
        trailing={
          f.mode === 'bins' && onCreateContainer ? (
            <Button
              variant="secondary"
              size="small"
              className="min-h-11 min-w-11"
              aria-label={t`New container`}
              isDisabled={!online}
              onPress={onCreateContainer}
            >
              <Plus size={16} aria-hidden />
              <span className="hidden min-[360px]:inline">
                <Trans>New container</Trans>
              </span>
            </Button>
          ) : undefined
        }
      />
      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" onPress={onRooms}>
          <Trans>Rooms</Trans>
        </Button>
        {(
          [
            { id: 'all', name: t`Items` },
            { id: 'categories', name: t`Categories` },
            { id: 'bins', name: t`Containers` },
          ] as const
        ).map((mode) => (
          <Button
            key={mode.id}
            variant="secondary"
            aria-pressed={f.mode === mode.id}
            onPress={() => update({ mode: mode.id })}
          >
            {mode.name}
          </Button>
        ))}
      </div>
      <div className="kept-search-line">
        <TextField
          className="kept-search-field"
          label={t`Search`}
          value={f.q}
          onChange={(q) => update({ q })}
          inputProps={{
            maxLength: 200,
            enterKeyHint: 'search',
            autoCapitalize: 'none',
            autoCorrect: 'off',
            onKeyDown: (event) => {
              if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                event.preventDefault();
                event.currentTarget.blur();
              }
            },
          }}
        />
        <Button
          variant="secondary"
          className="kept-search-action"
          aria-label={t`Search now`}
          onPress={() => (document.activeElement as HTMLElement | null)?.blur()}
        >
          <CornerDownLeft size={18} className="rtl:-scale-x-100" aria-hidden />
        </Button>
        <Button
          variant="secondary"
          className="kept-search-action"
          aria-label={t`Ask the assistant`}
          onPress={onAssistant}
        >
          <MessageSquare size={18} aria-hidden />
        </Button>
      </div>
      <PhotoSearchActions onOpen={onPhotoSearch} />
      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" aria-expanded={advanced} onPress={() => setAdvanced(!advanced)}>
          <Trans>Filters</Trans>
        </Button>
        <Button variant="secondary" aria-pressed={f.grid} onPress={() => update({ grid: !f.grid })}>
          <Trans>Grid</Trans>
        </Button>
        <Button
          variant="ghost"
          onPress={() => onFilters({ ...browseDefaults, mode: f.mode, grid: f.grid })}
        >
          <Trans>Clear all</Trans>
        </Button>
      </div>
      {advanced && (
        <div className="kept-card">
          <MultiFilter
            label={t`Rooms`}
            options={rooms}
            selected={f.rooms}
            update={(rooms) => update({ rooms })}
          />
          <MultiFilter
            label={t`Containers`}
            options={boxes}
            selected={f.bins}
            update={(bins) => update({ bins })}
          />
          <MultiFilter
            label={t`Categories`}
            options={tagOptions}
            selected={f.tags}
            update={(tags) => update({ tags })}
          />
          <MultiFilter
            label={t`Type`}
            options={cache.types}
            selected={f.types}
            update={(types) => update({ types })}
          />
          <MultiFilter
            label={t`Brand`}
            options={brands}
            selected={f.brands}
            update={(brands) => update({ brands })}
          />
          <Select
            label={t`Status`}
            items={options}
            selectedKey={f.state}
            onSelectionChange={(key) => update({ state: key as BrowseFilters['state'] })}
          >
            {(item) => <SelectItem id={item.id}>{item.name}</SelectItem>}
          </Select>
          <Select
            label={t`Sort`}
            items={[
              { id: 'name', name: t`Name` },
              { id: 'location', name: t`Recorded location` },
              ...(useCache
                ? []
                : [
                    { id: 'recorded', name: t`Recorded at` },
                    { id: 'updated', name: t`Last modified` },
                  ]),
              { id: 'lastSeen', name: t`Last recorded activity` },
            ]}
            selectedKey={displayedSort}
            onSelectionChange={(key) => update({ sort: key as Sort })}
          >
            {(item) => <SelectItem id={item.id}>{item.name}</SelectItem>}
          </Select>
          <Button
            variant="secondary"
            aria-pressed={f.nested}
            onPress={() => update({ nested: !f.nested })}
          >
            <Trans>Include nested contents</Trans>
          </Button>
          <Button
            variant="secondary"
            aria-pressed={f.inherit}
            onPress={() => update({ inherit: !f.inherit })}
          >
            <Trans>Include contents of matching bins</Trans>
          </Button>
          <Button
            variant="secondary"
            aria-pressed={f.untagged}
            onPress={() => update({ untagged: !f.untagged })}
          >
            <Trans>Uncategorized</Trans>
          </Button>
          <Button
            variant="secondary"
            aria-pressed={f.categoryMode === 'all'}
            onPress={() => update({ categoryMode: f.categoryMode === 'all' ? 'any' : 'all' })}
          >
            <Trans>Require all selected categories</Trans>
          </Button>
          <Button
            variant="secondary"
            aria-pressed={f.groupMode === 'any'}
            onPress={() => update({ groupMode: f.groupMode === 'any' ? 'all' : 'any' })}
          >
            <Trans>Match any filter group</Trans>
          </Button>
        </div>
      )}
      <div className="flex flex-wrap gap-1">
        {(
          [
            ['rooms', rooms],
            ['bins', boxes],
            ['tags', tagOptions],
            ['types', cache.types],
            ['brands', brands],
          ] as const
        ).flatMap(([group, items]) =>
          f[group].map((id) => (
            <Button
              key={group + id}
              size="small"
              variant="secondary"
              onPress={() => update({ [group]: f[group].filter((key) => key !== id) })}
            >
              <bdi>{items.find((item) => item.id === id)?.name ?? id}</bdi>
              <span aria-hidden>×</span>
            </Button>
          )),
        )}
        {f.untagged && (
          <Button size="small" variant="secondary" onPress={() => update({ untagged: false })}>
            <Trans>Uncategorized</Trans>
            <span aria-hidden>×</span>
          </Button>
        )}
        {f.state !== 'all' && (
          <Button size="small" variant="secondary" onPress={() => update({ state: 'all' })}>
            {options.find((item) => item.id === f.state)?.name}
            <span aria-hidden>×</span>
          </Button>
        )}
      </div>
      {(advanced ||
        f.rooms.length + f.tags.length + f.bins.length + f.types.length + f.brands.length > 0) && (
        <p className="m-0 text-small">
          {f.groupMode === 'any' ? t`Match any filter group` : t`Match every filter group`}
          {sep()}
          {f.categoryMode === 'all'
            ? t`Require all selected categories`
            : t`Match any selected category`}
        </p>
      )}
      {f.mode === 'categories' && (
        <Button
          variant="secondary"
          aria-pressed={f.untagged}
          onPress={() =>
            update({ tags: [], untagged: !f.untagged, inherit: false, groupMode: 'all' })
          }
        >
          <Trans>Uncategorized</Trans>
        </Button>
      )}
      {(f.mode === 'categories' || selected.length > 0) && owner?.ownerAccountId && (
        <>
          {accounts.length > 1 && (
            <Select
              label={t`Account`}
              items={accounts}
              selectedKey={owner.id}
              onSelectionChange={(key) => {
                setAccount(accounts.find((l) => l.id === key)?.ownerAccountId ?? '');
                setSelected([]);
                update({ brands: [] });
              }}
            >
              {(item) => <SelectItem id={item.id}>{item.name}</SelectItem>}
            </Select>
          )}
          <CategoryEditor
            key={owner.ownerAccountId}
            connection={connection}
            online={online}
            accountId={owner.ownerAccountId}
            cached={tagOptions.filter((tag) => tag.accountId === owner.ownerAccountId)}
            manage={f.mode === 'categories' && (owner.role === 'owner' || owner.role === 'admin')}
            things={selected.length ? selected : undefined}
            onPick={(tag) =>
              update({ tags: [tag.id], untagged: false, inherit: false, groupMode: 'all' })
            }
            onChange={() => {
              setRevision((value) => value + 1);
              onInventoryChanged();
            }}
          />
        </>
      )}
      {useCache && (
        <p className="m-0 text-small text-ink-2">
          <Trans>Showing cached inventory</Trans>
          {cache.truncated && (
            <>
              {' '}
              <Trans>Some items are missing from this device.</Trans>
            </>
          )}
        </p>
      )}
      {needsOnlineFilter && (
        <p>
          <Trans>Needs a connection</Trans>
        </p>
      )}
      {count !== undefined && (
        <p role="status" className="m-0 text-small text-ink-2">
          {t`Matches`} {count}
        </p>
      )}
      {count === 0 && (
        <p>
          <Trans>No matching items</Trans>
        </p>
      )}
      {error && online ? <p role="alert">{errorText(error)}</p> : null}
      <ul className={f.grid ? 'grid grid-cols-2 gap-2' : 'grid gap-2'}>
        {rows.map((row) => {
          const cachedCategoryMatch =
            f.inherit &&
            f.tags.length > 0 &&
            !matchTags(
              row.tags.map((tag) => tag.id),
              f.tags,
              f.categoryMode === 'all',
            ) &&
            cache.things.some(
              (box) =>
                box.isContainer &&
                row.ancestors.includes(box.id) &&
                matchTags(box.tagIds ?? [], f.tags, f.categoryMode === 'all'),
            );
          const inBox = useCache
            ? cachedCategoryMatch
            : page?.categoryInheritedIds?.includes(row.id);
          const writable = cache.locations.some(
            (l) =>
              l.id === row.locationId &&
              l.role !== 'viewer' &&
              l.ownerAccountId === owner?.ownerAccountId,
          );
          const selectable = online && writable;
          const name = row.name ?? t`Untitled`;
          const boxType = cache.types.find(
            (type) =>
              type.id === row.typeId && builtinType(type.builtinKey ?? '')?.parent === 'box_bin',
          );
          return (
            <li key={row.id} className="min-w-0">
              <div className="relative flex h-full min-w-0 items-stretch rounded-lg border border-line bg-surface">
                {selectable && (
                  <label
                    className={`flex size-11 shrink-0 cursor-pointer items-center justify-center ${
                      f.grid
                        ? 'absolute start-1 top-1 z-10 rounded-lg bg-surface shadow-sm'
                        : 'self-center'
                    }`}
                  >
                    <input
                      className="size-5 cursor-pointer"
                      type="checkbox"
                      checked={selected.includes(row.id)}
                      onChange={(event) =>
                        setSelected((prev) =>
                          event.target.checked
                            ? [...prev, row.id]
                            : prev.filter((id) => id !== row.id),
                        )
                      }
                    />
                    <span className="sr-only">
                      <Trans>Select</Trans> <bdi>{name}</bdi>
                    </span>
                  </label>
                )}
                <Button
                  className={
                    f.grid
                      ? `min-w-0 flex-1 flex-col items-start p-2${selectable && !row.thumb ? ' pt-12' : ''}`
                      : 'kept-phone-row min-w-0 flex-1'
                  }
                  variant="ghost"
                  onPress={() => onOpen({ id: row.id, locationId: row.locationId, kind: 'thing' })}
                >
                  {row.thumb ? (
                    <PhotoImage
                      src={row.thumb}
                      rotation={row.thumbnailRotation}
                      className={f.grid ? 'aspect-square w-full rounded-lg' : 'kept-thumb'}
                    />
                  ) : (
                    <Package size={20} aria-hidden />
                  )}
                  <span className="kept-row-body text-start">
                    <bdi>{name}</bdi>
                    {f.mode === 'bins' && boxType && (
                      <span className="text-small">
                        {typeName({
                          ...boxType,
                          name: boxType.name === boxType.builtinKey ? null : boxType.name,
                        })}
                      </span>
                    )}
                    <span className="text-small">
                      <bdi>{row.path}</bdi>
                    </span>
                    {row.tags.length > 0 && (
                      <span className="flex flex-wrap gap-1">
                        {row.tags.map((tag) => (
                          <bdi key={tag.id} className="rounded-md bg-sunken px-2 py-0.5 text-small">
                            {tag.name}
                          </bdi>
                        ))}
                      </span>
                    )}
                    {row.shortCode && <bdi className="text-small">{row.shortCode}</bdi>}
                    {f.mode === 'bins' && cache.things.some((item) => item.id === row.id) && (
                      <span className="text-small">
                        <Trans>Contents</Trans>{' '}
                        {
                          cache.things.filter(
                            (item) =>
                              item.containerId === row.id && item.reviewState === 'confirmed',
                          ).length
                        }
                      </span>
                    )}
                    {inBox && (
                      <span className="text-small">
                        <Trans>Inside a matching container</Trans>
                      </span>
                    )}
                  </span>
                </Button>
                {f.mode === 'bins' &&
                  cache.locations.some(
                    (location) => location.id === row.locationId && location.role !== 'viewer',
                  ) && (
                    <Button
                      variant="ghost"
                      aria-label={t`Add to ${name}`}
                      onPress={() =>
                        onAddToBox({
                          id: row.id,
                          locationId: row.locationId,
                          name,
                          kind: 'box',
                          path: [row.path, name].filter(Boolean).join(' › '),
                        })
                      }
                    >
                      <Plus size={20} aria-hidden />
                    </Button>
                  )}
              </div>
            </li>
          );
        })}
      </ul>
      {online && !useCache && page?.next_cursor && (
        <Button
          variant="secondary"
          onPress={() => {
            const requested = page;
            void transport
              .request<BrowsePage>(
                connection,
                `${inventoryPaths.things}${query}&${qs({ cursor: page.next_cursor }).slice(1)}`,
              )
              .then((next) =>
                setPage((previous) =>
                  previous === requested
                    ? {
                        ...next,
                        items: [...previous.items, ...next.items],
                        categoryInheritedIds: [
                          ...(previous.categoryInheritedIds ?? []),
                          ...(next.categoryInheritedIds ?? []),
                        ],
                      }
                    : previous,
                ),
              )
              .catch(setError);
          }}
        >
          <Trans>Load more</Trans>
        </Button>
      )}
    </section>
  );
}
