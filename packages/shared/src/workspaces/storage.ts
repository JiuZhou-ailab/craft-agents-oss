/**
 * Workspace Storage
 *
 * input: Workspace folders, global defaults, and persisted workspace config files
 * output: Workspace configuration persistence, creation, and legacy-state migration
 * pos: Shared filesystem-backed workspace storage layer
 *
 * Filesystem persistence for workspaces.
 * Workspaces can be stored anywhere on disk via rootPath.
 * Default location: ~/.craft-agent/workspaces/
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from 'fs';
import { dirname, isAbsolute, join, relative } from 'path';
import { homedir } from 'os';
import { randomUUID } from 'crypto';
import { expandPath, toPortablePath } from '../utils/paths.ts';
import { atomicWriteFileSync, readJsonFileSync } from '../utils/files.ts';
import { getDefaultStatusConfig, saveStatusConfig, ensureDefaultIconFiles } from '../statuses/storage.ts';
import { getDefaultLabelConfig, saveLabelConfig } from '../labels/storage.ts';
import { loadConfigDefaults } from '../config/storage.ts';
import { parsePermissionMode, PERMISSION_MODE_ORDER } from '../agent/mode-types.ts';
import { normalizeThinkingLevel } from '../agent/thinking-levels.ts';
import { detectWritingProject } from '../writing/manifest.ts';
import type {
  WorkspaceConfig,
  LoadedWorkspace,
} from './types.ts';
import {
  getExistingWorkspaceConfigPath,
  getExistingWorkspaceSessionsPath,
  getExistingWorkspaceSourcesPath,
  getLegacyWorkspaceConfigPath,
  getWorkspaceConfigPath,
  getWorkspaceAgentsPath,
  getWorkspaceClaudePath,
  getWorkspaceLabelConfigPath,
  getWorkspaceLabelsPath,
  getWorkspaceNoticePath,
  getWorkspacePackLockPath,
  getWorkspaceReadmePath,
  getWorkspaceSessionsPath,
  getWorkspaceSourcesPath,
  getWorkspaceStatePath,
  getWorkspaceStatusConfigPath,
  getWorkspaceStatusIconsPath,
  getWorkspaceViewsPath,
  getWorkspaceWritingManifestPath,
  assertSymlinkFreeTree,
  ensureProjectOwnedDirectory,
  resolveProjectOwnedFilePath,
  resolveProjectOwnedPath,
} from './paths.ts';

export {
  WORKSPACE_STATE_DIR,
  getExistingWorkspaceConfigPath,
  getExistingWorkspaceLabelConfigPath,
  getExistingWorkspaceSessionsPath,
  getExistingWorkspaceSourcesPath,
  getExistingWorkspaceStatusConfigPath,
  getExistingWorkspaceStatusIconsPath,
  getExistingWorkspaceViewsPath,
  getExistingWorkspaceWritingManifestPath,
  getLegacyCraftWorkspaceSkillsPath,
  getLegacyWorkspaceConfigPath,
  getLegacyWorkspaceLabelConfigPath,
  getLegacyWorkspaceSessionsPath,
  getLegacyWorkspaceSkillsPath,
  getLegacyWorkspaceSourcesPath,
  getLegacyWorkspaceStatusConfigPath,
  getLegacyWorkspaceStatusIconsPath,
  getLegacyWorkspaceViewsPath,
  getLegacyWorkspaceWritingManifestPath,
  getWorkspaceAgentsPath,
  getWorkspaceClaudePath,
  getWorkspaceConfigPath,
  getWorkspaceLabelConfigPath,
  getWorkspaceLabelsPath,
  getWorkspaceNoticePath,
  getWorkspacePackLockPath,
  getWorkspaceReadmePath,
  getWorkspaceSessionsPath,
  getWorkspaceSkillsPath,
  getWorkspaceSourcesPath,
  getWorkspaceStatePath,
  getWorkspaceStateRelativePath,
  getWorkspaceStatusConfigPath,
  getWorkspaceStatusIconsPath,
  getWorkspaceStatusesPath,
  getWorkspaceViewsPath,
  getWorkspaceWritingManifestPath,
} from './paths.ts';

const CONFIG_DIR = join(homedir(), '.craft-agent');
const DEFAULT_WORKSPACES_DIR = join(CONFIG_DIR, 'workspaces');

// ============================================================
// Path Utilities
// ============================================================

/**
 * Get the default workspaces directory (~/.craft-agent/workspaces/)
 */
