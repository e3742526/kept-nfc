/** English interface copy for the documentation map demo. */
import {
  formatRoomSide,
  type MapModelKey,
  type MapRoomKind,
  type MapSurface,
  mToCm,
  type ShapeGroup,
} from '@kept/shared';

export type Lang = 'ar' | 'de' | 'en' | 'es' | 'fr' | 'it' | 'uk' | 'vi';
export type OtherLang = Exclude<Lang, 'en' | 'ar'>;

export const MODEL_NAMES: Record<MapModelKey, string> = {
  sofa: 'Sofa',
  armchair: 'Armchair',
  coffee_table: 'Coffee table',
  tv_stand: 'TV stand',
  cube_shelf: 'Cube shelf',
  tall_plant: 'Tall plant',
  plant: 'Plant',
  succulent: 'Succulent',
  dining_chair: 'Dining chair',
  drawers: 'Chest of drawers',
  bedside: 'Bedside table',
  metal_shelf: 'Metal shelf',
  tool_cart: 'Tool cart',
  drill: 'Drill',
  cardboard: 'Moving box',
  crate: 'Crate',
  basket: 'Basket',
  outdoor_set: 'Bistro set',
  monobloc: 'Plastic chair',
  planter: 'Planter',
  planter_long: 'Long planter',
  ac_unit: 'AC outdoor unit',
  watering_can: 'Watering can',
  tv: 'TV',
  bookshelf: 'Bookshelf',
  cube_grid: 'Cube storage',
  bookcase: 'Tall bookcase',
  shelving_unit: 'Shelving unit',
  lamp: 'Floor lamp',
  counter: 'Kitchen counter',
  sink: 'Sink counter',
  fridge: 'Fridge',
  coffee_machine: 'Coffee machine',
  microwave: 'Microwave',
  dining: 'Dining table',
  bed: 'Bed',
  wardrobe: 'Wardrobe',
  table_lamp: 'Table lamp',
  desk: 'Desk',
  monitor: 'Monitor',
  laptop: 'Laptop',
  monitor_arm: 'Monitor arm',
  dual_monitor_arm: 'Dual monitor arm',
  pc_tower: 'Desktop PC',
  keyboard: 'Keyboard',
  mouse: 'Mouse',
  webcam: 'Webcam',
  camera: 'Camera',
  speaker: 'Desk speaker',
  portable_speaker: 'Portable speaker',
  floor_speaker: 'Tall speaker',
  boombox: 'Boombox',
  smart_speaker: 'Smart speaker',
  soundbar: 'Soundbar',
  headphones: 'Headphones',
  headset: 'Headset',
  earbuds: 'Earbuds',
  router: 'Router',
  printer: 'Printer',
  console: 'Game console',
  controller: 'Game controller',
  phone: 'Phone',
  tablet: 'Tablet',
  power_strip: 'Power strip',
  external_drive: 'External drive',
  mini_pc: 'Mini PC',
  nas: 'NAS',
  sbc: 'Raspberry Pi or SBC',
  network_switch: 'Network switch',
  patch_panel: 'Patch panel',
  ups: 'UPS',
  device: 'Small device',
  chair: 'Desk chair',
  cabinet: 'Filing cabinet',
  rack_24u: 'Server rack 24U',
  rack_42u: 'Server rack 42U',
  box: 'Storage box',
  washer: 'Washing machine',
  water_purifier: 'Water purifier',
  workbench: 'Workbench',
  tool_wall: 'Tool wall',
  wall_tv: 'Wall TV',
  wall_shelf: 'Wall shelf',
  wall_cabinet: 'Wall cabinet',
  rack_wall_6u: 'Wall rack 6U',
  rack_wall_12u: 'Wall rack 12U',
  picture: 'Picture or mirror',
  clock: 'Wall clock',
  hooks: 'Hooks',
  car: 'Car',
  bike: 'Bike',
  water_tank: 'Water tank',
  dish: 'Satellite dish',
  stairs: 'Stairs',
  stairwell: 'Stairwell',
  zone: 'Area',
  item: 'Small thing',
};

