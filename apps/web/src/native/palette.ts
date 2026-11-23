import { useSyncExternalStore } from 'react';

export type PaletteId = 'default' | 'slate' | 'meadow' | 'contrast';

export const PALETTE_KEY = 'kept.palette';
export const PALETTES: readonly PaletteId[] = ['default', 'slate', 'meadow', 'contrast'];

function isPalette(value: unknown): value is PaletteId {
  return typeof value === 'string' && (PALETTES as readonly string[]).includes(value);
}

function readPalette(): PaletteId {
  try {
    const raw = localStorage.getItem(PALETTE_KEY);
    return isPalette(raw) ? raw : 'default';
  } catch {
    return 'default';
  }
}

function writePalette(palette: PaletteId): void {
  try {
    if (palette === 'default') localStorage.removeItem(PALETTE_KEY);
    else localStorage.setItem(PALETTE_KEY, palette);
  } catch {
    // Ignore storage errors in restricted environments.
  }
}

let currentPalette: PaletteId = readPalette();
const listeners = new Set<() => void>();

export function applyPalette(palette: PaletteId = currentPalette): void {
  if (typeof document === 'undefined') return;
  if (palette === 'default') document.documentElement.removeAttribute('data-palette');
  else document.documentElement.setAttribute('data-palette', palette);
}

export function setPalette(palette: PaletteId): void {
  currentPalette = palette;
  writePalette(palette);
  applyPalette(palette);
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function usePalette(): PaletteId {
  return useSyncExternalStore(subscribe, () => currentPalette);
}
