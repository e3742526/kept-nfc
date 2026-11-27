/**
 * The sample home of the "Try the map" demo (D241): the prototype's house (three floors,
 * thirteen rooms, what stands in them and what is inside), as the map's read answers it
 * (`MapView`, apps/web/src/api/map/types.ts), with every room and thing arranged. The shipped
 * map's own code turns it into a plan (layout.ts `planOf`) and draws it.
 *
 * Sample names are in English.
 * name; brands and model names stay as they are written. Dates are days from today, so what is
 * due stays due. Nothing here is anyone's real home.
 */
import {
  ALPHABET,
  type MapModelKey,
  type MapRoomKind,
  type MapSurface,
  mToCm,
  ROOM_KIND_SURFACE,
  TAG_COLOURS,
  type TagColourKey,
} from '@kept/shared';
import type {
  MapAttention,
  MapNodeView,
  MapRoomView,
  MapThingView,
  MapView,
} from '../../../../web/src/api/map/types';
import { type Lang, MODEL_NAMES, type Pack } from './strings';

/** A built-in type's key (@kept/shared builtin-types.ts); sample.test.ts checks each is one. */
type BuiltinTypeKey = string;

/** A tag as the card shows it: its name and its palette colour (#209). */
export type SampleTag = { id: string; name: string; colour: string };

/** The sample's photos (photos.ts): a few things have one, as Kept would show it. */
export type PhotoKey = 'sofa' | 'armchair' | 'coffee_table' | 'tall_plant' | 'drill' | 'ac_unit';

/** What a card's Details show: the facts Kept would read from the thing or place. */
export type Facts = {
  brand?: string;
  model?: string;
  serial?: string;
  condition?: string;
  quantity?: number;
  /** Its type, a built-in one (@kept/shared builtin-types); none shows "No type". */
  type?: BuiltinTypeKey;
  tags?: SampleTag[];
  photo?: PhotoKey;
  /** A place: how many places are in it (the app reads it from the place, not the map). */
  places?: number;
};

export type Sample = { view: MapView; facts: Map<string, Facts>; location: string };

type TagKey = 'electronics' | 'warranty' | 'tools' | 'moving' | 'kids' | 'seasonal' | 'garden';
/** The sample's tags: none violet, so none reads as the app's own colour. */
const TAGS: Record<TagKey, { name: string; colour: TagColourKey }> = {
  electronics: { name: 'Electronics', colour: 'cyan' },
  warranty: { name: 'Under warranty', colour: 'blue' },
  tools: { name: 'Tools', colour: 'orange' },
  moving: { name: 'Moving', colour: 'brown' },
  kids: { name: 'Kids', colour: 'pink' },
  seasonal: { name: 'Seasonal', colour: 'amber' },
  garden: { name: 'Garden', colour: 'green' },
};

/** A thing's type from its shape, where one is plain; anything else has no type. */
const TYPE_OF: Partial<Record<MapModelKey, BuiltinTypeKey>> = {
  wall_tv: 'tv_display',
  monitor: 'tv_display',
  laptop: 'computer',
  webcam: 'electronics',
  earbuds: 'electronics',
  coffee_machine: 'small_appliance',
  microwave: 'small_appliance',
  fridge: 'large_appliance',
  washer: 'large_appliance',
  ac_unit: 'appliance',
  drill: 'power_tool',
  car: 'car',
  bike: 'bicycle',
  box: 'box_bin',
  cardboard: 'box_bin',
  crate: 'box_bin',
  basket: 'box_bin',
  sofa: 'furniture',
  armchair: 'furniture',
  coffee_table: 'furniture',
  bed: 'furniture',
  dining: 'furniture',
  dining_chair: 'furniture',
  chair: 'furniture',
  lamp: 'furniture',
  table_lamp: 'furniture',
};

