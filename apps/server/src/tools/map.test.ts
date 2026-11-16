import {
  byteLength,
  type Envelope,
  envelopeSchema,
  isToolError,
  OUTPUT_LIMIT_BYTES,
  TOOL_DEFS,
  type ToolName,
} from '@kept/mcp';
import { newId } from '@kept/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { TestApp } from '../../test/app.js';
import { type TestDb, testDb } from '../../test/db.js';
import { call, join, type Person, peopleApp, person } from '../../test/people.js';
import { createLocation, eventsOf, type Loc, ok, own } from '../../test/things.js';
import { runTool, toolsFor } from './context.js';
import type { ToolContext, ToolVia } from './types.js';

// get_map and arrange_rooms: the location map's rooms over MCP, as GET /locations/:id/map shows
// them and PUT /locations/:id/layout arranges them. arrange_rooms changes only the rooms it names:
// every other room and node stays where it was, and the route's own checks (role, version, rooms
// that overlap on a floor) and its undoable `place.arrange` apply. Ola owns Home (Complete: MCP
// on); Max is a member, Vic a viewer.

let db: TestDb;
let t: TestApp;
let ola: Person;
let max: Person;
let vic: Person;
let home: Loc;

type Ids = {
  ground: string;
  first: string;
  living: string;
  kitchen: string;
  bedroom: string;
  balcony: string;
  shelf: string;
  box: string;
};
let ids: Ids;

// biome-ignore lint/suspicious/noExplicitAny: the envelope was validated against its zod schema
type Answer = Record<string, any>;

let seq = 0;
const ctx = (
  who: Person,
  { scope = 'write', via = 'mcp' }: { scope?: 'read' | 'write'; via?: ToolVia } = {},
): ToolContext => {
  seq += 1;
  return {
    deps: {
      pools: db.pools,
      jobs: null,
      files: null,
      providerResolved: async () => true,
      baseUrl: 'https://kept.example',
    },
    principal: { userId: who.userId, mfa: false, scope },
    locale: 'en',
    requestId: `map-tool-${seq}`,
    via,
  };
};

async function tool(c: ToolContext, name: ToolName, args: Record<string, unknown>) {
  const env = (await runTool(c, name, args)) as Envelope<Answer>;
  const parsed = envelopeSchema(TOOL_DEFS[name].output).safeParse(env);
  expect(parsed.success, `${name}: ${JSON.stringify(parsed.error?.issues?.slice(0, 3))}`).toBe(
    true,
  );
  expect(byteLength(env)).toBeLessThanOrEqual(OUTPUT_LIMIT_BYTES);
  return env;
}

async function data(who: Person, name: ToolName, args: Record<string, unknown>) {
  const env = await tool(ctx(who), name, args);
  if (isToolError(env)) throw new Error(`${name}: ${env.error} (${env.hint})`);
  return env.data;
}

const sql = <T extends Record<string, unknown>>(text: string, values: unknown[] = []) =>
  own<T>(db, text, values);

async function placeOf(name: string, parentId: string | null, kind = 'room') {
  const id = newId();
  await sql(
    'INSERT INTO public.places (id, location_id, parent_id, name, kind_key) VALUES ($1, $2, $3, $4, $5)',
    [id, home.id, parentId, name, kind],
  );
  return id;
}

async function thingOf(name: string, placeId: string, typeKey: string) {
  const id = newId();
  await sql(
    `INSERT INTO public.things (id, location_id, place_id, name, type_id)
     VALUES ($1, $2, $3, $4,
             (SELECT id FROM public.types WHERE owner_account_id IS NULL AND builtin_key = $5))`,
    [id, home.id, placeId, name, typeKey],
  );
  return id;
}

type MapJson = {
  version: string | null;
  rooms: { id: string; layout: Record<string, unknown> | null }[];
  nodes: { id: string; layout: Record<string, unknown> | null }[];
};

const getMap = async (): Promise<MapJson> =>
  ok(await call(t, `/api/v1/locations/${home.id}/map`, { as: ola })) as unknown as MapJson;

/** Arranges the living room, the kitchen and the bedroom, the shelf and the box, as the web does. */
async function arrangedInTheApp(): Promise<string> {
  const res = await call(t, `/api/v1/locations/${home.id}/layout`, {
    as: ola,
    method: 'PUT',
    body: {
      version: null,
      rooms: [
        { id: ids.living, x: 0, z: 0, w: 600, d: 500, kind: 'room', surface: 'wood' },
        { id: ids.kitchen, x: 700, z: 0, w: 400, d: 500, kind: 'room', surface: 'tile' },
        { id: ids.bedroom, x: 0, z: 0, w: 450, d: 400, kind: 'room', surface: 'wood' },
      ],
      nodes: [
        { id: ids.shelf, x: 15, z: 15, rot: 0, model: 'metal_shelf', hostId: null },
        { id: ids.box, x: 200, z: 300, rot: 90, model: 'box', hostId: null },
      ],
    },
  });
  return (ok(res) as unknown as { version: string }).version;
}

