/**
 * Source Storage
 *
 * input: Explicit Storyflow global/project source roots and source creation inputs
 * output: Source CRUD, project-over-global discovery, guide loading, and icon persistence
 * pos: Shared filesystem storage without implicit third-party source discovery
 *
 * CRUD operations for reusable sources.
 * Craft-owned global sources: {CONFIG_DIR}/sources/{sourceSlug}/
 * Workspace sources: {workspaceRootPath}/.craft-agent/sources/{sourceSlug}/
 *
 * Project callers pass the Host-owned projectId separately from the mutable root path.
 */

import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync } from 'fs';
import { homedir } from 'os';
import { join, basename, dirname } from 'path';
import { createHash, randomUUID } from 'crypto';
import type {
  FolderSourceConfig,
  SourceGuide,
  LoadedSource,
  CreateSourceInput,
  SourceConnectionStatus,
  SourceDefinitionOrigin,
} from './types.ts';
import { validateSourceConfig } from '../config/validators.ts';
import { CONFIG_DIR } from '../config/paths.ts';
import { debug } from '../utils/debug.ts';
import { atomicWriteFileSync, readJsonFileSync } from '../utils/files.ts';
import { expandPath, toPortablePath } from '../utils/paths.ts';
import {
  ensureProjectOwnedDirectory,
  getLegacyWorkspaceSourcesPath,
  getWorkspaceSourcesPath,
  resolveProjectOwnedPath,
} from '../workspaces/paths.ts';
import { resolveResourceRoots } from '../resources/resolver.ts';
import {
  validateIconValue,
  findIconFile,
  downloadIcon,
  ICON_EXTENSIONS,
  needsIconDownload,
} from '../utils/icon.ts';

// ============================================================
// Directory Utilities
// ============================================================

/**
 * Craft-owned global root. Defaults to ~/.craft-agent and follows
 * CRAFT_CONFIG_DIR for isolated development instances.
 * Craft-created and product-seeded global sources write here.
 */
export const GLOBAL_AGENT_ROOT_DIR = CONFIG_DIR;

/** Craft-owned global sources: ~/.craft-agent/sources/ */
export const GLOBAL_AGENT_SOURCES_DIR = join(GLOBAL_AGENT_ROOT_DIR, 'sources');

/**
 * Shared multi-tool root: ~/.agents/
 * Read for interop; Craft does not seed product defaults here.
 */
export const SHARED_AGENTS_ROOT_DIR = join(homedir(), '.agents');

/** Shared multi-tool sources: ~/.agents/sources/ */
export const SHARED_AGENTS_SOURCES_DIR = join(SHARED_AGENTS_ROOT_DIR, 'sources');

/**
 * Craft-owned runtime projection for externally owned source definitions.
 *
 * This directory stores only connection status, never a copy of the source
 * definition. Entries are keyed by source slug and guarded by definition ID
 * (or a content hash when external input omits one), so a removed or replaced
 * shared definition cannot inherit stale state.
 */
export const SHARED_SOURCE_RUNTIME_STATE_DIR = join(
  GLOBAL_AGENT_ROOT_DIR,
  'state',
  'shared-sources',
);

interface SharedSourceRuntimeState {
  version: 1;
  definitionIdentity: string;
  isAuthenticated: boolean | null;
  connectionStatus: SourceConnectionStatus | null;
  connectionError: string | null;
  lastTestedAt: number | null;
  updatedAt: number;
}

export interface SourceConnectionStateUpdate {
  isAuthenticated?: boolean;
  connectionStatus?: SourceConnectionStatus;
  connectionError?: string;
  lastTestedAt?: number;
}

export class ReadOnlySourceDefinitionError extends Error {
  constructor(sourceSlug: string) {
    super(`Shared source definition is read-only: ${sourceSlug}`);
    this.name = 'ReadOnlySourceDefinitionError';
  }
}

function assertMutableSourceRoot(rootPath: string, sourceSlug: string): void {
  if (rootPath === SHARED_AGENTS_ROOT_DIR) {
    throw new ReadOnlySourceDefinitionError(sourceSlug);
  }
}

