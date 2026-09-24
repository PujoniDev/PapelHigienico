import type { LimpaCApi } from '@shared/api';

export const api: LimpaCApi = window.limpac;

/** Strips Electron's "Error invoking remote method ..." prefix from IPC errors. */
export function errorMessage(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.replace(/^Error invoking remote method '[^']+':\s*/, '').replace(/^(Error|ZodError):\s*/, '');
}
