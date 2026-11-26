import { parseDeviceLabel } from '@kept/shared';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { TestApp } from '../../test/app.js';
import { type TestDb, testDb } from '../../test/db.js';
import { call, freshIp, join, type Person, peopleApp, person } from '../../test/people.js';
import { createLocation, createThing, type Loc, ok, own } from '../../test/things.js';

// Numbered label series (labels/series.ts), the label address (labels/label-host.ts) and the
// iPhone app's association file, through the front door.

/** Series IDs the next reservations try, in order, before random ones (the collision test). */
const queued: string[] = [];
vi.mock('@kept/shared', async (importOriginal) => {
  const real = await importOriginal<typeof import('@kept/shared')>();
  return {
    ...real,
    randomDeviceBatchId: () => queued.shift() ?? real.randomDeviceBatchId(),
  };
});

const LABELS = 'https://labels.example.org';
const APP_ID = 'ABCDE12345.info.keptinventory.nfc';

let db: TestDb;
let t: TestApp;
let ibrahim: Person; // owner of Home
let louis: Person; // member of Home
let talia: Person; // viewer of Home
let bruce: Person; // another household
let home: Loc;
let garage: Loc;

type Cell = { code: string; alias?: string; url: string; kind: string; targetId?: string };
type Batch = { id: string; labels: Cell[] };

const numbered = (as: Person, loc: Loc, prefix: string, blankCount: number) =>
  call(t, '/api/v1/labels/batches', {
    as,
    body: {
      locationId: loc.id,
      kind: 'blank',
      blankCount,
      stock: 'thermal_1x1in',
      series: { prefix },
    },
  });
const resolve = (as: Person, text: string) =>
  call(t, '/api/v1/scan/resolve', { as, body: { text } });
const answer = (res: LightMyRequestResponse) => ({ status: res.statusCode, body: res.body });
const onHost = (host: string, url: string, method: 'GET' | 'HEAD' | 'POST' = 'GET') =>
  t.app.inject({ method, url, headers: { host }, remoteAddress: freshIp() });

beforeAll(async () => {
  db = await testDb();
  await db.reset();
  t = await peopleApp(db, { labelUrl: LABELS, appleAppIds: [APP_ID] });
  ibrahim = await person(t, db, 'ibrahim');
  louis = await person(t, db, 'louis');
  talia = await person(t, db, 'talia');
  bruce = await person(t, db, 'bruce');
  home = await createLocation(t, db, ibrahim, 'household');
  garage = await createLocation(t, db, bruce, 'household', 'Garage');
  await join(db, home.id, louis.userId, 'member');
  await join(db, home.id, talia.userId, 'viewer');
});

afterAll(async () => {
  await t.app.close();
});

