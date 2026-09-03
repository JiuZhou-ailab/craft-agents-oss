/**
 * Config File Watcher
 *
 * input: App, global Storyflow resources, and workspace/project configuration changes
 * output: Debounced callbacks for config, sources, skills, permissions, themes, and metadata
 * pos: Shared filesystem watch coordinator for live runtime configuration updates
 *
 * Watches configuration files for changes and triggers callbacks.
 * Uses recursive directory watching for simplicity and reliability.
 *
 * Watched paths:
 * - ~/.craft-agent/config.json - Main app configuration
 * - ~/.craft-agent/preferences.json - User preferences
 * - ~/.craft-agent/theme.json - App-level theme overrides
 * - ~/.craft-agent/themes/*.json - Preset theme files (app-level)
 * - ~/.craft-agent/sources/{slug}/config.json, guide.md, icon.* - Craft global sources
 * - ~/.pi/agent/skills, ~/.agents/skills, ~/.craft-agent/skills - Pi user Skills
 * - ~/.craft-agent/workspaces/{slug}/ - Workspace directory (recursive)
 *   - .pi/skills and .agents/skills - Pi project Skills
 *   - .craft-agent/sources/{slug}/config.json, guide.md, permissions.json
 *   - .craft-agent/sessions/{id}/session.jsonl (header metadata only)
 *   - permissions.json
 */

import { watch, existsSync, readdirSync, statSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir, platform } from 'os';
import type { FSWatcher } from 'fs';
import { CONFIG_DIR } from './paths.ts';
import { debug } from '../utils/debug.ts';
import { expandPath } from '../utils/paths.ts';
import { readJsonFileSync } from '../utils/files.ts';
import { perf } from '../utils/perf.ts';
import { loadStoredConfig, type StoredConfig } from './storage.ts';
import {
  validateConfig,
  validatePreferences,
  validateSource,
  type ValidationResult,
} from './validators.ts';
import type { LoadedSource, SourceGuide } from '../sources/types.ts';
import {
  loadSource,
  loadWorkspaceSources,
  loadSourceGuide,
  sourceNeedsIconDownload,
  downloadSourceIcon,
  GLOBAL_AGENT_SOURCES_DIR,
} from '../sources/storage.ts';
import { permissionsConfigCache, getAppPermissionsDir } from '../agent/permissions-config.ts';
import { getWorkspacePath, getWorkspaceSourcesPath } from '../workspaces/storage.ts';
import { WORKSPACE_STATE_DIR } from '../workspaces/paths.ts';
import {
  getPiUserSkillsDir,
  invalidateSkillsCache,
} from '../skills/storage.ts';
import { resolveResourceRoots } from '../resources/resolver.ts';
import {
  loadStatusConfig,
  statusNeedsIconDownload,
  downloadStatusIcon,
} from '../statuses/storage.ts';
import { readSessionHeader } from '../sessions/jsonl.ts';
import { getSessionFilePath } from '../sessions/storage.ts';
import type { SessionHeader } from '../sessions/types.ts';
import { AUTOMATIONS_CONFIG_FILE } from '../automations/constants.ts';
import { loadAppTheme, loadPresetThemes, loadPresetTheme, getAppThemesDir } from './storage.ts';
import type { ThemeOverrides, PresetTheme } from './theme.ts';

// ============================================================
// Active Watcher Registry (duplicate detection)
// ============================================================

/**
 * Tracks active ConfigWatcher instances by workspace directory.
 * Used to detect duplicate recursive watchers on the same directory tree,
 * which can wedge Bun's event loop on Linux.
 */
const activeWatchers = new Map<string, string>(); // workspaceDir → creator workspaceId

/** Exported for testing only */
export function _getActiveWatchers(): ReadonlyMap<string, string> {
  return activeWatchers;
}

export function _getGlobalWatcherState(): {
  started: boolean;
  watcherCount: number;
  subscriberCount: number;
} {
  return ConfigWatcher.getGlobalWatcherState();
}

// ============================================================
// Constants
// ============================================================

const PREFERENCES_FILE = join(CONFIG_DIR, 'preferences.json');
const GLOBAL_AGENT_SKILLS_DIRS = Array.from(new Set([
  getPiUserSkillsDir(),
  join(homedir(), '.agents', 'skills'),
  resolveResourceRoots().skillsPath,
]));

// Debounce delay in milliseconds
const DEBOUNCE_MS = 100;

// Longer debounce for session metadata on Windows where fs.watch() fires
// aggressively for atomic writes (unlink + rename = 2+ events)
const SESSION_META_DEBOUNCE_MS = platform() === 'win32' ? 300 : DEBOUNCE_MS;

// ============================================================
// Types
// ============================================================

/**
 * User preferences structure (mirrors UserPreferencesSchema)
 */