function getSharedSourceRuntimeStatePath(sourceSlug: string): string {
  return join(SHARED_SOURCE_RUNTIME_STATE_DIR, `${encodeURIComponent(sourceSlug)}.json`);
}

function getSharedSourceDefinitionIdentity(
  sourceSlug: string,
  config: FolderSourceConfig,
): string {
  if (typeof config.id === 'string' && config.id.length > 0) {
    return `id:${config.id}`;
  }

  const configPath = join(getSourcePath(SHARED_AGENTS_ROOT_DIR, sourceSlug), 'config.json');
  const digest = createHash('sha256').update(readFileSync(configPath)).digest('hex');
  return `sha256:${digest}`;
}

function loadSharedSourceRuntimeState(
  sourceSlug: string,
  definitionIdentity: string,
): SharedSourceRuntimeState | null {
  const statePath = getSharedSourceRuntimeStatePath(sourceSlug);
  if (!existsSync(statePath)) return null;

  try {
    const state = readJsonFileSync<SharedSourceRuntimeState>(statePath);
    return state.version === 1 && state.definitionIdentity === definitionIdentity ? state : null;
  } catch {
    return null;
  }
}

function saveSharedSourceRuntimeState(
  sourceSlug: string,
  definitionIdentity: string,
  state: SourceConnectionStateUpdate,
): void {
  const next: SharedSourceRuntimeState = {
    version: 1,
    definitionIdentity,
    isAuthenticated: state.isAuthenticated ?? null,
    connectionStatus: state.connectionStatus ?? null,
    connectionError: state.connectionError ?? null,
    lastTestedAt: state.lastTestedAt ?? null,
    updatedAt: Date.now(),
  };

  mkdirSync(SHARED_SOURCE_RUNTIME_STATE_DIR, { recursive: true });
  atomicWriteFileSync(
    getSharedSourceRuntimeStatePath(sourceSlug),
    JSON.stringify(next, null, 2),
  );
}

function isGlobalSourcesRoot(rootPath: string): boolean {
  return rootPath === GLOBAL_AGENT_ROOT_DIR || rootPath === SHARED_AGENTS_ROOT_DIR;
}

function resolveOwnedSourcePath(rootPath: string, targetPath: string): string {
  return isGlobalSourcesRoot(rootPath)
    ? targetPath
    : resolveProjectOwnedPath(rootPath, targetPath);
}

function ensureOwnedSourceDirectory(rootPath: string, targetPath: string): string {
  if (!isGlobalSourcesRoot(rootPath)) {
    return ensureProjectOwnedDirectory(rootPath, targetPath);
  }
  mkdirSync(targetPath, { recursive: true });
  return targetPath;
}

function ensureOwnedSourceWriteTarget(rootPath: string, targetPath: string): void {
  ensureOwnedSourceDirectory(rootPath, dirname(targetPath));
  if (lstatSync(targetPath, { throwIfNoEntry: false })) {
    resolveOwnedSourcePath(rootPath, targetPath);
  }
}

function getSourcesPathForRoot(rootPath: string): string {
  if (rootPath === GLOBAL_AGENT_ROOT_DIR) return GLOBAL_AGENT_SOURCES_DIR;
  if (rootPath === SHARED_AGENTS_ROOT_DIR) return SHARED_AGENTS_SOURCES_DIR;
  return getWorkspaceSourcesPath(rootPath);
}

function getLegacySourcesPathForRoot(rootPath: string): string {
  if (isGlobalSourcesRoot(rootPath)) return getSourcesPathForRoot(rootPath);
  return getLegacyWorkspaceSourcesPath(rootPath);
}

export function assertSafeSourceSlug(sourceSlug: string): void {
  if (
    !sourceSlug
    || sourceSlug === '.'
    || sourceSlug === '..'
    || basename(sourceSlug) !== sourceSlug
    || sourceSlug.includes('\\')
    || sourceSlug.includes('\0')
  ) {
    throw new Error(`Invalid Source slug: ${sourceSlug}`);
  }
}