describe('a numbered series', () => {
  // catalogue: POST /api/v1/labels/batches
  it('numbers a blank sheet in print order, each label its alias and the label address', async () => {
    const out = ok(await numbered(louis, home, 'bin', 3), 201) as unknown as { batch: Batch };
    const labels = out.batch.labels;
    expect(labels).toHaveLength(3);
    const first = parseDeviceLabel(labels[0]?.alias ?? '');
    expect(first).toMatchObject({ prefix: 'BIN', sequence: 1 });
    labels.forEach((cell, i) => {
      expect(cell.alias).toBe(`BIN-${first?.batchId}-000${i + 1}`);
      expect(cell.url).toBe(`${LABELS}/l/${cell.alias}`);
      expect(cell.code).toMatch(/^[0-9A-HJKMNP-TV-Z]{6}$/);
      expect(cell.kind).toBe('blank');
    });
    const events = await own<{ diff: Record<string, unknown> }>(
      db,
      `SELECT diff FROM public.audit_events
        WHERE location_id = $1 AND action = 'label_batch.create' ORDER BY at DESC LIMIT 1`,
      [home.id],
    );
    expect(events[0]?.diff).toMatchObject({
      series: { after: `BIN-${first?.batchId}` },
      code_count: { after: 3 },
    });
    // A reprint is the same labels (D45).
    const again = ok(await call(t, `/api/v1/labels/batches/${out.batch.id}`, { as: talia }));
    expect((again as unknown as Batch).labels).toEqual(labels);
  });

  it('tries the next series ID when one is taken anywhere, and never says whose it was', async () => {
    const taken = ok(await numbered(bruce, garage, 'LOC', 1), 201) as unknown as { batch: Batch };
    const series = parseDeviceLabel(taken.batch.labels[0]?.alias ?? '')?.batchId as string;
    queued.push(series, 'ZZ99');
    const out = ok(await numbered(ibrahim, home, 'LOC', 2), 201) as unknown as { batch: Batch };
    expect(out.batch.labels.map((l) => l.alias)).toEqual(['LOC-ZZ99-0001', 'LOC-ZZ99-0002']);
    // The same series ID under another prefix is another series.
    queued.push('ZZ99');
    const tmp = ok(await numbered(ibrahim, home, 'TMP', 1), 201) as unknown as { batch: Batch };
    expect(tmp.batch.labels[0]?.alias).toBe('TMP-ZZ99-0001');
  });

  it('registers exactly the device batch, replays it, and refuses collisions atomically', async () => {
    const id = crypto.randomUUID();
    const body = {
      id,
      locationId: home.id,
      kind: 'blank',
      blankCount: 2,
      stock: 'thermal_50x20',
      series: { prefix: 'TMP', id: 'OIL0', origin: LABELS },
    };
    const register = (as: Person, request = body) =>
      call(t, '/api/v1/labels/batches', { as, body: request });
    const first = ok(await register(louis), 201) as unknown as { batch: Batch };
    expect(first.batch.id).toBe(id);
    const suffix = id.slice(-12);
    const cell = first.batch.labels[0] as Cell;
    expect(cell.url).toBe(`${LABELS}/l/TMP-OIL0-0001-${suffix}`);
    expect(ok(await register(louis), 201)).toEqual(first);
    const rejected = { ...body, id: crypto.randomUUID(), locationId: garage.id };
    const collision = await register(bruce, rejected);
    expect(collision.statusCode).toBe(409);
    expect(collision.json()).toMatchObject({ code: 'label_series_collision' });
    const missing = await call(t, `/api/v1/labels/batches/${rejected.id}`, { as: bruce });
    expect(missing.statusCode).toBe(404);
    expect(ok(await resolve(louis, cell.url))).toMatchObject({ outcome: 'claim', code: cell.code });
    expect(ok(await resolve(louis, `${LABELS}/l/TMP-OIL0-0001-${rejected.id.slice(-12)}`))).toEqual(
      { outcome: 'not_in_your_kept' },
    );
    expect(
      (await onHost('labels.example.org', new URL(cell.url).pathname)).headers.location,
    ).toContain(`/l/TMP-OIL0-0001-${suffix}`);
  });

  it('numbers only blank sheets, with a three-letter prefix, and only for writers', async () => {
    const thing = await createThing(t, ibrahim, home, { name: 'Drill' });
    const things = await call(t, '/api/v1/labels/batches', {
      as: ibrahim,
      body: {
        locationId: home.id,
        kind: 'things',
        thingIds: [thing.id],
        stock: 'thermal_1x1in',
        series: { prefix: 'ITM' },
      },
    });
    expect(things.statusCode).toBe(400);
    for (const prefix of ['BI', 'BINS', 'B1N', '']) {
      expect((await numbered(ibrahim, home, prefix, 1)).statusCode).toBe(400);
    }
    expect((await numbered(talia, home, 'BIN', 1)).statusCode).toBe(403);
  });
});

