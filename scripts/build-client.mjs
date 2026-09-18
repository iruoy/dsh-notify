import { build } from 'esbuild';
await build({
  entryPoints: ['src/client/index.tsx'], outfile: 'dist/client.js', bundle: true,
  format: 'cjs', platform: 'browser', target: 'es2023', jsx: 'automatic',
  external: ['react', 'react/jsx-runtime', '@deepseek-ai/*'],
  banner: { js: 'window.__ModuleLoader__.load({ id: "dsh-notify", factory: (require) => { var module = { exports: {} }; var exports = module.exports;' },
  footer: { js: 'return module.exports; } });' },
});
