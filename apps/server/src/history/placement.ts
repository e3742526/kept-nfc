import { type PlacementHistory, type RecordedPlacement, rankPlacements } from '@kept/shared';
import type pg from 'pg';
import { z } from 'zod';
import { liveThing } from '../things/service.js';

type PlacementEvent = {
  id: string;
  at: Date;
  action: string;
  entity_id: string;
  request_id: string | null;
  undo_of: string | null;
  location_id: string;
  location_name: string;
  destination_location_id: string | null;
  place_id: string | null;
  container_id: string | null;
  recorded_path: unknown;
  carrier_name: string | null;
};

type Destination = {
  location_id: string;
  id: string;
  kind: 'place' | 'container';
  is_unplaced: boolean;
  path: { name: string | null; kindKey: string | null }[];
};

const EVIDENCE_LIMIT = 1000;
const labels = z.array(z.string().nullable());

const destinationKey = (location: string, kind: string, id: string) =>
  JSON.stringify([location, kind, id]);

/** Cross-location moves have one audit row at each end. The pair shares a request and instant. */
function placementKey(e: PlacementEvent): string {
  return e.request_id
    ? JSON.stringify([
        e.request_id,
        e.at.toISOString(),
        e.action,
        e.entity_id,
        e.destination_location_id ?? e.location_id,
        e.place_id,
        e.container_id,
      ])
    : e.id;
}

function destinationOf(event: PlacementEvent) {
  const container = z.uuid().safeParse(event.container_id);
  if (container.success) return { id: container.data, kind: 'container' as const };
  const place = z.uuid().safeParse(event.place_id);
  return place.success ? { id: place.data, kind: 'place' as const } : null;
}

