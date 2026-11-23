#!/usr/bin/env node
// Derive documentation assets from the supplied SheepKeep Identity v2 outlines.
// The ready-to-ship PWA and iOS bitmaps are copied directly from the asset package.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const root = new URL('../', import.meta.url);
const read = (path) => readFileSync(new URL(path, root), 'utf8');
const write = (path, data) => writeFileSync(new URL(path, root), data);
const asset = (name) => read(`apps/web/src/assets/sheepkeep-${name}.svg`);
const mark = asset('mark-evergreen');
const light = asset('horizontal-evergreen');
const dark = asset('horizontal-ivory');

export function markSvg({ size = 128 } = {}) {
  return mark.replace('<svg ', `<svg style="width:${size}px;height:${size}px" `);
}

export function lockupSvg({ height = 64 } = {}) {
  return light.replace('<svg ', `<svg style="width:auto;height:${height}px" `);
}

async function main() {
  write('apps/docs/public/favicon.svg', read('apps/web/public/favicon.svg'));
  write('apps/docs/src/assets/logo.svg', mark);
  write('docs/assets/sheepkeep-lockup-light.svg', light);
  write('docs/assets/sheepkeep-lockup-dark.svg', dark);

  // The launch storyboard aspect-fills the square, so keep the lockup in its central area.
  const logo = await sharp(Buffer.from(light)).resize({ width: 928 }).png().toBuffer();
  const splash = await sharp({
    create: { width: 2732, height: 2732, channels: 3, background: '#FFF9EB' },
  })
    .composite([{ input: logo, gravity: 'center' }])
    .png()
    .toBuffer();
  for (const suffix of ['', '-1', '-2']) {
    write(
      `apps/ios/ios/App/App/Assets.xcassets/Splash.imageset/splash-2732x2732${suffix}.png`,
      splash,
    );
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