export interface UserPreferences {
  name?: string;
  timezone?: string;
  location?: {
    city?: string;
    region?: string;
    country?: string;
  };
  language?: string;
  notes?: string;
  updatedAt?: number;
}

/**
 * Callbacks for config changes
 */
export interface ConfigWatcherCallbacks {
  /** Called when config.json changes */
  onConfigChange?: (config: StoredConfig) => void;
  /** Called when preferences.json changes */
  onPreferencesChange?: (prefs: UserPreferences) => void;
  /** Called when LLM connections array changes (add/remove/update connections) */
  onLlmConnectionsChange?: (connections: import('./storage.ts').LlmConnection[]) => void;

  // Source callbacks
  /** Called when a specific source config changes (null if deleted) */
  onSourceChange?: (slug: string, source: LoadedSource | null) => void;
  /** Called when a source's guide.md changes */
  onSourceGuideChange?: (slug: string, guide: SourceGuide) => void;
  /** Called when the sources list changes (add/remove folders) */
  onSourcesListChange?: (sources: LoadedSource[]) => void;

  // Skill callbacks
  /** Called when the effective Skill catalog may have changed. */
  onSkillsChange?: () => void;

  // Permissions callbacks
  /** Called when app-level default permissions change (~/.craft-agent/permissions/default.json) */
  onDefaultPermissionsChange?: () => void;
  /** Called when workspace permissions.json changes */
  onWorkspacePermissionsChange?: (workspaceId: string) => void;
  /** Called when a source's permissions.json changes */
  onSourcePermissionsChange?: (sourceSlug: string) => void;

  // Status callbacks
  /** Called when statuses config.json changes */
  onStatusConfigChange?: (workspaceId: string) => void;
  /** Called when a status icon file changes */
  onStatusIconChange?: (workspaceId: string, iconFilename: string) => void;

  // Label callbacks
  /** Called when labels config.json changes */
  onLabelConfigChange?: (workspaceId: string) => void;

  // Automations callbacks
  /** Called when automations.json changes */
  onAutomationsConfigChange?: (workspaceId: string) => void;

  // Session callbacks
  /** Called when a session's JSONL header is modified externally (labels, name, flags, etc.) */
  onSessionMetadataChange?: (sessionId: string, header: SessionHeader) => void;

  // Theme callbacks (app-level only)
  /** Called when app-level theme.json changes */
  onAppThemeChange?: (theme: ThemeOverrides | null) => void;
  /** Called when a preset theme file changes (null if deleted) */
  onPresetThemeChange?: (themeId: string, theme: PresetTheme | null) => void;
  /** Called when the preset themes list changes (add/remove files) */
  onPresetThemesListChange?: (themes: PresetTheme[]) => void;

  // Error callbacks
  /** Called when a validation error occurs */
  onValidationError?: (file: string, result: ValidationResult) => void;
  /** Called when an error occurs reading/parsing a file */
  onError?: (file: string, error: Error) => void;
}

// ============================================================
// Preferences Loading
// ============================================================

/**
 * Load preferences from file
 */
export function loadPreferences(): UserPreferences | null {
  if (!existsSync(PREFERENCES_FILE)) {
    return null;
  }

  try {
    return readJsonFileSync<UserPreferences>(PREFERENCES_FILE);
  } catch (error) {
    debug('[ConfigWatcher] Error loading preferences', error);
    return null;
  }
}

// ============================================================
// ConfigWatcher Class
// ============================================================

/**
 * Watches config files and triggers callbacks on changes.
 * Uses recursive directory watching for workspace files.
 */
export class ConfigWatcher {
  private static globalWatchers: FSWatcher[] = [];
  private static globalSubscribers: Set<ConfigWatcher> = new Set();
  private static globalDebounceTimers: Map<string, NodeJS.Timeout> = new Map();
  private static globalStarted = false;

  private workspaceId: string;
  private callbacks: ConfigWatcherCallbacks;
  private watchers: FSWatcher[] = [];
  private debounceTimers: Map<string, NodeJS.Timeout> = new Map();
  private isRunning = false;

  // Track known items for detecting adds/removes
  private knownSources: Set<string> = new Set();
  private knownThemes: Set<string> = new Set();

  // Track LLM connections for change detection (JSON string for deep comparison)
  private lastLlmConnectionsHash: string = '';

  // Computed paths
  private workspaceDir: string;
  private sourcesDir: string;

  constructor(workspaceIdOrPath: string, callbacks: ConfigWatcherCallbacks) {
    this.callbacks = callbacks;
    // Support both workspace ID and workspace root path
    // Paths contain '/' or '\\' (Windows) while IDs don't
    const isPath = workspaceIdOrPath.includes('/') || workspaceIdOrPath.includes('\\');
    if (isPath) {
      this.workspaceDir = expandPath(workspaceIdOrPath);
      // Extract workspace ID from path (last segment) - handle both separators
      this.workspaceId = workspaceIdOrPath.split(/[/\\]/).pop() || workspaceIdOrPath;
    } else {
      this.workspaceId = workspaceIdOrPath;
      this.workspaceDir = getWorkspacePath(workspaceIdOrPath);
    }
    this.sourcesDir = getWorkspaceSourcesPath(this.workspaceDir);
  }