/** Bind executable authority to the current definition, not its reusable slug. */
export function getSourceDefinitionIdentity(config: FolderSourceConfig): string {
  const executableDefinition = {
    id: config.id,
    slug: config.slug,
    provider: config.provider,
    type: config.type,
    mcp: config.mcp,
    api: config.api,
    local: config.local,
  };
  return createHash('sha256')
    .update(JSON.stringify(executableDefinition))
    .digest('hex');
}

function getSourceWritePath(workspaceRootPath: string, sourceSlug: string): string {
  assertSafeSourceSlug(sourceSlug);
  return join(getSourcesPathForRoot(workspaceRootPath), sourceSlug);
}

function hasSourceConfigAtRoot(rootPath: string, sourceSlug: string): boolean {
  return existsSync(join(getSourcePath(rootPath, sourceSlug), 'config.json'));
}

/** Resolve the Craft-owned definition currently visible to a project. */
function resolveVisibleSourceRoot(workspaceRootPath: string, sourceSlug: string): string {
  if (isGlobalSourcesRoot(workspaceRootPath)) return workspaceRootPath;
  if (hasSourceConfigAtRoot(workspaceRootPath, sourceSlug)) return workspaceRootPath;
  if (hasSourceConfigAtRoot(GLOBAL_AGENT_ROOT_DIR, sourceSlug)) return GLOBAL_AGENT_ROOT_DIR;
  return workspaceRootPath;
}

/**
 * Get path to a source folder within a workspace or global agents root.
 */
export function getSourcePath(workspaceRootPath: string, sourceSlug: string): string {
  assertSafeSourceSlug(sourceSlug);
  const sourcePath = join(getSourcesPathForRoot(workspaceRootPath), sourceSlug);
  const configPath = join(sourcePath, 'config.json');
  if (existsSync(configPath)) {
    resolveOwnedSourcePath(workspaceRootPath, configPath);
    return sourcePath;
  }

  const legacySourcePath = join(getLegacySourcesPathForRoot(workspaceRootPath), sourceSlug);
  const legacyConfigPath = join(legacySourcePath, 'config.json');
  if (existsSync(legacyConfigPath)) {
    resolveOwnedSourcePath(workspaceRootPath, legacyConfigPath);
    return legacySourcePath;
  }

  return sourcePath;
}

/**
 * Ensure sources directory exists for a workspace or global agents root.
 */
export function ensureSourcesDir(workspaceRootPath: string): void {
  assertMutableSourceRoot(workspaceRootPath, 'sources');
  const dir = getSourcesPathForRoot(workspaceRootPath);
  ensureOwnedSourceDirectory(workspaceRootPath, dir);
}

// ============================================================
// Config Operations
// ============================================================

/**
 * Load source config.json
 */
export function loadSourceConfig(
  workspaceRootPath: string,
  sourceSlug: string
): FolderSourceConfig | null {
  const configPath = join(getSourcePath(workspaceRootPath, sourceSlug), 'config.json');
  if (!existsSync(configPath)) return null;
  resolveOwnedSourcePath(workspaceRootPath, configPath);

  try {
    const config = readJsonFileSync<FolderSourceConfig>(configPath);

    // Expand path variables in local source paths for portability
    if (config.type === 'local' && config.local?.path) {
      config.local.path = expandPath(config.local.path);
    }

    if (workspaceRootPath !== SHARED_AGENTS_ROOT_DIR) return config;

    const definitionIdentity = getSharedSourceDefinitionIdentity(sourceSlug, config);
    const runtimeState = loadSharedSourceRuntimeState(sourceSlug, definitionIdentity);
    if (!runtimeState) return config;

    return {
      ...config,
      isAuthenticated: runtimeState.isAuthenticated ?? undefined,
      connectionStatus: runtimeState.connectionStatus ?? undefined,
      connectionError: runtimeState.connectionError ?? undefined,
      lastTestedAt: runtimeState.lastTestedAt ?? undefined,
    };
  } catch {
    return null;
  }
}

