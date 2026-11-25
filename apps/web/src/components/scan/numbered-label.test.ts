/**
 * A numbered label (`BIN-A09Z-0001`): the phone holds no series, so the server answers it as the
 * short ID it stands for, and a blank's claim carries that short ID; offline it is "Not on this
 * phone", to check again online, never "Not a Kept label".
 */
import { describe, expect, it } from 'vitest';
import type { ScanOutcome } from '@/api/capture/types';
import { MemoryStore } from '@/offline/store';
import { resolveScan } from './resolve';

const LOC = '01926f00-0000-7000-8000-00000000b002';
const BOX = '01926f00-0000-7000-8000-0000000d0008';
const URL_ = 'https://labels.example.org/l/BIN-A09Z-0001';

describe('a numbered label', () => {
  it('asks the server, and claims the short ID it stands for', async () => {
    const asked: string[] = [];
    const server = async (body: { text: string }): Promise<ScanOutcome> => {
      asked.push(body.text);
      return { outcome: 'claim', locationId: LOC, code: '7KQ4MZ' };
    };
    const r = await resolveScan({ text: URL_ }, { store: new MemoryStore(), online: true, server });
    expect(asked).toEqual([URL_]);
    expect(r).toEqual({ outcome: 'claim', code: '7KQ4MZ', locationId: LOC, from: 'server' });
  });

  it('opens what it was claimed for', async () => {
    const server = async (): Promise<ScanOutcome> => ({
      outcome: 'open',
      target: { kind: 'thing', id: BOX, locationId: LOC },
    });
    const r = await resolveScan({ text: 'bin-a09z-0001' }, { store: null, online: true, server });
    expect(r).toMatchObject({ outcome: 'open', target: { id: BOX }, from: 'server' });
  });

  it('offline, is not on this phone yet', async () => {
    const r = await resolveScan({ text: URL_ }, { store: new MemoryStore(), online: false });
    expect(r).toEqual({ outcome: 'not_on_phone', text: URL_, code: null });
  });
});
