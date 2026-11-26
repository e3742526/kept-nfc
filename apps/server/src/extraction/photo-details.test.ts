import { newId } from '@kept/shared';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { TestApp } from '../../test/app.js';
import { type TestDb, testDb } from '../../test/db.js';
import { type TestFiles, testFiles, uniqueJpeg, upload } from '../../test/files.js';
import { call, join, type Person, peopleApp, person } from '../../test/people.js';
import { builtinType, createLocation, createThing, type Loc, ok, own } from '../../test/things.js';
import { providerKeyAad } from '../ai/db-keys.js';
import { type MockAnswer, mockKey } from '../ai/mock.js';
import { aiRuntime } from '../ai/runtime.js';
import { seal } from '../crypto/envelope.js';
import { partsFor } from './image.js';
import { photoEvidence } from './photo-details.js';

// POST /api/v1/things/:id/photo-details through the mock provider: a thing's photos, and photos
// just taken, read for the edit form. Nothing is applied, attempted or audited; the call is on
// the ledger.

let db: TestDb;
let t: TestApp;
let files: TestFiles;
let ibrahim: Person; // owner of Home
let talia: Person; // viewer of Home
let bruce: Person; // another household
let home: Loc;

const MASTER = { key: Buffer.alloc(32, 7), keyVersion: 1 };
const keyring = new Map([[1, MASTER.key]]);
const silent = { warn: () => {}, info: () => {}, error: () => {} };
/** Mutated, never replaced: the app's runtime holds this object. */
const answers: Record<string, MockAnswer> = {};
const c = <T>(value: T, confidence = 0.9) => ({ value, confidence });

const details = (thingId: string, as: Person, body: unknown) =>
  call(t, `/api/v1/things/${thingId}/photo-details`, { as, body });

/** A photo on the thing, as the app attaches one; its bytes as the route will send them. */
async function photoOn(thingId: string): Promise<{ attachmentId: string; key: string }> {
  const bytes = await uniqueJpeg();
  const res = await upload(t, ibrahim, home.id, bytes, { cls: 'photo' });
  expect(res.statusCode, res.body).toBe(201);
  const fileId = (res.json() as { id: string }).id;
  const attachmentId = newId();
  ok(
    await call(t, '/api/v1/attachments', {
      as: ibrahim,
      body: {
        id: attachmentId,
        locationId: home.id,
        fileId,
        subject: { thingId },
        role: 'photo',
      },
    }),
    201,
  );
  const [f] = await own<{ mime: string }>(db, 'SELECT mime FROM public.files WHERE id = $1', [
    fileId,
  ]);
  const parts = await partsFor(
    'label',
    [{ attachmentId, fileId, locationId: home.id, mime: f?.mime as string, displayKey: null }],
    { blobs: files.blobs, textOf: async () => null },
  );
  const img = parts.images[0];
  if (!img) throw new Error('nothing to send');
  return { attachmentId, key: mockKey(img.bytes) };
}

beforeAll(async () => {
  db = await testDb();
  await db.reset();
  files = await testFiles();
  t = await peopleApp(db, {
    files,
    ai: {
      mock: true,
      runtime: (scope) =>
        aiRuntime({ pools: db.pools, keyring: () => keyring, log: silent, mock: answers }, scope),
    },
  });
  ibrahim = await person(t, db, 'ibrahim');
  talia = await person(t, db, 'talia');
  bruce = await person(t, db, 'bruce');
  home = await createLocation(t, db, ibrahim, 'household');
  await join(db, home.id, talia.userId, 'viewer');
  const providerId = newId();
  await own(
    db,
    `INSERT INTO public.ai_providers (id, scope, owner_account_id, kind, key_ciphertext,
                                      key_version, models, created_by)
     VALUES ($1, 'account', $2, 'groq', $3, 1, '{"vision": "qwen/qwen3.8-27b"}', $4)`,
    [
      providerId,
      home.accountId,
      JSON.stringify(seal(MASTER, 'gsk_TESTKEY-details', providerKeyAad(providerId))),
      ibrahim.userId,
    ],
  );
});

afterEach(async () => {
  for (const key of Object.keys(answers)) delete answers[key];
  await own(
    db,
    `DELETE FROM public.ai_breakers; DELETE FROM public.ai_provider_limits;
     DELETE FROM public.ai_leases; DELETE FROM public.ai_budgets;
     DELETE FROM public.ai_usage_windows; DELETE FROM public.ai_cost_windows`,
  );
});

