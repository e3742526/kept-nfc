import { newId } from '@kept/shared';
import { Trans, useLingui } from '@lingui/react/macro';
import { ChevronRight, Clock, MapPin, Package, Plus, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { inventoryPaths } from '@/api/inventory/paths';
import type { CreatePlaceBody, PlaceView } from '@/api/inventory/types';
import { useErrorText } from '@/components/page';
import { Button } from '@/components/ui/button';
import { Select, SelectItem } from '@/components/ui/select';
import { TextField } from '@/components/ui/text-field';
import { sep } from '@/lib/format';
import { usePlatform } from './adapters';
import { ScreenHeader } from './back-button';
import type { Connection } from './bridge';
import { LocationPicker, writableLocations } from './destination';
import { type InventoryCache, inventoryPath, previewUrl } from './inventory';
import type { Target } from './labels';
import { isAuthRefusal, isRestoreEpochMismatch } from './outbox';

export function Rooms({
  cache,
  connection,
  online,
  recent,
  onOpen,
  onCreated,
  onClose,
  onAuthError,
}: {
  cache: InventoryCache;
  connection: Connection;
  online: boolean;
  recent: string[];
  onOpen: (target: Target) => void;
  onCreated: (target: Target) => void;
  onClose: () => void;
  onAuthError: (reason: 'expired' | 'restored') => void;
}) {
  const { t } = useLingui();
  const adapters = usePlatform();
  const errorText = useErrorText();
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [id, setId] = useState(newId);
  const locations = writableLocations(cache);
  const [locationId, setLocationId] = useState(locations[0]?.id ?? null);
  const [locationFilter, setLocationFilter] = useState<string | null>(null);
  const activeLocation = cache.locations.some((location) => location.id === locationFilter)
    ? locationFilter
    : null;
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const boxes = recent.flatMap((boxId) =>
    cache.things.filter((thing) => thing.id === boxId && thing.isContainer),
  );
  const rooms = cache.places.filter(
    (place) =>
      place.kindKey === 'room' &&
      !place.isUnplaced &&
      (!activeLocation || place.locationId === activeLocation),
  );

  async function create() {
    if (busy || !online || !locationId || !name.trim()) return;
    setBusy(true);
    setStatus('');
    try {
      const body: CreatePlaceBody = { id, name: name.trim(), kindKey: 'room' };
      const room = await adapters.transport.request<PlaceView>(
        connection,
        inventoryPaths.locationPlaces(locationId),
        { method: 'POST', body, idempotencyKey: id },
      );
      onCreated({ kind: 'place', id: room.id, locationId: room.locationId });
    } catch (error) {
      if (isAuthRefusal(error)) onAuthError('expired');
      else if (isRestoreEpochMismatch(error)) onAuthError('restored');
      else setStatus(errorText(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="grid gap-4">
      <ScreenHeader
        title={<Trans>Rooms</Trans>}
        onBack={onClose}
        icon={<MapPin size={18} aria-hidden />}
        trailing={
          !adding && (
            <Button
              size="small"
              isDisabled={!online || !locations.length}
              onPress={() => setAdding(true)}
            >
              <Plus size={16} aria-hidden />
              <Trans>Create room</Trans>
            </Button>
          )
        }
      />
      {adding && (
        <form
          className="kept-card"
          onSubmit={(event) => {
            event.preventDefault();
            void create();
          }}
        >
          <TextField
            label={t`Room name`}
            value={name}
            onChange={(value) => {
              setName(value);
              setId(newId());
            }}
            isDisabled={busy}
            inputProps={{ maxLength: 120 }}
          />
          <LocationPicker
            cache={cache}
            value={locationId}
            onChange={(value) => {
              setLocationId(value);
              setId(newId());
            }}
            disabled={busy}
          />
          <div className="flex flex-wrap gap-2">
            <Button
              type="submit"
              isPending={busy}
              isDisabled={!online || !locationId || !name.trim()}
            >
              <Plus size={16} aria-hidden />
              <Trans>Create room</Trans>
            </Button>
            <Button variant="ghost" isDisabled={busy} onPress={() => setAdding(false)}>
              <X size={16} aria-hidden />
              <Trans>Cancel</Trans>
            </Button>
          </div>
          {status && <p role="alert">{status}</p>}
        </form>
      )}
      {cache.locations.length > 1 && (
        <Select
          label={t`Location`}
          items={[
            { id: 'all', name: t`All locations` },
            ...cache.locations.map((loc) => ({ id: loc.id, name: loc.name })),
          ]}
          selectedKey={activeLocation ?? 'all'}
          onSelectionChange={(key) =>
            setLocationFilter(key === null || key === 'all' ? null : String(key))
          }
        >
          {(item) => (
            <SelectItem id={item.id} textValue={item.name}>
              <bdi>{item.name}</bdi>
            </SelectItem>
          )}
        </Select>
      )}
      {boxes.length > 0 && (
        <section className="grid gap-2">
          <h3 className="kept-card-title text-ink-2">
            <Clock size={16} aria-hidden />
            <Trans>Recently opened boxes</Trans>
          </h3>
          <ul className="grid gap-2">
            {boxes.map((box) => (
              <li key={box.id}>
                <Button
                  variant="secondary"
                  className="kept-phone-row"
                  onPress={() => onOpen({ kind: 'thing', id: box.id, locationId: box.locationId })}
                >
                  <span className="kept-row-lead" aria-hidden>
                    <Package size={18} />
                  </span>
                  <span className="kept-row-body">
                    <bdi className="text-body font-semibold">{box.name ?? t`Untitled`}</bdi>
                    <bdi className="text-small font-normal text-ink-2">
                      {inventoryPath(cache, box).join(' › ')}
                    </bdi>
                  </span>
                  <ChevronRight size={18} className="kept-row-chevron rtl:rotate-180" aria-hidden />
                </Button>
              </li>
            ))}
          </ul>
        </section>
      )}
      {(!online || cache.truncated) && (
        <p className="text-small text-ink-2">
          <Trans>Showing cached inventory</Trans>
        </p>
      )}
      {rooms.length ? (
        <ul className="grid gap-2">
          {rooms.map((room) => (
            <li key={room.id}>
              <Button
                variant="secondary"
                className="kept-phone-row"
                onPress={() => onOpen({ kind: 'place', id: room.id, locationId: room.locationId })}
              >
                <span className="kept-row-lead" aria-hidden>
                  <RoomCover connection={connection} id={room.id} online={online} />
                </span>
                <span className="kept-row-body">
                  <bdi className="text-body font-semibold">{room.name}</bdi>
                  <span className="text-small font-normal text-ink-2">
                    <bdi>{inventoryPath(cache, room).join(' › ')}</bdi>
                    {sep()}
                    <Trans>Contents</Trans>{' '}
                    {
                      cache.things.filter(
                        (item) => item.placeId === room.id && item.reviewState === 'confirmed',
                      ).length
                    }
                  </span>
                </span>
                <ChevronRight size={18} className="kept-row-chevron rtl:rotate-180" aria-hidden />
              </Button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-ink-2">
          <Trans>No rooms yet.</Trans>
        </p>
      )}
    </section>
  );
}

function RoomCover({
  connection,
  id,
  online,
}: {
  connection: Connection;
  id: string;
  online: boolean;
}) {
  const { transport } = usePlatform();
  const marker = useRef<HTMLSpanElement>(null);
  const [thumb, setThumb] = useState<string>();
  useEffect(() => {
    if (!online || !marker.current || typeof IntersectionObserver === 'undefined') return;
    let active = true;
    const observer = new IntersectionObserver(([entry]) => {
      if (!entry?.isIntersecting) return;
      observer.disconnect();
      void transport
        .request<PlaceView>(connection, inventoryPaths.place(id))
        .then((place) => {
          if (!active) return;
          const photo = place.attachments.find(
            (item) => item.role === 'photo' && item.file?.thumbUrl,
          );
          setThumb(previewUrl(photo?.file?.thumbUrl, connection.origin));
        })
        .catch(() => {});
    });
    observer.observe(marker.current);
    return () => {
      active = false;
      observer.disconnect();
    };
  }, [connection, id, online, transport]);
  return (
    <span ref={marker}>
      {online && thumb ? (
        <img
          src={thumb}
          alt=""
          className="kept-thumb"
          loading="lazy"
          referrerPolicy="no-referrer"
        />
      ) : (
        <MapPin size={18} />
      )}
    </span>
  );
}