/**
 * Mark a source as authenticated and connected.
 * Updates isAuthenticated, connectionStatus, and clears any connection error.
 *
 * @returns true if the source was found and updated, false otherwise
 */
export function markSourceAuthenticated(
  workspaceRootPath: string,
  sourceSlug: string
): boolean {
  const updated = updateSourceConnectionState(workspaceRootPath, sourceSlug, {
    isAuthenticated: true,
    connectionStatus: 'connected',
    connectionError: undefined,
  });
  if (!updated) {
    debug(`[markSourceAuthenticated] Source ${sourceSlug} not found`);
    return false;
  }

  debug(`[markSourceAuthenticated] Marked ${sourceSlug} as authenticated`);
  return true;
}

/**
 * Persist Craft-owned connection state for a source.
 *
 * Owned definitions keep the existing config.json representation. Shared
 * definitions project the same runtime fields from Craft's private state
 * directory, leaving every file under ~/.agents/sources byte-for-byte intact.
 */
export function updateSourceConnectionState(
  workspaceRootPath: string,
  sourceSlug: string,
  update: SourceConnectionStateUpdate,
): boolean {
  const sourceRootPath = resolveVisibleSourceRoot(workspaceRootPath, sourceSlug);
  const config = loadSourceConfig(sourceRootPath, sourceSlug);
  if (!config) return false;

  if (sourceRootPath === SHARED_AGENTS_ROOT_DIR) {
    const definitionIdentity = getSharedSourceDefinitionIdentity(sourceSlug, config);
    saveSharedSourceRuntimeState(sourceSlug, definitionIdentity, {
      isAuthenticated: update.isAuthenticated ?? config.isAuthenticated,
      connectionStatus: update.connectionStatus ?? config.connectionStatus,
      connectionError: Object.prototype.hasOwnProperty.call(update, 'connectionError')
        ? update.connectionError
        : config.connectionError,
      lastTestedAt: update.lastTestedAt ?? config.lastTestedAt,
    });
    return true;
  }

  Object.assign(config, update);
  saveSourceConfig(sourceRootPath, config);
  return true;
}

/**
 * Save source config.json
 * @throws Error if config is invalid
 */
export function saveSourceConfig(
  workspaceRootPath: string,
  config: FolderSourceConfig
): void {
  assertMutableSourceRoot(workspaceRootPath, config.slug);

  // Validate config before writing
  const validation = validateSourceConfig(config);
  if (!validation.valid) {
    const errorMessages = validation.errors.map((e) => `${e.path}: ${e.message}`).join(', ');
    debug('[saveSourceConfig] Validation failed:', errorMessages);
    throw new Error(`Invalid source config: ${errorMessages}`);
  }

  const targetRootPath = workspaceRootPath !== GLOBAL_AGENT_ROOT_DIR
    && !existsSync(join(getSourcePath(workspaceRootPath, config.slug), 'config.json'))
    && existsSync(join(getSourcePath(GLOBAL_AGENT_ROOT_DIR, config.slug), 'config.json'))
    ? GLOBAL_AGENT_ROOT_DIR
    : workspaceRootPath;

  const dir = getSourceWritePath(targetRootPath, config.slug);
  const configPath = join(dir, 'config.json');
  ensureOwnedSourceWriteTarget(targetRootPath, configPath);

  // Convert local source paths to portable form
  const storageConfig: FolderSourceConfig = { ...config, updatedAt: Date.now() };
  if (storageConfig.type === 'local' && storageConfig.local?.path) {
    storageConfig.local = {
      ...storageConfig.local,
      path: toPortablePath(storageConfig.local.path),
    };
  }

  writeFileSync(configPath, JSON.stringify(storageConfig, null, 2));
}

// ============================================================
// Guide Operations
// ============================================================

/**
 * Parse guide markdown.
 * Extracts sections (Scope, Guidelines, Context, API Notes) and Cache (JSON in code block).
 */
