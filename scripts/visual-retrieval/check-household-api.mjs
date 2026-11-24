#!/usr/bin/env node
// Exercise actual HTTP, the durable worker, and a Chromium search at phone width.
// Only run against the dedicated, disposable visual-qualification E2E instance.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { newId } from '../../packages/shared/dist/index.js';

const { chromium, expect } = createRequire(new URL('../../apps/web/package.json', import.meta.url))(
  '@playwright/test',
);
const { Client } = createRequire(new URL('../../apps/server/package.json', import.meta.url))('pg');
const { values: args } = parseArgs({
  options: {
    'fixture-dir': { type: 'string' },
    'encoder-report': { type: 'string' },
    output: { type: 'string' },
    port: { type: 'string', default: '8237' },
    scale: { type: 'boolean' },
  },
});
assert(args['fixture-dir'] && args['encoder-report'] && args.output);
assert.match(args.port, /^\d{4,5}$/);
const origin = `http://localhost:${args.port}`;
const state = new URL('../../.tmp/e2e/visual-qualification/server.log', import.meta.url);
const log = await readFile(state, 'utf8');
const database = /database (kept_e2e_visual_qualification_\d+) migrated/.exec(log)?.[1];
assert(
  database &&
    (log.includes(`listening on http://[::1]:${args.port}`) ||
      log.includes(`listening on http://127.0.0.1:${args.port}`)),
  'Start the disposable E2E instance',
);
process.kill(Number(database.split('_').at(-1)), 0);
const fixture = JSON.parse(await readFile(args['encoder-report'], 'utf8'));
const stats = (duration) => {
  const sorted = duration.toSorted((a, b) => a - b);
  const at = (p) => Number(sorted[Math.ceil(p * sorted.length) - 1].toFixed(2));
  return { p50Ms: at(0.5), p95Ms: at(0.95), maxMs: at(1) };
};

const browser = await chromium.launch({ channel: 'chromium' });
const context = await browser.newContext({
  baseURL: origin,
  viewport: { width: 375, height: 800 },
});
const page = await context.newPage();
const db = new Client({
  connectionString: `postgres://kept_owner:kept_owner@localhost:5452/${database}`,
});
await db.connect();

async function api(method, path, data, headers = {}) {
  const reply = await context.request.fetch(path, {
    method,
    data,
    headers: { origin, 'idempotency-key': randomUUID(), ...headers },
  });
  assert(reply.ok(), `${method} ${new URL(path, origin).pathname}: HTTP ${reply.status()}`);
  return reply.status() === 204 ? undefined : reply.json();
}

async function signIn() {
  await page.goto('/signin');
  await page.getByLabel('Email or username', { exact: true }).fill('ibrahim@kept.test');
  await page.getByLabel('Password', { exact: true }).fill('kept-seed-password');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(`${origin}/`);
}

