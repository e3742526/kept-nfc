// The contract between this provider and the encoder it calls (scripts/visual-retrieval/serve.py).
// provider.test.ts fakes the encoder in Node. Here the provider talks to serve.py's own HTTP
// server: contract_server.py runs it with a stand-in model, so this needs Python 3 but neither
// PyTorch nor the checkpoint. With KEPT_VISUAL_CONTRACT_URL set (the visual-encoder workflow,
// against the built image), the same checks run against the real model, plus a check that its
// text and image vectors share one space.
import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { request } from 'node:http';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openClipEncoder, VISUAL_DIMENSIONS, VISUAL_GENERATION } from './provider.js';

const STAND_IN = fileURLToPath(
  new URL('../../../../scripts/visual-retrieval/contract_server.py', import.meta.url),
);
const REAL = process.env.KEPT_VISUAL_CONTRACT_URL;

function python(): string | null {
  for (const candidate of ['python3', 'python']) {
    try {
      const out = execFileSync(candidate, ['-c', 'import sys; print(sys.version_info >= (3, 9))'], {
        encoding: 'utf8',
      });
      if (out.trim() === 'True') return candidate;
    } catch {}
  }
  return null;
}

const interpreter = REAL ? null : python();

/** Starts contract_server.py and resolves with its origin once it prints its port. */
function startStandIn(command: string): Promise<{ origin: string; child: ChildProcess }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [STAND_IN], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const timer = setTimeout(() => reject(new Error(`encoder did not start: ${err}`)), 15_000);
    child.stdout?.on('data', (chunk: Buffer) => {
      out += chunk.toString('utf8');
      const port = /ready on 127\.0\.0\.1:(\d+)/.exec(out)?.[1];
      if (port) {
        clearTimeout(timer);
        resolve({ origin: `http://127.0.0.1:${port}`, child });
      }
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      err += chunk.toString('utf8');
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`encoder exited with ${code}: ${err}`));
    });
  });
}

/** A raw request, to check what serve.py refuses before any input reaches the model. */
function raw(
  origin: string,
  path: string,
  init: { method?: string; headers?: Record<string, string>; body?: Buffer } = {},
): Promise<{ status: number; type: string | undefined; json: unknown }> {
  return new Promise((resolve, reject) => {
    const req = request(
      new URL(path, origin),
      { method: init.method ?? 'GET', headers: init.headers, agent: false },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({
            status: res.statusCode ?? 0,
            type: res.headers['content-type'],
            json: text ? JSON.parse(text) : null,
          });
        });
      },
    );
    req.on('error', reject);
    req.end(init.body);
  });
}

function jpeg(color: { r: number; g: number; b: number }): Promise<Buffer> {
  return sharp({ create: { width: 224, height: 224, channels: 3, background: color } })
    .jpeg({ quality: 85 })
    .toBuffer();
}

function cosine(a: number[], b: number[]): number {
  return a.reduce((sum, value, i) => sum + value * (b[i] ?? 0), 0);
}

function isUnitVector(vector: number[]): boolean {
  const norm = vector.reduce((sum, value) => sum + value * value, 0);
  return vector.length === VISUAL_DIMENSIONS && Math.abs(norm - 1) <= 0.01;
}

describe.skipIf(!REAL && !interpreter && !process.env.CI)('visual encoder contract', () => {
  let origin = REAL ?? '';
  let child: ChildProcess | null = null;

  beforeAll(async () => {
    if (REAL) return;
    if (!interpreter) throw new Error('the encoder contract test needs Python 3.9 or later');
    ({ origin, child } = await startStandIn(interpreter));
  });

  afterAll(() => {
    child?.kill();
  });

  it('serves the generation the provider expects', async () => {
    await expect(openClipEncoder(origin).isReady?.()).resolves.toBe(true);
    const status = await raw(origin, '/v1/status');
    expect(status).toEqual({
      status: 200,
      type: 'application/json',
      json: { generation: VISUAL_GENERATION, dimensions: VISUAL_DIMENSIONS },
    });
  });

  it('returns unit vectors the provider accepts for text and JPEG input', async () => {
    const encoder = openClipEncoder(origin);
    const mug = await encoder.encodeText('a blue thermos');
    const again = await encoder.encodeText('a blue thermos');
    const photo = await encoder.encodeImage(await jpeg({ r: 30, g: 60, b: 200 }));
    expect(isUnitVector(mug)).toBe(true);
    expect(isUnitVector(photo)).toBe(true);
    expect(again).toEqual(mug);
  });

  it('refuses requests without the generation, with a browser origin or another host', async () => {
    const body = Buffer.from('{"text":"a mug"}');
    const port = new URL(origin).port;
    const headers = {
      'Content-Type': 'application/json',
      'Content-Length': String(body.length),
      'X-Kept-Visual-Generation': VISUAL_GENERATION,
    };
    const send = (extra: Record<string, string>, drop?: string) => {
      const h: Record<string, string> = { ...headers, ...extra };
      if (drop) delete h[drop];
      return raw(origin, '/v1/encode/text', { method: 'POST', headers: h, body });
    };
    await expect(send({})).resolves.toMatchObject({ status: 200 });
    await expect(send({}, 'X-Kept-Visual-Generation')).resolves.toMatchObject({ status: 404 });
    await expect(send({ 'X-Kept-Visual-Generation': 'another' })).resolves.toMatchObject({
      status: 404,
    });
    await expect(send({ Origin: 'http://evil.example' })).resolves.toMatchObject({ status: 404 });
    await expect(send({ Host: `localhost:${port}` })).resolves.toMatchObject({ status: 404 });
    await expect(send({ 'Content-Type': 'text/plain' })).resolves.toMatchObject({ status: 415 });
  });

  it('answers malformed input as invalid_input, which the provider reports as unavailable', async () => {
    const notJpeg = Buffer.from('not a jpeg');
    const reply = await raw(origin, '/v1/encode/image', {
      method: 'POST',
      headers: {
        'Content-Type': 'image/jpeg',
        'Content-Length': String(notJpeg.length),
        'X-Kept-Visual-Generation': VISUAL_GENERATION,
      },
      body: notJpeg,
    });
    expect(reply).toEqual({
      status: 400,
      type: 'application/json',
      json: { error: 'invalid_input' },
    });
    await expect(openClipEncoder(origin).encodeImage(notJpeg)).rejects.toThrow('unavailable');
  });

  it.runIf(REAL)('puts text and images in one space (the real model only)', async () => {
    const encoder = openClipEncoder(origin);
    const red = await encoder.encodeImage(await jpeg({ r: 220, g: 20, b: 20 }));
    const blue = await encoder.encodeImage(await jpeg({ r: 20, g: 40, b: 220 }));
    const redText = await encoder.encodeText('a plain red square');
    const blueText = await encoder.encodeText('a plain blue square');
    expect(cosine(red, redText)).toBeGreaterThan(cosine(red, blueText));
    expect(cosine(blue, blueText)).toBeGreaterThan(cosine(blue, redText));
  });
});
