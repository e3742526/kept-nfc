import type { LocationDestination } from '@kept/shared';
import { Trans, useLingui } from '@lingui/react/macro';
import { ChevronRight, MapPin, Package, QrCode } from 'lucide-react';
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { inventoryPaths } from '@/api/inventory/paths';
import { referencePhotos } from '@/components/places/reference-photos';
import { Button } from '@/components/ui/button';
import { Dialog, Modal } from '@/components/ui/dialog';
import { Select, SelectItem } from '@/components/ui/select';
import { usePlatform } from './adapters';
import type { Connection } from './bridge';
import { type InventoryCache, inventoryPath, loadPlace, previewUrl } from './inventory';
import type { TagPlace } from './label-panel';
import type { Target } from './labels';
import { useOfflinePlacePhotos } from './place-photo-cache';
import { readRecentDestinations } from './recent-destinations';

const PlaceLabelScanner = lazy(async () => {
  const { LabelPanel } = await import('./label-panel');
  return { default: LabelPanel };
});

export type Destination = {
  id: string;
  locationId: string;
  name: string;
  path?: string;
  kind?: 'box' | 'place' | 'photos' | 'documents' | 'location-photo';
};

export function writableLocations(cache: InventoryCache) {
  return cache.locations.filter((location) => location.role !== 'viewer');
}

export function LocationPicker({
  cache,
  value,
  onChange,
  disabled,
}: {
  cache: InventoryCache;
  value: string | null;
  onChange: (id: string) => void;
  disabled?: boolean;
}) {
  const { t } = useLingui();
  return (
    <Select
      label={t`Location`}
      items={writableLocations(cache)}
      selectedKey={value}
      onSelectionChange={(key) => {
        if (key !== null) onChange(String(key));
      }}
      isDisabled={disabled}
    >
      {(item) => (
        <SelectItem id={item.id} textValue={item.name}>
          <bdi>{item.name}</bdi>
        </SelectItem>
      )}
    </Select>
  );
}

export function useLocationDestinations(
  cache: InventoryCache,
  connection: Connection,
  locationId: string | undefined,
  online: boolean,
) {
  const { transport } = usePlatform();
  const local = useMemo<LocationDestination[]>(
    () => [
      ...cache.places
        .filter((row) => row.locationId === locationId)
        .map((row) => ({
          ...row,
          kind: 'place' as const,
        })),
      ...cache.things
        .filter(
          (row) =>
            row.locationId === locationId && row.isContainer && row.reviewState === 'confirmed',
        )
        .map((row) => ({ ...row, kind: 'box' as const, parentId: row.containerId ?? row.placeId })),
    ],
    [cache.places, cache.things, locationId],
  );
  const [live, setLive] = useState<{ locationId: string; rows: LocationDestination[] }>();
  const [failed, setFailed] = useState<string>();
  // biome-ignore lint/correctness/useExhaustiveDependencies: a newly loaded snapshot invalidates the live fallback.
  useEffect(() => {
    if (!locationId || !online || !cache.truncated) return;
    let current = true;
    setLive(undefined);
    setFailed(undefined);
    void transport
      .request<LocationDestination[]>(connection, inventoryPaths.locationDestinations(locationId))
      .then((rows) => {
        if (current && Array.isArray(rows)) setLive({ locationId, rows });
        else if (current) setFailed(locationId);
      })
      .catch(() => {
        if (current) setFailed(locationId);
      });
    return () => {
      current = false;
    };
  }, [cache.asOf, cache.truncated, connection, locationId, online, transport]);

  const liveRows = online && live?.locationId === locationId ? live?.rows : undefined;
  const rows = liveRows
    ? [
        ...liveRows,
        ...local.filter(
          ({ id }) => cache.pendingPlaceIds?.includes(id) && !liveRows.some((r) => r.id === id),
        ),
      ]
    : local;
  return {
    rows,
    incomplete: cache.truncated && rows === local,
    loading: !!locationId && cache.truncated && online && rows === local && failed !== locationId,
  };
}

export function ancestorsOf(id: string | null, byId: ReadonlyMap<string, LocationDestination>) {
  const path: LocationDestination[] = [];
  const seen = new Set<string>();
  while (id && !seen.has(id)) {
    seen.add(id);
    const row = byId.get(id);
    if (!row) break;
    path.unshift(row);
    id = row.parentId;
  }
  return path;
}