  /**
   * Get the workspace slug this watcher is scoped to
   */
  getWorkspaceSlug(): string {
    return this.workspaceId;
  }

  /**
   * Start watching config files
   */
  start(): void {
    if (this.isRunning) {
      return;
    }

    const span = perf.span('configWatcher.start', { workspaceId: this.workspaceId });

    this.isRunning = true;

    // Detect duplicate recursive watchers on the same directory tree
    const existingOwner = activeWatchers.get(this.workspaceDir);
    if (existingOwner) {
      debug(`[ConfigWatcher] WARNING: duplicate watcher for ${this.workspaceDir} (already owned by: ${existingOwner}, new: ${this.workspaceId})`);
    }
    activeWatchers.set(this.workspaceDir, this.workspaceId);

    debug('[ConfigWatcher] Starting for workspace:', this.workspaceId);

    // Ensure workspace directory exists
    if (!existsSync(this.workspaceDir)) {
      mkdirSync(this.workspaceDir, { recursive: true });
    }
    span.mark('ensureDir');

    // Watch global config files
    ConfigWatcher.addGlobalSubscriber(this);
    span.mark('watchGlobalConfigs');

    // Watch workspace directory recursively
    this.watchWorkspaceDir();
    span.mark('watchWorkspaceDir');

    // Global config/source/skill/theme/permission OS watchers are process-level
    // singletons. This instance only owns the workspace-local recursive watcher.
    span.mark('watchGlobalSourcesDir');
    span.mark('watchGlobalSkillsDir');
    span.mark('watchAppThemesDir');
    span.mark('watchAppPermissionsDir');

    // Initial scan to populate known sources and themes
    this.scanSources();
    span.mark('scanSources');

    this.scanAppThemes();
    span.mark('scanAppThemes');

    // Initialize LLM connections hash for change detection
    this.initLlmConnectionsHash();
    span.mark('initLlmConnectionsHash');

    debug('[ConfigWatcher] Started watching files');
    span.end();
  }

  /**
   * Initialize LLM connections hash for change detection
   */
  private initLlmConnectionsHash(): void {
    const config = loadStoredConfig();
    if (config) {
      const connections = config.llmConnections || [];
      this.lastLlmConnectionsHash = JSON.stringify(connections);
    }
  }

  /**
   * Manually notify the watcher of a file change.
   * Workaround: Bun's fs.watch({ recursive: true }) on Linux doesn't track
   * files in directories created after the watcher started.
   * See: https://github.com/oven-sh/bun/issues/15939
   * See: https://github.com/oven-sh/bun/issues/15085
   * When these are fixed, this method and its call sites can be removed.
   */
  notifyFileChange(relativePath: string): void {
    if (!this.isRunning) return;
    this.handleWorkspaceFileChange(relativePath, 'change');
  }

  /**
   * Stop watching all files
   */
  stop(): void {
    if (!this.isRunning) {
      return;
    }

    this.isRunning = false;
    activeWatchers.delete(this.workspaceDir);
    ConfigWatcher.removeGlobalSubscriber(this);

    // Clear all debounce timers
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();

    // Close all watchers
    for (const watcher of this.watchers) {
      watcher.close();
    }
    this.watchers = [];

    this.knownSources.clear();
    this.knownThemes.clear();

    debug('[ConfigWatcher] Stopped');
  }

  static getGlobalWatcherState(): {
    started: boolean;
    watcherCount: number;
    subscriberCount: number;
  } {
    return {
      started: ConfigWatcher.globalStarted,
      watcherCount: ConfigWatcher.globalWatchers.length,
      subscriberCount: ConfigWatcher.globalSubscribers.size,
    };
  }

  private static addGlobalSubscriber(watcher: ConfigWatcher): void {
    ConfigWatcher.globalSubscribers.add(watcher);
    if (!ConfigWatcher.globalStarted) {
      ConfigWatcher.startGlobalWatchers();
    }
  }

  private static removeGlobalSubscriber(watcher: ConfigWatcher): void {
    ConfigWatcher.globalSubscribers.delete(watcher);
    if (ConfigWatcher.globalSubscribers.size > 0) return;

    for (const timer of ConfigWatcher.globalDebounceTimers.values()) {
      clearTimeout(timer);
    }
    ConfigWatcher.globalDebounceTimers.clear();

    for (const globalWatcher of ConfigWatcher.globalWatchers) {
      globalWatcher.close();
    }
    ConfigWatcher.globalWatchers = [];
    ConfigWatcher.globalStarted = false;
  }