function parseGuideMarkdown(raw: string): SourceGuide {
  const guide: SourceGuide = { raw };

  // Extract sections by headers (including Cache)
  const sectionRegex = /^## (Scope|Guidelines|Context|API Notes|Cache)\n([\s\S]*?)(?=\n## |\Z)/gim;
  let match;
  while ((match = sectionRegex.exec(raw)) !== null) {
    const sectionName = (match[1] ?? '').toLowerCase().replace(/\s+/g, '');
    const content = (match[2] ?? '').trim();

    switch (sectionName) {
      case 'scope':
        guide.scope = content;
        break;
      case 'guidelines':
        guide.guidelines = content;
        break;
      case 'context':
        guide.context = content;
        break;
      case 'apinotes':
        guide.apiNotes = content;
        break;
      case 'cache':
        // Parse JSON from code block: ```json ... ```
        const jsonMatch = content.match(/```json\n([\s\S]*?)\n```/);
        if (jsonMatch && jsonMatch[1]) {
          try {
            guide.cache = JSON.parse(jsonMatch[1]);
          } catch {
            // Invalid JSON, ignore
          }
        }
        break;
    }
  }

  return guide;
}

/**
 * Load and parse guide.md with frontmatter cache
 */
export function loadSourceGuide(workspaceRootPath: string, sourceSlug: string): SourceGuide | null {
  const guidePath = join(getSourcePath(workspaceRootPath, sourceSlug), 'guide.md');
  if (!existsSync(guidePath)) return null;

  try {
    resolveOwnedSourcePath(workspaceRootPath, guidePath);
    const raw = readFileSync(guidePath, 'utf-8');
    return parseGuideMarkdown(raw);
  } catch {
    return null;
  }
}

/**
 * Extract a short tagline from guide.md content
 * Looks for the first non-empty paragraph after the title, or falls back to scope section
 * @returns Tagline string (max 100 chars) or null if not found
 */
