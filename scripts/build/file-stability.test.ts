import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { waitForFileStable } from './common';

test('waits for stable output and times out on missing or unsettled files', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'storyflow-file-stability-'));
  const file = join(dir, 'bundle.cjs');
  try {
    expect(await waitForFileStable(file, 100)).toBe(false);
    writeFileSync(file, 'export {};');
    expect(await waitForFileStable(file, 100)).toBe(false);
    expect(await waitForFileStable(file, 2000)).toBe(true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