describe('reading a numbered label', () => {
  it('is its short ID: claim a blank, then it opens what it was claimed for', async () => {
    const out = ok(await numbered(louis, home, 'BIN', 1), 201) as unknown as { batch: Batch };
    const cell = out.batch.labels[0] as Cell;
    const alias = cell.alias as string;
    // The link, the alias typed in lower case, and with a printed non-breaking hyphen.
    for (const text of [cell.url, alias.toLowerCase(), alias.replaceAll('-', '‑')]) {
      expect(ok(await resolve(louis, text))).toEqual({
        outcome: 'claim',
        locationId: home.id,
        code: cell.code,
      });
    }
    const box = await createThing(t, louis, home, { name: 'Camping box' });
    ok(await call(t, `/api/v1/codes/${cell.code}/claim`, { as: louis, body: { thingId: box.id } }));
    expect(ok(await resolve(talia, cell.url))).toEqual({
      outcome: 'open',
      target: { kind: 'thing', id: box.id, locationId: home.id },
    });
    // A replacement label for the box prints the same numbered label.
    const reprint = ok(
      await call(t, '/api/v1/labels/batches', {
        as: louis,
        body: { locationId: home.id, kind: 'things', thingIds: [box.id], stock: 'thermal_2x2in' },
      }),
      201,
    ) as unknown as { batch: Batch };
    expect(reprint.batch.labels[0]).toMatchObject({ code: cell.code, alias, url: cell.url });
  });

  // catalogue: POST /api/v1/labels/replace
  it('replaces two stickers in sequence while every QR still opens the same inventory UUID', async () => {
    const box = await createThing(t, louis, home, { name: 'Cable box' });
    const labels = (ok(await numbered(louis, home, 'CAB', 3), 201) as unknown as { batch: Batch })
      .batch.labels;
    const url = (index: number) => labels[index]?.url as string;
    ok(
      await call(t, `/api/v1/codes/${labels[0]?.code}/claim`, {
        as: louis,
        body: { thingId: box.id },
      }),
    );
    const replace = (as: Person, from: number, to: number) =>
      call(t, '/api/v1/labels/replace', {
        as,
        body: {
          locationId: home.id,
          previous: url(from),
          replacement: url(to),
          reason: 'Worn sticker',
        },
      });
    expect((await replace(talia, 0, 1)).statusCode).toBe(403);
    ok(await replace(louis, 0, 1));
    ok(await replace(louis, 0, 1));
    expect((await replace(louis, 0, 2)).statusCode).toBe(404);
    ok(await replace(louis, 1, 2));
    const target = { kind: 'thing', id: box.id, locationId: home.id };
    expect(ok(await resolve(talia, url(0)))).toEqual({ outcome: 'open', target, superseded: true });
    expect(ok(await resolve(talia, url(1)))).toEqual({ outcome: 'open', target, superseded: true });
    expect(ok(await resolve(talia, url(2)))).toEqual({ outcome: 'open', target });
    const rows = await own<{
      replacement_code: string;
      replacement_reason: string;
      superseded_by: string;
    }>(
      db,
      'SELECT replacement_code, replacement_reason, superseded_by FROM public.short_ids WHERE code = $1',
      [labels[0]?.code],
    );
    expect(rows[0]).toMatchObject({
      replacement_code: labels[1]?.code,
      replacement_reason: 'Worn sticker',
      superseded_by: louis.userId,
    });
    const events = await own<{ diff: Record<string, unknown> }>(
      db,
      "SELECT diff FROM public.audit_events WHERE action = 'label.replace' AND entity_id = $1",
      [box.id],
    );
    expect(events).toHaveLength(2);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          diff: expect.objectContaining({
            code: expect.objectContaining({ before: labels[0]?.code, after: labels[1]?.code }),
            reason: expect.objectContaining({ after: 'Worn sticker' }),
          }),
        }),
      ]),
    );
  });

  // catalogue: POST /api/v1/labels/tags
  it('verifies NFC and registers a distinct, unique EPC across physical sticker replacement', async () => {
    const box = await createThing(t, louis, home, {
      name: 'Tagged drill',
      barcode: '5901234123457',
    });
    const blank = (ok(await numbered(louis, home, 'TOL', 1), 201) as unknown as { batch: Batch })
      .batch.labels[0] as Cell;
    const epc = '300833B2DDD9014000000001';
    const register = (
      as: Person,
      tag: { kind: 'nfc' } | { kind: 'uhf'; epc: string },
      label = box.shortCode,
    ) =>
      call(t, '/api/v1/labels/tags', {
        as,
        body: { locationId: home.id, label, ...tag },
      });
    expect((await register(talia, { kind: 'nfc' })).statusCode).toBe(403);
    ok(await register(louis, { kind: 'nfc' }));
    ok(await register(louis, { kind: 'uhf', epc }));
    const another = await createThing(t, louis, home, {
      name: 'Another drill',
      barcode: '5901234123457',
    });
    expect((await register(louis, { kind: 'uhf', epc }, another.shortCode)).statusCode).toBe(409);
    ok(
      await call(t, '/api/v1/labels/replace', {
        as: louis,
        body: {
          locationId: home.id,
          previous: box.shortCode,
          replacement: blank.url,
          reason: 'Smudged',
        },
      }),
    );
    const printed = ok(
      await call(t, '/api/v1/labels/batches', {
        as: louis,
        body: {
          locationId: home.id,
          kind: 'things',
          thingIds: [box.id],
          stock: 'thermal_30_48x20_32',
        },
      }),
      201,
    ) as unknown as { batch: Batch };
    expect(printed.batch.labels[0]).toMatchObject({ code: blank.code, nfc: 'verified', uhf: true });
    const read = ok(
      await call(t, '/api/v1/scan/resolve', { as: talia, body: { text: epc, format: 'uhf_rfid' } }),
    );
    expect(read).toEqual({
      outcome: 'open',
      target: { kind: 'thing', id: box.id, locationId: home.id },
    });
    const events = await own<{ diff: Record<string, unknown> }>(
      db,
      "SELECT diff FROM public.audit_events WHERE action = 'label.tag.register' AND entity_id = $1",
      [box.id],
    );
    expect(events).toHaveLength(2);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          diff: expect.objectContaining({
            nfc_verified: expect.objectContaining({ after: true }),
          }),
        }),
      ]),
    );
  });

  it("answers another household's numbered label, a viewer's blank and an unknown one alike", async () => {
    const theirs = ok(await numbered(bruce, garage, 'BIN', 1), 201) as unknown as {
      batch: Batch;
    };
    const blank = ok(await numbered(ibrahim, home, 'GEN', 1), 201) as unknown as {
      batch: Batch;
    };
    const miss = answer(await resolve(talia, 'BIN-0000-0001'));
    expect(JSON.parse(miss.body)).toEqual({ outcome: 'not_in_your_kept' });
    expect(answer(await resolve(talia, theirs.batch.labels[0]?.url as string))).toEqual(miss);
    expect(answer(await resolve(talia, blank.batch.labels[0]?.url as string))).toEqual(miss);
  });

  it('can be a household own code that looks like one', async () => {
    const thing = await createThing(t, ibrahim, home, { name: 'Ladder' });
    await own(
      db,
      `INSERT INTO public.legacy_codes (location_id, source, code, thing_id)
       VALUES ($1, 'own', 'SHF-OWN1-0001', $2)`,
      [home.id, thing.id],
    );
    expect(ok(await resolve(ibrahim, 'SHF-OWN1-0001'))).toEqual({
      outcome: 'open',
      target: { kind: 'thing', id: thing.id, locationId: home.id },
    });
  });

  it('can neither be updated nor deleted by the app, nor made for a code that is not blank', async () => {
    const out = ok(await numbered(ibrahim, home, 'BIN', 1), 201) as unknown as { batch: Batch };
    const code = out.batch.labels[0]?.code as string;
    const rows = await own<{ series_id: string }>(
      db,
      'SELECT series_id FROM public.label_aliases WHERE code = $1',
      [code],
    );
    expect(rows).toHaveLength(1);
    const privileges = await own<{ t: string; up: boolean; del: boolean }>(
      db,
      `SELECT t, has_table_privilege('kept_app', 'public.' || t, 'UPDATE') AS up,
              has_table_privilege('kept_app', 'public.' || t, 'DELETE') AS del
         FROM unnest(ARRAY['label_series', 'label_aliases']) t`,
    );
    expect(privileges).toEqual([
      { t: 'label_series', up: false, del: false },
      { t: 'label_aliases', up: false, del: false },
    ]);
  });
});