export function extractTagline(guide: SourceGuide | null): string | null {
  if (!guide?.raw) return null;

  const content = guide.raw;

  // Try to get first paragraph after the title (# Title)
  // Match: # Title\n\n<first paragraph>
  const titleMatch = content.match(/^#[^\n]+\n+([^\n#][^\n]*)/);
  if (titleMatch?.[1]?.trim()) {
    const tagline = titleMatch[1].trim();
    // Skip if it looks like a section or placeholder
    if (!tagline.startsWith('##') && !tagline.startsWith('(')) {
      return tagline.slice(0, 100);
    }
  }

  // Fallback to first line of scope section
  if (guide.scope) {
    const firstLine = guide.scope.split('\n')[0]?.trim();
    if (firstLine && !firstLine.startsWith('(')) {
      return firstLine.slice(0, 100);
    }
  }

  return null;
}

/**
 * Save guide.md
 */
export function saveSourceGuide(
  workspaceRootPath: string,
  sourceSlug: string,
  guide: SourceGuide
): void {
  assertMutableSourceRoot(workspaceRootPath, sourceSlug);
  const dir = getSourcePath(workspaceRootPath, sourceSlug);
  const guidePath = join(dir, 'guide.md');
  ensureOwnedSourceWriteTarget(workspaceRootPath, guidePath);
  writeFileSync(guidePath, guide.raw);
}

// ============================================================
// Icon Operations (uses shared utilities from utils/icon.ts)
// ============================================================

function findOwnedSourceIcon(rootPath: string, sourceDir: string): string | undefined {
  const iconPath = findIconFile(sourceDir);
  if (iconPath) resolveOwnedSourcePath(rootPath, iconPath);
  return iconPath;
}

/**
 * Find icon file for a source
 * Returns absolute path to icon file or undefined
 */
export function findSourceIcon(workspaceRootPath: string, sourceSlug: string): string | undefined {
  return findOwnedSourceIcon(workspaceRootPath, getSourcePath(workspaceRootPath, sourceSlug));
}

/**
 * Download an icon from a URL and save it to the source directory.
 * Returns the path to the downloaded icon, or null on failure.
 */
export async function downloadSourceIcon(
  workspaceRootPath: string,
  sourceSlug: string,
  iconUrl: string
): Promise<string | null> {
  assertMutableSourceRoot(workspaceRootPath, sourceSlug);
  const sourceDir = getSourceWritePath(workspaceRootPath, sourceSlug);
  ensureOwnedSourceDirectory(workspaceRootPath, sourceDir);
  for (const ext of ICON_EXTENSIONS) {
    const iconPath = join(sourceDir, `icon${ext}`);
    if (lstatSync(iconPath, { throwIfNoEntry: false })) {
      resolveOwnedSourcePath(workspaceRootPath, iconPath);
    }
  }
  return downloadIcon(
    sourceDir,
    iconUrl,
    'Sources',
    'icon',
    iconPath => ensureOwnedSourceWriteTarget(workspaceRootPath, iconPath),
  );
}

/**
 * Check if a source needs its icon downloaded.
 * Returns true if config has a URL icon and no local icon file exists.
 */
export function sourceNeedsIconDownload(
  workspaceRootPath: string,
  sourceSlug: string,
  config: FolderSourceConfig
): boolean {
  const iconPath = findSourceIcon(workspaceRootPath, sourceSlug);
  return needsIconDownload(config.icon, iconPath);
}

// Re-export icon utilities for convenience
export { isIconUrl } from '../utils/icon.ts';

// ============================================================
// Load Operations
// ============================================================

/**
 * Load complete source with all files
 * @param workspaceRootPath - Absolute path to workspace folder (e.g., ~/.craft-agent/workspaces/xxx)
 * @param sourceSlug - Source folder name
 */
export function loadSource(
  projectRoot: string | undefined,
  sourceSlug: string,
  projectId?: string,
): LoadedSource | null {
  const consumerRoot = projectRoot ?? GLOBAL_AGENT_ROOT_DIR;
  for (const root of resolveResourceRoots({ projectRoot }).sources) {
    const origin = root.origin === 'project' ? 'workspace' : 'craft-global';
    const source = loadSourceFromRoot(
      root.rootPath,
      sourceSlug,
      origin,
      consumerRoot,
      projectId,
    );
    if (source) return source;
  }

  return null;
}

function loadSourceFromRoot(
  sourceRootPath: string,
  sourceSlug: string,
  origin: Exclude<SourceDefinitionOrigin, 'builtin'>,
  consumerWorkspaceRootPath = sourceRootPath,
  consumerProjectId?: string,
): LoadedSource | null {
  const folderPath = getSourcePath(sourceRootPath, sourceSlug);
  const config = loadSourceConfig(sourceRootPath, sourceSlug);
  if (!config) return null;
  if (config.slug !== sourceSlug) {
    debug(`[sources] Ignoring folder/config slug mismatch: ${sourceSlug} != ${String(config.slug)}`);
    return null;
  }

  const legacyWorkspaceId = basename(consumerWorkspaceRootPath);
  const workspaceId = origin === 'workspace'
    ? consumerProjectId ?? legacyWorkspaceId
    : 'global';

  // Pre-compute icon path for renderer (avoids fs access in browser)
  const iconPath = findOwnedSourceIcon(sourceRootPath, folderPath);

  return {
    config,
    guide: loadSourceGuide(sourceRootPath, sourceSlug),
    folderPath,
    workspaceRootPath: sourceRootPath,
    workspaceId,
    definitionIdentity: getSourceDefinitionIdentity(config),
    iconPath,
    origin,
  };
}

/**
 * Load all user-configured sources visible in an optional project.
 * Resolver roots are consumed from highest to lowest precedence, with the first
 * definition for a slug winning.
 */
export function loadWorkspaceSources(projectRoot?: string, projectId?: string): LoadedSource[] {
  if (projectRoot) {
    ensureSourcesDir(projectRoot);
  }
  ensureSourcesDir(GLOBAL_AGENT_ROOT_DIR);

  const sourcesBySlug = new Map<string, LoadedSource>();
  const consumerRoot = projectRoot ?? GLOBAL_AGENT_ROOT_DIR;

  for (const root of resolveResourceRoots({ projectRoot }).sources) {
    const origin = root.origin === 'project' ? 'workspace' : 'craft-global';
    const sourceDirs = root.origin === 'project'
      ? [root.path, getLegacyWorkspaceSourcesPath(root.rootPath)]
      : [root.path];

    for (const sourceDir of sourceDirs) {
      for (const source of loadSourcesFromRoot(
        root.rootPath,
        origin,
        consumerRoot,
        sourceDir,
        projectId,
      )) {
        if (!sourcesBySlug.has(source.config.slug)) {
          sourcesBySlug.set(source.config.slug, source);
        }
      }
    }
  }

  return Array.from(sourcesBySlug.values());
}

function loadSourcesFromRoot(
  sourceRootPath: string,
  origin: Exclude<SourceDefinitionOrigin, 'builtin'>,
  consumerWorkspaceRootPath = sourceRootPath,
  explicitSourcesDir?: string,
  consumerProjectId?: string,
): LoadedSource[] {
  const sources: LoadedSource[] = [];
  const sourcesDir = explicitSourcesDir ?? getSourcesPathForRoot(sourceRootPath);
  if (!existsSync(sourcesDir)) return sources;

  const entries = readdirSync(resolveOwnedSourcePath(sourceRootPath, sourcesDir), { withFileTypes: true });

  for (const entry of entries) {
    if (entry.isDirectory()) {
      const loadedSource = loadSourceFromRoot(
        sourceRootPath,
        entry.name,
        origin,
        consumerWorkspaceRootPath,
        consumerProjectId,
      );
      if (loadedSource) {
        sources.push(loadedSource);
      }
    }
  }

  return sources;
}

/**
 * Get enabled sources for a workspace
 */
export function getEnabledSources(projectRoot?: string, projectId?: string): LoadedSource[] {
  return loadWorkspaceSources(projectRoot, projectId).filter((s) => s.config.enabled);
}

/**
 * Check if a source is ready for use (enabled and authenticated).
 * Sources with authType: 'none' or undefined are considered authenticated.
 *
 * Use this instead of inline `s.config.enabled && s.config.isAuthenticated` checks
 * to ensure consistent handling of no-auth sources.
 */
export function isSourceUsable(source: LoadedSource): boolean {
  if (!source.config.enabled) return false;

  // Get auth type from MCP or API config
  const authType = source.config.mcp?.authType || source.config.api?.authType;

  // Sources with no auth requirement are always usable when enabled
  if (authType === 'none' || authType === 'managed' || authType === undefined) return true;

  // Sources requiring auth must be authenticated
  return source.config.isAuthenticated === true;
}

/**
 * Get sources by slugs for a workspace.
 * Loads configured sources from disk.
 */
export function getSourcesBySlugs(
  projectRoot: string | undefined,
  slugs: string[],
  projectId?: string,
): LoadedSource[] {
  const sources: LoadedSource[] = [];
  for (const slug of slugs) {
    const source = loadSource(projectRoot, slug, projectId);
    if (source) {
      sources.push(source);
    }
  }
  return sources;
}

/**
 * Load all configured sources for a workspace.
 */
export function loadAllSources(projectRoot?: string, projectId?: string): LoadedSource[] {
  return loadWorkspaceSources(projectRoot, projectId);
}

// ============================================================
// Create/Delete Operations
// ============================================================

/**
 * Generate URL-safe slug from name
 */
export function generateSourceSlug(workspaceRootPath: string, name: string): string {
  let slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .substring(0, 50);

  // Ensure slug is not empty
  if (!slug) {
    slug = 'source';
  }

  // Check for existing slugs and append number if needed
  const sourcesDir = getSourcesPathForRoot(workspaceRootPath);
  const existingSlugs = new Set<string>();
  for (const dir of [
    getLegacySourcesPathForRoot(workspaceRootPath),
    sourcesDir,
  ]) {
    if (!existsSync(dir)) continue;
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        existingSlugs.add(entry.name);
      }
    }
  }

  if (!existingSlugs.has(slug)) {
    return slug;
  }

  // Find next available number
  let counter = 2;
  while (existingSlugs.has(`${slug}-${counter}`)) {
    counter++;
  }

  return `${slug}-${counter}`;
}

