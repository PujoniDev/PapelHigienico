import { createRequire } from 'node:module';

export type Koffi = typeof import('koffi');

let cached: Koffi | null | undefined;
let loadError: string | null = null;

/**
 * Loads koffi lazily so a missing or broken native binary degrades features
 * (slower scanner, no Recycle Bin size) instead of preventing the app from starting.
 */
export function loadKoffi(): Koffi | null {
  if (cached !== undefined) return cached;
  if (process.platform !== 'win32') {
    cached = null;
    loadError = 'Plataforma não suportada';
    return cached;
  }
  try {
    cached = createRequire(import.meta.url)('koffi') as Koffi;
  } catch (error) {
    loadError = error instanceof Error ? error.message : String(error);
    cached = null;
  }
  return cached;
}

export function koffiLoadError(): string | null {
  loadKoffi();
  return loadError;
}