export function PlacePreview({
  connection,
  id,
  online,
}: {
  connection: Connection;
  id: string;
  online: boolean;
}) {
  const adapters = usePlatform();
  const [thumb, setThumb] = useState<{ id: string; src: string }>();
  const cachedPhotos = useOfflinePlacePhotos(connection, id, online);
  const marker = useRef<HTMLSpanElement>(null);
  const src = online && thumb?.id === id ? thumb.src : cachedPhotos?.[0]?.file?.thumbUrl;

  useEffect(() => {
    if (!online) return;
    let active = true;
    const load = () => {
      void loadPlace(connection, id, adapters)
        .then((place) => {
          const src = previewUrl(
            referencePhotos(place.attachments)[0]?.file?.thumbUrl,
            connection.origin,
          );
          if (active) setThumb(src ? { id, src } : undefined);
        })
        .catch(() => {
          if (active) setThumb(undefined);
        });
    };
    const observer =
      typeof IntersectionObserver === 'undefined'
        ? undefined
        : new IntersectionObserver(([entry]) => {
            if (!entry?.isIntersecting || !active) return;
            observer?.disconnect();
            load();
          });
    if (observer && marker.current) observer.observe(marker.current);
    else load();
    return () => {
      active = false;
      observer?.disconnect();
    };
  }, [adapters, connection, id, online]);

  return (
    <span ref={marker}>
      {src ? (
        <img src={src} alt="" className="kept-thumb" loading="lazy" referrerPolicy="no-referrer" />
      ) : (
        <MapPin size={18} aria-hidden />
      )}
    </span>
  );
}

