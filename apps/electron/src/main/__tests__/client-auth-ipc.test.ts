// input: Electron main/preload/renderer client-auth source files
// output: Regression coverage for cross-window auth state, sign-out revocation, and operation-scoped managed access
// pos: Static IPC contract guard for managed-account auth without a desktop gate

import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const electronRoot = join(import.meta.dir, '..', '..')

function readElectronFile(path: string): string {
  return readFileSync(join(electronRoot, path), 'utf8')
}

describe('client auth IPC propagation', () => {
  it('broadcasts client auth state changes from main to every window', () => {
    const source = readElectronFile('main/index.ts')

    expect(source).toContain('CLIENT_AUTH_IPC_CHANNELS.STATE_CHANGED')
    expect(source).toContain('BrowserWindow.getAllWindows()')
    expect(source).toContain('onAuthChange: (change)')
    expect(source).toContain('broadcastClientAuthState(change.state)')
    expect(source).toContain('void revokeManagedModelRuntimes()')
    expect(source).not.toContain('onAuthChange: async (change)')
  })

  it('wires ephemeral managed model access into runtimes and model discovery', () => {
    const source = readElectronFile('main/index.ts')

    expect(source).toContain('ensureManagedModelAccessToken: async (forceRefresh)')
    expect(source).toContain('authService.ensureModelAccessToken')
    expect(source).toContain('MANAGED_LLM_CONNECTION_SLUGS.map')
    expect(source).toContain('disposeConnectionRuntimes(slug)')
    expect(source).not.toContain('reloadConnectionCredentials(slug, managedModelAccess)')
    expect(source).toContain('isManagedLlmConnectionSlug(connection.slug)')
    expect(source).toContain('return { apiKey: result.token }')
    expect(source).toContain('resolveModelRefreshCredentials(connection, getCredentialManager())')
    expect(source).toContain('managedModelAccessAvailable: !serverModeEnabled && managedModelAccessConfigured')
    expect(source).toContain('clientAuthService?.dispose()')
  })

  it('exposes a renderer auth-state subscription', () => {
    const source = readElectronFile('preload/bootstrap.ts')

    expect(source).toContain('onClientAuthStateChanged')
    expect(source).toContain('signUpClient')
    expect(source).toContain('ipcRenderer.on(CLIENT_AUTH_IPC_CHANNELS.STATE_CHANGED')
    expect(source).toContain('callback(nextState)')
  })

  it('keeps native email verification behind the main-process IPC boundary', () => {
    const mainSource = readElectronFile('main/index.ts')
    const preloadSource = readElectronFile('preload/bootstrap.ts')

    expect(mainSource).toContain('CLIENT_AUTH_IPC_CHANNELS.VERIFY_EMAIL')
    expect(mainSource).toContain('CLIENT_AUTH_IPC_CHANNELS.RESEND_VERIFICATION_EMAIL')
    expect(mainSource).toContain("otp: typeof record.otp === 'string'")
    expect(preloadSource).toContain('CLIENT_AUTH_IPC_CHANNELS.VERIFY_EMAIL, input')
    expect(preloadSource).toContain('CLIENT_AUTH_IPC_CHANNELS.RESEND_VERIFICATION_EMAIL, input')
  })

  it('keeps managed sign-in at the account capability boundary', () => {
    const rendererEntry = readElectronFile('renderer/main.tsx')
    const signInForm = readElectronFile('renderer/components/auth/ClientSignInForm.tsx')

    expect(rendererEntry).not.toContain('ClientAuthGate')
    expect(signInForm).toContain('signUpClient')
    expect(signInForm).toContain('signInClient')
    expect(signInForm).toContain('signInWithFeishuClient')
  })
})

describe('feedback IPC contract', () => {
  it('registers the main handler exposed by preload', () => {
    const mainSource = readElectronFile('main/index.ts')
    const preloadSource = readElectronFile('preload/bootstrap.ts')

    expect(preloadSource).toContain("ipcRenderer.invoke('feedback:submitIssue'")
    expect(mainSource).toContain("ipcMain.handle('feedback:submitIssue'")
  })
})
