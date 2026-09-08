// input: Shared RPC channel registry (wire-format values from channels.ts)
// output: Exhaustive CHANNEL_ROUTING table, derived LOCAL_ONLY/REMOTE_ELIGIBLE sets, query helpers
// pos: Transport routing contract for hybrid local/remote execution

/**
 * Exhaustive channel routing table for hybrid local/remote transport.
 *
 * Every RPC channel must belong to exactly one of two classes:
 * - LOCAL_ONLY: Always runs on the local Electron server, never proxied.
 * - REMOTE_ELIGIBLE: Runs on whichever server owns the workspace.
 *
 * Keys are wire-format strings — the stable API contract — so reorganizing
 * key paths in channels.ts never touches this table. The `satisfies` clause
 * makes compilation fail until every channel in RPC_CHANNELS is classified.
 */

import type { RpcChannel } from './channels'

/** Routing class assigned to every channel in CHANNEL_ROUTING. */
type RoutingClass = 'LOCAL_ONLY' | 'REMOTE_ELIGIBLE'

export const CHANNEL_ROUTING = {
  // ---------------------------------------------------------------------------
  // LOCAL_ONLY — fundamentally requires local OS / Electron
  // ---------------------------------------------------------------------------

  'remote:testConnection': 'LOCAL_ONLY',

  'workspaces:get': 'LOCAL_ONLY',
  'workspaces:create': 'LOCAL_ONLY',
  'workspaces:relink': 'LOCAL_ONLY',
  'workspaces:checkSlug': 'LOCAL_ONLY',
  'workspaces:updateRemote': 'LOCAL_ONLY',

  'window:getWorkspace': 'LOCAL_ONLY',
  'window:getMode': 'LOCAL_ONLY',
  'window:resolveRuntimeWorkspace': 'LOCAL_ONLY',
  'window:openWorkspace': 'LOCAL_ONLY',
  'window:openSessionInNewWindow': 'LOCAL_ONLY',
  'window:switchWorkspace': 'LOCAL_ONLY',
  'window:close': 'LOCAL_ONLY',
  'window:closeRequested': 'LOCAL_ONLY',
  'window:confirmClose': 'LOCAL_ONLY',
  'window:cancelClose': 'LOCAL_ONLY',
  'window:setTrafficLights': 'LOCAL_ONLY',
  'window:focusState': 'LOCAL_ONLY',
  'window:getFocusState': 'LOCAL_ONLY',

  'file:openDialog': 'LOCAL_ONLY',
  'file:moveEntry': 'LOCAL_ONLY',
  'file:deleteEntry': 'LOCAL_ONLY',
  'file:readUserAttachment': 'LOCAL_ONLY',

  'dialog:openFolder': 'LOCAL_ONLY',

  'auth:logout': 'LOCAL_ONLY',
  'auth:showLogoutConfirmation': 'LOCAL_ONLY',
  'auth:showDeleteSessionConfirmation': 'LOCAL_ONLY',

  'shell:openUrl': 'LOCAL_ONLY',
  'shell:openFile': 'LOCAL_ONLY',
  'shell:showInFolder': 'LOCAL_ONLY',

  'skills:openEditor': 'LOCAL_ONLY',
  'skills:openFinder': 'LOCAL_ONLY',

  'system:versions': 'LOCAL_ONLY',
  'system:homeDir': 'LOCAL_ONLY',
  'system:isDebugMode': 'LOCAL_ONLY',

  'theme:getSystemPreference': 'LOCAL_ONLY',
  'theme:systemChanged': 'LOCAL_ONLY',
  'theme:appChanged': 'LOCAL_ONLY',
  'theme:getApp': 'LOCAL_ONLY',
  'theme:getPresets': 'LOCAL_ONLY',
  'theme:loadPreset': 'LOCAL_ONLY',
  'theme:getColorTheme': 'LOCAL_ONLY',
  'theme:setColorTheme': 'LOCAL_ONLY',
  'theme:broadcastPreferences': 'LOCAL_ONLY',
  'theme:preferencesChanged': 'LOCAL_ONLY',
  'theme:getWorkspaceColorTheme': 'LOCAL_ONLY',
  'theme:setWorkspaceColorTheme': 'LOCAL_ONLY',
  'theme:getAllWorkspaceThemes': 'LOCAL_ONLY',
  'theme:broadcastWorkspaceTheme': 'LOCAL_ONLY',
  'theme:workspaceThemeChanged': 'LOCAL_ONLY',

  'update:check': 'LOCAL_ONLY',
  'update:getInfo': 'LOCAL_ONLY',
  'update:install': 'LOCAL_ONLY',
  'update:dismiss': 'LOCAL_ONLY',
  'update:getDismissed': 'LOCAL_ONLY',
  'update:available': 'LOCAL_ONLY',
  'update:downloadProgress': 'LOCAL_ONLY',

  'releaseNotes:get': 'LOCAL_ONLY',
  'releaseNotes:getLatestVersion': 'LOCAL_ONLY',
  'releaseNotes:getWhatsNewManifest': 'LOCAL_ONLY',

  'badge:refresh': 'LOCAL_ONLY',
  'badge:setIcon': 'LOCAL_ONLY',
  'badge:draw-windows': 'LOCAL_ONLY',

  'menu:newChat': 'LOCAL_ONLY',
  'menu:newWindow': 'LOCAL_ONLY',
  'menu:openSettings': 'LOCAL_ONLY',
  'menu:keyboardShortcuts': 'LOCAL_ONLY',
  'menu:toggleSidebar': 'LOCAL_ONLY',
  'menu:quit': 'LOCAL_ONLY',
  'menu:minimize': 'LOCAL_ONLY',
  'menu:maximize': 'LOCAL_ONLY',
  'menu:zoomIn': 'LOCAL_ONLY',
  'menu:zoomOut': 'LOCAL_ONLY',
  'menu:zoomReset': 'LOCAL_ONLY',
  'menu:toggleDevTools': 'LOCAL_ONLY',
  'menu:undo': 'LOCAL_ONLY',
  'menu:redo': 'LOCAL_ONLY',
  'menu:cut': 'LOCAL_ONLY',
  'menu:copy': 'LOCAL_ONLY',
  'menu:paste': 'LOCAL_ONLY',
  'menu:selectAll': 'LOCAL_ONLY',

  'deeplink:navigate': 'LOCAL_ONLY',

  'notification:show': 'LOCAL_ONLY',
  'notification:navigate': 'LOCAL_ONLY',
  'notification:getEnabled': 'LOCAL_ONLY',
  'notification:setEnabled': 'LOCAL_ONLY',

  'input:getAutoCapitalisation': 'LOCAL_ONLY',
  'input:setAutoCapitalisation': 'LOCAL_ONLY',
  'input:getSendMessageKey': 'LOCAL_ONLY',
  'input:setSendMessageKey': 'LOCAL_ONLY',
  'input:getSpellCheck': 'LOCAL_ONLY',
  'input:setSpellCheck': 'LOCAL_ONLY',

  'power:getKeepAwake': 'LOCAL_ONLY',
  'power:setKeepAwake': 'LOCAL_ONLY',

  'userProfile:read': 'LOCAL_ONLY',
  'userProfile:write': 'LOCAL_ONLY',

  'systemInstructions:read': 'LOCAL_ONLY',
  'systemInstructions:write': 'LOCAL_ONLY',

  'caching:getExtendedPromptCache': 'LOCAL_ONLY',
  'caching:setExtendedPromptCache': 'LOCAL_ONLY',
  'caching:getEnable1MContext': 'LOCAL_ONLY',
  'caching:setEnable1MContext': 'LOCAL_ONLY',

  'tools:getBrowserToolEnabled': 'LOCAL_ONLY',
  'tools:setBrowserToolEnabled': 'LOCAL_ONLY',

  'browser-pane:create': 'LOCAL_ONLY',
  'browser-pane:destroy': 'LOCAL_ONLY',
  'browser-pane:list': 'LOCAL_ONLY',
  'browser-pane:navigate': 'LOCAL_ONLY',
  'browser-pane:go-back': 'LOCAL_ONLY',
  'browser-pane:go-forward': 'LOCAL_ONLY',
  'browser-pane:reload': 'LOCAL_ONLY',
  'browser-pane:stop': 'LOCAL_ONLY',
  'browser-pane:focus': 'LOCAL_ONLY',
  'browser-pane:snapshot': 'LOCAL_ONLY',
  'browser-pane:click': 'LOCAL_ONLY',
  'browser-pane:fill': 'LOCAL_ONLY',
  'browser-pane:select': 'LOCAL_ONLY',
  'browser-pane:screenshot': 'LOCAL_ONLY',
  'browser-pane:evaluate': 'LOCAL_ONLY',
  'browser-pane:scroll': 'LOCAL_ONLY',
  'browser-empty-state:launch': 'LOCAL_ONLY',
  'browser-pane:state-changed': 'LOCAL_ONLY',
  'browser-pane:removed': 'LOCAL_ONLY',
  'browser-pane:interacted': 'LOCAL_ONLY',

  'gitbash:check': 'LOCAL_ONLY',
  'gitbash:browse': 'LOCAL_ONLY',
  'gitbash:setPath': 'LOCAL_ONLY',

  'debug:log': 'LOCAL_ONLY',

  'onboarding:getAuthState': 'LOCAL_ONLY',
  'onboarding:validateMcp': 'LOCAL_ONLY',
  'onboarding:startMcpOAuth': 'LOCAL_ONLY',
  'onboarding:deferSetup': 'LOCAL_ONLY',
  'settings:getNetworkProxy': 'LOCAL_ONLY',
  'settings:setNetworkProxy': 'LOCAL_ONLY',

  'settings:getServerConfig': 'LOCAL_ONLY',
  'settings:setServerConfig': 'LOCAL_ONLY',
  'settings:getServerStatus': 'LOCAL_ONLY',

  // ---------------------------------------------------------------------------
  // REMOTE_ELIGIBLE — runs on whichever server owns the workspace
  // ---------------------------------------------------------------------------

  'server:getWorkspaces': 'REMOTE_ELIGIBLE',
  'server:createWorkspace': 'REMOTE_ELIGIBLE',
  'server:getStatus': 'REMOTE_ELIGIBLE',
  'server:getHealth': 'REMOTE_ELIGIBLE',
  'server:getActiveSessions': 'REMOTE_ELIGIBLE',
  'server:shuttingDown': 'REMOTE_ELIGIBLE',
  'server:statusChanged': 'REMOTE_ELIGIBLE',
  'server:homeDir': 'REMOTE_ELIGIBLE',

  'sessions:get': 'REMOTE_ELIGIBLE',
  'sessions:listByWorkspace': 'REMOTE_ELIGIBLE',
  'sessions:getUnreadSummary': 'REMOTE_ELIGIBLE',
  'sessions:markAllRead': 'REMOTE_ELIGIBLE',
  'sessions:unreadSummaryChanged': 'REMOTE_ELIGIBLE',
  'sessions:create': 'REMOTE_ELIGIBLE',
  'sessions:delete': 'REMOTE_ELIGIBLE',
  'sessions:rewind': 'REMOTE_ELIGIBLE',
  'sessions:getMessages': 'REMOTE_ELIGIBLE',
  'sessions:releaseMessages': 'REMOTE_ELIGIBLE',
  'sessions:sendMessage': 'REMOTE_ELIGIBLE',
  'sessions:rewriteNovelSelection': 'REMOTE_ELIGIBLE',
  'sessions:cancel': 'REMOTE_ELIGIBLE',
  'sessions:killShell': 'REMOTE_ELIGIBLE',
  'sessions:respondToPermission': 'REMOTE_ELIGIBLE',
  'sessions:respondToUserQuestion': 'REMOTE_ELIGIBLE',
  'sessions:respondToCredential': 'REMOTE_ELIGIBLE',
  'sessions:command': 'REMOTE_ELIGIBLE',
  'sessions:getPendingPlanExecution': 'REMOTE_ELIGIBLE',
  'sessions:getPermissionModeState': 'REMOTE_ELIGIBLE',
  'session:event': 'REMOTE_ELIGIBLE',
  'session:getModel': 'REMOTE_ELIGIBLE',
  'session:setModel': 'REMOTE_ELIGIBLE',
  'sessions:getFiles': 'REMOTE_ELIGIBLE',
  'sessions:getNotes': 'REMOTE_ELIGIBLE',
  'sessions:setNotes': 'REMOTE_ELIGIBLE',
  'sessions:watchFiles': 'REMOTE_ELIGIBLE',
  'sessions:unwatchFiles': 'REMOTE_ELIGIBLE',
  'sessions:filesChanged': 'REMOTE_ELIGIBLE',
  'sessions:searchContent': 'REMOTE_ELIGIBLE',
  'sessions:export': 'REMOTE_ELIGIBLE',
  'sessions:import': 'REMOTE_ELIGIBLE',
  'sessions:exportRemoteTransfer': 'REMOTE_ELIGIBLE',
  'sessions:importRemoteTransfer': 'REMOTE_ELIGIBLE',

  'transfer:start': 'REMOTE_ELIGIBLE',
  'transfer:chunk': 'REMOTE_ELIGIBLE',
  'transfer:commit': 'REMOTE_ELIGIBLE',
  'transfer:abort': 'REMOTE_ELIGIBLE',

  'tasks:getOutput': 'REMOTE_ELIGIBLE',

  'file:read': 'REMOTE_ELIGIBLE',
  'file:write': 'REMOTE_ELIGIBLE',
  'file:delete': 'REMOTE_ELIGIBLE',
  'file:createDirectory': 'REMOTE_ELIGIBLE',
  'file:readDataUrl': 'REMOTE_ELIGIBLE',
  'file:readPreviewDataUrl': 'REMOTE_ELIGIBLE',
  'file:readBinary': 'REMOTE_ELIGIBLE',
  'file:readAttachment': 'REMOTE_ELIGIBLE',
  'file:storeAttachment': 'REMOTE_ELIGIBLE',
  'file:generateThumbnail': 'REMOTE_ELIGIBLE',

  'fs:search': 'REMOTE_ELIGIBLE',
  'fs:searchBatch': 'REMOTE_ELIGIBLE',
  'fs:listFiles': 'REMOTE_ELIGIBLE',
  'fs:listDirectory': 'REMOTE_ELIGIBLE',

  'search:queryWorkspace': 'REMOTE_ELIGIBLE',
  'search:cancelWorkspace': 'REMOTE_ELIGIBLE',

  'credentials:healthCheck': 'REMOTE_ELIGIBLE',

  'LLM_Connection:list': 'REMOTE_ELIGIBLE',
  'LLM_Connection:listWithStatus': 'REMOTE_ELIGIBLE',
  'LLM_Connection:get': 'REMOTE_ELIGIBLE',
  'LLM_Connection:getApiKey': 'REMOTE_ELIGIBLE',
  'LLM_Connection:save': 'REMOTE_ELIGIBLE',
  'LLM_Connection:delete': 'REMOTE_ELIGIBLE',
  'LLM_Connection:test': 'REMOTE_ELIGIBLE',
  'LLM_Connection:setDefault': 'REMOTE_ELIGIBLE',
  'LLM_Connection:setWorkspaceDefault': 'REMOTE_ELIGIBLE',
  'LLM_Connection:refreshModels': 'REMOTE_ELIGIBLE',
  'LLM_Connection:changed': 'REMOTE_ELIGIBLE',

  'chatgpt:startOAuth': 'REMOTE_ELIGIBLE',
  'chatgpt:completeOAuth': 'REMOTE_ELIGIBLE',
  'chatgpt:cancelOAuth': 'REMOTE_ELIGIBLE',
  'chatgpt:getAuthStatus': 'REMOTE_ELIGIBLE',
  'chatgpt:logout': 'REMOTE_ELIGIBLE',

  'copilot:startOAuth': 'REMOTE_ELIGIBLE',
  'copilot:cancelOAuth': 'REMOTE_ELIGIBLE',
  'copilot:getAuthStatus': 'REMOTE_ELIGIBLE',
  'copilot:logout': 'REMOTE_ELIGIBLE',
  'copilot:deviceCode': 'REMOTE_ELIGIBLE',

  'onboarding:startClaudeOAuth': 'REMOTE_ELIGIBLE',
  'onboarding:exchangeClaudeCode': 'REMOTE_ELIGIBLE',
  'onboarding:claudeOAuthCompleted': 'REMOTE_ELIGIBLE',
  'onboarding:hasClaudeOAuthState': 'REMOTE_ELIGIBLE',
  'onboarding:clearClaudeOAuthState': 'REMOTE_ELIGIBLE',

  'settings:setupLlmConnection': 'REMOTE_ELIGIBLE',
  'settings:testLlmConnectionSetup': 'REMOTE_ELIGIBLE',
  'settings:getDefaultThinkingLevel': 'REMOTE_ELIGIBLE',
  'settings:setDefaultThinkingLevel': 'REMOTE_ELIGIBLE',

  'pi:getApiKeyProviders': 'REMOTE_ELIGIBLE',
  'pi:getProviderBaseUrl': 'REMOTE_ELIGIBLE',
  'pi:getProviderModels': 'REMOTE_ELIGIBLE',

  'preferences:read': 'REMOTE_ELIGIBLE',
  'preferences:write': 'REMOTE_ELIGIBLE',

  'drafts:get': 'REMOTE_ELIGIBLE',
  'drafts:set': 'REMOTE_ELIGIBLE',
  'drafts:delete': 'REMOTE_ELIGIBLE',
  'drafts:getAll': 'REMOTE_ELIGIBLE',

  'sources:get': 'REMOTE_ELIGIBLE',
  'sources:create': 'REMOTE_ELIGIBLE',
  'sources:delete': 'REMOTE_ELIGIBLE',
  'sources:startOAuth': 'REMOTE_ELIGIBLE',
  'sources:saveCredentials': 'REMOTE_ELIGIBLE',
  'sources:changed': 'REMOTE_ELIGIBLE',
  'sources:getPermissions': 'REMOTE_ELIGIBLE',
  'sources:getMcpTools': 'REMOTE_ELIGIBLE',

  'oauth:start': 'REMOTE_ELIGIBLE',
  'oauth:complete': 'REMOTE_ELIGIBLE',
  'oauth:cancel': 'REMOTE_ELIGIBLE',
  'oauth:revoke': 'REMOTE_ELIGIBLE',

  'workspace:getPermissions': 'REMOTE_ELIGIBLE',
  'workspace:readImage': 'REMOTE_ELIGIBLE',
  'workspace:writeImage': 'REMOTE_ELIGIBLE',
  'workspaceSettings:get': 'REMOTE_ELIGIBLE',
  'workspaceSettings:update': 'REMOTE_ELIGIBLE',

  'permissions:getDefaults': 'REMOTE_ELIGIBLE',
  'permissions:defaultsChanged': 'REMOTE_ELIGIBLE',

  'skills:get': 'REMOTE_ELIGIBLE',
  'skills:getFiles': 'REMOTE_ELIGIBLE',
  'skills:export': 'REMOTE_ELIGIBLE',
  'skills:create': 'REMOTE_ELIGIBLE',
  'skills:delete': 'REMOTE_ELIGIBLE',
  'skills:changed': 'REMOTE_ELIGIBLE',

  'statuses:list': 'REMOTE_ELIGIBLE',
  'statuses:reorder': 'REMOTE_ELIGIBLE',
  'statuses:changed': 'REMOTE_ELIGIBLE',

  'labels:list': 'REMOTE_ELIGIBLE',
  'labels:create': 'REMOTE_ELIGIBLE',
  'labels:delete': 'REMOTE_ELIGIBLE',
  'labels:changed': 'REMOTE_ELIGIBLE',

  'views:list': 'REMOTE_ELIGIBLE',
  'views:save': 'REMOTE_ELIGIBLE',

  'toolIcons:getMappings': 'REMOTE_ELIGIBLE',

  'logo:getUrl': 'REMOTE_ELIGIBLE',

  'automations:get': 'REMOTE_ELIGIBLE',
  'automations:test': 'REMOTE_ELIGIBLE',
  'automations:setEnabled': 'REMOTE_ELIGIBLE',
  'automations:duplicate': 'REMOTE_ELIGIBLE',
  'automations:delete': 'REMOTE_ELIGIBLE',
  'automations:getHistory': 'REMOTE_ELIGIBLE',
  'automations:getLastExecuted': 'REMOTE_ELIGIBLE',
  'automations:replay': 'REMOTE_ELIGIBLE',
  'automations:changed': 'REMOTE_ELIGIBLE',

  'git:getBranch': 'REMOTE_ELIGIBLE',
  'git:getVersionStatus': 'REMOTE_ELIGIBLE',
  'git:compareVersions': 'REMOTE_ELIGIBLE',
  'git:readFileAtVersion': 'REMOTE_ELIGIBLE',
  'git:createVersion': 'REMOTE_ELIGIBLE',
  'git:listVersions': 'REMOTE_ELIGIBLE',
  'git:restoreVersion': 'REMOTE_ELIGIBLE',

  'resources:export': 'REMOTE_ELIGIBLE',
  'resources:import': 'REMOTE_ELIGIBLE',
  'resources:listInstallReceipts': 'REMOTE_ELIGIBLE',
  'resources:upgradeSkill': 'REMOTE_ELIGIBLE',

  'messaging:bindingChanged': 'REMOTE_ELIGIBLE',
  'messaging:platformStatus': 'REMOTE_ELIGIBLE',
  'messaging:pendingChanged': 'REMOTE_ELIGIBLE',
  'messaging:getConfig': 'REMOTE_ELIGIBLE',
  'messaging:updateConfig': 'REMOTE_ELIGIBLE',
  'messaging:testTelegram': 'REMOTE_ELIGIBLE',
  'messaging:saveTelegram': 'REMOTE_ELIGIBLE',
  'messaging:testLark': 'REMOTE_ELIGIBLE',
  'messaging:saveLark': 'REMOTE_ELIGIBLE',
  'messaging:disconnect': 'REMOTE_ELIGIBLE',
  'messaging:forget': 'REMOTE_ELIGIBLE',
  'messaging:getBindings': 'REMOTE_ELIGIBLE',
  'messaging:generateCode': 'REMOTE_ELIGIBLE',
  'messaging:generateSupergroupCode': 'REMOTE_ELIGIBLE',
  'messaging:getSupergroup': 'REMOTE_ELIGIBLE',
  'messaging:unbindSupergroup': 'REMOTE_ELIGIBLE',
  'messaging:unbind': 'REMOTE_ELIGIBLE',
  'messaging:unbindBinding': 'REMOTE_ELIGIBLE',
  'messaging:wa:startConnect': 'REMOTE_ELIGIBLE',
  'messaging:wa:submitPhone': 'REMOTE_ELIGIBLE',
  'messaging:wa:uiEvent': 'REMOTE_ELIGIBLE',
  'messaging:access:getOwners': 'REMOTE_ELIGIBLE',
  'messaging:access:setOwners': 'REMOTE_ELIGIBLE',
  'messaging:access:getMode': 'REMOTE_ELIGIBLE',
  'messaging:access:setMode': 'REMOTE_ELIGIBLE',
  'messaging:access:getPending': 'REMOTE_ELIGIBLE',
  'messaging:access:dismissPending': 'REMOTE_ELIGIBLE',
  'messaging:access:allowPending': 'REMOTE_ELIGIBLE',
  'messaging:access:setBindingAccess': 'REMOTE_ELIGIBLE',

  // ---------------------------------------------------------------------------
} as const satisfies Record<RpcChannel, RoutingClass>

// ---------------------------------------------------------------------------
// Derived sets — same exported API the two-set implementation had
// ---------------------------------------------------------------------------

function channelsOfClass(klass: RoutingClass): ReadonlySet<string> {
  const channels = new Set<string>()
  for (const [channel, channelClass] of Object.entries(CHANNEL_ROUTING)) {
    if (channelClass === klass) channels.add(channel)
  }
  return channels
}

/** Channels that always run on the local Electron server. */
export const LOCAL_ONLY_CHANNELS = channelsOfClass('LOCAL_ONLY')

/** Channels that run on whichever server owns the workspace. */
export const REMOTE_ELIGIBLE_CHANNELS = channelsOfClass('REMOTE_ELIGIBLE')

// ---------------------------------------------------------------------------
// Query helpers
// ---------------------------------------------------------------------------

export function isLocalOnly(channel: string): boolean {
  return LOCAL_ONLY_CHANNELS.has(channel)
}

export function isRemoteEligible(channel: string): boolean {
  return REMOTE_ELIGIBLE_CHANNELS.has(channel)
}
