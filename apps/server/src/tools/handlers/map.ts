import { decodeOffsetCursor, encodeOffsetCursor, pageSize, type ToolOutput } from '@kept/mcp';
import {
  defaultRoomKind,
  firstOverlap,
  isMapModel,
  MAP_TURNS,
  type MapTurn,
  ROOM_KIND_SURFACE,
} from '@kept/shared';
import { AppError, conflict, invalid } from '../../http/errors.js';
import { type LayoutBody, putLayout } from '../../map/service.js';
import { type MapView, mapView } from '../../map/view.js';
import { placeIn } from '../resolve.js';
import type { Handler, Op } from '../types.js';
import { writeResult } from './write.js';

// The location map's rooms over MCP. get_map reads GET /locations/:id/map's own view (mapView()),
// rooms only. arrange_rooms is PUT /locations/:id/layout (putLayout()) with a merge in front: the
// route takes the whole layout, so the handler rebuilds it from the same view the web arranges
// from (every room and node with a layout row), changes only the rooms named, and sends the rest
// back as it was. The route's operation then does what it always does: the `things.edit` role,
// the version check (someone arranged since: 409 `arranged_since`), rooms that don't overlap on a
// floor, and one `place.arrange` audit undoable for ten minutes.

type Room = ToolOutput<'get_map'>['items'][number];
type RoomLayout = NonNullable<MapView['rooms'][number]['layout']>;

const locationOf = (op: Op) => {
  if (!op.location) throw new Error('a map tool always runs in one location');
  return op.location;
};

function roomOf(r: MapView['rooms'][number]): Room {
  return {
    id: r.id,
    short_code: r.shortCode,
    kind: r.kindKey,
    floor_id: r.levelId,
    map: r.layout
      ? {
          x_cm: r.layout.x,
          z_cm: r.layout.z,
          width_cm: r.layout.w,
          length_cm: r.layout.d,
          room_kind: r.layout.kind,
          surface: r.layout.surface,
        }
      : null,
    untrusted: { name: r.name },
  };
}

export const getMapTool: Handler<'get_map'> = {
  action: 'content.view',
  run: async (op, input) => {
    const view = await mapView(op.tx, op.client, locationOf(op).id);
    const offset = input.cursor ? decodeOffsetCursor(input.cursor) : 0;
    if (offset === null) throw invalid('The cursor is not valid; start again without one.');
    const end = offset + pageSize(input.limit);
    return {
      nextCursor: end < view.rooms.length ? encodeOffsetCursor(end) : null,
      cursorAt: (kept) => encodeOffsetCursor(offset + kept),
      data: {
        version: view.version,
        can_arrange: view.canArrange,
        floors: view.levels.map((l) => ({ id: l.id, untrusted: { name: l.name } })),
        items: view.rooms.slice(offset, end).map(roomOf),
      },
    };
  },
};

const isTurn = (n: number): n is MapTurn => (MAP_TURNS as readonly number[]).includes(n);

/** The whole layout as it stands: what the web would send back for this view. */
function layoutOf(view: MapView): LayoutBody {
  const rooms = view.rooms.flatMap((r) => (r.layout ? [{ id: r.id, ...r.layout }] : []));
  // A node whose stored shape isn't in the catalogue goes back to the app's own layout, which
  // gives it a shape again.
  const nodes = view.nodes.flatMap((n) => {
    const l = n.layout;
    if (!l?.model || !isMapModel(l.model)) return [];
    const rot = isTurn(l.rot) ? l.rot : 0;
    return [{ id: n.id, x: l.x, z: l.z, rot, model: l.model, hostId: l.hostId, height: l.height }];
  });
  return { version: view.version, rooms, nodes };
}

export const arrangeRoomsTool: Handler<'arrange_rooms'> = {
  action: 'things.edit',
  run: async (op, input) => {
    const loc = locationOf(op);
    const view = await mapView(op.tx, op.client, loc.id);
    const byId = new Map(view.rooms.map((r) => [r.id, r]));
    const body = layoutOf(view);
    const named = new Map<string, Room>();
    for (const asked of input.rooms) {
      const id = await placeIn(op.client, loc.id, asked.room_id);
      const room = byId.get(id);
      if (!room) {
        throw invalid(
          `${asked.room_id} is not a room: a room is a place directly on a floor or at the top of the location.`,
        );
      }
      if (named.has(id)) throw invalid(`${asked.room_id} is named twice; name each room once.`);
      const was = room.layout;
      const x = asked.x_cm ?? was?.x;
      const z = asked.z_cm ?? was?.z;
      const w = asked.width_cm ?? was?.w;
      const d = asked.length_cm ?? was?.d;
      if (x === undefined || z === undefined || w === undefined || d === undefined) {
        throw invalid(
          `${asked.room_id} is not on the map yet: send its x_cm, z_cm, width_cm and length_cm.`,
        );
      }
      const kind = asked.room_kind ?? was?.kind ?? defaultRoomKind(room.name);
      const rect: RoomLayout = {
        x,
        z,
        w,
        d,
        kind,
        surface: asked.surface ?? was?.surface ?? ROOM_KIND_SURFACE[kind],
      };
      body.rooms = [...body.rooms.filter((r) => r.id !== id), { id, ...rect }];
      named.set(id, roomOf({ ...room, layout: rect }));
    }
    // The map's version is the client's, so a map arranged since it read it is refused.
    body.version = input.version;
    let version: string | null;
    try {
      ({ version } = await putLayout(op, loc.id, body));
    } catch (err) {
      throw refusalOf(err, body, view);
    }
    return {
      data: {
        ...(await writeResult(op, 'location', loc.id)),
        version,
        rooms: [...named.values()],
      },
    };
  },
};

/** The route's refusals, said with the tool's words: what to call next, and which rooms. */
function refusalOf(err: unknown, body: LayoutBody, view: MapView): unknown {
  if (!(err instanceof AppError)) return err;
  const reason = err.extra?.reason;
  if (reason === 'arranged_since') {
    return conflict(
      'Someone arranged this map since that version. Call get_map again, then arrange from its version.',
    );
  }
  if (reason === 'rooms_overlap') {
    const codeOf = new Map(view.rooms.map((r) => [r.id, r.shortCode ?? r.id]));
    const floorOf = new Map(view.rooms.map((r) => [r.id, r.levelId]));
    for (const floor of new Set(body.rooms.map((r) => floorOf.get(r.id) ?? null))) {
      const here = body.rooms.filter((r) => (floorOf.get(r.id) ?? null) === floor);
      const pair = firstOverlap(here.map((r) => ({ x: r.x, z: r.z, w: r.w, d: r.d })));
      if (pair) {
        const [a, b] = pair.map((i) => codeOf.get(here[i]?.id ?? '') ?? '');
        return conflict(
          `Rooms on one floor can't overlap: ${a} and ${b} would. Move or resize one (get_map shows where each room is).`,
        );
      }
    }
  }
  return err;
}
