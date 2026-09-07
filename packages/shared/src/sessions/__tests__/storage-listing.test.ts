// input: Temporary workspaces with persisted session JSONL files
// output: Behavioral parity between synchronous and non-blocking session listing
// pos: Regression check for startup session restoration without main-thread filesystem reads

import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSession, deleteSession, listSessions, listSessionsAsync, loadSession } from '../storage.ts';

let workspaceRoot: string | undefined;
let otherWorkspaceRoot: string | undefined;
let externalRoot: string | undefined;

afterEach(() => {
  if (workspaceRoot) rmSync(workspaceRoot, { recursive: true, force: true });
  if (otherWorkspaceRoot) rmSync(otherWorkspaceRoot, { recursive: true, force: true });
  if (externalRoot) rmSync(externalRoot, { recursive: true, force: true });
  workspaceRoot = undefined;
  otherWorkspaceRoot = undefined;
  externalRoot = undefined;
});

describe('session storage listing', () => {
  it('returns the same metadata through the non-blocking startup path', async () => {
    workspaceRoot = mkdtempSync(join(tmpdir(), 'session-listing-'));
    await createSession(workspaceRoot, { name: 'first' });
    await createSession(workspaceRoot, { name: 'second' });

    expect(await listSessionsAsync(workspaceRoot)).toEqual(listSessions(workspaceRoot));
  });

  it('generates host-wide unique ids across Project roots', async () => {
    workspaceRoot = mkdtempSync(join(tmpdir(), 'session-listing-a-'));
    otherWorkspaceRoot = mkdtempSync(join(tmpdir(), 'session-listing-b-'));

    const [first, second] = await Promise.all([
      createSession(workspaceRoot, { name: 'first' }),
      createSession(otherWorkspaceRoot, { name: 'second' }),
    ]);

    expect(first.id).not.toBe(second.id);
  });

  it('persists pin state independently from the automation-facing flag state', async () => {
    workspaceRoot = mkdtempSync(join(tmpdir(), 'session-pinned-'));
    const created = await createSession(workspaceRoot, { isPinned: true, isFlagged: false });

    const restored = loadSession(workspaceRoot, created.id);
    expect(restored?.isPinned).toBe(true);
    expect(restored?.isFlagged).toBe(false);
  });

  it('refuses to delete through a Project sessions-directory symlink', () => {
    workspaceRoot = mkdtempSync(join(tmpdir(), 'session-delete-symlink-'));
    externalRoot = mkdtempSync(join(tmpdir(), 'session-delete-external-'));
    const externalSession = join(externalRoot, 'session-1');
    const sentinel = join(externalSession, 'keep.txt');
    mkdirSync(join(workspaceRoot, '.craft-agent'), { recursive: true });
    mkdirSync(externalSession, { recursive: true });
    writeFileSync(sentinel, 'keep');
    symlinkSync(
      externalRoot,
      join(workspaceRoot, '.craft-agent', 'sessions'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );

    expect(deleteSession(workspaceRoot, 'session-1')).toBe(false);
    expect(existsSync(sentinel)).toBe(true);
  });
});