type Due = { title: string; days: number };
type Lent = { who: string; days: number };
type Content = {
  name: string;
  qty?: number;
  brand?: string;
  /** Keep at least this many: below it, the thing is low. */
  min?: number;
  lent?: Lent;
  due?: Due;
  type?: BuiltinTypeKey;
  tags?: TagKey[];
};
type Extra = {
  name?: string;
  brand?: string;
  model?: string;
  serial?: string;
  cond?: string;
  contents?: Content[];
  due?: Due;
  lent?: Lent;
  /** #138: a thing on a wall, how high its middle hangs (metres). */
  height?: number;
  /** It carries a printed label: lists show its code as the amber tape (names first). */
  printed?: boolean;
  type?: BuiltinTypeKey;
  tags?: TagKey[];
  photo?: PhotoKey;
  places?: number;
};

const LIKE_NEW: string = 'Like new';
const GOOD: string = 'Good';

/** A stable short ID from a seed (the prototype's hash), in Kept's own alphabet. */
function codeFor(seed: string): string {
  let h = 2166136261;
  for (const ch of seed) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 16777619);
  }
  let out = '';
  for (let i = 0; i < 6; i++) {
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    out += ALPHABET[(h >>> 7) & 31];
  }
  return out;
}

/** Things that are places in Kept (shelves, cupboards, counters): drawn because they are there. */
const PLACES = new Set<MapModelKey>([
  'tv_stand',
  'bookshelf',
  'counter',
  'sink',
  'wardrobe',
  'desk',
  'cabinet',
  'cube_shelf',
  'metal_shelf',
  'workbench',
  'tool_wall',
  'tool_cart',
  'bedside',
  'drawers',
]);
/** Containers (things that hold things): drawn because they are there too. */
const CONTAINERS = new Set<MapModelKey>(['box', 'cardboard', 'crate', 'basket']);

const C = (name: string, qty = 1, extra: Omit<Content, 'name' | 'qty'> = {}): Content => ({
  name,
  qty,
  ...extra,
});

