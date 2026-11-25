import { z } from 'zod';

const PlacementRank = z.object({
  locationId: z.uuid(),
  locationName: z.string(),
  path: z.array(z.string()),
  count: z.number().int().positive(),
  lastRecordedAt: z.iso.datetime(),
});
export const PlacementHistorySchema = z.object({
  rooms: z.array(PlacementRank),
  destinations: z.array(PlacementRank),
  locations: z.array(PlacementRank),
  limited: z.boolean(),
});
export type PlacementHistory = z.infer<typeof PlacementHistorySchema>;

export type RecordedPlacement = {
  locationId: string;
  locationName: string;
  recordedAt: string;
  room?: string[];
  destination?: { id: string; path: string[] };
};

type Rank = z.infer<typeof PlacementRank>;

function record(rows: Map<string, Rank>, key: string, evidence: RecordedPlacement, path: string[]) {
  const current = rows.get(key);
  if (current) {
    current.count++;
    if (evidence.recordedAt > current.lastRecordedAt) current.lastRecordedAt = evidence.recordedAt;
  } else {
    rows.set(key, {
      locationId: evidence.locationId,
      locationName: evidence.locationName,
      path,
      count: 1,
      lastRecordedAt: evidence.recordedAt,
    });
  }
}

const mostFrequent = (rows: ReadonlyMap<string, Rank>) =>
  [...rows.values()]
    .sort((a, b) => b.count - a.count || b.lastRecordedAt.localeCompare(a.lastRecordedAt))
    .slice(0, 12);

export function rankPlacements(
  placements: RecordedPlacement[],
  limited: boolean,
): PlacementHistory {
  const locations = new Map<string, Rank>();
  const destinations = new Map<string, Rank>();
  const rooms = new Map<string, Rank>();
  for (const placement of placements) {
    const { locationId, destination, room } = placement;
    record(locations, locationId, placement, []);
    if (room) record(rooms, JSON.stringify([locationId, room]), placement, room);
    if (destination)
      record(
        destinations,
        JSON.stringify([locationId, destination.id, destination.path]),
        placement,
        destination.path,
      );
  }
  return {
    rooms: mostFrequent(rooms),
    destinations: mostFrequent(destinations),
    locations: mostFrequent(locations),
    limited,
  };
}
