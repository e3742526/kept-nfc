import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RELEASE } from './components/install/commands';

const root = join(import.meta.dirname, '../../..');
const docs = join(import.meta.dirname, 'content/docs');

function pages(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return pages(path);
    return /\.mdx?$/.test(name) ? [path] : [];
  });
}

// Raw download URLs only: an image tag in prose can be history (upgrades: the image moved in 1.8.0).
const PIN = /keptinventory\/kept\/v(\d+\.\d+\.\d+)\//g;

/** `file: version` for each pin in `files` that isn't the release, and how many pins there are. */
function stalePins(files: string[]) {
  const stale: string[] = [];
  let pins = 0;
  for (const file of files) {
    for (const m of readFileSync(file, 'utf8').matchAll(PIN)) {
      pins++;
      const version = m[1];
      if (version !== RELEASE) stale.push(`${relative(root, file)}: ${version}`);
    }
  }
  return { stale, pins };
}

describe('release pins in the docs', () => {
  it('use a consistent version for upstream Kept downloads in every language', () => {
    const { stale, pins } = stalePins(pages(docs));
    expect(pins).toBeGreaterThan(0);
    expect(stale).toEqual([]);
  });

  it('starts SheepKeep from a locally built image in the README', () => {
    const readme = readFileSync(join(root, 'README.md'), 'utf8');
    expect(readme).toContain('-t sheepkeep:local');
    expect(readme).toContain('KEPT_IMAGE=sheepkeep:local docker compose up -d');
    expect(stalePins([join(root, 'README.md')]).pins).toBe(0);
  });
});