afterAll(async () => {
  await t.app.close();
  await files.cleanup();
});

describe('POST /api/v1/things/:id/photo-details', () => {
  it("reads a thing's photo and a photo just taken, and changes nothing", async () => {
    const drill = await createThing(t, ibrahim, home, { name: 'DeWalt Cordless Impact Driver' });
    const { attachmentId, key } = await photoOn(drill.id as string);
    answers[key] = {
      output: {
        objects: [
          {
            name: c('DeWalt impact driver'),
            brand: c('DeWalt', 0.97),
            model: c('DCF887', 0.95),
            serial: c('2024 18-AB', 0.7),
            colour: c('Yellow', 0.8),
            type_hint: c('power tool', 0.85),
            specs: c('20 V MAX XR, brushless, 1/4 in hex chuck, 3 speeds', 0.6),
          },
        ],
      },
    };
    const before = await own<{ row_version: number; events: number; extractions: number }>(
      db,
      `SELECT t.row_version,
              (SELECT count(*)::int FROM public.audit_events e WHERE e.location_id = t.location_id) AS events,
              (SELECT count(*)::int FROM public.extractions x WHERE x.thing_id = t.id) AS extractions
         FROM public.things t WHERE t.id = $1`,
      [drill.id],
    );
    const taken = (await uniqueJpeg()).toString('base64');

    const body = ok(
      await details(drill.id as string, ibrahim, { attachmentIds: [attachmentId], jpegs: [taken] }),
      200,
    );
    expect(body).toEqual({
      name: c('DeWalt impact driver'),
      brand: c('DeWalt', 0.97),
      model: c('DCF887', 0.95),
      serial: c('2024 18-AB', 0.7),
      colour: c('Yellow', 0.8),
      specs: c('20 V MAX XR, brushless, 1/4 in hex chuck, 3 speeds', 0.6),
      type: { id: await builtinType(db, 'power_tool'), value: 'power tool', confidence: 0.85 },
    });
    // Nothing applied, no attempt, nothing audited: the person saves the form (thing.update).
    const after = await own<{ row_version: number; events: number; extractions: number }>(
      db,
      `SELECT t.row_version,
              (SELECT count(*)::int FROM public.audit_events e WHERE e.location_id = t.location_id) AS events,
              (SELECT count(*)::int FROM public.extractions x WHERE x.thing_id = t.id) AS extractions
         FROM public.things t WHERE t.id = $1`,
      [drill.id],
    );
    expect(after).toEqual(before);
    // The call is on the ledger, as THING's task, with both photos sent.
    const calls = await own<{ task: string; prompt_version: string; thing_id: string }>(
      db,
      'SELECT task, prompt_version, thing_id FROM public.llm_calls WHERE thing_id = $1',
      [drill.id],
    );
    expect(calls).toEqual([
      { task: 'extract_thing', prompt_version: 'details-v1', thing_id: drill.id },
    ]);
  });

  it('a photo just taken is enough, and an empty answer is no suggestions', async () => {
    const lamp = await createThing(t, ibrahim, home, { name: 'Lamp' });
    const taken = await uniqueJpeg();
    const sent = await photoEvidence(taken.toString('base64'));
    answers[mockKey(sent.bytes)] = { output: { objects: [] } };
    expect(
      ok(await details(lamp.id as string, ibrahim, { jpegs: [taken.toString('base64')] }), 200),
    ).toEqual({});
  });

  it('refuses a viewer, another household, a photo not of this thing, and no photo', async () => {
    const drill = await createThing(t, ibrahim, home, { name: 'Drill' });
    const saw = await createThing(t, ibrahim, home, { name: 'Saw' });
    const { attachmentId } = await photoOn(saw.id as string);
    const mine = await photoOn(drill.id as string);
    const id = drill.id as string;
    expect((await details(id, talia, { attachmentIds: [mine.attachmentId] })).statusCode).toBe(403);
    expect((await details(id, bruce, { attachmentIds: [mine.attachmentId] })).statusCode).toBe(404);
    expect((await details(id, ibrahim, { attachmentIds: [attachmentId] })).statusCode).toBe(404);
    expect((await details(id, ibrahim, {})).statusCode).toBe(400);
    expect(
      (await details(id, ibrahim, { jpegs: [Buffer.from('not a jpeg!!!!!!').toString('base64')] }))
        .statusCode,
    ).toBe(400);
  });
});