  private static debounceGlobal(key: string, handler: () => void, delayMs: number = DEBOUNCE_MS): void {
    const existing = ConfigWatcher.globalDebounceTimers.get(key);
    if (existing) {
      clearTimeout(existing);
    }

    const timer = setTimeout(() => {
      ConfigWatcher.globalDebounceTimers.delete(key);
      handler();
    }, delayMs);

    ConfigWatcher.globalDebounceTimers.set(key, timer);
  }

  private static forEachGlobalSubscriber(handler: (watcher: ConfigWatcher) => void): void {
    for (const watcher of ConfigWatcher.globalSubscribers) {
      if (watcher.isRunning) {
        handler(watcher);
      }
    }
  }

  private static startGlobalWatchers(): void {
    ConfigWatcher.globalStarted = true;
    ConfigWatcher.watchGlobalConfigsOnce();
    ConfigWatcher.watchGlobalSourcesDirOnce();
    ConfigWatcher.watchGlobalSkillsDirOnce();
    ConfigWatcher.watchAppThemesDirOnce();
    ConfigWatcher.watchAppPermissionsDirOnce();
  }

  private static watchGlobalConfigsOnce(): void {
    if (!existsSync(CONFIG_DIR)) {
      mkdirSync(CONFIG_DIR, { recursive: true });
    }

    try {
      const watcher = watch(CONFIG_DIR, (_eventType, filename) => {
        if (!filename) return;

        if (filename === 'config.json') {
          ConfigWatcher.debounceGlobal('config.json', () => {
            ConfigWatcher.handleGlobalConfigChange();
          });
        } else if (filename === 'preferences.json') {
          ConfigWatcher.debounceGlobal('preferences.json', () => {
            ConfigWatcher.forEachGlobalSubscriber(w => w.handlePreferencesChange());
          });
        } else if (filename === 'theme.json') {
          ConfigWatcher.debounceGlobal('app-theme', () => {
            ConfigWatcher.forEachGlobalSubscriber(w => w.handleAppThemeChange());
          });
        }
      });

      ConfigWatcher.globalWatchers.push(watcher);
      debug('[ConfigWatcher] Watching global configs once:', CONFIG_DIR);
    } catch (error) {
      debug('[ConfigWatcher] Error watching global configs:', error);
    }
  }

  private static watchSourcesDirOnce(
    sourcesDir: string,
    label: string,
    createIfMissing = true,
  ): void {
    if (!existsSync(sourcesDir)) {
      if (!createIfMissing) return;
      mkdirSync(sourcesDir, { recursive: true });
    }

    try {
      const watcher = watch(sourcesDir, { recursive: true }, (_eventType, filename) => {
        if (!filename) return;

        const normalizedPath = filename.replace(/\\/g, '/');
        const parts = normalizedPath.split('/');
        const file = parts[1];

        if (
          parts.length === 1
          || file === 'config.json'
          || file === 'guide.md'
          || (file && /^icon\.(svg|png|jpg|jpeg)$/i.test(file))
        ) {
          ConfigWatcher.debounceGlobal('global-sources', () => {
            ConfigWatcher.forEachGlobalSubscriber(w => w.handleGlobalSourcesChange());
          });
        }
      });

      ConfigWatcher.globalWatchers.push(watcher);
      debug('[ConfigWatcher] Watching global sources once:', label, sourcesDir);
    } catch (error) {
      debug('[ConfigWatcher] Error watching global sources directory:', label, error);
    }
  }

  private static watchGlobalSourcesDirOnce(): void {
    ConfigWatcher.watchSourcesDirOnce(GLOBAL_AGENT_SOURCES_DIR, 'craft');
  }

  private static watchGlobalSkillsDirOnce(): void {
    for (const skillsDir of GLOBAL_AGENT_SKILLS_DIRS) {
      if (!existsSync(skillsDir)) {
        mkdirSync(skillsDir, { recursive: true });
      }

      try {
        const watcher = watch(
          skillsDir,
          { recursive: true },
          (_eventType, filename) => {
            if (!filename) return;

            const normalizedPath = filename.replace(/\\/g, '/');
            const parts = normalizedPath.split('/');
            const file = parts[1];
            if (
              parts.length === 1
              || file === 'SKILL.md'
              || (file && /^icon\.(svg|png|jpg|jpeg)$/i.test(file))
            ) {
              ConfigWatcher.debounceGlobal('global-skills', () => {
                ConfigWatcher.forEachGlobalSubscriber(w => w.handleSkillsChange());
              });
            }
          },
        );

        ConfigWatcher.globalWatchers.push(watcher);
        debug('[ConfigWatcher] Watching global Skills once:', skillsDir);
      } catch (error) {
        debug('[ConfigWatcher] Error watching global Skills directory:', skillsDir, error);
      }
    }
  }