beforeAll(async () => {
  db = await testDb();
  await db.reset();
  t = await peopleApp(db);
  ola = await person(t, db, 'ola');
  max = await person(t, db, 'max');
  vic = await person(t, db, 'vic');
  home = await createLocation(t, db, ola, 'complete');
  await join(db, home.id, max.userId, 'member');
  await join(db, home.id, vic.userId, 'viewer');

  const ground = await placeOf('Ground floor', null, 'floor');
  const first = await placeOf('First floor', null, 'floor');
  await sql('UPDATE public.places SET sort = 1 WHERE id = $1', [first]);
  const living = await placeOf('Living room', ground);
  const kitchen = await placeOf('Kitchen', ground);
  const bedroom = await placeOf('Bedroom', first);
  const balcony = await placeOf('Balcony', first);
  const shelf = await placeOf('Shelf A', living, 'zone');
  const box = await thingOf('Games box', living, 'box_bin');
  ids = { ground, first, living, kitchen, bedroom, balcony, shelf, box };
});

beforeEach(async () => {
  await sql('DELETE FROM public.map_nodes WHERE location_id = $1', [home.id]);
});

afterAll(async () => {
  await t?.app.close();
});

describe('who is offered the map tools', () => {
  it('get_map to every reader over MCP, arrange_rooms to those who may arrange, neither to the assistant', async () => {
    const names = (c: ToolContext) => toolsFor(c, [home.id]).then((ls) => ls[0]?.tools ?? []);
    expect(await names(ctx(max))).toEqual(expect.arrayContaining(['get_map', 'arrange_rooms']));
    const reader = await names(ctx(max, { scope: 'read' }));
    expect(reader).toContain('get_map');
    expect(reader).not.toContain('arrange_rooms');
    const viewer = await names(ctx(vic));
    expect(viewer).toContain('get_map');
    expect(viewer).not.toContain('arrange_rooms');
    const assistant = await names(ctx(max, { via: 'assistant' }));
    expect(assistant).not.toContain('get_map');
    expect(assistant).not.toContain('arrange_rooms');
    const viaAssistant = await runTool(ctx(max, { via: 'assistant' }), 'get_map', {
      location_id: home.id,
    });
    expect(viaAssistant).toMatchObject({ error: 'tool_unavailable' });
  });

  it('refuses arrange_rooms to a read token and a viewer, and changes nothing', async () => {
    const args = {
      location_id: home.id,
      version: null,
      rooms: [{ room_id: ids.kitchen, x_cm: 0, z_cm: 0, width_cm: 300, length_cm: 300 }],
    };
    expect(await tool(ctx(max, { scope: 'read' }), 'arrange_rooms', args)).toMatchObject({
      error: 'token_scope',
    });
    expect(await tool(ctx(vic), 'arrange_rooms', args)).toMatchObject({ error: 'forbidden' });
    expect((await getMap()).version).toBeNull();
  });
});

describe('get_map', () => {
  it('lists the floors and each room, with no rectangle before anyone arranged', async () => {
    const d = await data(vic, 'get_map', { location_id: home.id });
    expect(d.version).toBeNull();
    expect(d.can_arrange).toBe(false);
    expect(d.floors).toEqual([
      { id: ids.ground, untrusted: { name: 'Ground floor' } },
      { id: ids.first, untrusted: { name: 'First floor' } },
    ]);
    const rooms = new Map(d.items.map((r: Answer) => [r.id, r]));
    expect([...rooms.keys()].sort()).toEqual(
      [ids.living, ids.kitchen, ids.bedroom, ids.balcony].sort(),
    );
    expect(rooms.get(ids.living)).toMatchObject({
      kind: 'room',
      floor_id: ids.ground,
      map: null,
      untrusted: { name: 'Living room' },
    });
    expect(rooms.has(ids.shelf)).toBe(false);
  });

  it('answers the rectangles and version the app arranged', async () => {
    const version = await arrangedInTheApp();
    const d = await data(max, 'get_map', { location_id: home.id });
    expect(d.version).toBe(version);
    expect(d.can_arrange).toBe(true);
    const kitchen = d.items.find((r: Answer) => r.id === ids.kitchen);
    expect(kitchen.map).toEqual({
      x_cm: 700,
      z_cm: 0,
      width_cm: 400,
      length_cm: 500,
      room_kind: 'room',
      surface: 'tile',
    });
    expect(d.items.find((r: Answer) => r.id === ids.balcony).map).toBeNull();
  });

  it('pages the rooms', async () => {
    const first = (await tool(ctx(max), 'get_map', { location_id: home.id, limit: 3 })) as Answer;
    expect(first.data.items).toHaveLength(3);
    expect(first.next_cursor).toBeTruthy();
    const rest = await data(max, 'get_map', { location_id: home.id, cursor: first.next_cursor });
    expect(rest.items).toHaveLength(1);
    expect(rest.floors).toHaveLength(2);
  });
});