export function DestinationPicker({
  cache,
  connection,
  online,
  value,
  onChange,
  disabled,
  placesOnly,
  boxesOnly,
  onlyLocation,
  exclude,
  forParent,
  offerTagWrite,
  onAuthError,
}: {
  cache: InventoryCache;
  connection: Connection;
  online: boolean;
  value: Destination | undefined;
  onChange: (destination: Destination | undefined) => void;
  disabled?: boolean;
  placesOnly?: boolean;
  boxesOnly?: boolean;
  onlyLocation?: string;
  exclude?: string;
  /** Reparenting permits the location root and excludes Unplaced and all boxes. */
  forParent?: boolean;
  /** Adding: a blank NFC tag scanned in Scan place label can be written for the chosen place. */
  offerTagWrite?: boolean;
  onAuthError?: ((reason: 'expired' | 'restored') => void) | undefined;
}) {
  const { t } = useLingui();
  const adapters = usePlatform();
  const locations = writableLocations(cache);
  const [locationId, setLocationId] = useState(value?.locationId);
  const location =
    locations.find((entry) => entry.id === (onlyLocation ?? locationId)) ??
    (onlyLocation ? undefined : locations[0]);
  const [branchId, setBranchId] = useState<string>();
  const [recent, setRecent] = useState<string[]>([]);
  const [scannerOpen, setScannerOpen] = useState(false);
  const scanGeneration = useRef(0);
  useEffect(
    () => () => {
      scanGeneration.current++;
    },
    [],
  );
  useEffect(() => {
    let current = true;
    void readRecentDestinations(connection, adapters).then((ids) => {
      if (current) setRecent(ids);
    });
    return () => {
      current = false;
    };
  }, [adapters, connection]);

  const { rows, incomplete, loading } = useLocationDestinations(
    cache,
    connection,
    location?.id,
    online,
  );
  const byId = new Map(rows.map((row) => [row.id, row]));
  const allowed = (row: LocationDestination) =>
    (!(placesOnly || forParent) || row.kind === 'place') &&
    (!forParent || !row.isUnplaced) &&
    (!exclude || !ancestorsOf(row.id, byId).some(({ id }) => id === exclude));
  const locationName = location?.name;
  const selected = value && byId.get(value.id);
  const branch = (branchId && byId.get(branchId)) || undefined;
  const parent = branch?.id ?? null;
  const eligible = rows.filter(allowed);
  const parents = new Set(eligible.map((row) => row.parentId));
  const siblings = eligible.filter(
    (row) =>
      row.parentId === parent || (parent === null && row.parentId && !byId.has(row.parentId)),
  );
  const label = (row: LocationDestination) => row.name ?? t`Untitled`;
  const pathOf = (row: LocationDestination) =>
    [locationName, ...ancestorsOf(row.id, byId).map(label)].filter(Boolean).join(' › ');
  const choose = (row: LocationDestination) =>
    onChange({
      id: row.id,
      locationId: row.locationId,
      name: label(row),
      kind: row.kind,
      path: pathOf(row),
    });
  const recentRows = recent.flatMap((id) => {
    const row = byId.get(id);
    return row && allowed(row) && (!boxesOnly || row.kind === 'box') ? [row] : [];
  });
  function closeScanner() {
    scanGeneration.current++;
    setScannerOpen(false);
  }

  // Writing a tag needs the chosen place to take a label (never Unplaced), a connection over
  // HTTPS, and the Labels module; null tells the scanner it could write but has nothing to write for.
  const tagTarget = selected ?? branch;
  const tagPlace: TagPlace | null | undefined = !offerTagWrite
    ? undefined
    : online &&
        connection.origin.startsWith('https://') &&
        location?.effectiveModules?.includes('labels') &&
        tagTarget?.kind === 'place' &&
        !tagTarget.isUnplaced
      ? { id: tagTarget.id, name: label(tagTarget), locationId: tagTarget.locationId }
      : null;

  async function chooseScannedPlace(target: Target) {
    const generation = scanGeneration.current;
    const here = locations.find(({ id }) => id === target.locationId);
    if (!here || (onlyLocation && target.locationId !== onlyLocation))
      return t`This place is outside the available destinations.`;
    const cachedPlace = cache.places.find(({ id }) => id === target.id);
    const place = online ? await loadPlace(connection, target.id, adapters) : cachedPlace;
    if (generation !== scanGeneration.current) return;
    if (!place || place.locationId !== here.id)
      return t`This place is outside the available destinations.`;

    const ancestors =
      'path' in place
        ? place.path
        : ancestorsOf(
            place.id,
            new Map(cache.places.map((row) => [row.id, { ...row, kind: 'place' as const }])),
          );
    if ((forParent && place.isUnplaced) || ancestors.some(({ id }) => id === exclude))
      return t`Choose a different place.`;
    if (forParent && !online && cache.truncated)
      return t`Connect to check where this place belongs.`;
    const path = (
      'path' in place
        ? [here.name, ...place.path.map(({ name }) => name)]
        : [...inventoryPath(cache, place), place.name]
    ).join(' › ');
    setLocationId(here.id);
    setBranchId(place.id);
    onChange({ id: place.id, locationId: here.id, name: place.name, kind: 'place', path });
    closeScanner();
  }

  return (
    <fieldset className="grid min-w-0 gap-2" aria-label={t`Destination`}>
      {!onlyLocation && (
        <LocationPicker
          cache={cache}
          value={location?.id ?? null}
          disabled={disabled}
          onChange={(id) => {
            setLocationId(id);
            setBranchId(undefined);
            const next = locations.find((entry) => entry.id === id);
            onChange(next && !boxesOnly ? defaultDestination(cache, id) : undefined);
          }}
        />
      )}
      {(selected || value?.path) && (
        <div className="kept-destination flex items-center gap-2 rounded-lg border border-line p-2">
          {selected?.kind === 'place' && !selected.isUnplaced ? (
            <PlacePreview connection={connection} id={selected.id} online={online} />
          ) : (
            <Package size={18} aria-hidden />
          )}
          <bdi>{selected ? pathOf(selected) : value?.path}</bdi>
        </div>
      )}
      {branch ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="small"
            variant="secondary"
            isDisabled={disabled}
            onPress={() => setBranchId(branch.parentId ?? undefined)}
          >
            <Trans>Back</Trans>
          </Button>
          <bdi className="text-small">{pathOf(branch)}</bdi>
        </div>
      ) : (
        forParent &&
        location && (
          <Button
            variant="secondary"
            size="small"
            isDisabled={disabled}
            onPress={() =>
              onChange({
                id: location.id,
                name: location.name,
                locationId: location.id,
                path: location.name,
                kind: 'place',
              })
            }
          >
            <Trans>Top level</Trans>
          </Button>
        )
      )}
      {branch && (!boxesOnly || branch.kind === 'box') && (
        <Button
          variant="secondary"
          size="small"
          isDisabled={disabled}
          onPress={() => choose(branch)}
        >
          <Trans>Choose this destination</Trans>
        </Button>
      )}
      <Select
        label={placesOnly || forParent ? t`Room or place` : t`Room or box`}
        items={siblings}
        selectedKey={null}
        isDisabled={disabled || siblings.length === 0}
        onSelectionChange={(key) => {
          const row = byId.get(String(key));
          if (!row) return;
          setBranchId(row.id);
          if (!boxesOnly || row.kind === 'box') choose(row);
        }}
      >
        {(item) => (
          <SelectItem id={item.id} textValue={label(item)}>
            <bdi>{label(item)}</bdi>
            {parents.has(item.id) && (
              <ChevronRight size={14} className="ms-2 inline rtl:rotate-180" aria-hidden />
            )}
          </SelectItem>
        )}
      </Select>
      {!branch && !forParent && recentRows.length > 0 && (
        <Select
          label={t`Recent destinations`}
          items={recentRows}
          selectedKey={null}
          isDisabled={disabled}
          onSelectionChange={(key) => {
            const row = byId.get(String(key));
            if (row) {
              setBranchId(row.id);
              choose(row);
            }
          }}
        >
          {(row) => (
            <SelectItem id={row.id} textValue={pathOf(row)}>
              <bdi>{pathOf(row)}</bdi>
            </SelectItem>
          )}
        </Select>
      )}
      {!boxesOnly && (
        <Button
          variant="secondary"
          size="small"
          className="justify-self-start"
          isDisabled={disabled || !locations.length}
          onPress={() => setScannerOpen(true)}
        >
          <QrCode size={16} aria-hidden />
          <Trans>Scan place label</Trans>
        </Button>
      )}
      {scannerOpen && (
        <Modal
          isOpen
          onOpenChange={(open) => {
            if (!open) closeScanner();
          }}
        >
          <Dialog title={<Trans>Scan place label</Trans>}>
            <Suspense
              fallback={
                <p role="status">
                  <Trans>Loading…</Trans>
                </p>
              }
            >
              <PlaceLabelScanner
                connection={connection}
                cache={cache}
                action="identify"
                placeOnly
                onOpen={chooseScannedPlace}
                onClose={closeScanner}
                {...(tagPlace !== undefined ? { tagPlace } : {})}
                {...(onAuthError ? { onAuthError } : {})}
              />
            </Suspense>
          </Dialog>
        </Modal>
      )}
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
    </fieldset>
  );
}

