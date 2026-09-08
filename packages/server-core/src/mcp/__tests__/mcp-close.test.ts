import { test, expect } from 'bun:test'
import { ChildProcess } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { McpClientPool } from '../mcp-pool'

for (const blocked of [false, true]) test(`MCP close confirms exit and retries pending cleanup (blocked=${blocked})`, async () => {
  const root = mkdtempSync(join(tmpdir(), 'storyflow-mcp-close-'))
  const file = join(root, 'server.cjs')
  writeFileSync(file, `
    process.on('SIGTERM', () => {});
    setInterval(() => {}, 1000);
    require('node:readline').createInterface({input:process.stdin}).on('line', line => {
      const m = JSON.parse(line); if (m.id === undefined) return;
      const result = m.method === 'initialize' ? {protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}}
        : m.method === 'tools/list' ? {tools:[{name:'pid',inputSchema:{type:'object'}}]}
        : {content:[{type:'text',text:String(process.pid)}]};
      process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');
    });
  `)
  const pool = new McpClientPool()
  let pid: number | undefined
  let blockedChild: ChildProcess | undefined
  const kill = ChildProcess.prototype.kill
  try {
    await pool.connect('fixture', { type: 'stdio', command: process.execPath, args: [file], capabilityRef: 'fixture:pid' })
    const result = await pool.callTool('mcp__fixture__pid', {})
    pid = Number(result.content)
    expect(pid).toBeGreaterThan(0)
    if (blocked) {
      // Fault only the owned child's OS signal boundary; the SDK and pool remain real.
      ChildProcess.prototype.kill = function(signal) {
        if (this.pid === pid) { blockedChild = this; return false }
        return kill.call(this, signal)
      }
      await expect(pool.disconnectAll()).rejects.toThrow('MCP clients failed to close')
      expect(blockedChild).toBeDefined()
      ChildProcess.prototype.kill = kill
      // External recovery of a process the OS previously refused to stop.
      kill.call(blockedChild!, 'SIGKILL')
    }
    await pool.disconnectAll()
    expect(() => process.kill(pid!, 0)).toThrow()
  } finally {
    ChildProcess.prototype.kill = kill
    if (blockedChild) kill.call(blockedChild, 'SIGKILL')
    else if (pid) { try { process.kill(pid, 'SIGKILL') } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error } }
    await pool.disconnectAll()
    rmSync(root, {recursive:true,force:true})
  }
}, 15_000)
