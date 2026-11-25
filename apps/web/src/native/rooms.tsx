import { type LocationDestination, newId } from '@kept/shared';
import { Trans, useLingui } from '@lingui/react/macro';
import { ChevronDown, ChevronRight, MapPin, Package, Plus } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { inventoryPaths } from '@/api/inventory/paths';
import type { BuiltinPlaceKind, CreatePlaceBody, PlaceView } from '@/api/inventory/types';
import { useErrorText } from '@/components/page';
import { Button } from '@/components/ui/button';
import { Select, SelectItem } from '@/components/ui/select';
import { TextField } from '@/components/ui/text-field';
import { matchesAll, queryWords } from '@/offline/local-search';
import { usePlatform } from './adapters';
import { ScreenHeader } from './back-button';
import type { Connection } from './bridge';
import {
  ancestorsOf,
  LocationPicker,
  PlacePreview,
  useLocationDestinations,
  writableLocations,
} from './destination';
import type { InventoryCache } from './inventory';
import type { Target } from './labels';
import {
  ensureCaptureCompatible,
  isAuthRefusal,
  isRestoreEpochMismatch,
  ReplayError,
  saveOnPhone,
} from './outbox';
import { PlaceKindSelect } from './place-kind-select';

type AuthHandler = (reason: 'expired' | 'restored') => void;

