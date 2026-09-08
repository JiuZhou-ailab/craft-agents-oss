import { test, expect } from 'bun:test'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('standard fixture gives every workspace session a globally unique identity', async () => {
  const root = mkdtempSync(join(tmpdir(), 'storyflow-fixture-'))
  const output = join(root, 'data')
  try {
    const child = Bun.spawn(['bun', 'scripts/perf/generate-fixture.ts', '--out', output], { stdout: 'pipe', stderr: 'pipe' })
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    expect(code, stdout + stderr).toBe(0)
    const ids = readdirSync(join(output, 'workspaces')).flatMap(workspace => readdirSync(join(output, 'workspaces', workspace, '.craft-agent', 'sessions')))
    expect(ids).toHaveLength(6000)
    expect(new Set(ids).size).toBe(6000)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}, 120_000)
