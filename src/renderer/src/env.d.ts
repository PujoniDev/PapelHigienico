import type { LimpaCApi } from '@shared/api';

declare global {
  interface Window {
    limpac: LimpaCApi;
  }
}

export {};
