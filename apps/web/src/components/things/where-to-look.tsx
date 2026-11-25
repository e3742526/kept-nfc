import type { PlacementHistory } from '@kept/shared';
import { Trans, useLingui } from '@lingui/react/macro';
import { MapPin } from 'lucide-react';
import { useId, useState } from 'react';
import { useErrorText } from '@/components/page';
import { Button } from '@/components/ui/button';
import { Segmented } from '@/components/ui/segmented';
import { sep, useFormat } from '@/lib/format';

type Group = 'rooms' | 'destinations' | 'locations';

export function WhereToLook({
  load,
  online = true,
  onError,
}: {
  load: () => Promise<PlacementHistory>;
  online?: boolean;
  onError?: (error: unknown) => boolean;
}) {
  const { t } = useLingui();
  const fmt = useFormat();
  const errorText = useErrorText();
  const panel = useId();
  const [open, setOpen] = useState(false);
  const [group, setGroup] = useState<Group>('rooms');
  const [result, setResult] = useState<PlacementHistory>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  async function fetchHistory() {
    if (loading || !online) return;
    setLoading(true);
    setError(undefined);
    try {
      const next = await load();
      if (!next.rooms.length && next.locations.length) setGroup('locations');
      setResult(next);
    } catch (e) {
      if (!onError?.(e)) setError(errorText(e));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="grid justify-items-start gap-2">
      <Button
        variant="secondary"
        size="small"
        aria-expanded={open}
        aria-controls={panel}
        onPress={() => {
          if (!open && !result && online) void fetchHistory();
          setOpen(!open);
        }}
      >
        <MapPin size={16} aria-hidden />
        <Trans>Where to look</Trans>
      </Button>
      <div id={panel} hidden={!open} className="w-full">
        {open && (
          <div className="grid gap-2 rounded-lg border border-line bg-surface p-3">
            {!online ? (
              <p>
                <Trans>Connect to see location history.</Trans>
              </p>
            ) : loading ? (
              <p role="status">
                <Trans>Loading location history…</Trans>
              </p>
            ) : error ? (
              <>
                <p role="alert">{error}</p>
                <Button
                  size="small"
                  variant="secondary"
                  onPress={() => void fetchHistory()}
                  className="justify-self-start"
                >
                  <Trans>Try again</Trans>
                </Button>
              </>
            ) : result?.locations.length ? (
              <>
                <Segmented<Group>
                  label={t`Group by`}
                  value={group}
                  onChange={setGroup}
                  options={[
                    { id: 'rooms', label: t`Rooms and areas` },
                    { id: 'destinations', label: t`Exact places` },
                    { id: 'locations', label: t`Locations` },
                  ]}
                />
                {result[group].length ? (
                  <ol className="grid gap-2">
                    {result[group].map((row) => {
                      const count = fmt.num(row.count);
                      const date = fmt.date(row.lastRecordedAt);
                      return (
                        <li
                          key={JSON.stringify([row.locationId, row.path, row.lastRecordedAt])}
                          className="grid gap-0.5 border-line border-b pb-2 last:border-b-0 last:pb-0"
                        >
                          <div className="wrap-anywhere font-semibold">
                            <bdi>{[row.locationName, ...row.path].join(' › ')}</bdi>
                          </div>
                          <p className="text-small text-ink-2">
                            <span>
                              <Trans>Recorded placements {count}</Trans>
                            </span>
                            {sep()}
                            <Trans>
                              Last recorded <time dateTime={row.lastRecordedAt}>{date}</time>
                            </Trans>
                          </p>
                        </li>
                      );
                    })}
                  </ol>
                ) : (
                  <p className="text-small text-ink-2">
                    <Trans>No recorded places in this group.</Trans>
                  </p>
                )}
                {result.limited && (
                  <p className="text-small text-ink-2">
                    <Trans>Based on the most recent recorded placements.</Trans>
                  </p>
                )}
              </>
            ) : result ? (
              <p className="text-small text-ink-2">
                <Trans>No placement history yet.</Trans>
              </p>
            ) : (
              <Button
                size="small"
                variant="secondary"
                onPress={() => void fetchHistory()}
                className="justify-self-start"
              >
                <Trans>Show location history</Trans>
              </Button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