export function sampleHome(_lang: Lang, today: Date = new Date(), pack?: Pack): Sample {
  const modelName = (model: MapModelKey) => (pack ? pack.models[model] : MODEL_NAMES[model]);
  const tagsOf = (keys: TagKey[] | undefined) =>
    keys?.length
      ? {
          tags: keys.map((k) => ({
            id: `tag-${k}`,
            name: TAGS[k].name,
            colour: TAG_COLOURS[TAGS[k].colour],
          })),
        }
      : {};
  const dayOf = (days: number) => {
    const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() + days);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };

  const levels = [
    { id: 'L0', name: 'Ground floor' },
    { id: 'L1', name: 'First floor' },
    { id: 'L2', name: 'Roof' },
  ];

  const rooms: MapRoomView[] = [];
  const R = (
    id: string,
    levelId: string,
    name: string,
    x: number,
    z: number,
    w: number,
    d: number,
    kind: MapRoomKind = 'room',
    surface: MapSurface = ROOM_KIND_SURFACE[kind],
  ) => {
    rooms.push({
      id,
      name: name,
      shortCode: codeFor(`room:${id}`),
      levelId,
      kindKey: 'room',
      layout: { x: mToCm(x), z: mToCm(z), w: mToCm(w), d: mToCm(d), kind, surface },
    });
  };
  R('r1', 'L0', 'Living room', 0, 0, 6, 5);
  R('r2', 'L0', 'Kitchen', 7, 0, 5, 4, 'room', 'tile');
  R('r3', 'L0', 'Office', 13, 0, 4, 4);
  R('r4', 'L0', 'Garden', 0, 6, 5, 5, 'garden');
  R('r5', 'L0', 'Laundry', 6, 6, 3, 3, 'room', 'tile');
  R('r6', 'L0', 'Garage', 10, 5, 7, 6, 'room', 'concrete');
  R('r7', 'L1', 'Bedroom', 0, 0, 4, 5);
  R('r8', 'L1', 'Balcony', 0, 5, 4, 2, 'balcony');
  R('r9', 'L1', 'Landing', 4, 0, 2, 4);
  R('r10', 'L1', 'Guest room', 6, 0, 5, 4);
  R('r11', 'L1', 'Storage room', 12, 0, 4, 4, 'room', 'concrete');
  R('r12', 'L2', 'Roof terrace', 0, 0, 9, 7, 'terrace');
  R('r13', 'L2', 'Roof room', 10, 0, 3, 3, 'room', 'concrete');

  const nodes: MapNodeView[] = [];
  const things: MapThingView[] = [];
  const attention: MapAttention[] = [];
  const facts = new Map<string, Facts>();
  let n = 0;

  const due = (subjectId: string, d: Due) =>
    attention.push({
      subjectId,
      kind: 'due',
      title: d.title,
      sourceType: 'schedule',
      state: d.days < 0 ? 'overdue' : 'due',
      dueOn: dayOf(d.days),
      person: null,
      quantity: null,
      min: null,
    });
  const lent = (subjectId: string, l: Lent) =>
    attention.push({
      subjectId,
      kind: 'lent',
      title: null,
      sourceType: null,
      state: null,
      dueOn: dayOf(l.days),
      person: l.who,
      quantity: null,
      min: null,
    });

  type Node = { id: string; roomId: string; x: number; z: number };
  const add = (
    roomId: string,
    model: MapModelKey,
    x: number,
    z: number,
    rot = 0,
    extra: Extra = {},
    hostId: string | null = null,
  ): Node => {
    const id = `n${++n}`;
    const name = extra.name ? extra.name : modelName(model);
    const place = PLACES.has(model);
    const container = CONTAINERS.has(model);
    const shortCode = codeFor(`${roomId}:${extra.name ?? model}:${model}:${x}:${z}`);
    nodes.push({
      id,
      subject: place ? 'place' : 'thing',
      name,
      shortCode,
      labelPrinted: extra.printed === true,
      roomId,
      parentId: roomId,
      kindKey: place ? 'shelf' : null,
      typeKey: null,
      isContainer: container,
      quantity: 1,
      layout: {
        x: mToCm(x),
        z: mToCm(z),
        rot,
        model,
        hostId,
        height: extra.height === undefined ? null : mToCm(extra.height),
      },
    });
    if (!place)
      things.push({
        id,
        name,
        shortCode,
        labelPrinted: extra.printed === true,
        quantity: 1,
        parentId: roomId,
        typeKey: null,
        typeName: null,
        isContainer: container,
      });
    const type = extra.type ?? (place ? undefined : TYPE_OF[model]);
    facts.set(id, {
      ...(type ? { type } : {}),
      ...tagsOf(extra.tags),
      ...(extra.photo ? { photo: extra.photo } : {}),
      ...(extra.places ? { places: extra.places } : {}),
      ...(extra.brand ? { brand: extra.brand } : {}),
      ...(extra.model ? { model: extra.model } : {}),
      ...(extra.serial ? { serial: extra.serial } : {}),
      ...(extra.cond ? { condition: extra.cond } : {}),
    });
    if (extra.due) due(id, extra.due);
    if (extra.lent) lent(id, extra.lent);
    (extra.contents ?? []).forEach((c, i) => {
      const cid = `${id}c${i + 1}`;
      const qty = c.qty ?? 1;
      things.push({
        id: cid,
        name: c.name,
        shortCode: codeFor(`${shortCode}:${i}:${c.name}`),
        quantity: qty,
        parentId: id,
        typeKey: null,
        typeName: null,
        isContainer: false,
      });
      facts.set(cid, {
        quantity: qty,
        ...(c.type ? { type: c.type } : {}),
        ...tagsOf(c.tags),
        ...(c.brand ? { brand: c.brand } : {}),
      });
      if (c.min !== undefined && qty < c.min) {
        attention.push({
          subjectId: cid,
          kind: 'low',
          title: null,
          sourceType: null,
          state: null,
          dueOn: null,
          person: null,
          quantity: qty,
          min: c.min,
        });
      }
      if (c.lent) lent(cid, c.lent);
      if (c.due) due(cid, c.due);
    });
    return { id, roomId, x, z };
  };
  /** Something standing on `host`, `dx`/`dz` metres from the host's corner, turned `rot`. */
  const on = (host: Node, model: MapModelKey, dx: number, dz: number, extra: Extra = {}, rot = 0) =>
    add(host.roomId, model, host.x + dx, host.z + dz, rot, extra, host.id);

  // ---- Ground floor · Living room ------------------------------------------------------------
  const stand = add('r1', 'tv_stand', 1.6, 0.15, 0, {
    brand: 'Home Centre',
    contents: [
      C('PS5 controller', 2, {
        brand: 'Sony',
        type: 'console',
        tags: ['electronics'],
      }),
      C('HDMI cable 2 m', 3, { type: 'cable' }),
      C('Apple TV remote', 1, { brand: 'Apple' }),
      C('Soundbar remote'),
      C('Blu-ray: Dune'),
      C('AA batteries', 4, { min: 6, type: 'batteries' }),
    ],
  });
  // #138: the TV on the wall behind the stand (the −z wall, 10 cm thick), at eye level, its
  // middle over the stand's.
  add('r1', 'wall_tv', stand.x + 1.22 - 1.23 / 2, 0.1, 0, {
    name: 'Samsung TV',
    brand: 'Samsung',
    model: 'QA55Q60C, 55″',
    serial: 'Q60C-0X55-7731',
    cond: LIKE_NEW,
    tags: ['electronics', 'warranty'],
    due: { title: 'Register the warranty', days: 13 },
    height: 1.2,
  });
  add('r1', 'sofa', 1.9, 3.7, 180, {
    brand: 'Chesterfield',
    model: 'Leather 2-seat',
    cond: GOOD,
    photo: 'sofa',
  });
  const table = add('r1', 'coffee_table', 2.2, 2.6, 0, {
    brand: 'IKEA',
    model: 'Lisabo',
    photo: 'coffee_table',
  });
  on(table, 'succulent', 0.15, 0.2, { name: 'Haworthia' });
  add('r1', 'armchair', 0.2, 2.0, 270, { brand: 'Kave Home', photo: 'armchair' });
  // #138: a floating shelf on the −x wall over the armchair, a small cactus on it.
  const wallShelf = add('r1', 'wall_shelf', 0.1, 2.0, 270, {
    name: 'Floating shelf',
    height: 1.5,
  });
  on(wallShelf, 'succulent', 0.02, 0.32, { name: 'Small cactus' }, 270);
  add('r1', 'bookshelf', 4.5, 0.15, 0, {
    brand: 'IKEA',
    model: 'Billy',
    contents: [
      C('The Pragmatic Programmer'),
      C('Atomic Habits'),
      C('Dune'),
      C('Children of Dune'),
      C('Sapiens'),
      C('Thinking, Fast and Slow'),
      C('Cairo Trilogy', 3, { brand: 'Naguib Mahfouz' }),
      C('Photo album 2019'),
      C('Photo album 2022'),
      C('National Geographic', 12),
    ],
  });
  add('r1', 'tall_plant', 0.2, 0.2, 0, {
    photo: 'tall_plant',
    tags: ['garden'],
    due: { title: 'Water the plant', days: 1 },
  });
  add('r1', 'lamp', 5.4, 4.4, 0, { brand: 'IKEA', model: 'Hektar' });
  add('r1', 'box', 0.3, 4.4, 0, {
    name: 'Games box',
    printed: true,
    tags: ['kids'],
    contents: [
      C('Catan', 1, { lent: { who: 'Bruce', days: 5 }, tags: ['kids'] }),
      C('Monopoly'),
      C('Uno'),
      C('Chess set'),
      C('Jenga'),
      C('Playing cards', 2),
    ],
  });
  add('r1', 'stairs', 4.9, 1.0, 0, { name: 'Stairs up' });

  // ---- Kitchen -------------------------------------------------------------------------------
  const counter = add('r2', 'counter', 0.15, 0.12, 0, {
    name: 'Counter by the window',
    contents: [
      C('Knife set', 1, { brand: 'Zwilling' }),
      C('Cutting board', 3),
      C('Blender', 1, { brand: 'Moulinex' }),
      C('Toaster', 1, { brand: 'Philips' }),
      C('Electric kettle', 1, { brand: 'Tefal' }),
      C('Spice jars', 12),
    ],
  });
  add('r2', 'sink', 2.0, 0.12, 0, {
    contents: [
      C('Dish soap', 1, { min: 2 }),
      C('Sponges', 6),
      C('Bin bags (rolls)', 2),
      C('Kitchen spray', 2),
    ],
  });
  on(counter, 'coffee_machine', 0.3, 0.1, {
    name: 'Espresso machine',
    brand: "De'Longhi",
    model: 'Dedica EC685',
    serial: 'EC685-2403-118',
    due: { title: 'Descale', days: 6 },
  });
  on(counter, 'microwave', 1.05, 0.15, { brand: 'Sharp', model: 'R-20A' });
  add('r2', 'fridge', 4.1, 0.12, 0, {
    brand: 'LG',
    model: 'GN-B392PLGB',
    serial: 'LG392-118-0457',
    due: { title: 'Change the water filter', days: 19 },
  });
  add('r2', 'dining', 1.8, 2.2, 0, { brand: 'Home Centre' });
  for (const [x, z, r] of [
    [2.05, 1.7, 0],
    [2.92, 1.7, 0],
    [2.05, 3.0, 180],
    [2.92, 3.0, 180],
  ] as const) {
    add('r2', 'dining_chair', x, z, r, { brand: 'Home Centre' });
  }
  add('r2', 'wardrobe', 0.15, 1.5, 270, {
    name: 'Pantry',
    contents: [
      C('Rice 5 kg', 2),
      C('Pasta', 6),
      C('Olive oil 1 L', 2),
      C('Coffee beans 1 kg', 1, { min: 2 }),
      C('Lentils', 3),
      C('Sugar 1 kg', 2),
      C('Tea boxes', 3),
    ],
  });

  // ---- Office --------------------------------------------------------------------------------
  const desk = add('r3', 'desk', 1.4, 0.15, 0, {
    brand: 'Flexispot',
    model: 'E7',
    contents: [
      C('Notebooks', 4),
      C('Pens', 12),
      C('Stapler'),
      C('USB-C charger 65 W', 2, { brand: 'Anker', type: 'charger' }),
      C('Passport folder'),
    ],
  });
  const monitor = on(desk, 'monitor', 0.4, 0.08, {
    name: 'Dell monitor',
    brand: 'Dell',
    model: 'U2723QE, 27″',
    serial: 'CN-0U27-23QE',
    tags: ['electronics'],
  });
  // #137: a webcam clipped to the monitor's top edge, on its line (3 cm in front of its middle).
  on(monitor, 'webcam', 0.26, 0.11, {
    name: 'HD webcam',
  });
  on(desk, 'earbuds', 0.15, 0.45, {
    name: 'Wireless earbuds',
  });
  on(desk, 'laptop', 1.0, 0.35, {
    name: 'MacBook Air',
    brand: 'Apple',
    model: 'M3, 15″',
    serial: 'FVFG2M3LQ6L4',
    cond: LIKE_NEW,
    printed: true,
    tags: ['electronics', 'warranty'],
  });
  add('r3', 'chair', 1.75, 1.0, 0, { brand: 'Herman Miller', model: 'Sayl' });
  add('r3', 'cabinet', 0.15, 0.15, 0, {
    contents: [
      C('Car papers'),
      C('Apartment lease', 1, {
        due: { title: 'Renew the lease', days: 15 },
      }),
      C('Tax return 2025'),
      C('Warranty cards', 14),
      C('Bank statements'),
    ],
  });
  add('r3', 'cube_shelf', 0.15, 1.2, 270, {
    contents: [
      C('Printer paper (reams)', 3),
      C('Ink cartridges', 1, { min: 2 }),
      C('Label tape', 3, { brand: 'Brother' }),
      C('External drive 2 TB', 1, { brand: 'Samsung' }),
    ],
  });
  add('r3', 'box', 3.2, 3.45, 0, {
    name: 'Cable box',
    printed: true,
    tags: ['electronics'],
    contents: [
      C('HDMI cable', 4),
      C('USB-C cable', 6),
      C('Ethernet cable', 3),
      C('Travel adapter', 2, { lent: { who: 'Louis', days: 10 } }),
    ],
  });

  // ---- Garden --------------------------------------------------------------------------------
  add('r4', 'planter_long', 0.3, 0.2, 0, {
    name: 'Herb planter',
    due: { title: 'Water the basil', days: 0 },
  });
  add('r4', 'planter', 2.1, 0.2, 0, { name: 'Tomato planter' });
  add('r4', 'plant', 4.0, 3.9, 0, { name: 'Olive tree' });
  add('r4', 'monobloc', 2.4, 2.4, 0);
  add('r4', 'watering_can', 4.2, 0.3, 0);

  // ---- Laundry -------------------------------------------------------------------------------
  add('r5', 'washer', 0.2, 0.15, 0, {
    brand: 'Samsung',
    model: 'WW90T, 9 kg',
    due: { title: 'Clean the filter', days: 4 },
  });
  add('r5', 'metal_shelf', 1.0, 0.15, 0, {
    name: 'Laundry shelf',
    contents: [
      C('Detergent', 1, { min: 2 }),
      C('Softener', 2),
      C('Stain remover'),
      C('Laundry bag', 3),
    ],
  });
  add('r5', 'basket', 1.8, 0.2, 0, {
    name: 'Peg basket',
    contents: [C('Clothes pegs', 40)],
  });
  add('r5', 'box', 2.1, 2.3, 0, {
    name: 'Iron and board',
    contents: [C('Steam iron', 1, { brand: 'Philips' }), C('Ironing board')],
  });

  // ---- Garage --------------------------------------------------------------------------------
  add('r6', 'car', 0.6, 0.9, 0, {
    name: 'Toyota Corolla',
    brand: 'Toyota',
    model: 'Corolla 1.6, 2019',
    due: { title: '60,000 km service', days: 14 },
  });
  add('r6', 'bike', 3.0, 1.4, 0, { brand: 'Trinx', model: 'M136, 27.5″' });
  const bench = add('r6', 'workbench', 4.6, 0.3, 0, {
    contents: [
      C('Screw assortment'),
      C('Wood glue'),
      C('Sandpaper pack'),
      C('Measuring tape', 2, { brand: 'Stanley' }),
      C('Safety glasses'),
    ],
  });
  // #138: the tool wall over the bench, its bottom a metre up; the drill hangs on its hooks, in
  // front of the board (its middle 1.5 cm out, the drill's 3 cm more).
  const board = add('r6', 'tool_wall', 4.9, 0.1, 0, {
    height: 1.3,
    contents: [
      C('Claw hammer'),
      C('Screwdriver set', 1, { brand: 'Wera' }),
      C('Adjustable wrench'),
      C('Hand saw'),
      C('Pliers', 2),
      C('Spirit level'),
      C('Allen keys set'),
    ],
  });
  on(board, 'drill', 0.21, 0.03, {
    name: 'Bosch drill',
    brand: 'Bosch',
    model: 'GSR 12V-15',
    printed: true,
    photo: 'drill',
    tags: ['tools'],
    lent: { who: 'Bruce', days: 2 },
  });
  add('r6', 'tool_cart', 5.5, 2.0, 0, {
    contents: [
      C('Socket set', 1, { brand: 'Bosch' }),
      C('Tyre gauge'),
      C('Jump leads'),
      C('Car wax', 1, { min: 2 }),
      C('Microfibre cloths', 6),
    ],
  });
  add('r6', 'metal_shelf', 5.6, 5.4, 180, {
    name: 'Garage shelf',
    contents: [
      C('Engine oil 4 L', 1, { min: 2 }),
      C('Coolant'),
      C('Spare bulbs', 4),
      C('Bike pump'),
    ],
  });
  add('r6', 'crate', 4.9, 5.45, 0, {
    name: 'Camping crate',
    printed: true,
    tags: ['seasonal'],
    contents: [
      C('Tent', 1, { brand: 'Coleman', tags: ['seasonal'] }),
      C('Sleeping bag', 2),
      C('Camping stove'),
      C('Head torch', 2),
    ],
  });
  add('r6', 'box', 2.6, 5.4, 0, {
    name: 'Paint box',
    contents: [
      C('Wall paint, white', 1, { min: 2 }),
      C('Brushes', 4),
      C('Roller'),
      C('Masking tape', 3),
    ],
  });
  add('r6', 'box', 3.3, 5.4, 0, {
    name: 'Holiday box',
    printed: true,
    tags: ['seasonal'],
    contents: [C('String lights', 3), C('Lanterns', 4), C('Banners', 2)],
  });

  // ---- First floor · Bedroom -----------------------------------------------------------------
  add('r7', 'bed', 1.15, 0.15, 0, { brand: 'IKEA', model: 'Malm, 160 cm' });
  const bedside = add('r7', 'bedside', 0.55, 0.15, 0, {
    contents: [
      C('Kindle', 1, { brand: 'Amazon' }),
      C('Reading glasses'),
      C('Phone charger'),
      C('Hand cream'),
    ],
  });
  on(bedside, 'table_lamp', 0.12, 0.07);
  add('r7', 'bedside', 2.9, 0.15, 0, {
    contents: [C('Notebook'), C('Earplugs', 6)],
  });
  add('r7', 'wardrobe', 2.3, 4.3, 180, {
    brand: 'IKEA',
    model: 'Pax',
    places: 3,
    contents: [
      C('Winter jacket', 3, { tags: ['seasonal'] }),
      C('Suit', 2),
      C('Bed linen set', 4),
      C('Shoes (pairs)', 8),
      C('Small suitcase', 1, { brand: 'Samsonite' }),
    ],
  });
  add('r7', 'drawers', 0.12, 2.6, 270, {
    contents: [
      C('T-shirts', 14),
      C('Socks (pairs)', 20),
      C('Gym kit', 3),
      C('Watch box', 1, { brand: 'Casio' }),
    ],
  });
  add('r7', 'basket', 0.8, 4.5, 0, {
    name: 'Laundry basket',
    contents: [C('Towels', 3)],
  });
  add('r7', 'plant', 3.1, 2.4, 0, { name: 'Snake plant' });

  // ---- Balcony -------------------------------------------------------------------------------
  add('r8', 'monobloc', 0.4, 0.4, 0);
  add('r8', 'monobloc', 1.2, 0.4, 0);
  add('r8', 'planter', 2.9, 1.4, 0, {
    name: 'Jasmine planter',
    due: { title: 'Feed the jasmine', days: 10 },
  });

  // ---- Landing -------------------------------------------------------------------------------
  add('r9', 'stairwell', 0.9, 1.0, 0, { name: 'Stairs' });

  // ---- Guest room ----------------------------------------------------------------------------
  add('r10', 'bed', 1.6, 0.15, 0, {
    name: 'Guest bed',
    brand: 'IKEA',
    model: 'Malm, 160 cm',
  });
  add('r10', 'bedside', 1.0, 0.15, 0, {
    contents: [C('Spare keys', 2), C('Guest wifi card')],
  });
  add('r10', 'wardrobe', 3.4, 3.3, 180, {
    name: 'Guest wardrobe',
    contents: [C('Spare duvet'), C('Winter blanket', 2), C('Pillows', 4)],
  });
  add('r10', 'armchair', 0.2, 2.8, 0, { brand: 'Kave Home' });

  // ---- Storage room --------------------------------------------------------------------------
  add('r11', 'metal_shelf', 0.15, 0.15, 0, {
    name: 'Shelf A',
    printed: true,
    places: 4,
    contents: [
      C('Light bulbs E27', 6),
      C('Batteries AA', 8, { min: 12, type: 'batteries' }),
      C('Extension lead', 3),
      C('First-aid kit', 1, { type: 'first_aid_kit' }),
    ],
  });
  add('r11', 'metal_shelf', 0.85, 0.15, 0, {
    name: 'Shelf B',
    printed: true,
    places: 4,
    contents: [
      C('Toilet paper (packs)', 2, { min: 3 }),
      C('Kitchen roll', 4),
      C('Cleaning spray', 3),
    ],
  });
  add('r11', 'metal_shelf', 1.55, 0.15, 0, {
    name: 'Shelf C',
    printed: true,
    places: 4,
    contents: [
      C('Suitcase, large', 1, { brand: 'Samsonite' }),
      C('Travel pillow', 2),
      C('Luggage scale'),
    ],
  });
  const moving = add('r11', 'cardboard', 0.4, 2.6, 0, {
    name: 'Moving box 1',
    printed: true,
    tags: ['moving'],
    contents: [C('Old phones', 3), C('Chargers', 7), C('Manuals', 11)],
  });
  on(moving, 'cardboard', 0, 0, {
    name: 'Moving box 2',
    printed: true,
    tags: ['moving'],
    contents: [C('Winter scarves', 5), C('Gloves (pairs)', 3)],
  });
  add('r11', 'cardboard', 1.0, 2.6, 0, {
    name: 'Moving box 3',
    printed: true,
    tags: ['moving', 'kids'],
    contents: [C('Baby clothes', 18), C('Toys', 9)],
  });
  add('r11', 'crate', 2.6, 0.2, 0, {
    name: 'Tools crate',
    printed: true,
    tags: ['tools'],
    contents: [C('Spare tiles', 12), C('Grout'), C('Silicone gun')],
  });

  // ---- Roof ----------------------------------------------------------------------------------
  add('r12', 'water_tank', 0.3, 0.3, 0, {
    name: 'Water tank 1',
    model: '1,000 L',
    due: { title: 'Clean the tank', days: 17 },
  });
  add('r12', 'water_tank', 1.6, 0.3, 0, {
    name: 'Water tank 2',
    model: '1,000 L',
  });
  add('r12', 'ac_unit', 3.2, 0.15, 0, {
    name: 'AC unit, living room',
    photo: 'ac_unit',
    tags: ['warranty'],
    brand: 'Carrier',
    model: 'Optimax 2.25 HP',
    due: { title: 'Clean the filters', days: 15 },
  });
  add('r12', 'ac_unit', 5.3, 0.15, 0, {
    name: 'AC unit, bedroom',
    brand: 'Sharp',
    model: 'AH-A12 1.5 HP',
  });
  add('r12', 'dish', 7.8, 0.3, 0, { model: '90 cm' });
  add('r12', 'outdoor_set', 4.0, 3.8, 0);
  add('r12', 'monobloc', 3.3, 5.2, 0);
  add('r12', 'monobloc', 6.1, 5.2, 0);
  add('r12', 'planter_long', 0.3, 6.3, 0, { name: 'Mint planter' });
  add('r12', 'tall_plant', 8.2, 6.2, 0, { name: 'Bougainvillea' });
  add('r12', 'watering_can', 2.0, 6.4, 0);
  add('r13', 'metal_shelf', 0.15, 0.15, 0, {
    name: 'Roof shelf',
    contents: [
      C('Spare tap washers', 10),
      C('PVC pipe glue'),
      C('Tank float valve'),
      C('Rope 20 m'),
    ],
  });
  add('r13', 'crate', 1.0, 0.2, 0, {
    name: 'Plant crate',
    contents: [
      C('Potting soil 20 L', 1, { min: 2 }),
      C('Plant food'),
      C('Secateurs', 1, { brand: 'Fiskars' }),
    ],
  });
  add('r13', 'cardboard', 1.0, 1.6, 0, {
    name: 'Old fans box',
    contents: [C('Desk fan', 2), C('Fan remote')],
  });

  return {
    view: {
      locationId: 'sample',
      canArrange: true,
      version: null,
      levels,
      rooms,
      nodes,
      things,
      more: 0,
      attention,
    },
    facts,
    location: 'Sample home',
  };
}