/** A place or an open box by id, while its location is writable on this phone. */
export function resolveDestination(cache: InventoryCache, id: string): Destination | undefined {
  const place = cache.places.find((entry) => entry.id === id && !entry.deleted);
  const box = place
    ? undefined
    : cache.things.find(
        (entry) => entry.id === id && entry.isContainer && entry.lifecycle === 'in_use',
      );
  const row = place ?? box;
  if (!row || !writableLocations(cache).some(({ id: locationId }) => locationId === row.locationId))
    return;
  return { id, locationId: row.locationId, name: row.name ?? '', kind: place ? 'place' : 'box' };
}

/**
 * Where Add starts: the place or box the last item or box was added to, while it is still an
 * open, writable destination in the default location (when one is set). Otherwise that
 * location's Unplaced.
 */
export function addDestination(
  cache: InventoryCache,
  last: Destination | undefined,
  preferredLocationId?: string,
): Destination | undefined {
  const found =
    last &&
    (!preferredLocationId || last.locationId === preferredLocationId) &&
    resolveDestination(cache, last.id);
  if (!last || !found) return defaultDestination(cache, preferredLocationId);
  return { ...found, name: found.name || last.name };
}

export function defaultDestination(
  cache: InventoryCache,
  preferredId?: string,
): Destination | undefined {
  const locations = writableLocations(cache);
  const location = locations.find(({ id }) => id === preferredId) ?? locations[0];
  if (!location) return;
  const place = cache.places.find((entry) => entry.id === location.unplacedPlaceId);
  return {
    id: location.unplacedPlaceId,
    name: place?.name ?? location.name,
    path: place ? [location.name, place.name].join(' › ') : location.name,
    locationId: location.id,
    kind: 'place',
  };
}
