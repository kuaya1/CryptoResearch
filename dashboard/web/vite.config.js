// The desk's browser app: React components bundled by Vite.
//   npm run dev    a fictional, offline desk (scripts/dev-desk.cjs) behind
//                  Vite's dev server, with immediate refresh
//   npm run build  the production bundle into ../public/app, which the Node
//                  server serves at / (committed, so the server needs no npm
//                  packages on the PC or on Render)
// The views the app still hosts from ../public are bundled as they are; their
// stylesheets are scoped under .lg at build time (scope-legacy.js), so a rule
// written for them can never reach a React component.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { scopeLegacy } from './scope-legacy.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.resolve(here, '..', 'public');
const DESK = process.env.CR_DEV_DESK || 'http://127.0.0.1:4790';

// The hosted views' stylesheets. tokens.css is not one of them: it is the one
// token layer and applies everywhere.
const LEGACY_CSS = new Set(['styles.css', 'position.css', 'chart.css', 'dex.css', 'brief.css', 'brief-views.css', 'explorer.css']
  .map((f) => path.join(PUBLIC, f).toLowerCase()));
const isLegacy = (file) => LEGACY_CSS.has(path.resolve(String(file).split('?')[0]).toLowerCase());

export default defineConfig(({ command }) => ({
  root: here,
  base: command === 'build' ? '/app/' : '/',
  publicDir: false,
  plugins: [react()],
  css: { postcss: { plugins: [scopeLegacy(isLegacy)] } },
  build: {
    outDir: path.join(PUBLIC, 'app'),
    emptyOutDir: true,
    sourcemap: false,
    target: 'es2022',
    assetsDir: 'assets',
    modulePreload: { polyfill: false },
    reportCompressedSize: true,
    chunkSizeWarningLimit: 700,
    // React and the Radix primitives change rarely: their own chunks stay
    // cached across deploys of the app.
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            { name: 'react', test: /node_modules[\\/](react|react-dom|scheduler)[\\/]/, priority: 20 },
            { name: 'radix', test: /node_modules[\\/](@radix-ui|@floating-ui|aria-hidden|react-remove-scroll|react-style-singleton|use-callback-ref|use-sidecar|get-nonce|detect-node-es|tslib)[\\/]/, priority: 10 },
          ],
        },
      },
    },
  },
  server: {
    host: '127.0.0.1',
    port: Number(process.env.CR_DEV_PORT || process.env.PORT || 5173),
    strictPort: false,
    fs: { allow: [here, PUBLIC] },
    // The fictional desk answers the API; the page's writes carry the desk's
    // own origin, as the desk requires of every write.
    proxy: Object.fromEntries(['/api', '/theme.js', '/favicon.svg'].map((p) => [p, {
      target: DESK,
      changeOrigin: true,
      configure: (proxy) => {
        proxy.on('proxyReq', (req) => {
          if (req.getHeader('origin')) req.setHeader('origin', DESK);
        });
      },
    }])),
  },
}));
