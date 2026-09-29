import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { KINDS } from '../src/types.js';
const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
it('documents every implemented event exactly once', () => {
  const readme = read('README.md');
  const events = [...readme.matchAll(/^\| `([^`]+)` \|/gm)].map(match => match[1]);
  expect(events).toEqual([...KINDS]);
  expect(readme).toContain('All eight events');
});
it('keeps the compatibility warning and README aligned with pinned DSH dependencies', () => {
  const pkg = JSON.parse(read('package.json'));
  const versions = new Set(Object.entries(pkg.devDependencies).filter(([name]) => name.startsWith('@deepseek-ai/dsh-')).map(([, version]) => version));
  expect(versions.size).toBe(1);
  const [version] = versions;
  expect(read('README.md')).toContain(`**${version} API**`);
  expect(read('src/index.ts')).toContain(`tested with ${version}`);
});
it('uses only asynchronous filesystem operations for state and pricing persistence', () => {
  for (const path of ['src/store.ts', 'src/persistence.ts', 'src/pricing.ts']) {
    const source = read(path);
    expect(source).not.toMatch(/from ['"]node:fs['"]/);
    expect(source).not.toMatch(/\b\w+Sync\s*\(/);
  }
});
it('pins every CI action to a full commit SHA and preserves delivery checks', () => {
  const ci = read('.github/workflows/ci.yml');
  const actions = [...ci.matchAll(/^\s*- uses:\s*(\S+)(.*)$/gm)];
  expect(actions.map(([, ref]) => ref.split('@')[0])).toEqual([
    'actions/checkout', 'pnpm/action-setup', 'actions/setup-node', 'actions/upload-artifact',
  ]);
  for (const [, ref, comment] of actions) {
    expect(ref).toMatch(/^[\w-]+\/[\w-]+@[a-f0-9]{40}$/);
    expect(comment).toMatch(/# v\d+\.\d+\.\d+/);
  }
  expect(ci).toContain('contents: read');
  expect(ci).toContain('node-version: ${{ matrix.node }}');
  expect(ci).toContain('cache: pnpm');
  expect(ci).toContain('pnpm run check');
  expect(ci).toContain('pnpm exec playwright install --with-deps chromium');
  expect(ci).toContain('pnpm run test:browser');
  expect(ci).toContain('if: failure()');
  expect(ci).toContain('path: test-results/');
});
it('declares the documented Node floor and tests it with the tracked package manager', () => {
  const pkg = JSON.parse(read('package.json'));
  expect(pkg.engines.node).toBe('^22.19.0 || >=24.0.0');
  expect(read('README.md')).toContain('**22.19+ or 24+**');
  expect(pkg.packageManager).toBe('pnpm@11.26.0');
  const ci = read('.github/workflows/ci.yml');
  expect(ci).toContain("node: ['22', '24', '26']");
  expect(ci).toContain('pnpm install --frozen-lockfile');
  expect(ci).toContain('git diff --exit-code -- dist');
});