/** The shape picker's groups (D249). */
export const GROUP_NAMES: Record<ShapeGroup, string> = {
  furniture: 'Furniture',
  storage: 'Storage',
  wall: 'On the wall',
  electronics: 'Electronics',
  kitchen: 'Kitchen and laundry',
  tools: 'Tools',
  outdoor: 'Plants and outdoor',
  vehicles: 'Vehicles',
  building: 'Stairs and areas',
  other: 'Other',
};

export const ROOM_KIND_NAMES: Record<MapRoomKind, string> = {
  room: 'Room',
  balcony: 'Balcony',
  terrace: 'Terrace',
  garden: 'Garden',
};

export const SURFACE_NAMES: Record<MapSurface, string> = {
  wood: 'Wood',
  tile: 'Tiles',
  concrete: 'Concrete',
  deck: 'Deck',
  grass: 'Grass',
};

export type Words = {
  sample: string;
  reset: string;
  install: string;
  mapOf: (name: string) => string;
  where: string;
  view: string;
  threeD: string;
  plan: string;
  arrange: string;
  done: string;
  pins: string;
  pin: Record<'low' | 'lent' | 'due', { long: string; short: string }>;
  arrangeTool: string;
  move: string;
  drawRoom: string;
  addFloor: string;
  cancel: string;
  hints: Record<'move' | 'room' | 'overlap' | 'blocked', string>;
  /** #301: where an arrow key moved the selected room, for screen readers. */
  movedRoom: Record<'ArrowUp' | 'ArrowDown' | 'ArrowLeft' | 'ArrowRight', (room: string) => string>;
  floor: string;
  allFloors: string;
  all: string;
  zoomIn: string;
  zoomOut: string;
  turnLeft: string;
  turnRight: string;
  home: string;
  detailed: string;
  glError: string;
  placesHere: string;
  noFloor: string;
  roomN: (n: string) => string;
  floorN: (n: string) => string;
  engine: {
    onIt: (name: string) => string;
    more: (n: number) => string;
    inside: (n: number) => string;
    openFloor: string;
    changeFloor: string;
  };
  close: string;
  open: string;
  whatsHere: (n: string) => string;
  insideN: (n: string) => string;
  details: string;
  less: string;
  turn: string;
  takeOff: string;
  upTo: (name: string) => string;
  downTo: (name: string) => string;
  size: (w: string, d: string) => string;
  things: (n: number, f: string) => string;
  thingsInside: (n: number, f: string) => string;
  onHost: (name: string) => string;
  within: Record<'low' | 'lent' | 'due', (n: string) => string>;
  low: (remaining: string, min: string) => string;
  lentTo: (who: string) => string;
  lentBack: (who: string, back: string) => string;
  someone: string;
  dueOn: (what: string, when: string) => string;
  overdue: (what: string, when: string) => string;
  dueWord: string;
  facts: {
    type: string;
    quantity: string;
    brand: string;
    model: string;
    serial: string;
    condition: string;
    tags: string;
  };
  noType: string;
  /** The label's QR code, as the app's card names it. */
  qrLabel: (code: string) => string;
  placesIn: (n: number, f: string) => string;
  /** The card's links into Kept: in the demo they lead to Install Kept. */
  openPlace: string;
  openThing: string;
  photograph: string;
  countRoom: string;
  /** "What's in" under the map (apps/web/src/map/whats-in.tsx). */
  list: {
    title: (name: string) => string;
    rooms: (n: number, f: string) => string;
    floors: (n: number, f: string) => string;
    /** After the bold count: "3 low". */
    sum: Record<'low' | 'lent' | 'due', string>;
    find: string;
    findLabel: string;
    show: string;
    byRoom: string;
    attention: string;
    nothingHere: string;
    nothingYet: string;
    more: (f: string) => string;
    fewer: string;
  };
  /** Cancel's question, and Done's Undo. */
  confirm: { title: string; body: string; throwAway: string };
  arranged: string;
  undo: string;
  undone: string;
  /** The shape picker's footer (#171): before, the link, between, the link, after. */
  shapesMore: [string, string, string, string, string];
  noPhoto: string;
  labelThing: string;
  labelPlace: string;
  onIt: string;
  findInside: (name: string) => string;
  findInsideLabel: string;
  nothingMatches: string;
  nothingYet: string;
  kind: string;
  surface: string;
  shape: string;
  /** D249: the card's shape line and the shape picker. */
  shapeLine: (shape: string, from: 'type' | 'name' | 'guess' | undefined) => string;
  change: string;
  pickShape: string;
  shapeFor: (name: string) => string;
  findShape: string;
  findShapeHint: string;
  shapes: string;
  suggested: string;
  noShape: (query: string) => string;
  putOnMap: string;
  findThingIn: (name: string) => string;
  findThingLabel: string;
  everythingOnMap: string;
  /** #138: a thing on a wall's Height, and where it hangs. */
  height: {
    label: string;
    lower: string;
    higher: string;
    help: string;
    value: (n: string) => string;
    onWall: (n: string) => string;
  };
  /** #137: Put on…, Add on it and Take off. */
  put: {
    putOn: string;
    addOn: string;
    putTitle: (name: string) => string;
    addTitle: (name: string) => string;
    onNow: (name: string) => string;
    takeOff: string;
    list: string;
    shapeOn: (shape: string, on: string) => string;
    nothing: (room: string) => string;
    nothingElse: (room: string) => string;
    toAdd: string;
    full: (n: number, f: string) => string;
    left: (n: number, f: string) => string;
    noMonitor: (room: string) => string;
    allOn: (room: string) => string;
    /** #152: Add on it's two lists. */
    onMap: string;
    notOnMap: string;
    putN: (n: number, f: string) => string;
    pick: string;
    onItNow: (names: string) => string;
    /** A list longer than eight gets a search (put-on.tsx). */
    findPlace: string;
    findIn: (room: string) => string;
    findThing: string;
  };
};