export function getDefaultWorkspacesDir(): string {
  return DEFAULT_WORKSPACES_DIR;
}

/**
 * Ensure default workspaces directory exists
 */
export function ensureDefaultWorkspacesDir(): void {
  if (!existsSync(DEFAULT_WORKSPACES_DIR)) {
    mkdirSync(DEFAULT_WORKSPACES_DIR, { recursive: true });
  }
}

/**
 * Get workspace root path from ID
 * @param workspaceId - Workspace ID
 * @returns Absolute path to workspace root in default location
 */
export function getWorkspacePath(workspaceId: string): string {
  return join(DEFAULT_WORKSPACES_DIR, workspaceId);
}

// ============================================================
// Config Operations
// ============================================================

function isWorkspaceConfigLike(value: unknown): value is WorkspaceConfig {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<WorkspaceConfig>;
  return (
    typeof candidate.id === 'string'
    && typeof candidate.name === 'string'
    && typeof candidate.slug === 'string'
    && typeof candidate.createdAt === 'number'
  );
}

function hasLegacyWorkspaceConfig(rootPath: string): boolean {
  const legacyConfigPath = getLegacyWorkspaceConfigPath(rootPath);
  if (!existsSync(legacyConfigPath)) return false;

  try {
    resolveProjectOwnedPath(rootPath, legacyConfigPath);
    return isWorkspaceConfigLike(JSON.parse(readFileSync(legacyConfigPath, 'utf-8')));
  } catch {
    return false;
  }
}

function hasLegacyWritingManifest(rootPath: string): boolean {
  const manifestPath = join(rootPath, 'craft-writing.json');
  if (!existsSync(manifestPath)) return false;

  try {
    resolveProjectOwnedPath(rootPath, manifestPath);
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as Record<string, unknown>;
    return manifest.schemaVersion === 1 && typeof manifest.type === 'string';
  } catch {
    return false;
  }
}

function filesMatch(leftPath: string, rightPath: string): boolean {
  try {
    const left = statSync(leftPath);
    const right = statSync(rightPath);
    return left.isFile() && right.isFile() && readFileSync(leftPath).equals(readFileSync(rightPath));
  } catch {
    return false;
  }
}