export async function placementHistory(
  client: pg.PoolClient,
  id: string,
): Promise<PlacementHistory> {
  await liveThing(client, id);
  // Both branches use the existing thing history indexes. Join the caller's visible locations
  // before considering a path, and keep the source copy only long enough to correlate an undo.
  const { rows } = await client.query<PlacementEvent>(
    `WITH candidates AS (
       SELECT e.id, e.at FROM public.audit_events e
        WHERE e.root_thing_id = $1
          AND (e.action IN ('thing.move', 'thing.create', 'thing.capture') OR e.undo_of IS NOT NULL)
       UNION
       SELECT s.event_id, s.event_at FROM public.audit_event_subjects s WHERE s.thing_id = $1
     )
     SELECT e.id, e.at, e.action, e.entity_id, e.request_id, e.undo_of, e.location_id,
            l.name AS location_name, e.diff->'location_id'->>'after' AS destination_location_id,
            e.diff->'place_id'->>'after' AS place_id, e.diff->'container_id'->>'after' AS container_id,
            e.diff->'path'->'after' AS recorded_path, carrier.name AS carrier_name
       FROM candidates c JOIN public.audit_events e USING (id, at)
       JOIN public.locations l ON l.id = e.location_id AND l.deleted_at IS NULL
       LEFT JOIN public.things carrier ON carrier.id = e.entity_id AND carrier.id <> $1
                                      AND carrier.location_id = e.location_id
      WHERE e.entity_type = 'thing'
        AND (e.undo_of IS NOT NULL OR (
          (e.action = 'thing.move' OR (e.entity_id = $1 AND e.action IN ('thing.create', 'thing.capture')))
          AND (e.diff->'place_id'->>'after' IS NOT NULL OR e.diff->'container_id'->>'after' IS NOT NULL)
          AND coalesce(e.diff->'placement_intent'->>'after', '') NOT IN ('correct', 'remove')
          AND coalesce(e.diff->'location_uncertain'->>'after', 'false') <> 'true'
          AND coalesce(e.diff->'review_state'->>'after', '') <> 'draft'
        ))
      ORDER BY e.at DESC, e.id DESC LIMIT $2`,
    [id, EVIDENCE_LIMIT + 1],
  );

  const window = rows.slice(0, EVIDENCE_LIMIT);
  const undoneIds = new Set(window.flatMap((row) => (row.undo_of ? [row.undo_of] : [])));
  const undone = new Set(
    window.flatMap((row) => (undoneIds.has(row.id) ? [placementKey(row)] : [])),
  );
  const undoRequests = new Set(window.flatMap((row) => (row.undo_of ? [placementKey(row)] : [])));
  const seen = new Set<string>();
  const placements = window.flatMap((event) => {
    if (event.destination_location_id && event.destination_location_id !== event.location_id)
      return [];
    const key = placementKey(event);
    if (event.undo_of || undone.has(key) || undoRequests.has(key) || seen.has(key)) return [];
    const target = destinationOf(event);
    if (!target) return [];
    seen.add(key);
    return [{ event, ...target, key: destinationKey(event.location_id, target.kind, target.id) }];
  });
  const targets = [...new Map(placements.map((p) => [p.key, p])).values()];
  const resolved = targets.length
    ? await client.query<Destination>(
        `SELECT w.location_id, w.id, w.kind, coalesce(p.is_unplaced, false) AS is_unplaced,
                coalesce((SELECT jsonb_agg(jsonb_build_object('name', s.step->'name',
                                                           'kindKey', ancestor.kind_key) ORDER BY s.n)
                           FROM jsonb_array_elements(kept.path_of(p.id, b.id)) WITH ORDINALITY s(step, n)
                           LEFT JOIN public.places ancestor ON ancestor.id = (s.step->>'id')::uuid
                             AND ancestor.location_id = w.location_id AND s.step->>'kind' = 'place'), '[]') AS path
           FROM unnest($1::uuid[], $2::uuid[], $3::text[]) w(location_id, id, kind)
           LEFT JOIN public.places p ON p.id = w.id AND p.location_id = w.location_id AND w.kind = 'place'
           LEFT JOIN public.things b ON b.id = w.id AND b.location_id = w.location_id AND w.kind = 'container'
          WHERE p.id IS NOT NULL OR b.id IS NOT NULL`,
        [
          targets.map((p) => p.event.location_id),
          targets.map((p) => p.id),
          targets.map((p) => p.kind),
        ],
      )
    : { rows: [] };
  const byTarget = new Map(
    resolved.rows.map((r) => [destinationKey(r.location_id, r.kind, r.id), r]),
  );
  const evidence = placements.flatMap(({ event, id: destinationId, key }): RecordedPlacement[] => {
    const live = byTarget.get(key);
    const placement = {
      locationId: event.location_id,
      locationName: event.location_name,
      recordedAt: event.at.toISOString(),
    };
    if (live?.is_unplaced) return [placement];
    const saved = labels.safeParse(event.recorded_path);
    const recordedPath = saved.success ? saved.data.filter((part): part is string => !!part) : [];
    const liveSteps = (live?.path ?? []).flatMap((step) =>
      step.name ? [{ ...step, name: step.name }] : [],
    );
    const path = recordedPath.length ? recordedPath : liveSteps.map((step) => step.name);
    if (path.length === 0) return [placement];

    // When the saved breadcrumb predates a reparent or rename, use the names in it. For
    // currently resolvable paths, use the nearest room and keep its floor in the breadcrumb.
    const roomIndex = liveSteps.findLastIndex((step) => step.kindKey === 'room');
    const sameRoom =
      roomIndex >= 0 &&
      liveSteps.slice(0, roomIndex + 1).every((step, index) => step.name === path[index]);
    const room = path.slice(0, sameRoom ? roomIndex + 1 : 1);
    const carrier = event.carrier_name;
    const destination = carrier
      ? { id: event.entity_id, path: [...path, carrier] }
      : { id: destinationId, path };
    return [{ ...placement, room, destination }];
  });
  return rankPlacements(evidence, rows.length > EVIDENCE_LIMIT);
}