/** Arabic plural forms (zero, one, two, few, many, other), as the app's catalogue writes them. */
export const WORDS: Record<'en', Words> = {
  en: {
    sample: 'A sample home, in your browser. Nothing you change is saved or sent anywhere.',
    reset: 'Reset',
    install: 'Install Kept',
    mapOf: (name) => `Map of ${name}`,
    where: 'Where you are on the map',
    view: 'View',
    threeD: '3D',
    plan: 'Plan',
    arrange: 'Arrange',
    done: 'Done',
    pins: 'Pins',
    pin: {
      low: { long: 'Low stock', short: 'Low' },
      lent: { long: 'Lent out', short: 'Lent' },
      due: { long: 'Due soon', short: 'Due' },
    },
    arrangeTool: 'Arrange tool',
    move: 'Move',
    drawRoom: 'Draw a room',
    addFloor: 'Add a floor',
    cancel: 'Cancel',
    hints: {
      move: 'Drag anything to move it. Drop small things on a counter, desk, shelf or box; wall things go on the nearest wall. To move a room, hold its floor, then drag. Drag its amber corner to resize it.',
      room: 'Drag on empty ground to draw a new room on this floor.',
      overlap: 'Rooms can’t overlap. Draw on empty ground.',
      blocked: 'Rooms can’t overlap.',
    },
    movedRoom: {
      ArrowUp: (room) => `Moved ${room} up.`,
      ArrowDown: (room) => `Moved ${room} down.`,
      ArrowLeft: (room) => `Moved ${room} left.`,
      ArrowRight: (room) => `Moved ${room} right.`,
    },
    floor: 'Floor',
    allFloors: 'All floors',
    all: 'All',
    zoomIn: 'Zoom in',
    zoomOut: 'Zoom out',
    turnLeft: 'Turn left',
    turnRight: 'Turn right',
    home: 'Show the whole floor',
    detailed: 'Detailed models',
    glError: 'This browser can’t draw the map.',
    placesHere: 'Places on this level',
    noFloor: 'Not on a floor',
    roomN: (n) => `Room ${n}`,
    floorN: (n) => `Floor ${n}`,
    engine: {
      onIt: (name) => `on it: ${name}`,
      more: (n) => `+${n} more`,
      inside: (n) => `${n} inside`,
      openFloor: 'click to open',
      changeFloor: 'click to change floor',
    },
    close: 'Close',
    open: 'Open',
    whatsHere: (n) => `What’s here, ${n}`,
    insideN: (n) => `Inside, ${n}`,
    details: 'Details',
    less: 'Less',
    turn: 'Turn',
    height: {
      label: 'Height',
      lower: 'Lower',
      higher: 'Higher',
      help: 'From the floor to its middle',
      value: (n) => `${n} m`,
      onWall: (n) => `On the wall, ${n} m up`,
    },
    takeOff: 'Take off the map',
    upTo: (name) => `Up to ${name}`,
    downTo: (name) => `Down to ${name}`,
    size: (w, d) => `${w} × ${d} m`,
    things: (n, f) => (n === 1 ? `${f} thing` : `${f} things`),
    thingsInside: (n, f) => (n === 1 ? `${f} thing inside` : `${f} things inside`),
    onHost: (name) => `on ${name}`,
    within: {
      low: (n) => `${n} running low inside`,
      lent: (n) => `${n} lent out inside`,
      due: (n) => `${n} due inside`,
    },
    low: (remaining, min) => `${remaining} left, keep at least ${min}`,
    lentTo: (who) => `Lent to ${who}`,
    lentBack: (who, back) => `Lent to ${who}, back by ${back}`,
    someone: 'someone',
    dueOn: (what, when) => `${what}: due ${when}`,
    overdue: (what, when) => `${what}: overdue since ${when}`,
    dueWord: 'Due',
    facts: {
      type: 'Type',
      quantity: 'Quantity',
      brand: 'Brand',
      model: 'Model',
      serial: 'Serial',
      condition: 'Condition',
      tags: 'Tags',
    },
    noType: 'No type',
    qrLabel: (code) => `QR label for ${code}`,
    placesIn: (n, f) => (n === 1 ? `${f} place in it` : `${f} places in it`),
    openPlace: 'Open the place',
    openThing: 'Open the thing',
    photograph: 'Photograph this room',
    countRoom: 'Count this room',
    list: {
      title: (name) => `What’s in ${name}`,
      rooms: (n, f) => (n === 1 ? `${f} room` : `${f} rooms`),
      floors: (n, f) => (n === 1 ? `${f} floor` : `${f} floors`),
      sum: { low: 'low', lent: 'lent', due: 'due' },
      find: 'Find a thing or a short ID',
      findLabel: 'Find a thing',
      show: 'Show',
      byRoom: 'By room',
      attention: 'Needs attention',
      nothingHere: 'Nothing here.',
      nothingYet: 'Nothing here yet.',
      more: (f) => `Show ${f} more`,
      fewer: 'Show fewer',
    },
    confirm: {
      title: 'Throw away these changes?',
      body: 'The map goes back to how it was.',
      throwAway: 'Throw away',
    },
    arranged: 'Map arranged',
    undo: 'Undo',
    undone: 'Undone',
    shapesMore: ['Missing a shape? ', 'Contribute one', ', or browse the ', 'shape library', '.'],
    noPhoto: 'No photo yet',
    labelThing: 'Label of this thing',
    labelPlace: 'Label of this place',
    onIt: 'On it',
    findInside: (name) => `Find inside ${name}`,
    findInsideLabel: 'Find inside',
    nothingMatches: 'Nothing matches.',
    nothingYet: 'Nothing in it yet.',
    kind: 'Kind',
    surface: 'Floor',
    shape: 'Shape',
    shapeLine: (shape, from) =>
      from === 'type'
        ? `Shape: ${shape}, from its type`
        : from === 'name'
          ? `Shape: ${shape}, from its name`
          : from === 'guess'
            ? `Shape: ${shape}, a guess`
            : `Shape: ${shape}`,
    change: 'Change',
    pickShape: 'Pick a shape',
    shapeFor: (name) => `Shape for ${name}`,
    findShape: 'Find a shape',
    findShapeHint: 'Find a shape: TV, shelf, box…',
    shapes: 'Shapes',
    suggested: 'Suggested',
    noShape: (q) =>
      `No shape matches “${q}”. Try Small thing or Small device, and give it a name that says what it is.`,
    putOnMap: 'Put on the map',
    findThingIn: (name) => `Find a thing in ${name}`,
    findThingLabel: 'Find a thing to put on the map',
    everythingOnMap: 'Everything here is on the map.',
    put: {
      putOn: 'Put on…',
      addOn: 'Add on it',
      putTitle: (name) => `Put ${name} on…`,
      addTitle: (name) => `Add on ${name}`,
      onNow: (name) => `On ${name}`,
      takeOff: 'Take off',
      list: 'What can carry it',
      shapeOn: (shape, on) => `${shape}, on ${on}`,
      nothing: (room) =>
        `Nothing in ${room} can carry it. Put a desk, a shelf or a monitor on the map first.`,
      nothingElse: (room) => `Nothing else in ${room} can carry it.`,
      toAdd: 'Things to add on it',
      full: (n, f) => (n === 1 ? 'Full: it holds one monitor.' : `Full: it holds ${f} monitors.`),
      left: (n, f) => (n === 1 ? 'Room for one more.' : `Room for ${f} more.`),
      noMonitor: (room) => `No monitor in ${room} is free.`,
      allOn: (room) => `Everything small in ${room} is on something already.`,
      onMap: 'On the map',
      notOnMap: 'Not on the map yet',
      putN: (_n, f) => `Put ${f} on it`,
      pick: 'Pick what goes on it',
      onItNow: (names) => `On it now: ${names}`,
      findPlace: 'Find a place to put it',
      findIn: (room) => `Find in ${room}`,
      findThing: 'Find a thing to add',
    },
  },
};