/**
 * Create a new source globally by default.
 */
export async function createSource(
  _workspaceRootPath: string,
  input: CreateSourceInput
): Promise<FolderSourceConfig> {
  const sourceRootPath = GLOBAL_AGENT_ROOT_DIR;
  const slug = generateSourceSlug(sourceRootPath, input.name);
  const now = Date.now();

  const config: FolderSourceConfig = {
    // ID format: {slug}_{random} for easy identification (e.g., "linear_a1b2c3d4")
    id: `${slug}_${randomUUID().slice(0, 8)}`,
    name: input.name,
    slug,
    enabled: input.enabled ?? true,
    provider: input.provider,
    type: input.type,
    createdAt: now,
    updatedAt: now,
  };

  // Add type-specific config
  switch (input.type) {
    case 'mcp':
      if (input.mcp) {
        config.mcp = input.mcp;
      }
      break;
    case 'api':
      if (input.api) {
        config.api = input.api;
      }
      break;
    case 'local':
      if (input.local) {
        config.local = input.local;
      }
      break;
  }

  // Validate and store icon (emoji or URL)
  // URL icons are downloaded on first config change via watcher
  if (input.icon) {
    const validatedIcon = validateIconValue(input.icon, 'Sources');
    if (validatedIcon) {
      config.icon = validatedIcon;
    }
  }

  // Save config first to create the directory
  saveSourceConfig(sourceRootPath, config);

  // Icon URL downloads are best-effort work owned by ConfigWatcher. Source
  // creation must not wait on favicon discovery or any external network.

  // Create guide.md with skeleton template
  // (bundled guides removed - agent should search craft-agents-docs MCP for service-specific guidance)
  const guideContent = `# ${input.name}

## Guidelines

(Add usage guidelines here)

## Context

(Add context about this source)
`;
  saveSourceGuide(sourceRootPath, slug, { raw: guideContent });

  return config;
}

