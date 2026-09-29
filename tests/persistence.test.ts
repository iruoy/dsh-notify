import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { writeJson } from '../src/persistence.js';
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'notify-persistence-'));
  directories.push(directory);
  return { directory, path: join(directory, 'state.json') };
}
it('atomically replaces complete JSON snapshots with owner-only permissions', async () => {
  const f = await setup();
  await writeJson(f.path, { revision: 1, secret: 'first' });
  await writeJson(f.path, { revision: 2, secret: 'second' });
  expect(JSON.parse(await readFile(f.path, 'utf8'))).toEqual({ revision: 2, secret: 'second' });
  expect((await stat(f.path)).mode & 0o777).toBe(0o600);
  expect(await readdir(f.directory)).toEqual(['state.json']);
});
it('removes failed temporary writes without touching the committed snapshot', async () => {
  const f = await setup(); await writeJson(f.path, { revision: 1 });
  const circular: any = {}; circular.self = circular;
  await expect(writeJson(f.path, circular)).rejects.toThrow();
  expect(JSON.parse(await readFile(f.path, 'utf8'))).toEqual({ revision: 1 });
  expect(await readdir(f.directory)).toEqual(['state.json']);
});
it('cleans up a temporary snapshot if rename fails', async () => {
  const f = await setup();
  await expect(writeJson(f.directory, { revision: 1 })).rejects.toThrow();
  expect(await readdir(f.directory)).toEqual([]);
});