async function seedGallery() {
  const location = await api('POST', '/api/v1/locations', {
    name: 'Household',
    kind: 'home',
    preset: 'essentials',
    timezone: 'UTC',
    currency: 'USD',
    rooms: [],
  });
  const {
    rows: [types],
  } = await db.query(
    `SELECT (SELECT id FROM public.places WHERE location_id = $1 AND is_unplaced) AS place_id,
       (SELECT id FROM public.types WHERE owner_account_id IS NULL AND builtin_key = 'box_bin') AS type_id`,
    [location.id],
  );
  const records = new Map();
  const uploads = [];
  const started = performance.now();
  let firstAttach;
  let firstReadyMs;
  for (const [index, stored] of Object.entries(fixture.index.gallery)) {
    const box = await api('POST', '/api/v1/things', {
      locationId: location.id,
      placeId: types.place_id,
      typeId: types.type_id,
      name: stored.path,
    });
    const item = await api('POST', '/api/v1/things', {
      locationId: location.id,
      containerId: box.id,
      name: stored.record,
    });
    const fileId = newId();
    const bytes = await readFile(`${args['fixture-dir']}/stored-${index}.jpg`);
    const uploadStarted = performance.now();
    await api('PUT', `/api/v1/files/${fileId}?locationId=${location.id}&class=evidence`, bytes, {
      'content-type': 'image/jpeg',
      'x-kept-sha256': createHash('sha256').update(bytes).digest('hex'),
    });
    uploads.push(performance.now() - uploadStarted);
    firstAttach ??= performance.now();
    await api('POST', '/api/v1/attachments', {
      locationId: location.id,
      subject: { thingId: item.id },
      fileId,
      role: 'photo',
    });
    if (records.size === 0) {
      await expect
        .poll(
          async () =>
            (await api('GET', `/api/v1/visual-search/status?locationIds=${location.id}`)).ready,
          { timeout: 25_000, intervals: [100, 200, 400] },
        )
        .toBe(1);
      firstReadyMs = Math.round(performance.now() - firstAttach);
    }
    records.set(item.id, index);
  }
  const uploadedAt = performance.now();
  const coverageUrl = `/api/v1/visual-search/status?locationIds=${location.id}`;
  const stop = performance.now() + 240_000;
  let status;
  do {
    status = await api('GET', coverageUrl);
    if (status.ready + status.failed === records.size) break;
    await delay(200);
  } while (performance.now() < stop);
  assert.equal(status.ready, records.size, 'Every corpus image should be indexed');
  return {
    locationId: location.id,
    records,
    status,
    inventoryBuildMs: Math.round(uploadedAt - started),
    firstReadyMs,
    wholeGalleryReadyMs: Math.round(performance.now() - firstAttach),
    lastAttachmentToReadyMs: Math.round(performance.now() - uploadedAt),
    originalUpload: stats(uploads),
  };
}

async function measureQueries(gallery) {
  const out = { text_full: [], photo_full: [] };
  for (const kind of Object.keys(out)) {
    for (const [index, row] of fixture.queries[kind].entries()) {
      const start = performance.now();
      let inputId;
      let inputMs;
      try {
        const request = { locationIds: [gallery.locationId], limit: 5 };
        if (kind === 'photo_full') {
          const input = await readFile(`${args['fixture-dir']}/input-${index}.jpg`);
          const beginUpload = performance.now();
          ({ inputId } = await api(
            'POST',
            `/api/v1/visual-search/input?locationIds=${gallery.locationId}`,
            input,
            { 'content-type': 'image/jpeg' },
          ));
          request.inputId = inputId;
          inputMs = performance.now() - beginUpload;
        } else {
          request.text = row.query;
        }
        const result = await api('POST', '/api/v1/visual-search', request);
        const matches = result.matches.map((match) => gallery.records.get(match.thingId));
        assert(
          matches.every((id) => id !== undefined),
          'Result outside scoped fixture gallery',
        );
        out[kind].push({
          query: row.query,
          expected: Object.keys(row.expected),
          matches,
          outcome: result.outcome,
          uncertain: result.uncertain === true,
          totalMs: Number((performance.now() - start).toFixed(2)),
          ...(inputMs !== undefined ? { inputMs: Number(inputMs.toFixed(2)) } : {}),
        });
      } finally {
        if (inputId) await api('DELETE', `/api/v1/visual-search/input/${inputId}`);
      }
    }
  }
  return out;
}