/** Everything the demo says in one language. */
export type Pack = {
  words: Words;
  models: Record<MapModelKey, string>;
  groups: Record<ShapeGroup, string>;
  kinds: Record<MapRoomKind, string>;
  surfaces: Record<MapSurface, string>;
  /** The sample home's names, by their English one (sample.ts). */
  sample: Readonly<Record<string, string>>;
};

export function basePack(_lang: 'en' | 'ar'): Pack {
  return {
    words: WORDS.en,
    models: MODEL_NAMES,
    groups: GROUP_NAMES,
    kinds: ROOM_KIND_NAMES,
    surfaces: SURFACE_NAMES,
    sample: {},
  };
}

export async function loadPack(_lang: Lang): Promise<Pack> {
  return basePack('en');
}

/** Numbers and dates as the app writes them (apps/web/src/lib/format.ts): Eastern digits in Arabic. */
export function formatter(lang: Lang) {
  const tag = lang === 'ar' ? 'ar-u-nu-arab' : lang;
  const nf = new Intl.NumberFormat(tag);
  const day = new Intl.DateTimeFormat(tag, { day: 'numeric', month: 'short' });
  return {
    /** Between a line's parts: a comma, the Arabic comma in Arabic; never the middle dot (#459). */
    sep: lang === 'ar' ? '، ' : ', ',
    num: (n: number) => nf.format(n),
    /** A room's side (metres), to the centimetre, as the app's card and plan view say it (#372). */
    side: (m: number) => formatRoomSide(mToCm(m), tag),
    day: (iso: string) => {
      const [y, m, d] = iso.split('-').map(Number);
      return day.format(new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1)).replace(/ /g, ' ');
    },
  };
}
