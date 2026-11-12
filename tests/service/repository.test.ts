import { mkdtemp, readFile, readdir, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { atomicJson } from '../../apps/planner-service/src/repository';

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, rename: vi.fn(actual.rename) };
});

let directory = '';
afterEach(async () => {
  vi.mocked(rename).mockReset();
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = '';
});

it.skipIf(process.platform !== 'win32')('retries transient Windows rename failures and surfaces permanent failures', async () => {
  directory = await mkdtemp(join(tmpdir(), 'whatif-atomic-test-'));
  const path = join(directory, 'record.json');
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  const locked = () => Object.assign(new Error('File is locked'), { code: 'EPERM' });
  vi.mocked(rename).mockRejectedValueOnce(locked()).mockImplementation(actual.rename);
  await atomicJson(path, { value: 1 });
  expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ value: 1 });
  expect(rename).toHaveBeenCalledTimes(2);
  vi.mocked(rename).mockReset().mockRejectedValue(locked());
  await expect(atomicJson(path, { value: 2 })).rejects.toThrow('File is locked');
  expect(vi.mocked(rename)).toHaveBeenCalledTimes(8);
  expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ value: 1 });
  expect(await readdir(directory)).toEqual(['record.json']);
});
