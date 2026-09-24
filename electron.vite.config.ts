import { resolve } from 'node:path';
import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';
import type { Plugin } from 'vite';

const alias = { '@shared': resolve(__dirname, 'src/shared') };

// Production pages get a strict CSP. The dev server needs inline scripts for React
// refresh and a websocket for HMR, so the policy is relaxed only while serving.
function contentSecurityPolicy(): Plugin {
  const strict =
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'";
  const dev =
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ws: http://localhost:*; object-src 'none'";
  let serving = false;
  return {
    name: 'limpac-csp',
    configResolved(config) {
      serving = config.command === 'serve';
    },
    transformIndexHtml(html) {
      return html.replace('%CSP%', serving ? dev : strict);
    },
  };
}

export default defineConfig({
  main: {
    resolve: { alias },
    build: {
      externalizeDeps: true,
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/main/index.ts') },
      },
    },
  },
  preload: {
    resolve: { alias },
    build: {
      externalizeDeps: true,
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/preload/index.ts') },
      },
    },
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    resolve: { alias },
    plugins: [react(), contentSecurityPolicy()],
    build: {
      minify: true,
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/renderer/index.html') },
      },
    },
  },
});