describe('arrange_rooms', () => {
  it('moves and resizes one room and leaves every other room and node as it was, undoably', async () => {
    const version = await arrangedInTheApp();
    const before = await getMap();
    const d = await data(max, 'arrange_rooms', {
      location_id: home.id,
      version,
      rooms: [{ room_id: ids.kitchen, x_cm: 650, width_cm: 500, surface: 'concrete' }],
    });
    expect(d.rooms).toEqual([
      expect.objectContaining({
        id: ids.kitchen,
        map: {
          x_cm: 650,
          z_cm: 0,
          width_cm: 500,
          length_cm: 500,
          room_kind: 'room',
          surface: 'concrete',
        },
      }),
    ]);
    expect(d.undo_until).not.toBeNull();

    const after = await getMap();
    expect(after.version).toBe(d.version);
    expect(after.version).not.toBe(version);
    const others = (m: MapJson) => ({
      rooms: m.rooms.filter((r) => r.id !== ids.kitchen),
      nodes: m.nodes,
    });
    expect(others(after)).toEqual(others(before));
    expect(after.rooms.find((r) => r.id === ids.kitchen)?.layout).toEqual({
      x: 650,
      z: 0,
      w: 500,
      d: 500,
      kind: 'room',
      surface: 'concrete',
    });

    const events = (await eventsOf(db, home.id, home.id)).filter(
      (e) => e.action === 'place.arrange',
    );
    const last = events.at(-1);
    expect(last).toMatchObject({ id: d.audit_event_id, actor_id: max.userId });
    const window = (last?.undoable_until?.getTime() ?? 0) - (last?.at.getTime() ?? 0);
    expect(window).toBeGreaterThan(9 * 60 * 1000);
    expect(window).toBeLessThanOrEqual(10 * 60 * 1000 + 5000);

    ok(await call(t, `/api/v1/audit/${d.audit_event_id}/undo`, { as: max, body: {} }));
    expect((await getMap()).rooms).toEqual(before.rooms);
  });

  it('puts a room nobody arranged on the map with its whole rectangle, its kind and floor from its name', async () => {
    const d = await data(max, 'arrange_rooms', {
      location_id: home.id,
      version: null,
      rooms: [{ room_id: ids.balcony, x_cm: 0, z_cm: 0, width_cm: 300, length_cm: 120 }],
    });
    expect(d.rooms[0].map).toEqual({
      x_cm: 0,
      z_cm: 0,
      width_cm: 300,
      length_cm: 120,
      room_kind: 'balcony',
      surface: 'deck',
    });
    const map = await getMap();
    expect(map.rooms.filter((r) => r.layout !== null).map((r) => r.id)).toEqual([ids.balcony]);
  });

  it('asks for the whole rectangle of a room not on the map yet', async () => {
    const env = await tool(ctx(max), 'arrange_rooms', {
      location_id: home.id,
      version: null,
      rooms: [{ room_id: ids.balcony, width_cm: 300 }],
    });
    expect(env).toMatchObject({ error: 'validation' });
    expect((env as Answer).hint).toMatch(/x_cm, z_cm, width_cm and length_cm/);
  });

  it('refuses a place that is not a room, and a room named twice', async () => {
    const shelf = await tool(ctx(max), 'arrange_rooms', {
      location_id: home.id,
      version: null,
      rooms: [{ room_id: ids.shelf, x_cm: 0, z_cm: 0, width_cm: 100, length_cm: 100 }],
    });
    expect(shelf).toMatchObject({ error: 'validation' });
    const twice = await tool(ctx(max), 'arrange_rooms', {
      location_id: home.id,
      version: null,
      rooms: [
        { room_id: ids.balcony, x_cm: 0, z_cm: 0, width_cm: 100, length_cm: 100 },
        { room_id: ids.balcony, surface: 'tile' },
      ],
    });
    expect(twice).toMatchObject({ error: 'validation' });
    expect((await getMap()).version).toBeNull();
  });

  it('refuses a map someone arranged since that version, and says to read it again', async () => {
    const version = await arrangedInTheApp();
    const stale = await tool(ctx(max), 'arrange_rooms', {
      location_id: home.id,
      version: null,
      rooms: [{ room_id: ids.kitchen, x_cm: 800 }],
    });
    expect(stale).toMatchObject({ error: 'conflict' });
    expect((stale as Answer).hint).toMatch(/get_map/);
    expect((await getMap()).version).toBe(version);
  });

  it('refuses rooms that would overlap on a floor, naming them', async () => {
    const version = await arrangedInTheApp();
    const env = await tool(ctx(max), 'arrange_rooms', {
      location_id: home.id,
      version,
      rooms: [{ room_id: ids.kitchen, x_cm: 300 }],
    });
    expect(env).toMatchObject({ error: 'conflict' });
    expect((env as Answer).hint).toMatch(/can't overlap/);
    expect((await getMap()).version).toBe(version);
    // A room on another floor may sit over it.
    await data(max, 'arrange_rooms', {
      location_id: home.id,
      version,
      rooms: [{ room_id: ids.balcony, x_cm: 500, z_cm: 0, width_cm: 300, length_cm: 150 }],
    });
  });
});