function isDirectoryPath(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function uniqueLegacyStatePath(rootPath: string, name: string): string {
  const parsed = name.match(/^(.*?)(\.[^.]*)?$/);
  const stem = parsed?.[1] || name;
  const ext = parsed?.[2] || '';
  let candidate = join(getWorkspaceStatePath(rootPath), 'legacy-root', name);
  let counter = 2;

  while (existsSync(candidate)) {
    candidate = join(getWorkspaceStatePath(rootPath), 'legacy-root', `${stem}-${counter++}${ext}`);
  }
  return candidate;
}

export function getLegacyConflictRelativePath(
  rootPath: string,
  sourcePath: string,
  pathApi: {
    relative(from: string, to: string): string;
    isAbsolute(path: string): boolean;
  } = { relative, isAbsolute },
): string {
  const candidate = pathApi.relative(rootPath, sourcePath);
  if (!candidate || /^\.\.(?:[\\/]|$)/.test(candidate) || pathApi.isAbsolute(candidate)) {
    throw new Error(`Legacy conflict path is outside the Project: ${sourcePath}`);
  }
  return candidate;
}

function moveLegacyWorkspaceConflict(rootPath: string, sourcePath: string): void {
  const relativePath = getLegacyConflictRelativePath(rootPath, sourcePath);
  ensureProjectOwnedDirectory(rootPath, join(getWorkspaceStatePath(rootPath), 'legacy-root'));
  const fallbackPath = uniqueLegacyStatePath(rootPath, relativePath);
  ensureProjectOwnedDirectory(rootPath, dirname(fallbackPath));
  resolveProjectOwnedFilePath(rootPath, fallbackPath);
  renameSync(sourcePath, fallbackPath);
}

function assertLegacyWorkspaceMigrationSafe(
  rootPath: string,
  moves: ReadonlyArray<readonly [string, string]>,
): void {
  const paths = new Set([
    ...moves.flat(),
    join(getWorkspaceStatePath(rootPath), 'legacy-root'),
  ]);
  for (const path of paths) {
    resolveProjectOwnedFilePath(rootPath, path);
    if (existsSync(path)) assertSymlinkFreeTree(resolveProjectOwnedPath(rootPath, path));
  }
}

function mergeLegacyDirectory(rootPath: string, sourceDir: string, targetDir: string): void {
  sourceDir = resolveProjectOwnedPath(rootPath, sourceDir);
  targetDir = ensureProjectOwnedDirectory(rootPath, targetDir);

  for (const entry of readdirSync(sourceDir, { withFileTypes: true })) {
    const sourcePath = resolveProjectOwnedPath(rootPath, join(sourceDir, entry.name));
    const targetCandidate = join(targetDir, entry.name);
    const targetPath = existsSync(targetCandidate)
      ? resolveProjectOwnedPath(rootPath, targetCandidate)
      : targetCandidate;

    if (!existsSync(targetPath)) {
      renameSync(sourcePath, targetPath);
      continue;
    }

    if (entry.isDirectory() && isDirectoryPath(targetPath)) {
      mergeLegacyDirectory(rootPath, sourcePath, targetPath);
      rmSync(sourcePath, { recursive: true, force: true });
      continue;
    }

    if (entry.isFile() && filesMatch(sourcePath, targetPath)) {
      rmSync(sourcePath, { recursive: true, force: true });
      continue;
    }

    moveLegacyWorkspaceConflict(rootPath, sourcePath);
  }
}

function moveLegacyWorkspaceStatePath(rootPath: string, sourcePath: string, targetPath: string): void {
  if (!existsSync(sourcePath)) return;
  sourcePath = resolveProjectOwnedPath(rootPath, sourcePath);
  if (existsSync(targetPath)) targetPath = resolveProjectOwnedPath(rootPath, targetPath);
  else ensureProjectOwnedDirectory(rootPath, dirname(targetPath));

  if (existsSync(targetPath)) {
    if (isDirectoryPath(sourcePath) && isDirectoryPath(targetPath)) {
      mergeLegacyDirectory(rootPath, sourcePath, targetPath);
      rmSync(sourcePath, { recursive: true, force: true });
      return;
    }
    if (filesMatch(sourcePath, targetPath)) {
      rmSync(sourcePath, { recursive: true, force: true });
      return;
    }
    moveLegacyWorkspaceConflict(rootPath, sourcePath);
    return;
  }

  renameSync(sourcePath, targetPath);
}

function restoreMergeableLegacyRootState(rootPath: string): void {
  const legacyRoot = join(getWorkspaceStatePath(rootPath), 'legacy-root');
  if (!existsSync(legacyRoot)) return;

  for (const [source, target] of [
    ['sessions', getWorkspaceSessionsPath(rootPath)],
    ['sources', getWorkspaceSourcesPath(rootPath)],
  ] as const) {
    const sourcePath = join(legacyRoot, source);
    if (!existsSync(sourcePath)) continue;
    mergeLegacyDirectory(rootPath, sourcePath, target);
    rmSync(sourcePath, { recursive: true, force: true });
  }

  try {
    if (readdirSync(legacyRoot).length === 0) {
      rmSync(legacyRoot, { recursive: true, force: true });
    }
  } catch {
    // ignore best-effort cleanup
  }
}

function migrateLegacyWorkspaceState(rootPath: string): void {
  const hasLegacyConfig = hasLegacyWorkspaceConfig(rootPath);
  const hasWritingManifest = hasLegacyConfig && hasLegacyWritingManifest(rootPath);
  const configMove = hasLegacyConfig
    ? [join(rootPath, 'config.json'), getWorkspaceConfigPath(rootPath)] as const
    : null;
  const configMoves: Array<readonly [string, string]> = hasLegacyConfig
    ? [
        [join(rootPath, 'sources'), getWorkspaceSourcesPath(rootPath)],
        [join(rootPath, 'sessions'), getWorkspaceSessionsPath(rootPath)],
        [join(rootPath, 'labels'), getWorkspaceLabelsPath(rootPath)],
        [join(rootPath, 'statuses/config.json'), getWorkspaceStatusConfigPath(rootPath)],
        [join(rootPath, 'statuses/icons'), getWorkspaceStatusIconsPath(rootPath)],
        [join(rootPath, 'views.json'), getWorkspaceViewsPath(rootPath)],
      ]
    : [];
  const writingMoves: Array<readonly [string, string]> = hasWritingManifest
    ? [
        [join(rootPath, 'craft-writing.json'), getWorkspaceWritingManifestPath(rootPath)],
        [join(rootPath, 'craft-pack-lock.json'), getWorkspacePackLockPath(rootPath)],
        [join(rootPath, 'AGENTS.md'), getWorkspaceAgentsPath(rootPath)],
        [join(rootPath, 'CLAUDE.md'), getWorkspaceClaudePath(rootPath)],
        [join(rootPath, 'README.md'), getWorkspaceReadmePath(rootPath)],
      ]
    : [];
  if (hasWritingManifest) {
    for (const entry of readdirSync(rootPath, { withFileTypes: true })) {
      if (entry.isFile() && /^NOTICE-.+\.md$/.test(entry.name)) {
        writingMoves.push([join(rootPath, entry.name), getWorkspaceNoticePath(rootPath, entry.name)]);
      }
    }
  }
  const legacyRoot = join(getWorkspaceStatePath(rootPath), 'legacy-root');
  const restoreMoves = [
    [join(legacyRoot, 'sessions'), getWorkspaceSessionsPath(rootPath)],
    [join(legacyRoot, 'sources'), getWorkspaceSourcesPath(rootPath)],
  ] as const;

  assertLegacyWorkspaceMigrationSafe(rootPath, [
    ...configMoves,
    ...writingMoves,
    ...restoreMoves,
    ...(configMove ? [configMove] : []),
  ]);
  if (!hasLegacyConfig && !hasWritingManifest) {
    restoreMergeableLegacyRootState(rootPath);
    return;
  }

  ensureProjectOwnedDirectory(rootPath, getWorkspaceStatePath(rootPath));

  if (hasLegacyConfig) {
    for (const [source, target] of configMoves) moveLegacyWorkspaceStatePath(rootPath, source, target);

    try {
      if (existsSync(join(rootPath, 'statuses')) && readdirSync(join(rootPath, 'statuses')).length === 0) {
        rmSync(join(rootPath, 'statuses'), { recursive: true, force: true });
      }
    } catch {
      // ignore best-effort cleanup
    }
  }

  if (hasWritingManifest) {
    for (const [source, target] of writingMoves) moveLegacyWorkspaceStatePath(rootPath, source, target);
  }

  restoreMergeableLegacyRootState(rootPath);
  if (configMove) moveLegacyWorkspaceStatePath(rootPath, configMove[0], configMove[1]);
}

/**
 * Load workspace config.json from a workspace folder
 * @param rootPath - Absolute path to workspace root folder
 */
function readWorkspaceConfig(rootPath: string): WorkspaceConfig | null {
  const configPath = getExistingWorkspaceConfigPath(rootPath);
  if (!existsSync(configPath)) return null;

  try {
    resolveProjectOwnedPath(rootPath, configPath);
    const config = readJsonFileSync<WorkspaceConfig>(configPath);
    if (!isWorkspaceConfigLike(config)) return null;
    // Expand path variables in defaults for portability
    if (config.defaults?.workingDirectory) {
      config.defaults.workingDirectory = expandPath(config.defaults.workingDirectory);
    }

    // Compatibility: accept canonical or legacy permission mode names on read
    if (config.defaults?.permissionMode && typeof config.defaults.permissionMode === 'string') {
      const parsed = parsePermissionMode(config.defaults.permissionMode);
      config.defaults.permissionMode = parsed === 'safe' ? 'ask' : parsed ?? undefined;
    }

    if (Array.isArray(config.defaults?.cyclablePermissionModes)) {
      const normalized = config.defaults.cyclablePermissionModes
        .map(mode => (typeof mode === 'string' ? parsePermissionMode(mode) : null))
        .filter((mode): mode is NonNullable<typeof mode> => !!mode)
        .filter(mode => PERMISSION_MODE_ORDER.includes(mode))
        .filter((mode, index, arr) => arr.indexOf(mode) === index);

      config.defaults.cyclablePermissionModes = normalized.length >= 2
        ? normalized
        : [...PERMISSION_MODE_ORDER];
    }

    if (config.defaults && 'thinkingLevel' in config.defaults) {
      // TODO: Remove legacy 'think' normalization after old persisted workspace configs
      // have realistically aged out across upgrades.
      config.defaults.thinkingLevel = normalizeThinkingLevel(config.defaults.thinkingLevel);
    }

    const writingProject = detectWritingProject(rootPath);
    if (!config.defaults?.workingDirectory && writingProject && writingProject.type !== 'screenplay') {
      config.defaults = {
        ...config.defaults,
        workingDirectory: rootPath,
      };
    }

    return config;
  } catch {
    return null;
  }
}

/** Read Project metadata without performing legacy-state migration. */
export function inspectWorkspaceConfig(rootPath: string): WorkspaceConfig | null {
  return readWorkspaceConfig(rootPath);
}

/** Read only canonical hidden Project state; ordinary root files are not Project metadata. */
export function inspectWorkspaceStateConfig(rootPath: string): WorkspaceConfig | null {
  const legacyConfigPath = getLegacyWorkspaceConfigPath(rootPath);
  const canonicalConfigPath = getWorkspaceConfigPath(rootPath);
  if (!existsSync(canonicalConfigPath)) return null;
  if (canonicalConfigPath === legacyConfigPath) return readWorkspaceConfig(rootPath);

  try {
    resolveProjectOwnedPath(rootPath, canonicalConfigPath);
    const config = readJsonFileSync<WorkspaceConfig>(canonicalConfigPath);
    return isWorkspaceConfigLike(config) ? config : null;
  } catch {
    return null;
  }
}

export function loadWorkspaceConfig(rootPath: string): WorkspaceConfig | null {
  try {
    const statePath = getWorkspaceStatePath(rootPath);
    if (existsSync(statePath)) resolveProjectOwnedPath(rootPath, statePath);
    // Legacy migration is only eligible before canonical Project state exists.
    // A newly registered ordinary directory may legitimately contain root-level
    // config.json/sources/sessions that Storyflow must never claim or move.
    if (!existsSync(getWorkspaceConfigPath(rootPath))) migrateLegacyWorkspaceState(rootPath);
    return readWorkspaceConfig(rootPath);
  } catch {
    return null;
  }
}

/**
 * Save workspace config.json to a workspace folder
 * @param rootPath - Absolute path to workspace root folder
 */
export function saveWorkspaceConfig(rootPath: string, config: WorkspaceConfig): void {
  // Convert paths to portable form for cross-machine compatibility
  const storageConfig: WorkspaceConfig = {
    ...config,
    updatedAt: Date.now(),
  };

  if (storageConfig.defaults?.workingDirectory) {
    storageConfig.defaults = {
      ...storageConfig.defaults,
      workingDirectory: toPortablePath(storageConfig.defaults.workingDirectory),
    };
  }

  // Use atomic write to prevent corruption on crash/interrupt
  const configPath = getWorkspaceConfigPath(rootPath);
  ensureProjectOwnedDirectory(rootPath, dirname(configPath));
  atomicWriteFileSync(configPath, JSON.stringify(storageConfig, null, 2));
}

// ============================================================
// Load Operations
// ============================================================

/**
 * Count subdirectories in a path
 */
function countSubdirs(dirPath: string): number {
  if (!existsSync(dirPath)) return 0;
  try {
    return readdirSync(dirPath, { withFileTypes: true }).filter((d) => d.isDirectory()).length;
  } catch {
    return 0;
  }
}

/**
 * List subdirectory names in a path
 */
function listSubdirNames(dirPath: string): string[] {
  if (!existsSync(dirPath)) return [];
  try {
    return readdirSync(dirPath, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [];
  }
}

/**
 * Load workspace with summary info from a rootPath
 * @param rootPath - Absolute path to workspace root folder
 */
export function loadWorkspace(rootPath: string): LoadedWorkspace | null {
  const config = loadWorkspaceConfig(rootPath);
  if (!config) return null;

  return {
    config,
    sourceSlugs: listSubdirNames(getExistingWorkspaceSourcesPath(rootPath)),
    sessionCount: countSubdirs(getExistingWorkspaceSessionsPath(rootPath)),
  };
}

// ============================================================
// Creation and Validation
// ============================================================

/**
 * Generate URL-safe slug from name
 */
export function generateSlug(name: string): string {
  const trimmed = name.trim();
  let slug = trimmed
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .substring(0, 50);

  if (!slug) {
    let hash = 0x811c9dc5;
    for (const char of trimmed) {
      hash ^= char.codePointAt(0) ?? 0;
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    slug = trimmed ? `workspace-${hash.toString(36)}` : 'workspace';
  }

  return slug;
}

/**
 * Create workspace folder structure at a given path
 * @param rootPath - Absolute path where workspace folder will be created
 * @param name - Display name for the workspace
 * @param defaults - Optional default settings for new sessions
 * @returns The created WorkspaceConfig
 */
export function createWorkspaceAtPath(
  rootPath: string,
  name: string,
  defaults?: WorkspaceConfig['defaults']
): WorkspaceConfig {
  const now = Date.now();
  const slug = generateSlug(name);

  // Load global defaults from config-defaults.json
  const globalDefaults = loadConfigDefaults();

  // Merge global defaults with provided defaults
  // AI settings (model, thinkingLevel, defaultLlmConnection) are left undefined
  // so they fall back to app-level defaults
  const workspaceDefaults: WorkspaceConfig['defaults'] = {
    model: undefined,
    thinkingLevel: undefined,
    // defaultLlmConnection: undefined - falls back to app default
    permissionMode: globalDefaults.workspaceDefaults.permissionMode,
    cyclablePermissionModes: globalDefaults.workspaceDefaults.cyclablePermissionModes,
    enabledSourceSlugs: [],
    workingDirectory: rootPath,
    ...defaults, // User-provided defaults override global defaults
  };

  const config: WorkspaceConfig = {
    id: `ws_${randomUUID().slice(0, 8)}`,
    name,
    slug,
    defaults: workspaceDefaults,
    localMcpServers: globalDefaults.workspaceDefaults.localMcpServers,
    createdAt: now,
    updatedAt: now,
  };

  // Create workspace directory structure
  mkdirSync(rootPath, { recursive: true });
  const statusDir = dirname(getWorkspaceStatusConfigPath(rootPath));
  for (const targetPath of [
    getWorkspaceStatePath(rootPath),
    getWorkspaceConfigPath(rootPath),
    getWorkspaceSourcesPath(rootPath),
    getWorkspaceSessionsPath(rootPath),
    statusDir,
    getWorkspaceStatusConfigPath(rootPath),
    getWorkspaceStatusIconsPath(rootPath),
    getWorkspaceLabelsPath(rootPath),
    getWorkspaceLabelConfigPath(rootPath),
  ]) {
    resolveProjectOwnedFilePath(rootPath, targetPath);
  }
  for (const targetDir of [statusDir, getWorkspaceLabelsPath(rootPath)]) {
    if (existsSync(targetDir)) assertSymlinkFreeTree(resolveProjectOwnedPath(rootPath, targetDir));
  }
  ensureProjectOwnedDirectory(rootPath, getWorkspaceStatePath(rootPath));
  ensureProjectOwnedDirectory(rootPath, getWorkspaceSourcesPath(rootPath));
  ensureProjectOwnedDirectory(rootPath, getWorkspaceSessionsPath(rootPath));

  // Initialize status configuration with defaults
  saveStatusConfig(rootPath, getDefaultStatusConfig());
  ensureDefaultIconFiles(rootPath);

  // Initialize label configuration with defaults (two nested groups + valued labels)
  saveLabelConfig(rootPath, getDefaultLabelConfig());

  // The canonical config is the initialization commit marker, so write it last.
  saveWorkspaceConfig(rootPath, config);

  return config;
}

/**
 * Check if a valid workspace exists at a path
 * @param rootPath - Absolute path to check
 */
export function isValidWorkspace(rootPath: string): boolean {
  return inspectWorkspaceConfig(rootPath) !== null;
}

// ============================================================
// Workspace Color Theme
// ============================================================

/**
 * Get the color theme setting for a workspace.
 * Returns undefined if workspace uses the app default.
 *
 * @param rootPath - Absolute path to workspace root folder
 * @returns Theme ID or undefined (inherit from app default)
 */
export function getWorkspaceColorTheme(rootPath: string): string | undefined {
  const config = loadWorkspaceConfig(rootPath);
  return config?.defaults?.colorTheme;
}

/**
 * Set the color theme for a workspace.
 * Pass undefined to clear and use app default.
 *
 * @param rootPath - Absolute path to workspace root folder
 * @param themeId - Preset theme ID or undefined to inherit
 */
export function setWorkspaceColorTheme(rootPath: string, themeId: string | undefined): void {
  const config = loadWorkspaceConfig(rootPath);
  if (!config) return;

  // Validate theme ID if provided (skip for undefined = inherit default)
  // Only allow alphanumeric characters, hyphens, and underscores (max 64 chars)
  if (themeId && themeId !== 'default') {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(themeId)) {
      console.warn(`[workspace-storage] Invalid theme ID rejected: ${themeId}`);
      return;
    }
  }

  // Initialize defaults if not present
  if (!config.defaults) {
    config.defaults = {};
  }

  if (themeId) {
    config.defaults.colorTheme = themeId;
  } else {
    delete config.defaults.colorTheme;
  }

  saveWorkspaceConfig(rootPath, config);
}

// ============================================================
// Local MCP Configuration
// ============================================================

/**
 * Check if local (stdio) MCP servers are enabled for a workspace.
 * Resolution order: ENV (CRAFT_LOCAL_MCP_ENABLED) > Host-owned Project setting > false
 *
 * @param rootPath - Absolute path to workspace root folder
 * @returns true if local MCP servers should be enabled
 */
export function isLocalMcpEnabled(_rootPath: string, hostEnabled = false): boolean {
  // 1. Environment variable override (highest priority)
  const envValue = process.env.CRAFT_LOCAL_MCP_ENABLED;
  if (envValue !== undefined) {
    return envValue.toLowerCase() === 'true';
  }

  return hostEnabled;
}

export { CONFIG_DIR, DEFAULT_WORKSPACES_DIR };