  private static watchAppThemesDirOnce(): void {
    const themesDir = getAppThemesDir();
    if (!existsSync(themesDir)) {
      mkdirSync(themesDir, { recursive: true });
    }

    try {
      const watcher = watch(themesDir, (_eventType, filename) => {
        if (!filename) return;
        if (filename.endsWith('.json')) {
          const themeId = filename.replace('.json', '');
          ConfigWatcher.debounceGlobal(`preset-theme:${themeId}`, () => {
            ConfigWatcher.forEachGlobalSubscriber(w => w.handlePresetThemeChange(themeId));
          });
        }
      });

      ConfigWatcher.globalWatchers.push(watcher);
      debug('[ConfigWatcher] Watching app themes once:', themesDir);
    } catch (error) {
      debug('[ConfigWatcher] Error watching app themes directory:', error);
    }
  }

  private static watchAppPermissionsDirOnce(): void {
    const permissionsDir = getAppPermissionsDir();
    if (!existsSync(permissionsDir)) {
      mkdirSync(permissionsDir, { recursive: true });
    }

    try {
      const watcher = watch(permissionsDir, (_eventType, filename) => {
        if (!filename) return;
        if (filename === 'default.json') {
          ConfigWatcher.debounceGlobal('default-permissions', () => {
            ConfigWatcher.forEachGlobalSubscriber(w => w.handleDefaultPermissionsChange());
          });
        }
      });

      ConfigWatcher.globalWatchers.push(watcher);
      debug('[ConfigWatcher] Watching app permissions once:', permissionsDir);
    } catch (error) {
      debug('[ConfigWatcher] Error watching app permissions directory:', error);
    }
  }

  /**
   * Watch workspace directory recursively
   */
  private watchWorkspaceDir(): void {
    debug('[ConfigWatcher] Setting up workspace watcher for:', this.workspaceDir);
    try {
      const watcher = watch(this.workspaceDir, { recursive: true }, (eventType, filename) => {
        if (!filename) return;

        // Normalize path separators
        const normalizedPath = filename.replace(/\\/g, '/');
        this.handleWorkspaceFileChange(normalizedPath, eventType);
      });

      this.watchers.push(watcher);
      debug('[ConfigWatcher] Watching workspace recursively:', this.workspaceDir);
    } catch (error) {
      debug('[ConfigWatcher] Error watching workspace directory:', error);
    }
  }

  /**
   * Handle global source changes. Global sources are visible from every
   * workspace unless a workspace source overrides the same slug.
   */
  private handleGlobalSourcesChange(): void {
    debug('[ConfigWatcher] Global sources changed');
    const allSources = loadWorkspaceSources(this.workspaceDir);
    this.callbacks.onSourcesListChange?.(allSources);
  }

  /** Invalidate discovery; consumers load the catalog only when they need it. */
  private handleSkillsChange(): void {
    debug('[ConfigWatcher] Skills changed');
    invalidateSkillsCache();
    this.callbacks.onSkillsChange?.();
  }

  /**
   * Handle a file change within the workspace directory
   */
  private handleWorkspaceFileChange(relativePath: string, eventType: string): void {
    const statePrefix = `${WORKSPACE_STATE_DIR}/`;
    const normalizedRelativePath = relativePath.startsWith(statePrefix)
      ? relativePath.slice(statePrefix.length)
      : relativePath;
    const parts = normalizedRelativePath.split('/');

    if (
      (parts[0] === '.pi' || parts[0] === '.agents')
      && parts[1] === 'skills'
    ) {
      this.debounce('project-skills', () => this.handleSkillsChange());
      return;
    }

    // Workspace-level permissions.json
    if (normalizedRelativePath === 'permissions.json') {
      this.debounce('workspace-permissions', () => this.handleWorkspacePermissionsChange());
      return;
    }

    // Workspace-level automations config file
    if (normalizedRelativePath === AUTOMATIONS_CONFIG_FILE) {
      debug('[ConfigWatcher] automations config change detected:', normalizedRelativePath);
      this.debounce('automations-config', () => this.handleAutomationsConfigChange());
      return;
    }

    // Sources changes: sources/{slug}/...
    if (parts[0] === 'sources' && parts.length >= 2) {
      const slug = parts[1]!;  // Safe: checked parts.length >= 2
      const file = parts[2];

      // Directory-level changes (new/removed source folders)
      if (parts.length === 2) {
        this.debounce('sources-dir', () => this.handleSourcesDirChange());
        return;
      }

      // File-level changes
      if (file === 'config.json') {
        this.debounce(`source-config:${slug}`, () => this.handleSourceConfigChange(slug));
      } else if (file === 'guide.md') {
        this.debounce(`source-guide:${slug}`, () => this.handleSourceGuideChange(slug));
      } else if (file === 'permissions.json') {
        this.debounce(`source-permissions:${slug}`, () => this.handleSourcePermissionsChange(slug));
      }
      return;
    }

    // Session metadata changes: sessions/{id}/session.jsonl
    // Detects external modifications (other instances, scripts, manual edits).
    // Only reads line 1 (header) — lightweight even during active streaming.
    if (parts[0] === 'sessions' && parts.length >= 3) {
      const sessionId = parts[1]!;
      const file = parts[2];

      // Only watch actual session files, ignore .tmp (atomic write intermediates)
      if (file === 'session.jsonl') {
        this.debounce(`session-meta:${sessionId}`, () => this.handleSessionMetadataChange(sessionId), SESSION_META_DEBOUNCE_MS);
      }
      return;
    }

    // Statuses changes: statuses/...
    if (parts[0] === 'statuses' && parts.length >= 2) {
      const file = parts[1];

      // config.json change
      if (file === 'config.json') {
        this.debounce('statuses-config', () => this.handleStatusConfigChange());
        return;
      }

      // Icon file changes: statuses/icons/*.svg, *.png, etc.
      if (file === 'icons' && parts.length >= 3) {
        const iconFilename = parts[2];
        if (iconFilename) {
          this.debounce(`statuses-icon:${iconFilename}`, () => {
            this.handleStatusIconChange(iconFilename);
          });
        }
        return;
      }
    }

    // Labels changes: labels/...
    if (parts[0] === 'labels' && parts.length >= 2) {
      const file = parts[1];

      // config.json change
      if (file === 'config.json') {
        this.debounce('labels-config', () => this.handleLabelConfigChange());
        return;
      }

    }
  }