async function browserSmoke(gallery) {
  const query = 'a yellow lemon';
  await page.goto(`/search?q=${encodeURIComponent(query)}&f.location=${gallery.locationId}`);
  await expect(page.getByText(/No match for/)).toBeVisible();
  await page.getByRole('button', { name: 'Find in photos' }).click();
  const results = page.getByRole('list', { name: 'Possible photo matches' });
  await expect(results.getByRole('link', { name: 'Recorded contents' }).first()).toBeVisible();
  await results.getByRole('button', { name: 'View stored photo' }).first().click();
  const image = page.getByRole('img', { name: 'Recorded contents' });
  await expect(image).toBeVisible();
  await expect.poll(() => image.evaluate((element) => element.naturalWidth)).toBeGreaterThan(0);
  await page.keyboard.press('Escape');
  await expect(image).toHaveCount(0);
  const queryIndex = fixture.queries.photo_full.findIndex((row) => row.query === 'P1030118');
  assert(queryIndex >= 0);
  const searched = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/api/v1/visual-search' &&
      response.request().method() === 'POST',
  );
  const cleaned = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname.startsWith('/api/v1/visual-search/input/') &&
      response.request().method() === 'DELETE',
  );
  await page
    .locator('input[type=file][accept]')
    .setInputFiles(`${args['fixture-dir']}/input-${queryIndex}.jpg`);
  const searchResponse = await searched;
  assert.equal(searchResponse.status(), 200);
  const { matches } = await searchResponse.json();
  const expected = fixture.queries.photo_full[queryIndex].expected;
  assert(matches.some((match) => gallery.records.get(match.thingId) in expected));
  await expect(results.getByRole('link', { name: 'Recorded contents' }).first()).toBeVisible();
  assert.equal((await cleaned).status(), 204);
  return { viewport: 375, query, evidenceOpened: true, temporaryInputReleased: true };
}

async function relationSize() {
  const { rows } = await db.query(
    "SELECT pg_total_relation_size('public.visual_embeddings')::integer AS bytes",
  );
  return rows[0].bytes;
}

async function measureScale(locationId, initial) {
  const results = [];
  let indexed = initial;
  for (const size of [300, 3000, 10000]) {
    // Copy real vectors into distinct fixture attachments, using the existing files. These
    // counts are for database/ranking timings only. Real photos determine quality separately.
    const inserted = await db.query(
      `WITH seeds AS MATERIALIZED (
         SELECT a.file_id, a.created_by, e.content_hash, e.generation, e.embedding,
                t.container_id, row_number() OVER (ORDER BY a.id) - 1 AS n
           FROM public.visual_embeddings e
           JOIN public.attachments a ON a.id = e.attachment_id
           JOIN public.things t ON t.id = a.thing_id
          WHERE e.location_id = $1 AND e.state = 'ready' AND t.name = 'Recorded contents'
       ), copies AS MATERIALIZED (
         SELECT seeds.*, uuidv7() AS thing_id, uuidv7() AS attachment_id
           FROM generate_series(0, $2::integer - 1) AS batch(n)
           JOIN seeds ON seeds.n = batch.n % (SELECT count(*) FROM seeds)
       ), things AS (
         INSERT INTO public.things (id, location_id, container_id, name)
         SELECT thing_id, $1, container_id, 'Additional fixture' FROM copies RETURNING id
       ), attachments AS (
         INSERT INTO public.attachments (id, location_id, file_id, thing_id, role, created_by)
         SELECT c.attachment_id, $1, c.file_id, t.id, 'photo', c.created_by
           FROM copies c JOIN things t ON t.id = c.thing_id RETURNING id
       )
       INSERT INTO public.visual_embeddings
                   (attachment_id, location_id, file_id, content_hash, generation, state, embedding)
       SELECT a.id, $1, c.file_id, c.content_hash, c.generation, 'ready', c.embedding
         FROM copies c JOIN attachments a ON a.id = c.attachment_id`,
      [locationId, size - indexed],
    );
    assert.equal(inserted.rowCount, size - indexed);
    indexed = size;
    const elapsed = [];
    const queries = fixture.queries.text_full.slice(0, 20);
    for (const [index, row] of queries.entries()) {
      const start = performance.now();
      const result = await api('POST', '/api/v1/visual-search', {
        locationIds: [locationId],
        text: row.query,
        limit: 20,
      });
      assert.equal(result.coverage.ready, size);
      if (index > 0) elapsed.push(performance.now() - start);
    }
    results.push({
      indexed: size,
      samples: elapsed.length,
      tableRelationBytes: await relationSize(),
      warmTextApi: stats(elapsed),
    });
  }
  return results;
}