describe('the label address', () => {
  const host = new URL(LABELS).host;

  it('sends a label on to the public address, and nothing else', async () => {
    for (const [path, to] of [
      ['/l/BIN-A09Z-0001', '/l/BIN-A09Z-0001'],
      ['/t/BIN-A09Z-0001', '/l/BIN-A09Z-0001'],
      ['/l/7KQ4MZ?utm=x', '/l/7KQ4MZ'],
      ['/', '/'],
    ] as const) {
      const res = await onHost(host, path);
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe(`${t.publicUrl}${to}`);
    }
    expect((await onHost(host, '/l/BIN-A09Z-0001', 'HEAD')).statusCode).toBe(302);
    for (const path of ['/api/v1/labels/summary', '/l/a%2Fb', '/l/x/y', '/settings', '/l/']) {
      expect((await onHost(host, path)).statusCode).toBe(404);
    }
    expect((await onHost(host, '/l/BIN-A09Z-0001', 'POST')).statusCode).toBe(404);
  });

  it('serves the iPhone app association there and on the public address, unsigned in', async () => {
    for (const where of [host, new URL(t.publicUrl).host]) {
      const res = await onHost(where, '/.well-known/apple-app-site-association');
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('application/json');
      expect(res.json()).toEqual({
        applinks: {
          details: [
            {
              appIDs: [APP_ID],
              components: [
                { '/': '/l/*', comment: 'A label: its code or numbered alias.' },
                { '/': '/t/???-????-????', comment: 'A numbered label read as /t/.' },
              ],
            },
          ],
        },
      });
    }
  });

  it('tells the phone which address labels carry', async () => {
    expect(ok(await call(t, '/api/v1/labels/address', { as: talia }))).toEqual({ url: LABELS });
  });
});

describe('without a label address or app', () => {
  it('labels carry the public address, and there is no association file', async () => {
    const plain = await peopleApp(db);
    try {
      const res = await plain.app.inject({
        method: 'GET',
        url: '/.well-known/apple-app-site-association',
        remoteAddress: freshIp(),
      });
      expect(res.statusCode).toBe(404);
      const out = ok(
        await call(plain, '/api/v1/labels/batches', {
          as: ibrahim,
          body: {
            locationId: home.id,
            kind: 'blank',
            blankCount: 1,
            stock: 'thermal_1x1in',
            series: { prefix: 'TMP' },
          },
        }),
        201,
      ) as unknown as { batch: Batch };
      const cell = out.batch.labels[0] as Cell;
      expect(cell.url).toBe(`${plain.publicUrl}/l/${cell.alias}`);
      expect(ok(await call(plain, '/api/v1/labels/address', { as: ibrahim }))).toEqual({
        url: plain.publicUrl,
      });
    } finally {
      await plain.app.close();
    }
  });
});