  /**
   * Debounce a handler by key
   */
  private debounce(key: string, handler: () => void, delayMs: number = DEBOUNCE_MS): void {
    const existing = this.debounceTimers.get(key);
    if (existing) {
      clearTimeout(existing);
    }

    const timer = setTimeout(() => {
      this.debounceTimers.delete(key);
      handler();
    }, delayMs);

    this.debounceTimers.set(key, timer);
  }

  // ============================================================
  // Sources Handlers
  // ============================================================

  /**
   * Scan sources directory to populate known sources
   */
  private scanSources(): void {
    if (!existsSync(this.sourcesDir)) {
      mkdirSync(this.sourcesDir, { recursive: true });
      return;
    }

    try {
      const entries = readdirSync(this.sourcesDir);

      for (const entry of entries) {
        const entryPath = join(this.sourcesDir, entry);
        if (statSync(entryPath).isDirectory()) {
          this.knownSources.add(entry);
        }
      }

      debug('[ConfigWatcher] Known sources:', Array.from(this.knownSources));
    } catch (error) {
      debug('[ConfigWatcher] Error scanning sources:', error);
    }
  }

  /**
   * Handle sources directory change (add/remove folders)
   */
  private handleSourcesDirChange(): void {
    debug('[ConfigWatcher] Sources directory changed');

    if (!existsSync(this.sourcesDir)) {
      // Directory was deleted
      const removed = Array.from(this.knownSources);
      this.knownSources.clear();

      for (const slug of removed) {
        this.callbacks.onSourceChange?.(slug, null);
      }

      this.callbacks.onSourcesListChange?.([]);
      return;
    }

    try {
      const entries = readdirSync(this.sourcesDir);
      const currentFolders = new Set<string>();

      for (const entry of entries) {
        const entryPath = join(this.sourcesDir, entry);
        if (statSync(entryPath).isDirectory()) {
          currentFolders.add(entry);
        }
      }

      // Find added folders
      for (const folder of currentFolders) {
        if (!this.knownSources.has(folder)) {
          debug('[ConfigWatcher] New source folder:', folder);
          this.knownSources.add(folder);

          const source = loadSource(this.workspaceDir, folder);
          if (source) {
            this.callbacks.onSourceChange?.(folder, source);
          }
        }
      }

      // Find removed folders
      for (const folder of this.knownSources) {
        if (!currentFolders.has(folder)) {
          debug('[ConfigWatcher] Removed source folder:', folder);
          this.knownSources.delete(folder);
          this.callbacks.onSourceChange?.(folder, null);
        }
      }

      // Notify list change
      const allSources = loadWorkspaceSources(this.workspaceDir);
      this.callbacks.onSourcesListChange?.(allSources);
    } catch (error) {
      debug('[ConfigWatcher] Error handling sources dir change:', error);
      this.callbacks.onError?.('sources/', error as Error);
    }
  }

