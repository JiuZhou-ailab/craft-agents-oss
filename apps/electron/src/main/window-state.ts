// input: Managed window snapshots and persisted window-state JSON
// output: Saved/restored desktop window state on disk
// pos: Main-process persistence boundary for Electron window restoration

import { existsSync, mkdirSync } from 'fs'
import { atomicWriteFileSync, readJsonFileSync } from '@craft-agent/shared/utils/files'
import { mainLog } from './logger'
import { join } from 'path'
import { CONFIG_DIR } from '@craft-agent/shared/config/paths'

export interface WindowBounds {
  x: number
  y: number
  width: number
  height: number
}

export interface SavedWindow {
  type: 'main'
  workspaceId: string
  bounds: WindowBounds
  // Full URL captured from webContents.getURL() at quit time.
  // May be localhost (dev) or file:// (prod) — both are safe to store because
  // createWindow() never loads this URL directly. It extracts query params
  // (workspaceId, route, etc.) and rebuilds the URL from __dirname
  // (prod) or the current dev server (dev). See window-manager.ts restoreUrl.
  url?: string
}

export interface WindowState {
  windows: SavedWindow[]
  lastFocusedWorkspaceId?: string
}

const WINDOW_STATE_FILE = join(CONFIG_DIR, 'window-state.json')

export function parseWindowState(raw: unknown): WindowState | null {
  if (!raw || typeof raw !== 'object' || !Array.isArray((raw as WindowState).windows)) {
    return null
  }

  const state = raw as WindowState
  const valid = state.windows.every(window => (
    window?.type === 'main'
    && typeof window.workspaceId === 'string'
    && (window.url === undefined || typeof window.url === 'string')
    && window.bounds
    && Number.isFinite(window.bounds.x)
    && Number.isFinite(window.bounds.y)
    && Number.isFinite(window.bounds.width)
    && window.bounds.width > 0
    && Number.isFinite(window.bounds.height)
    && window.bounds.height > 0
  ))
  if (!valid || (state.lastFocusedWorkspaceId !== undefined && typeof state.lastFocusedWorkspaceId !== 'string')) {
    return null
  }
  return state
}

/**
 * Save the current window state (windows with bounds and type)
 */
export function saveWindowState(state: WindowState): void {
  try {
    // Ensure config directory exists
    if (!existsSync(CONFIG_DIR)) {
      mkdirSync(CONFIG_DIR, { recursive: true })
    }

    atomicWriteFileSync(WINDOW_STATE_FILE, JSON.stringify(state, null, 2))
    mainLog.info('[WindowState] Saved window state:', state.windows.length, 'windows')
  } catch (error) {
    mainLog.error('[WindowState] Failed to save window state:', error instanceof Error ? error.message : String(error))
  }
}

/**
 * Load the saved window state
 */
export function loadWindowState(): WindowState | null {
  try {
    if (!existsSync(WINDOW_STATE_FILE)) {
      return null
    }

    const state = parseWindowState(readJsonFileSync(WINDOW_STATE_FILE))
    if (!state) {
      mainLog.warn('[WindowState] Invalid window state file, ignoring')
      return null
    }

    mainLog.info('[WindowState] Loaded window state:', state.windows.length, 'windows')
    return state
  } catch (error) {
    mainLog.error('[WindowState] Failed to load window state:', error instanceof Error ? error.message : String(error))
    return null
  }
}
