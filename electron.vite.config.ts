import { defineConfig } from 'electron-vite';

export default defineConfig({
  main: {},
  preload: {
    build: {
      rollupOptions: {
        input: {
          doc: 'src/preload/doc.ts',
          shell: 'src/preload/shell.ts',
        },
        output: {
          // Sandboxed preload scripts must be CommonJS (ESM preloads require sandbox: false).
          format: 'cjs',
          entryFileNames: '[name].cjs',
        },
      },
    },
  },
  renderer: {},
});