  /**
   * Handle source config.json change
   * Downloads icon if URL specified and no local icon exists
   */
  private handleSourceConfigChange(slug: string): void {
    debug('[ConfigWatcher] Source config changed:', slug);

    const validation = validateSource(this.workspaceDir, slug);
    if (!validation.valid) {
      debug('[ConfigWatcher] Source validation failed:', slug, validation.errors);
      this.callbacks.onValidationError?.(`sources/${slug}/config.json`, validation);
      return;
    }

    const source = loadSource(this.workspaceDir, slug);

    // Check if icon needs to be downloaded (URL in config, no local file)
    if (source && sourceNeedsIconDownload(this.workspaceDir, slug, source.config)) {
      debug('[ConfigWatcher] Downloading source icon:', slug);
      downloadSourceIcon(this.workspaceDir, slug, source.config.icon!)
        .then((iconPath) => {
          if (iconPath) {
            debug('[ConfigWatcher] Source icon downloaded:', slug, iconPath);
            // Re-emit source change with updated icon path
            const updatedSource = loadSource(this.workspaceDir, slug);
            this.callbacks.onSourceChange?.(slug, updatedSource);
          }
        })
        .catch((err) => {
          debug('[ConfigWatcher] Source icon download failed:', slug, err);
        });
    }

    this.callbacks.onSourceChange?.(slug, source);
  }

  /**
   * Handle source guide.md change
   */
  private handleSourceGuideChange(slug: string): void {
    debug('[ConfigWatcher] Source guide changed:', slug);

    const guide = loadSourceGuide(this.workspaceDir, slug);
    if (guide) {
      this.callbacks.onSourceGuideChange?.(slug, guide);
    }

    // Also emit full source change
    const source = loadSource(this.workspaceDir, slug);
    if (source) {
      this.callbacks.onSourceChange?.(slug, source);
    }
  }

  /**
   * Handle source permissions.json change
   */
  private handleSourcePermissionsChange(slug: string): void {
    debug('[ConfigWatcher] Source permissions.json changed:', slug);

    // Invalidate cache
    permissionsConfigCache.invalidateSource(this.workspaceDir, slug);

    // Notify callback
    this.callbacks.onSourcePermissionsChange?.(slug);
  }

  // ============================================================
  // Safe Mode & Config Handlers
  // ============================================================

  private static handleGlobalConfigChange(): void {
    debug('[ConfigWatcher] config.json changed');

    const validation = validateConfig();
    if (!validation.valid) {
      debug('[ConfigWatcher] Config validation failed:', validation.errors);
      ConfigWatcher.forEachGlobalSubscriber(w => (
        w.callbacks.onValidationError?.('config.json', validation)
      ));
      return;
    }

    const config = loadStoredConfig();
    if (!config) {
      ConfigWatcher.forEachGlobalSubscriber(w => (
        w.callbacks.onError?.('config.json', new Error('Failed to load config'))
      ));
      return;
    }

    ConfigWatcher.forEachGlobalSubscriber(w => w.handleConfigChange(config));
  }

  /**
   * Handle workspace permissions.json change
   */
  private handleWorkspacePermissionsChange(): void {
    debug('[ConfigWatcher] Workspace permissions.json changed:', this.workspaceId);

    // Invalidate cache
    permissionsConfigCache.invalidateWorkspace(this.workspaceDir);

    // Notify callback
    this.callbacks.onWorkspacePermissionsChange?.(this.workspaceId);
  }

  /**
   * Handle config.json change
   */
  private handleConfigChange(config: StoredConfig): void {
    this.callbacks.onConfigChange?.(config);

    // Check for LLM connections changes
    // Use JSON hash comparison for deep equality check
    const connections = config.llmConnections || [];
    const currentHash = JSON.stringify(connections);
    if (currentHash !== this.lastLlmConnectionsHash) {
      this.lastLlmConnectionsHash = currentHash;
      this.callbacks.onLlmConnectionsChange?.(connections);
    }
  }

  /**
   * Handle preferences.json change
   */
  private handlePreferencesChange(): void {
    debug('[ConfigWatcher] preferences.json changed');

    const validation = validatePreferences();
    if (!validation.valid) {
      debug('[ConfigWatcher] Preferences validation failed:', validation.errors);
      this.callbacks.onValidationError?.('preferences.json', validation);
      return;
    }

    const prefs = loadPreferences();
    if (prefs) {
      this.callbacks.onPreferencesChange?.(prefs);
    }
  }

  // ============================================================
  // Statuses Handlers
  // ============================================================

  /**
   * Handle statuses config.json change
   * Downloads icons for any status with URL icon and no local file
   */
  private handleStatusConfigChange(): void {
    debug('[ConfigWatcher] Statuses config.json changed:', this.workspaceId);

    // Load config and check for icons that need downloading
    const config = loadStatusConfig(this.workspaceDir);
    for (const status of config.statuses) {
      if (statusNeedsIconDownload(this.workspaceDir, status)) {
        debug('[ConfigWatcher] Downloading status icon:', status.id);
        downloadStatusIcon(this.workspaceDir, status.id, status.icon!)
          .then((iconPath) => {
            if (iconPath) {
              debug('[ConfigWatcher] Status icon downloaded:', status.id, iconPath);
              // Re-emit config change to update UI with new icon
              this.callbacks.onStatusConfigChange?.(this.workspaceId);
            }
          })
          .catch((err) => {
            debug('[ConfigWatcher] Status icon download failed:', status.id, err);
          });
      }
    }

    this.callbacks.onStatusConfigChange?.(this.workspaceId);
  }