/** Delete only from the already-resolved owning root; callers must not pass a consumer overlay root. */
export function deleteSource(ownerRootPath: string, sourceSlug: string): void {
  assertMutableSourceRoot(ownerRootPath, sourceSlug);

  const sourceDirs = new Set([
    getSourceWritePath(ownerRootPath, sourceSlug),
    join(getLegacySourcesPathForRoot(ownerRootPath), sourceSlug),
  ]);

  for (const sourceDir of sourceDirs) {
    if (existsSync(sourceDir)) {
      rmSync(resolveOwnedSourcePath(ownerRootPath, sourceDir), { recursive: true });
      return;
    }
  }
}

/**
 * Check if a source exists in a workspace
 */
export function sourceExists(workspaceRootPath: string, sourceSlug: string): boolean {
  return existsSync(join(getSourcePath(workspaceRootPath, sourceSlug), 'config.json'))
    || existsSync(join(getSourceWritePath(workspaceRootPath, sourceSlug), 'config.json'))
    || existsSync(join(getLegacySourcesPathForRoot(workspaceRootPath), sourceSlug, 'config.json'))
    || existsSync(join(getSourcePath(GLOBAL_AGENT_ROOT_DIR, sourceSlug), 'config.json'));
}

// ============================================================
// Source Loading/Saving Helpers
// ============================================================

// Note: SourceWithContext and wrapper functions were removed in this PR.
// Use loadSourceConfig and saveSourceConfig directly instead.

// ============================================================
// Re-export parseGuideMarkdown for use in other modules
// ============================================================

export { parseGuideMarkdown };
