import { newId } from '@kept/shared';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { TestApp } from '../../test/app.js';
import { type TestDb, testDb } from '../../test/db.js';
import { call, join, type Person, peopleApp, person } from '../../test/people.js';
import { createLocation, type Loc, ok, own } from '../../test/things.js';
import { providerKeyAad } from '../ai/db-keys.js';
import { aiRuntime } from '../ai/runtime.js';
import { nativeSyncEpoch } from '../auth/native.js';
import { seal } from '../crypto/envelope.js';

const path = '/api/v1/native/item-lookup';
const source = 'https://publisher.example.com/games/cedar-island';
const age = { field: 'min_age', label: 'Minimum age', value: '10', source };
const answer = {
  name: 'Cedar Island',
  facts: [
    age,
    { field: null, label: 'Rating', value: '8/10', source: 'https://uncited.example.com/' },
  ],
};
const master = { key: Buffer.alloc(32, 7), keyVersion: 1 };
const logger = { warn: vi.fn(), info: () => {} };
let db: TestDb;
let t: TestApp;
let owner: Person;
let viewer: Person;
let home: Loc;
let epoch: string;
let typeId: string;

const providerFetch = vi.fn<typeof fetch>(async () =>
  Response.json({
    id: 'resp_test',
    model: 'gpt-5.4-mini',
    output: [
      {
        id: 'ws_test',
        type: 'web_search_call',
        status: 'completed',
        action: { type: 'search', query: 'Cedar Island 036000291452' },
      },
      {
        id: 'msg_test',
        type: 'message',
        role: 'assistant',
        content: [
          {
            type: 'output_text',
            text: JSON.stringify(answer),
            annotations: [
              {
                type: 'url_citation',
                url: source,
                title: 'Publisher',
                start_index: 10,
                end_index: 16,
              },
            ],
          },
        ],
      },
    ],
    usage: { input_tokens: 800, output_tokens: 140, total_tokens: 940 },
  }),
);

beforeAll(async () => {
  db = await testDb();
  await db.reset();
  t = await peopleApp(db, {
    ai: {
      mock: false,
      runtime: (scope) =>
        aiRuntime(
          {
            pools: db.pools,
            keyring: () => new Map([[1, master.key]]),
            mock: null,
            log: logger,
            overrides: { fetch: providerFetch },
          },
          scope,
        ),
    },
  });
  owner = await person(t, db, 'lookup-owner');
  viewer = await person(t, db, 'lookup-viewer');
  home = await createLocation(t, db, owner, 'household');
  await join(db, home.id, viewer.userId, 'viewer');
  epoch = await nativeSyncEpoch(t.app.pools.auth);

  const providerId = newId();
  await own(
    db,
    `
    INSERT INTO public.ai_providers
      (id, scope, owner_account_id, kind, key_ciphertext, key_version, models, created_by)
    VALUES ($1, 'account', $2, 'openai', $3, 1, '{"vision":"gpt-5.4-mini"}', $4)
  `,
    [
      providerId,
      home.accountId,
      JSON.stringify(seal(master, 'sk-fixture-item-lookup', providerKeyAad(providerId))),
      owner.userId,
    ],
  );
  const type = await call(t, `/api/v1/accounts/${home.accountId}/types`, {
    as: owner,
    body: { name: 'Board game', parentId: null, icon: 'lucide:dices', capabilities: [] },
  });
  typeId = (ok(type, 201) as { id: string }).id;
  for (const field of [
    { key: 'min_age', label: 'Minimum age', kind: 'number', unit: 'years' },
    { key: 'private_code', label: 'Private code', kind: 'text', secret: true },
  ])
    ok(await call(t, `/api/v1/types/${typeId}/fields`, { as: owner, body: field }), 201);
});

afterAll(async () => {
  await t?.app.close();
});

function lookup(as: Person, body: unknown) {
  return call(t, path, {
    as,
    body,
    headers: { 'x-kept-native-account': as.userId, 'x-kept-native-epoch': epoch },
  });
}

describe('native online item lookup', () => {
  it('keeps only provider-cited facts and sends the UPC and public field definitions', async () => {
    const response = await lookup(owner, {
      locationId: home.id,
      name: 'Cedar Island',
      barcode: '036000291452',
      typeId,
    });
    expect(response.statusCode, `${response.body} ${JSON.stringify(logger.warn.mock.calls)}`).toBe(
      200,
    );
    expect(response.json()).toEqual({ name: 'Cedar Island', facts: [age] });
    expect(providerFetch).toHaveBeenCalledTimes(1);
    const [url, options] = providerFetch.mock.calls[0] ?? [];
    expect(String(url)).toBe('https://api.openai.com/v1/responses');
    const body = JSON.parse(String(options?.body));
    expect(body).toMatchObject({
      store: false,
      max_tool_calls: 1,
      tools: expect.arrayContaining([expect.objectContaining({ type: 'web_search' })]),
    });
    expect(JSON.stringify(body.input)).toContain('036000291452');
    expect(JSON.stringify(body.input)).toContain('min_age');
    expect(JSON.stringify(body.input)).not.toContain('private_code');
  });

  it('rejects viewers, browser-only requests, and an invalid UPC before using the provider', async () => {
    providerFetch.mockClear();
    const body = { locationId: home.id, name: 'Cedar Island' };
    expect((await lookup(viewer, body)).statusCode).toBe(403);
    expect((await call(t, path, { as: owner, body })).statusCode).toBe(400);
    expect((await lookup(owner, { ...body, barcode: '036000291453' })).statusCode).toBe(400);
    expect(providerFetch).not.toHaveBeenCalled();
  });

  it('uses the OpenRouter search tool and reads its annotations', async () => {
    await own(
      db,
      `UPDATE public.ai_providers SET kind = 'openrouter', models = '{"vision":"openai/gpt-5.4-mini"}'
       WHERE owner_account_id = $1`,
      [home.accountId],
    );
    providerFetch.mockClear();
    logger.warn.mockClear();
    providerFetch.mockResolvedValueOnce(
      Response.json({
        id: 'gen_test',
        model: 'openai/gpt-5.4-mini',
        choices: [
          {
            index: 0,
            finish_reason: 'stop',
            message: {
              role: 'assistant',
              content: JSON.stringify(answer),
              annotations: [
                { type: 'url_citation', url_citation: { url: source, title: 'Publisher' } },
              ],
            },
          },
        ],
        usage: { prompt_tokens: 800, completion_tokens: 140, total_tokens: 940, cost: 0.01 },
      }),
    );
    const response = await lookup(owner, { locationId: home.id, barcode: '036000291452', typeId });
    expect(response.statusCode, `${response.body} ${JSON.stringify(logger.warn.mock.calls)}`).toBe(
      200,
    );
    expect(response.json()).toEqual({ name: 'Cedar Island', facts: [age] });
    expect(providerFetch).toHaveBeenCalledTimes(1);
    const [url, options] = providerFetch.mock.calls[0] ?? [];
    expect(String(url)).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(JSON.parse(String(options?.body))).toMatchObject({
      tools: expect.arrayContaining([expect.objectContaining({ type: 'openrouter:web_search' })]),
    });
  });
});