  /**
   * Handle status icon file change
   */
  private handleStatusIconChange(iconFilename: string): void {
    debug('[ConfigWatcher] Status icon changed:', this.workspaceId, iconFilename);
    this.callbacks.onStatusIconChange?.(this.workspaceId, iconFilename);
  }

  // ============================================================
  // Labels Handlers
  // ============================================================

  /**
   * Handle labels config.json change.
   */
  private handleLabelConfigChange(): void {
    debug('[ConfigWatcher] Labels config.json changed:', this.workspaceId);
    this.callbacks.onLabelConfigChange?.(this.workspaceId);
  }

  /**
   * Handle automations config change.
   */
  private handleAutomationsConfigChange(): void {
    debug('[ConfigWatcher] automations config changed:', this.workspaceId);
    this.callbacks.onAutomationsConfigChange?.(this.workspaceId);
  }

  // ============================================================
  // Session Metadata Handlers
  // ============================================================

  /**
   * Handle session.jsonl change — reads only line 1 (header) and emits if valid.
   * This enables detection of external metadata changes (labels, name, flags)
   * made by other instances, scripts, or manual edits.
   */
  private handleSessionMetadataChange(sessionId: string): void {
    const sessionFile = getSessionFilePath(this.workspaceDir, sessionId);

    if (!existsSync(sessionFile)) {
      return;
    }

    const header = readSessionHeader(sessionFile);
    if (header) {
      this.callbacks.onSessionMetadataChange?.(sessionId, header);
    }
  }

  // ============================================================
  // Theme Handlers (App-Level)
  // ============================================================

  /**
   * Handle app-level theme.json change
   */
  private handleAppThemeChange(): void {
    debug('[ConfigWatcher] App theme.json changed');
    const theme = loadAppTheme();
    this.callbacks.onAppThemeChange?.(theme);
  }

  /**
   * Handle default.json permissions change (app-level)
   */
  private handleDefaultPermissionsChange(): void {
    debug('[ConfigWatcher] Default permissions changed');

    // Invalidate the cache so next getMergedConfig() reloads from file
    permissionsConfigCache.invalidateDefaults();

    // Notify callback
    this.callbacks.onDefaultPermissionsChange?.();
  }

  /**
   * Scan app-level themes directory to populate known themes
   */
  private scanAppThemes(): void {
    const themesDir = getAppThemesDir();

    if (!existsSync(themesDir)) {
      return;
    }

    try {
      const files = readdirSync(themesDir).filter(f => f.endsWith('.json'));

      for (const file of files) {
        const themeId = file.replace('.json', '');
        this.knownThemes.add(themeId);
      }

      debug('[ConfigWatcher] Known themes:', Array.from(this.knownThemes));
    } catch (error) {
      debug('[ConfigWatcher] Error scanning themes:', error);
    }
  }

  /**
   * Handle preset theme file change (app-level)
   */
  private handlePresetThemeChange(themeId: string): void {
    debug('[ConfigWatcher] Preset theme changed:', themeId);

    const themesDir = getAppThemesDir();
    const themePath = join(themesDir, `${themeId}.json`);

    if (!existsSync(themePath)) {
      // Theme was deleted
      if (this.knownThemes.has(themeId)) {
        this.knownThemes.delete(themeId);
        this.callbacks.onPresetThemeChange?.(themeId, null);

        // Also notify list change
        const allThemes = loadPresetThemes();
        this.callbacks.onPresetThemesListChange?.(allThemes);
      }
      return;
    }

    // Theme was added or modified
    if (!this.knownThemes.has(themeId)) {
      this.knownThemes.add(themeId);
    }

    const theme = loadPresetTheme(themeId);
    this.callbacks.onPresetThemeChange?.(themeId, theme);

    // Also notify list change in case name changed (affects sorting)
    const allThemes = loadPresetThemes();
    this.callbacks.onPresetThemesListChange?.(allThemes);
  }
}

// ============================================================
// Factory Function
// ============================================================

/**
 * Create and start a config watcher for a specific workspace.
 * Returns the watcher instance for later cleanup.
 */
export function createConfigWatcher(
  workspaceId: string,
  callbacks: ConfigWatcherCallbacks
): ConfigWatcher {
  const watcher = new ConfigWatcher(workspaceId, callbacks);
  watcher.start();
  return watcher;
}