async function measureBrowserHeap(locationId) {
  const path = `/search?q=a+yellow+lemon&f.location=${locationId}`;
  const memoryContext = await browser.newContext({
    baseURL: origin,
    viewport: { width: 375, height: 800 },
    serviceWorkers: 'block',
    storageState: await context.storageState(),
  });
  try {
    const memoryPage = await memoryContext.newPage();
    await memoryPage.route('**/api/v1/visual-search', (route) =>
      route.request().method() === 'POST'
        ? route.continue({
            postData: JSON.stringify({ ...route.request().postDataJSON(), limit: 20 }),
          })
        : route.continue(),
    );
    const devtools = await memoryContext.newCDPSession(memoryPage);
    await devtools.send('Performance.enable');
    const heap = async () => {
      const { metrics } = await devtools.send('Performance.getMetrics');
      return metrics.find(({ name }) => name === 'JSHeapUsedSize').value;
    };
    const samples = [];
    for (let trial = 0; trial < 3; trial += 1) {
      await memoryPage.goto(path);
      await expect(memoryPage.getByText(/No match for/)).toBeVisible();
      await devtools.send('HeapProfiler.collectGarbage');
      const before = await heap();
      const pending = memoryPage.waitForResponse(
        (response) =>
          response.request().method() === 'POST' &&
          new URL(response.url()).pathname === '/api/v1/visual-search',
      );
      await memoryPage.getByRole('button', { name: 'Find in photos' }).click();
      const { coverage, matches } = await (await pending).json();
      assert.equal(matches.length, 20);
      await expect(
        memoryPage.getByRole('list', { name: 'Possible photo matches' }).getByRole('link'),
      ).toHaveCount(matches.length);
      await devtools.send('HeapProfiler.collectGarbage');
      samples.push({
        ready: coverage.ready,
        rendered: matches.length,
        jsHeapBeforeBytes: before,
        jsHeapAfterBytes: await heap(),
      });
    }
    return samples;
  } finally {
    await memoryContext.close();
  }
}

try {
  await signIn();
  const { records, ...gallery } = await seedGallery();
  const browserResult = await browserSmoke({ ...gallery, records });
  const queries = await measureQueries({ ...gallery, records });
  const summary = Object.fromEntries(
    Object.entries(queries).map(([kind, rows]) => {
      const positives = rows.filter((row) => row.expected.length > 0);
      const absent = rows.filter((row) => row.expected.length === 0);
      const noMatch = rows.filter((row) => row.outcome === 'no_close_match');
      return [
        kind,
        {
          positive: positives.length,
          top1: positives.filter((row) => row.expected.includes(row.matches[0])).length,
          top5: positives.filter((row) => row.matches.some((id) => row.expected.includes(id)))
            .length,
          absent: absent.length,
          absentWithCandidate: absent.filter((row) => row.matches.length > 0).length,
          absentWithMatchesOutcome: absent.filter((row) => row.outcome === 'matches').length,
          absentWithNonWeakMatch: absent.filter(
            (row) => row.outcome === 'matches' && !row.uncertain,
          ).length,
          noMatchCorrect: noMatch.filter((row) => row.expected.length === 0).length,
          noMatchTotal: noMatch.length,
          apiLatency: stats(rows.map((row) => row.totalMs)),
        },
      ];
    }),
  );
  summary.photo_full.uploadAndEncode = stats(queries.photo_full.map((row) => row.inputMs));
  const tableRelationBytes = await relationSize();
  const scale = args.scale ? await measureScale(gallery.locationId, records.size) : [];
  const browserHeap = args.scale ? await measureBrowserHeap(gallery.locationId) : [];
  const report = {
    ...gallery,
    tableRelationBytes,
    scale,
    browser: browserResult,
    browserHeap,
    summary,
    queries,
  };
  await writeFile(args.output, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ ...report, queries: undefined }, null, 2));
} finally {
  await context.close();
  await browser.close();
  await db.end();
}
