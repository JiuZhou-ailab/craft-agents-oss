// input: Playground fixture state and AppShell context contracts
// output: No-op providers for isolated renderer component previews
// pos: Development-only adapter for components that normally run inside AppShell

/**
 * PlaygroundAppShellProvider
 *
 * Minimal stand-in for the real AppShellProvider so components that rely on
 * narrow app-shell contexts can render inside the playground without the full
 * app shell wiring.
 *
 * All callbacks are no-op logging stubs — interactions just go to the console.
 */

import * as React from 'react'
import { useSetAtom } from 'jotai'
import { AppShellProvider, type AppShellContextType } from '../context/AppShellContext'
import { windowRuntimeWorkspaceAtom, windowWorkspaceIdAtom, windowWorkspacesAtom } from '../atoms/sessions'
import type { Workspace } from '../../shared/types'

const PLAYGROUND_WORKSPACE: Workspace = {
  id: 'playground-workspace',
  name: 'Playground',
  slug: 'playground',
  rootPath: '/mock/workspaces/playground-workspace',
  createdAt: Date.now(),
}

function logCall(method: string) {
  return (...args: unknown[]) => {
    console.log(`[Playground AppShell] ${method} called`, args)
  }
}

// Build a minimal value that satisfies the type. Most callbacks are no-ops;
// workspace atoms below let workspace-scoped components resolve in playground.
const playgroundValue: AppShellContextType = {
  workspaces: [PLAYGROUND_WORKSPACE],
  clientAuthState: null,
  onClientSignedIn: async () => {},
  onClientSignOut: async () => {},
  runtimeWorkspace: PLAYGROUND_WORKSPACE,
  activeProjectId: PLAYGROUND_WORKSPACE.id,
  llmConnections: [],
  refreshLlmConnections: async () => {},
  getDraft: () => '',
  getDraftAttachmentRefs: () => [],
  hydrateDraftAttachments: async () => [],
  onCreateSession: (async () => {
    throw new Error('[Playground] onCreateSession is not available')
  }) as AppShellContextType['onCreateSession'],
  onSendMessage: logCall('onSendMessage'),
  onRenameSession: logCall('onRenameSession'),
  onFlagSession: logCall('onFlagSession'),
  onUnflagSession: logCall('onUnflagSession'),
  onPinSession: async (...args: unknown[]) => {
    logCall('onPinSession')(...args)
    return true
  },
  onUnpinSession: async (...args: unknown[]) => {
    logCall('onUnpinSession')(...args)
    return true
  },
  onArchiveSession: logCall('onArchiveSession'),
  onUnarchiveSession: logCall('onUnarchiveSession'),
  onMarkSessionRead: logCall('onMarkSessionRead'),
  onMarkSessionUnread: logCall('onMarkSessionUnread'),
  onSetActiveViewingSession: logCall('onSetActiveViewingSession'),
  onSessionStatusChange: logCall('onSessionStatusChange'),
  onDeleteSession: async () => {
    console.log('[Playground AppShell] onDeleteSession called')
    return false
  },
  onOpenFile: logCall('onOpenFile'),
  onOpenUrl: logCall('onOpenUrl'),
  onSelectWorkspace: logCall('onSelectWorkspace'),
  onOpenWritingWorkspace: logCall('onOpenWritingWorkspace'),
  onOpenFreeConversations: logCall('onOpenFreeConversations'),
  onOpenSettings: logCall('onOpenSettings'),
  onOpenKeyboardShortcuts: logCall('onOpenKeyboardShortcuts'),
  onOpenStoredUserPreferences: logCall('onOpenStoredUserPreferences'),
  onReset: logCall('onReset'),
  onSessionOptionsChange: logCall('onSessionOptionsChange'),
  onInputChange: logCall('onInputChange'),
  onAttachmentsChange: logCall('onAttachmentsChange'),
}

export function PlaygroundAppShellProvider({ children }: { children: React.ReactNode }) {
  const setWindowWorkspaceId = useSetAtom(windowWorkspaceIdAtom)
  const setRuntimeWorkspace = useSetAtom(windowRuntimeWorkspaceAtom)
  const setWindowWorkspaces = useSetAtom(windowWorkspacesAtom)

  React.useEffect(() => {
    setWindowWorkspaceId(PLAYGROUND_WORKSPACE.id)
    setRuntimeWorkspace(PLAYGROUND_WORKSPACE)
    setWindowWorkspaces([PLAYGROUND_WORKSPACE])
    return () => {
      setWindowWorkspaceId(null)
      setRuntimeWorkspace(null)
      setWindowWorkspaces([])
    }
  }, [setRuntimeWorkspace, setWindowWorkspaceId, setWindowWorkspaces])

  return <AppShellProvider value={playgroundValue}>{children}</AppShellProvider>
}