export function PlaceCreateForm({
  cache,
  connection,
  online,
  parent,
  onCreated,
  onClose,
  onAuthError,
}: {
  cache: InventoryCache;
  connection: Connection;
  online: boolean;
  parent?: { id: string; locationId: string; kindKey: string } | undefined;
  onCreated: (target: Target) => void;
  onClose: () => void;
  onAuthError?: AuthHandler | undefined;
}) {
  const { t } = useLingui();
  const adapters = usePlatform();
  const errorText = useErrorText();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [kind, setKind] = useState<BuiltinPlaceKind>(
    parent && parent.kindKey !== 'floor' ? 'zone' : 'room',
  );
  const [descriptionSupported, setDescriptionSupported] = useState(false);
  const [id, setId] = useState(newId);
  const locations = writableLocations(cache);
  const [locationId, setLocationId] = useState(parent?.locationId ?? locations[0]?.id ?? null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  useEffect(() => {
    if (!online) return;
    let current = true;
    void ensureCaptureCompatible(connection, adapters)
      .then((caps) => {
        if (current) setDescriptionSupported(caps.placeDescriptions === true);
      })
      .catch(() => {
        if (current) setDescriptionSupported(false);
      });
    return () => {
      current = false;
    };
  }, [adapters, connection, online]);

  async function create() {
    if (busy || !locationId || !name.trim()) return;
    setBusy(true);
    setStatus('');
    try {
      const text = description.trim();
      const pendingParent = parent && cache.pendingPlaceIds?.includes(parent.id);
      if (!online || pendingParent) {
        const id = await saveOnPhone(
          connection,
          {
            locationId,
            name: name.trim(),
            placeCreation: {
              parentId: parent?.id ?? null,
              kindKey: kind,
              description: text || null,
            },
            ...(pendingParent ? { dependsOnPlace: parent.id } : {}),
          },
          [],
          adapters,
        );
        onCreated({ kind: 'place', id, locationId });
        return;
      }
      if (text && !(await ensureCaptureCompatible(connection, adapters)).placeDescriptions)
        throw new ReplayError('compatibility_hold');
      const body: CreatePlaceBody = {
        id,
        name: name.trim(),
        kindKey: kind,
        ...(parent ? { parentId: parent.id } : {}),
        ...(text ? { description: text } : {}),
      };
      const place = await adapters.transport.request<PlaceView>(
        connection,
        inventoryPaths.locationPlaces(locationId),
        { method: 'POST', body, idempotencyKey: id },
      );
      onCreated({ kind: 'place', id: place.id, locationId: place.locationId });
    } catch (error) {
      if (isAuthRefusal(error)) onAuthError?.('expired');
      else if (isRestoreEpochMismatch(error)) onAuthError?.('restored');
      else if (error instanceof ReplayError && error.reason === 'compatibility_hold')
        setStatus(t`Update this SheepKeep server to use this action.`);
      else setStatus(errorText(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      className="kept-card"
      onSubmit={(event) => {
        event.preventDefault();
        void create();
      }}
    >
      <TextField
        label={t`Name`}
        value={name}
        maxLength={120}
        isDisabled={busy}
        onChange={(value) => {
          setName(value);
          setId(newId());
        }}
      />
      <PlaceKindSelect
        value={kind}
        disabled={busy}
        onChange={(value) => {
          setKind(value);
          setId(newId());
        }}
      />
      {(!online || descriptionSupported || description) && (
        <TextField
          label={t`Description`}
          value={description}
          maxLength={500}
          isDisabled={busy}
          onChange={(value) => {
            setDescription(value);
            setId(newId());
          }}
        />
      )}
      {!parent && (
        <LocationPicker
          cache={cache}
          value={locationId}
          disabled={busy}
          onChange={(value) => {
            setLocationId(value);
            setId(newId());
          }}
        />
      )}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" isPending={busy} isDisabled={!locationId || !name.trim()}>
          <Plus size={16} aria-hidden />
          {parent ? <Trans>Add sub-location</Trans> : <Trans>Create place</Trans>}
        </Button>
        <Button variant="ghost" isDisabled={busy} onPress={onClose}>
          <Trans>Cancel</Trans>
        </Button>
      </div>
      {status && <p role="alert">{status}</p>}
    </form>
  );
}

export function Places({
  cache,
  connection,
  online,
  onOpen,
  onCreated,
  onClose,
  onAuthError,
}: {
  cache: InventoryCache;
  connection: Connection;
  online: boolean;
  onOpen: (target: Target) => void;
  onCreated: (target: Target) => void;
  onClose: () => void;
  onAuthError: AuthHandler;
}) {
  const { t } = useLingui();
  const [adding, setAdding] = useState(false);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<string>();
  const locations = cache.locations;
  const active = locations.find((location) => location.id === filter);
  return (
    <section className="grid gap-4">
      <ScreenHeader
        title={<Trans>Places</Trans>}
        onBack={onClose}
        icon={<MapPin size={18} aria-hidden />}
        trailing={
          !adding && (
            <Button
              size="small"
              isDisabled={!writableLocations(cache).length}
              onPress={() => setAdding(true)}
            >
              <Plus size={16} aria-hidden />
              <Trans>Create place</Trans>
            </Button>
          )
        }
      />
      {adding && (
        <PlaceCreateForm
          {...{ cache, connection, online, onCreated, onAuthError }}
          onClose={() => setAdding(false)}
        />
      )}
      <TextField label={t`Search places`} value={query} onChange={setQuery} />
      {locations.length > 1 && (
        <Select
          label={t`Location`}
          items={[{ id: 'all', name: t`All locations` }, ...locations]}
          selectedKey={active?.id ?? 'all'}
          onSelectionChange={(key) =>
            setFilter(typeof key === 'string' && key !== 'all' ? key : undefined)
          }
        >
          {(item) => (
            <SelectItem id={item.id} textValue={item.name}>
              <bdi>{item.name}</bdi>
            </SelectItem>
          )}
        </Select>
      )}
      {(active ? [active] : locations).map(({ id, name }) => (
        <LocationPlaces
          key={id}
          {...{ cache, connection, online, query, onOpen }}
          locationId={id}
          name={name}
        />
      ))}
    </section>
  );
}

function LocationPlaces({
  cache,
  connection,
  online,
  locationId,
  name,
  query,
  onOpen,
}: {
  cache: InventoryCache;
  connection: Connection;
  online: boolean;
  locationId: string;
  name: string;
  query: string;
  onOpen: (target: Target) => void;
}) {
  const { t } = useLingui();
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const { rows, incomplete, loading } = useLocationDestinations(
    cache,
    connection,
    locationId,
    online,
  );
  const byId = useMemo(() => new Map(rows.map((row) => [row.id, row])), [rows]);
  const children = useMemo(() => {
    const grouped = new Map<string | null, LocationDestination[]>();
    for (const row of rows) {
      const parent = row.parentId && byId.has(row.parentId) ? row.parentId : null;
      const group = grouped.get(parent) ?? [];
      group.push(row);
      grouped.set(parent, group);
    }
    for (const group of grouped.values()) {
      group.sort((a, b) =>
        (a.name ?? '').localeCompare(b.name ?? '', undefined, { numeric: true }),
      );
    }
    return grouped;
  }, [byId, rows]);
  const counts = useMemo(() => {
    const direct = new Map<string, number>();
    const total = new Map<string, number>();
    if (!cache.truncated) {
      for (const item of cache.things) {
        if (item.locationId !== locationId || item.reviewState !== 'confirmed') continue;
        const parent = item.containerId ?? item.placeId;
        if (parent) direct.set(parent, (direct.get(parent) ?? 0) + 1);
      }
      for (const [parent, count] of direct) {
        for (const { id } of ancestorsOf(parent, byId)) total.set(id, (total.get(id) ?? 0) + count);
      }
    }
    return { direct, total };
  }, [byId, cache.things, cache.truncated, locationId]);
  const search = queryWords(query);
  const searching = search.length > 0;
  const nameOf = (row: LocationDestination) => row.name ?? t`Untitled`;
  const pathOf = (row: LocationDestination) =>
    [name, ...ancestorsOf(row.id, byId).map(nameOf)].join(' › ');
  const shown = searching
    ? rows.filter((row) => matchesAll(queryWords([pathOf(row), row.description].join(' ')), search))
    : (children.get(null) ?? []);

  const render = (row: LocationDestination, ancestors = new Set<string>()) => {
    const nested = children.get(row.id) ?? [];
    const open = expanded.has(row.id);
    const breadcrumb = pathOf(row);
    const direct = counts.direct.get(row.id) ?? 0;
    const total = counts.total.get(row.id) ?? 0;
    return (
      <li key={row.id} className="grid gap-2">
        <div className="flex items-center gap-1">
          {!searching && nested.length > 0 && (
            <Button
              variant="ghost"
              size="small"
              aria-label={t`Expand or collapse ${nameOf(row)}`}
              aria-expanded={open}
              onPress={() =>
                setExpanded((previous) => {
                  const next = new Set(previous);
                  if (next.has(row.id)) next.delete(row.id);
                  else next.add(row.id);
                  return next;
                })
              }
            >
              {open ? (
                <ChevronDown size={16} aria-hidden />
              ) : (
                <ChevronRight size={16} className="rtl:rotate-180" aria-hidden />
              )}
            </Button>
          )}
          <Button
            variant="secondary"
            className="kept-phone-row flex-1"
            onPress={() =>
              onOpen({
                kind: row.kind === 'place' ? 'place' : 'thing',
                id: row.id,
                locationId,
              })
            }
          >
            <span className="kept-row-lead" aria-hidden>
              {row.kind === 'place' ? (
                <PlacePreview
                  connection={connection}
                  id={row.id}
                  online={online && !row.isUnplaced}
                />
              ) : (
                <Package size={18} />
              )}
            </span>
            <span className="kept-row-body">
              <bdi className="font-semibold">{nameOf(row)}</bdi>
              <bdi className="text-small font-normal text-ink-2">{breadcrumb}</bdi>
              {row.description && (
                <bdi className="text-small font-normal text-ink-2">{row.description}</bdi>
              )}
              {!cache.truncated && (
                <span className="text-small font-normal text-ink-2">
                  <Trans>
                    Direct items {direct} · All levels {total}
                  </Trans>
                </span>
              )}
            </span>
          </Button>
        </div>
        {!searching && open && (
          <ul
            className={
              ancestors.size < 3 ? 'ms-3 grid gap-2 border-s border-line ps-2' : 'grid gap-2'
            }
          >
            {nested
              .filter((child) => child.id !== row.id && !ancestors.has(child.id))
              .map((child) => render(child, new Set([...ancestors, row.id])))}
          </ul>
        )}
      </li>
    );
  };

  return (
    <section className="grid gap-2">
      <h3 className="kept-card-title">
        <bdi>{name}</bdi>
      </h3>
      {loading ? (
        <p role="status">
          <Trans>Loading places…</Trans>
        </p>
      ) : (
        incomplete && (
          <p className="text-small text-ink-2">
            <Trans>Some destinations are missing from this device.</Trans>
          </p>
        )
      )}
      {shown.length ? (
        <ul className="grid gap-2">{shown.map((row) => render(row))}</ul>
      ) : (
        <p className="text-small text-ink-2">
          <Trans>No places to show.</Trans>
        </p>
      )}
    </section>
  );
}
