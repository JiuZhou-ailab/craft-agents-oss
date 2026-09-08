import { expect, test } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { PiAgent } from '../pi-agent'

class ProcessBoundaryAgent extends PiAgent {
  attach(child: ChildProcess) { this.subprocess = child }
}

test('failed Pi termination remains retryable and never reports a live child as stopped', async () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: ['pipe', 'pipe', 'pipe'] })
  await once(child, 'spawn')
  const agent = new ProcessBoundaryAgent({ workspace: { id: 'exit-test', name: 'Exit test', rootPath: '/tmp' }, isHeadless: true } as never)
  agent.attach(child)
  const kill = child.kill.bind(child)
  // Process boundary fault: emulate a platform that cannot terminate this child.
  child.kill = () => false
  try {
    await expect(agent.disposeForRestart()).rejects.toThrow('stop timed out')
    expect(child.exitCode).toBeNull()
    child.kill = kill
    await agent.disposeForRestart()
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true)
  } finally {
    child.kill = kill
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit'); kill('SIGKILL'); await exited
    }
    agent.destroy()
  }
}, 10_000)
