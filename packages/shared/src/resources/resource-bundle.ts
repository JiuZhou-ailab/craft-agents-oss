// input: Workspace resources, global Skill root, or untrusted portable ResourceBundle JSON
// output: Sanitized exports, validated imports, and atomic resource writes
// pos: Supply-chain trust boundary shared by local exchange and global Skills Market installs

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, renameSync, rmSync } from 'fs'
import { join, basename, resolve } from 'path'
import { createHash, randomUUID } from 'crypto'
import { isDeepStrictEqual } from 'node:util'
import {
  type BundleFile,
  MAX_BUNDLE_SIZE_BYTES,
  collectDirectoryFiles,
  restoreFiles,
  validateBundleFile,
} from '../utils/bundle-files.ts'
import {
  getLegacyWorkspaceSourcesPath,
  getExistingWorkspaceConfigPath,
  getWorkspaceSkillsPath,
  getWorkspaceSourcesPath,
} from '../workspaces/storage.ts'
import {
  assertSymlinkFreeTree,
  ensureProjectOwnedDirectory,
  resolveProjectOwnedPath,
} from '../workspaces/paths.ts'
import { assertSafeSourceSlug, loadSourceConfig, getSourcePath } from '../sources/storage.ts'
import { validateSourceConfig } from '../config/validators.ts'
import { AUTOMATIONS_CONFIG_FILE, AUTOMATIONS_HISTORY_FILE, AUTOMATIONS_RETRY_QUEUE_FILE } from '../automations/constants.ts'
import { validateAutomationsConfig } from '../automations/validation.ts'
import { generateShortId, resolveAutomationOwnedPath } from '../automations/resolve-config-path.ts'
import { withRetryQueueMutation } from '../automations/retry-scheduler.ts'
import { VALID_EVENTS } from '../automations/schemas.ts'
import { isValidSkillSlug, validateSkillDocumentForSlug } from '../skills/storage.ts'
import { portablePathCollisionKey } from './portable-path.ts'

import type { FolderSourceConfig } from '../sources/types.ts'
import type { AutomationMatcher } from '../automations/types.ts'
import {
  MAX_SKILL_INSTALL_ARTIFACT_BYTES,
  SKILL_INSTALL_RECEIPT_FILE,
  type ResourceImportOptions,
  type SkillInstallReceipt,
  type ResourceBundle,
  type SourceBundleEntry,
  type SkillBundleEntry,
  type AutomationBundleEntry,
  type ExportResourcesOptions,
  type ExportResult,
  type ResourceImportMode,
  type ResourceImportResult,
  type ImportBucketResult,
  type ResourceImportDeps,
} from './types.ts'

function listResourceSlugs(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true })
    .filter(d => d.isDirectory() && !d.name.startsWith('.'))
    .map(d => d.name)
}

// ============================================================
// Source Config Sanitization
// ============================================================

/**
 * Fields to strip from source configs on export.
 *
 * Runtime state fields are always removed.
 * Known secret-bearing fields are removed with warnings.
 */

/** Strip runtime auth/status state from a source config */
function sanitizeSourceConfig(config: FolderSourceConfig): { config: FolderSourceConfig; warnings: string[] } {
  const warnings: string[] = []

  // Deep clone to avoid mutating the original
  const sanitized: FolderSourceConfig = JSON.parse(JSON.stringify(config))

  // --- Runtime state: always remove ---
  sanitized.isAuthenticated = false
  delete sanitized.connectionError
  delete sanitized.lastTestedAt

  // Determine if source requires auth
  const authType = sanitized.mcp?.authType || sanitized.api?.authType
  if (authType && authType !== 'none') {
    sanitized.connectionStatus = 'needs_auth'
  } else {
    sanitized.connectionStatus = undefined
  }

  // --- Known secret fields: always remove ---
  if (sanitized.api?.googleOAuthClientSecret) {
    delete sanitized.api.googleOAuthClientSecret
    warnings.push(`Source '${config.slug}': stripped googleOAuthClientSecret`)
  }

  // --- MCP env vars: may contain tokens ---
  if (sanitized.mcp?.env && Object.keys(sanitized.mcp.env).length > 0) {
    delete sanitized.mcp.env
    warnings.push(`Source '${config.slug}': stripped mcp.env (may contain secrets)`)
  }

  // --- Headers: potentially secret, remove with warning ---
  if (sanitized.mcp?.headers && Object.keys(sanitized.mcp.headers).length > 0) {
    delete sanitized.mcp.headers
    warnings.push(`Source '${config.slug}': stripped mcp.headers (may contain auth tokens)`)
  }

  if (sanitized.api?.defaultHeaders && Object.keys(sanitized.api.defaultHeaders).length > 0) {
    delete sanitized.api.defaultHeaders
    warnings.push(`Source '${config.slug}': stripped api.defaultHeaders (may contain auth tokens)`)
  }

  return { config: sanitized, warnings }
}

// ============================================================
// Export
// ============================================================

/**
 * Export workspace resources to a portable ResourceBundle.
 *
 * @param workspaceRootPath - Absolute path to workspace root
 * @param options - Which resources to export
 * @returns Bundle + export warnings
 */
export function exportResources(
  workspaceRootPath: string,
  options: ExportResourcesOptions,
  skillsRootPath = getWorkspaceSkillsPath(workspaceRootPath),
): ExportResult {
  const warnings: string[] = []
  const bundle: ResourceBundle = {
    version: 1,
    exportedAt: Date.now(),
    resources: {},
  }

  // Try to read workspace name for informational purposes
  try {
    const wsConfigPath = getExistingWorkspaceConfigPath(workspaceRootPath)
    if (existsSync(wsConfigPath)) {
      const wsConfig = JSON.parse(readFileSync(wsConfigPath, 'utf-8'))
      if (wsConfig.name) {
        bundle.sourceWorkspace = wsConfig.name
      }
    }
  } catch {
    // Non-fatal: sourceWorkspace is informational
  }

  // --- Export sources ---
  if (options.sources) {
    bundle.resources.sources = exportSources(workspaceRootPath, options.sources, warnings)
  }

  // --- Export skills ---
  if (options.skills) {
    bundle.resources.skills = exportSkills(skillsRootPath, options.skills, warnings)
  }

  // --- Export automations ---
  // Normalize: true → 'all', false/undefined → skip
  const automationSelection = options.automations === true ? 'all' : options.automations
  if (automationSelection) {
    bundle.resources.automations = exportAutomations(workspaceRootPath, automationSelection, warnings)
  }

  // Validate total size
  const bundleJson = JSON.stringify(bundle)
  if (Buffer.byteLength(bundleJson) > MAX_BUNDLE_SIZE_BYTES) {
    warnings.push(`Bundle exceeds ${MAX_BUNDLE_SIZE_BYTES / 1024 / 1024}MB size limit`)
  }

  return { bundle, warnings }
}

function exportSources(
  workspaceRootPath: string,
  selection: string[] | 'all',
  warnings: string[],
): SourceBundleEntry[] {
  const entries: SourceBundleEntry[] = []
  const sourcesDir = getWorkspaceSourcesPath(workspaceRootPath)

  // Determine which slugs to export
  let slugs: string[]
  if (selection === 'all') {
    slugs = Array.from(new Set([
      ...listResourceSlugs(getLegacyWorkspaceSourcesPath(workspaceRootPath)),
      ...listResourceSlugs(sourcesDir),
    ]))
  } else {
    slugs = selection
  }

  for (const slug of slugs) {
    const sourcePath = getSourcePath(workspaceRootPath, slug)
    if (!existsSync(sourcePath)) {
      warnings.push(`Source '${slug}' not found, skipping`)
      continue
    }

    const config = loadSourceConfig(workspaceRootPath, slug)
    if (!config) {
      warnings.push(`Source '${slug}' has invalid config, skipping`)
      continue
    }

    // Sanitize config
    const { config: sanitizedConfig, warnings: sanitizeWarnings } = sanitizeSourceConfig(config)
    warnings.push(...sanitizeWarnings)

    // Collect all files except config.json (which travels as structured data)
    const files = collectDirectoryFiles(sourcePath, {
      skipFiles: new Set(['config.json']),
    })

    entries.push({
      slug,
      config: sanitizedConfig,
      files,
    })
  }

  return entries
}

function exportSkills(
  skillsDir: string,
  selection: string[] | 'all',
  warnings: string[],
): SkillBundleEntry[] {
  const entries: SkillBundleEntry[] = []

  // Determine which slugs to export
  let slugs: string[]
  if (selection === 'all') {
    slugs = listResourceSlugs(skillsDir)
  } else {
    slugs = selection
  }

  for (const slug of slugs) {
    if (!isValidSkillSlug(slug)) {
      warnings.push(`Skill selector '${slug}' is invalid, skipping`)
      continue
    }
    const skillDir = join(skillsDir, slug)
    if (!existsSync(skillDir)) {
      warnings.push(`Skill '${slug}' not found, skipping`)
      continue
    }
    try {
      assertSymlinkFreeTree(skillDir)
    } catch (err) {
      warnings.push(`Skill '${slug}' cannot be exported: ${err}`)
      continue
    }

    // Collect all files in the skill directory
    const files = collectDirectoryFiles(skillDir)

    // Validate that SKILL.md is present
    const hasSkillMd = files.some(f => f.relativePath === 'SKILL.md')
    if (!hasSkillMd) {
      warnings.push(`Skill '${slug}' missing SKILL.md, skipping`)
      continue
    }

    entries.push({ slug, files })
  }

  return entries
}

// ============================================================
// Export: Automations
// ============================================================

/** Header keys that are known to carry secrets (case-insensitive match) */
const SECRET_HEADER_PATTERNS = [
  /^authorization$/i,
  /^proxy-authorization$/i,
  /api[-_]?key/i,
]

function isSecretHeader(key: string): boolean {
  return SECRET_HEADER_PATTERNS.some(p => p.test(key))
}

/** Returns true if the value references an env var template like $VAR_NAME or ${VAR} (safe to keep) */
function isTemplatedValue(value: string): boolean {
  return /\$[A-Z_]|\$\{/.test(value)
}

/**
 * Sanitize a single automation matcher for export.
 * Strips webhook auth credentials and known auth headers.
 */
function sanitizeAutomationMatcher(
  matcher: AutomationMatcher,
  label: string,
  warnings: string[],
): AutomationMatcher {
  // Deep clone to avoid mutating the original
  const sanitized: AutomationMatcher = JSON.parse(JSON.stringify(matcher))

  if (!sanitized.actions) return sanitized

  for (const action of sanitized.actions) {
    if (action.type !== 'webhook') continue

    // Strip auth field entirely (bearer tokens, basic auth passwords)
    if (action.auth) {
      delete (action as unknown as Record<string, unknown>).auth
      warnings.push(`Automation '${label}': stripped webhook auth credentials`)
    }

    // Strip known auth headers (unless templated)
    if (action.headers) {
      const keysToStrip = Object.keys(action.headers).filter(
        key => isSecretHeader(key) && !isTemplatedValue(action.headers![key]!),
      )
      for (const key of keysToStrip) {
        delete action.headers[key]
        warnings.push(`Automation '${label}': stripped webhook header '${key}'`)
      }
      // Clean up empty headers object
      if (Object.keys(action.headers).length === 0) {
        delete (action as unknown as Record<string, unknown>).headers
      }
    }
  }

  return sanitized
}

function exportAutomations(
  workspaceRootPath: string,
  selection: string[] | 'all',
  warnings: string[],
): AutomationBundleEntry[] {
  let automationsPath: string
  try {
    automationsPath = resolveAutomationOwnedPath(
      workspaceRootPath,
      join(workspaceRootPath, AUTOMATIONS_CONFIG_FILE),
    )
  } catch (err) {
    warnings.push(`Failed to read automations.json: ${err}`)
    return []
  }

  if (!existsSync(automationsPath)) {
    warnings.push('No automations.json found in workspace')
    return []
  }

  // Read and validate via the full validation pipeline
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(automationsPath, 'utf-8'))
  } catch (err) {
    warnings.push(`Failed to read automations.json: ${err}`)
    return []
  }

  const validation = validateAutomationsConfig(raw)
  if (!validation.valid || !validation.config) {
    warnings.push(`automations.json is invalid: ${validation.errors.join('; ')}`)
    return []
  }

  // Flatten { event: matchers[] } into individual entries
  const allEntries: AutomationBundleEntry[] = []
  for (const [event, matchers] of Object.entries(validation.config.automations)) {
    if (!matchers) continue
    for (const matcher of matchers) {
      // Ensure every matcher has an ID (backfill if missing)
      const id = matcher.id || generateShortId()
      allEntries.push({
        id,
        name: matcher.name,
        event,
        matcher: { ...matcher, id },
      })
    }
  }

  // Apply selection filter
  let selected: AutomationBundleEntry[]
  if (selection === 'all') {
    selected = allEntries
  } else {
    const matched = new Set<string>()
    selected = []
    for (const selector of selection) {
      const matches = allEntries.filter(
        e => e.id === selector || (e.name !== undefined && e.name === selector),
      )
      if (matches.length === 0) {
        warnings.push(`Automation selector '${selector}' did not match any automation`)
      } else if (matches.length > 1 && matches.every(m => m.id !== selector)) {
        // Name matched multiple — warn about ambiguity but include all
        warnings.push(`Automation name '${selector}' matched ${matches.length} automations`)
      }
      for (const m of matches) {
        if (!matched.has(m.id)) {
          matched.add(m.id)
          selected.push(m)
        }
      }
    }
  }

  // Sanitize each entry
  return selected.map(entry => ({
    ...entry,
    matcher: sanitizeAutomationMatcher(
      entry.matcher,
      entry.name ?? entry.id,
      warnings,
    ),
  }))
}

// ============================================================
// Validation
// ============================================================

/**
 * Validate a ResourceBundle structure.
 * Returns { valid, errors } rather than a type guard, so callers get diagnostics.
 */
export function validateResourceBundle(bundle: unknown): { valid: boolean; errors: string[] } {
  const errors: string[] = []

  if (!bundle || typeof bundle !== 'object') {
    return { valid: false, errors: ['Bundle is not an object'] }
  }

  const b = bundle as Record<string, unknown>

  if (b.version !== 1) {
    errors.push(`Unsupported bundle version: ${b.version}`)
  }

  if (typeof b.exportedAt !== 'number') {
    errors.push('Missing or invalid exportedAt')
  }

  if (!b.resources || typeof b.resources !== 'object') {
    errors.push('Missing or invalid resources')
    return { valid: false, errors }
  }

  const res = b.resources as Record<string, unknown>

  // Validate sources
  if (res.sources !== undefined) {
    if (!Array.isArray(res.sources)) {
      errors.push('resources.sources must be an array')
    } else {
      const slugs = new Set<string>()
      for (let i = 0; i < res.sources.length; i++) {
        const entry = res.sources[i]
        const prefix = `sources[${i}]`

        if (!entry || typeof entry !== 'object') {
          errors.push(`${prefix}: not an object`)
          continue
        }

        const e = entry as Record<string, unknown>

        if (typeof e.slug !== 'string' || !e.slug) {
          errors.push(`${prefix}: missing or invalid slug`)
          continue
        }

        if (slugs.has(e.slug as string)) {
          errors.push(`${prefix}: duplicate slug '${e.slug}'`)
        }
        slugs.add(e.slug as string)

        if (!e.config || typeof e.config !== 'object') {
          errors.push(`${prefix}: missing or invalid config`)
        } else {
          const cfg = e.config as Record<string, unknown>
          if (typeof cfg.slug === 'string' && cfg.slug !== e.slug) {
            errors.push(`${prefix}: config.slug '${cfg.slug}' does not match entry slug '${e.slug}'`)
          }
        }

        if (!Array.isArray(e.files)) {
          errors.push(`${prefix}: files must be an array`)
        } else {
          validateFileEntries(e.files as BundleFile[], prefix, errors)
        }
      }
    }
  }

  // Validate skills
  if (res.skills !== undefined) {
    if (!Array.isArray(res.skills)) {
      errors.push('resources.skills must be an array')
    } else {
      const slugs = new Set<string>()
      for (let i = 0; i < res.skills.length; i++) {
        const entry = res.skills[i]
        const prefix = `skills[${i}]`

        if (!entry || typeof entry !== 'object') {
          errors.push(`${prefix}: not an object`)
          continue
        }

        const e = entry as Record<string, unknown>

        if (typeof e.slug !== 'string' || !isValidSkillSlug(e.slug)) {
          errors.push(`${prefix}: missing or invalid slug`)
          continue
        }

        if (slugs.has(e.slug as string)) {
          errors.push(`${prefix}: duplicate slug '${e.slug}'`)
        }
        slugs.add(e.slug as string)

        if (!Array.isArray(e.files)) {
          errors.push(`${prefix}: files must be an array`)
        } else {
          // Validate SKILL.md is present
          const hasSkillMd = (e.files as BundleFile[]).some(f =>
            typeof f === 'object' && f && (f as BundleFile).relativePath === 'SKILL.md',
          )
          const hasInstallReceipt = (e.files as unknown[]).some(file =>
            typeof file === 'object'
              && file !== null
              && typeof (file as Record<string, unknown>).relativePath === 'string'
              && portablePathCollisionKey((file as BundleFile).relativePath)
                === portablePathCollisionKey(SKILL_INSTALL_RECEIPT_FILE),
          )
          if (!hasSkillMd) {
            errors.push(`${prefix}: missing SKILL.md`)
          } else if (hasInstallReceipt) {
            errors.push(`${prefix}: ${SKILL_INSTALL_RECEIPT_FILE} is reserved for local install metadata`)
          } else {
            const skillFile = (e.files as BundleFile[]).find(file => file.relativePath === 'SKILL.md')
            if (skillFile) {
              try {
                const skillDocument = new TextDecoder('utf-8', { fatal: true })
                  .decode(Buffer.from(skillFile.contentBase64, 'base64'))
                const validationError = validateSkillDocumentForSlug(skillDocument, e.slug as string)
                if (validationError) errors.push(`${prefix}: ${validationError}`)
              } catch {
                errors.push(`${prefix}: SKILL.md is not valid UTF-8 content`)
              }
            }
          }
          validateFileEntries(e.files as BundleFile[], prefix, errors)
        }
      }
    }
  }

  // Validate automations
  if (res.automations !== undefined) {
    if (!Array.isArray(res.automations)) {
      errors.push('resources.automations must be an array')
    } else {
      const ids = new Set<string>()
      for (let i = 0; i < res.automations.length; i++) {
        const entry = res.automations[i]
        const prefix = `automations[${i}]`

        if (!entry || typeof entry !== 'object') {
          errors.push(`${prefix}: not an object`)
          continue
        }

        const e = entry as Record<string, unknown>

        if (typeof e.id !== 'string' || !e.id) {
          errors.push(`${prefix}: missing or invalid id`)
          continue
        }

        if (ids.has(e.id as string)) {
          errors.push(`${prefix}: duplicate id '${e.id}'`)
        }
        ids.add(e.id as string)

        if (typeof e.event !== 'string' || !e.event) {
          errors.push(`${prefix}: missing or invalid event`)
        } else if (!VALID_EVENTS.includes(e.event as string)) {
          errors.push(`${prefix}: unknown event type '${e.event}'`)
        }

        if (!e.matcher || typeof e.matcher !== 'object') {
          errors.push(`${prefix}: missing or invalid matcher`)
        } else {
          const m = e.matcher as Record<string, unknown>
          if (!Array.isArray(m.actions) || m.actions.length === 0) {
            errors.push(`${prefix}: matcher must have at least one action`)
          }
        }
      }
    }
  }

  // Validate total bundle size
  try {
    const size = Buffer.byteLength(JSON.stringify(bundle))
    if (size > MAX_BUNDLE_SIZE_BYTES) {
      errors.push(`Bundle size ${size} exceeds max ${MAX_BUNDLE_SIZE_BYTES}`)
    }
  } catch {
    errors.push('Bundle is not serializable')
  }

  return { valid: errors.length === 0, errors }
}

function validateFileEntries(files: BundleFile[], prefix: string, errors: string[]): void {
  const paths = new Set<string>()

  for (let j = 0; j < files.length; j++) {
    const file = files[j]
    if (!file || typeof file !== 'object') {
      errors.push(`${prefix}.files[${j}]: not an object`)
      continue
    }

    // Check for duplicate paths
    const collisionKey = portablePathCollisionKey(file.relativePath)
    if (paths.has(collisionKey)) {
      errors.push(`${prefix}.files[${j}]: duplicate path '${file.relativePath}'`)
    }
    paths.add(collisionKey)

    const fileError = validateBundleFile(file)
    if (fileError) {
      errors.push(`${prefix}.files[${j}]: ${fileError}`)
    }
  }
}

// ============================================================
// Import
// ============================================================

/**
 * Import a ResourceBundle into a target workspace.
 *
 * Uses staging + atomic rename per resource to minimize watcher churn
 * and ensure true replacement on overwrite.
 *
 * @param workspaceRootPath - Absolute path to target workspace
 * @param bundle - The validated ResourceBundle to import
 * @param mode - 'skip' (keep existing) or 'overwrite' (replace)
 * @param deps - Injected dependencies for credential cleanup
 */
export async function importResources(
  workspaceRootPath: string,
  bundle: ResourceBundle,
  mode: ResourceImportMode,
  deps: ResourceImportDeps,
  skillsRootPath = getWorkspaceSkillsPath(workspaceRootPath),
  options: ResourceImportOptions = {},
): Promise<ResourceImportResult> {
  // Validate bundle first
  const validation = validateResourceBundle(bundle)
  if (!validation.valid) {
    const errorMsg = `Invalid bundle: ${validation.errors.join('; ')}`
    return failedImportResult(errorMsg)
  }

  const install = validateImportArtifact(bundle, mode, options)
  if (install.error) {
    return failedImportResult(install.error)
  }

  const workspaceId = basename(workspaceRootPath)

  // Import each resource type
  const sourcesResult = bundle.resources.sources
    ? await importSources(workspaceRootPath, workspaceId, bundle.resources.sources, mode, deps)
    : emptyBucketResult()

  const skillsResult = bundle.resources.skills
    ? importSkills(
        skillsRootPath,
        bundle.resources.skills,
        mode,
        resolve(skillsRootPath) === resolve(getWorkspaceSkillsPath(workspaceRootPath))
          ? workspaceRootPath
          : undefined,
        install.receipt,
      )
    : emptyBucketResult()

  const automationsResult = bundle.resources.automations?.length
    ? await importAutomations(workspaceRootPath, bundle.resources.automations, mode)
    : emptyBucketResult()

  return {
    sources: sourcesResult,
    skills: skillsResult,
    automations: automationsResult,
  }
}

function failedImportResult(error: string): ResourceImportResult {
  const failedBucket = { imported: [], skipped: [], failed: [{ id: '*', error }], warnings: [] }
  return {
    sources: { ...failedBucket },
    skills: { ...failedBucket },
    automations: { ...failedBucket },
  }
}

function validateImportArtifact(
  bundle: ResourceBundle,
  mode: ResourceImportMode,
  options: ResourceImportOptions,
): { receipt?: SkillInstallReceipt; error?: string } {
  const artifact = options.installArtifact
  if (!artifact) return {}
  if (
    !isValidSkillSlug(artifact.slug)
    || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(artifact.version)
    || !/^[a-f0-9]{64}$/.test(artifact.sha256)
    || typeof artifact.raw !== 'string'
  ) return { error: 'Invalid Skill install artifact' }
  if (Buffer.byteLength(artifact.raw) > MAX_SKILL_INSTALL_ARTIFACT_BYTES) {
    return { error: 'Skill install artifact exceeds 5 MB' }
  }
  if (mode !== 'skip') {
    return { error: 'Market install receipts require explicit upgrade, not generic overwrite' }
  }
  if (options.skillScope !== 'project' && options.skillScope !== 'user') {
    return { error: 'Skill install artifact requires an explicit import scope' }
  }
  if (createHash('sha256').update(artifact.raw).digest('hex') !== artifact.sha256) {
    return { error: 'Skill install artifact checksum mismatch' }
  }
  let artifactBundle: ResourceBundle
  try {
    artifactBundle = JSON.parse(artifact.raw) as ResourceBundle
  } catch {
    return { error: 'Skill install artifact is not valid JSON' }
  }
  const artifactValidation = validateResourceBundle(artifactBundle)
  if (!artifactValidation.valid || !isDeepStrictEqual(artifactBundle, bundle)) {
    return { error: 'Skill install artifact does not match the imported bundle' }
  }
  const skills = artifactBundle.resources.skills
  if (
    !Array.isArray(skills)
    || skills.length !== 1
    || skills[0]?.slug !== artifact.slug
    || artifactBundle.resources.sources !== undefined
    || artifactBundle.resources.automations !== undefined
  ) return { error: 'Skill install artifact requires exactly one matching Skill' }
  return {
    receipt: {
      kind: 'skill',
      slug: artifact.slug,
      version: artifact.version,
      sha256: artifact.sha256,
      scope: options.skillScope,
    },
  }
}

function emptyBucketResult(): ImportBucketResult {
  return { imported: [], skipped: [], failed: [], warnings: [] }
}

// ============================================================
// Import: Sources
// ============================================================

async function importSources(
  workspaceRootPath: string,
  workspaceId: string,
  entries: SourceBundleEntry[],
  mode: ResourceImportMode,
  deps: ResourceImportDeps,
): Promise<ImportBucketResult> {
  const result = emptyBucketResult()
  const sourcesDir = ensureProjectOwnedDirectory(
    workspaceRootPath,
    getWorkspaceSourcesPath(workspaceRootPath),
  )

  for (const entry of entries) {
    try {
      assertSafeSourceSlug(entry.slug)
      const targetDir = join(sourcesDir, entry.slug)
      const legacyTargetDir = join(getLegacyWorkspaceSourcesPath(workspaceRootPath), entry.slug)
      const targetExists = existsSync(targetDir)
      const legacyTargetExists = existsSync(legacyTargetDir)
      if (targetExists) resolveProjectOwnedPath(workspaceRootPath, targetDir)
      if (legacyTargetExists) resolveProjectOwnedPath(workspaceRootPath, legacyTargetDir)
      const exists = targetExists || legacyTargetExists

      if (exists && mode === 'skip') {
        result.skipped.push(entry.slug)
        continue
      }

      // Stage: build in temp dir
      const tmpDir = join(sourcesDir, `.tmp-${entry.slug}-${randomUUID().slice(0, 8)}`)
      ensureProjectOwnedDirectory(workspaceRootPath, tmpDir)

      try {
        // Write sanitized config.json
        writeFileSync(join(tmpDir, 'config.json'), JSON.stringify(entry.config, null, 2))

        // Restore all other files
        restoreFiles(tmpDir, entry.files)

        // Validate: config should load correctly
        const validation = validateSourceConfig(entry.config)
        if (!validation.valid) {
          const msgs = validation.errors.map(e => `${e.path}: ${e.message}`).join(', ')
          result.failed.push({ id: entry.slug, error: `Invalid source config: ${msgs}` })
          rmSync(tmpDir, { recursive: true })
          continue
        }

        // On overwrite: clear credentials + remove old dir
        if (exists) {
          // Clear all credential types for this slug
          try {
            await deps.clearSourceCredentials(workspaceId, entry.slug)
          } catch (err) {
            result.warnings.push(`Source '${entry.slug}': failed to clear credentials: ${err}`)
          }
          if (targetExists) rmSync(resolveProjectOwnedPath(workspaceRootPath, targetDir), { recursive: true, force: true })
          if (legacyTargetExists) rmSync(resolveProjectOwnedPath(workspaceRootPath, legacyTargetDir), { recursive: true, force: true })
        }

        // Atomic replace: rename temp → target
        renameSync(tmpDir, targetDir)
        result.imported.push(entry.slug)
      } catch (err) {
        // Clean up temp dir on failure
        if (existsSync(tmpDir)) {
          rmSync(tmpDir, { recursive: true })
        }
        throw err
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      result.failed.push({ id: entry.slug, error: message })
    }
  }

  return result
}

// ============================================================
// Import: Skills
// ============================================================

function importSkills(
  skillsDir: string,
  entries: SkillBundleEntry[],
  mode: ResourceImportMode,
  projectRootPath?: string,
  installReceipt?: SkillInstallReceipt,
): ImportBucketResult {
  const result = emptyBucketResult()

  if (!projectRootPath && !existsSync(skillsDir)) {
    mkdirSync(skillsDir, { recursive: true })
  }

  for (const entry of entries) {
    try {
      const ownedSkillsDir = projectRootPath
        ? ensureProjectOwnedDirectory(projectRootPath, skillsDir)
        : skillsDir
      const targetDir = join(ownedSkillsDir, entry.slug)
      const exists = existsSync(targetDir)
      if (projectRootPath && exists) resolveProjectOwnedPath(projectRootPath, targetDir)

      if (exists && mode === 'skip') {
        result.skipped.push(entry.slug)
        continue
      }

      // Stage: build in temp dir
      const tmpDir = join(ownedSkillsDir, `.tmp-${entry.slug}-${randomUUID().slice(0, 8)}`)
      if (projectRootPath) ensureProjectOwnedDirectory(projectRootPath, tmpDir)
      else mkdirSync(tmpDir, { recursive: true })

      try {
        // Restore all files
        restoreFiles(tmpDir, entry.files)

        // Validate: SKILL.md should exist
        if (!existsSync(join(tmpDir, 'SKILL.md'))) {
          result.failed.push({ id: entry.slug, error: 'SKILL.md missing after restore' })
          rmSync(tmpDir, { recursive: true })
          continue
        }

        if (installReceipt) {
          writeFileSync(
            join(tmpDir, SKILL_INSTALL_RECEIPT_FILE),
            `${JSON.stringify(installReceipt, null, 2)}\n`,
            { flag: 'wx' },
          )
        }

        // On overwrite: remove old dir
        if (exists) {
          rmSync(
            projectRootPath ? resolveProjectOwnedPath(projectRootPath, targetDir) : targetDir,
            { recursive: true, force: true },
          )
        }

        // Atomic replace: rename temp → target
        renameSync(tmpDir, targetDir)
        result.imported.push(entry.slug)
      } catch (err) {
        // Clean up temp dir on failure
        if (existsSync(tmpDir)) {
          rmSync(tmpDir, { recursive: true })
        }
        throw err
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      result.failed.push({ id: entry.slug, error: message })
    }
  }

  return result
}

// ============================================================
// Import: Automations
// ============================================================

/** Display label for an automation entry (name if available, otherwise ID) */
function automationLabel(entry: AutomationBundleEntry): string {
  return entry.name ?? entry.id
}

/**
 * Find a matcher by ID across all event arrays.
 * Returns { event, index } if found, undefined otherwise.
 */
function findMatcherById(
  automations: Record<string, AutomationMatcher[]>,
  id: string,
): { event: string; index: number } | undefined {
  for (const [event, matchers] of Object.entries(automations)) {
    for (let i = 0; i < matchers.length; i++) {
      if (matchers[i]?.id === id) return { event, index: i }
    }
  }
  return undefined
}

/**
 * Filter JSONL file to remove entries matching a set of matcher IDs.
 * Used for selective history/retry-queue cleanup on overwrite.
 */
function filterJsonlByMatcherIds(
  workspaceRootPath: string,
  filePath: string,
  idsToRemove: Set<string>,
): boolean {
  if (idsToRemove.size === 0) return true
  try {
    const ownedFilePath = resolveAutomationOwnedPath(workspaceRootPath, filePath)
    if (!existsSync(ownedFilePath)) return true
    const raw = readFileSync(ownedFilePath, 'utf-8')
    const lines = raw.split('\n')
    const kept: string[] = []

    for (const line of lines) {
      if (!line.trim()) continue
      try {
        const entry = JSON.parse(line)
        if (entry.matcherId && idsToRemove.has(entry.matcherId)) continue
        // History entries use automationId
        if (entry.automationId && idsToRemove.has(entry.automationId)) continue
        kept.push(line)
      } catch {
        // Keep unparseable lines (don't silently drop data)
        kept.push(line)
      }
    }

    writeFileSync(ownedFilePath, kept.length > 0 ? kept.join('\n') + '\n' : '', 'utf-8')
    return true
  } catch {
    // Non-critical: cleanup failure doesn't block import
    return false
  }
}

function importAutomations(
  workspaceRootPath: string,
  entries: AutomationBundleEntry[],
  mode: ResourceImportMode,
): Promise<ImportBucketResult> {
  return withRetryQueueMutation(
    workspaceRootPath,
    () => importAutomationsUnlocked(workspaceRootPath, entries, mode),
  )
}

function importAutomationsUnlocked(
  workspaceRootPath: string,
  entries: AutomationBundleEntry[],
  mode: ResourceImportMode,
): ImportBucketResult {
  const result = emptyBucketResult()
  let configPath: string
  try {
    configPath = resolveAutomationOwnedPath(
      workspaceRootPath,
      join(workspaceRootPath, AUTOMATIONS_CONFIG_FILE),
    )
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    for (const entry of entries) result.failed.push({ id: automationLabel(entry), error })
    return result
  }

  // Read existing config (if present)
  let existingConfig: { version?: number; automations: Record<string, AutomationMatcher[]> }

  if (existsSync(configPath)) {
    try {
      const raw = JSON.parse(readFileSync(configPath, 'utf-8'))
      const validation = validateAutomationsConfig(raw)
      if (validation.valid && validation.config) {
        existingConfig = {
          version: (raw as Record<string, unknown>).version as number | undefined,
          automations: validation.config.automations as Record<string, AutomationMatcher[]>,
        }
      } else if (mode === 'overwrite') {
        // Existing config is invalid but we're overwriting — start fresh
        result.warnings.push('Existing automations.json is invalid, starting fresh in overwrite mode')
        existingConfig = { version: 2, automations: {} }
      } else {
        // Skip mode + invalid existing config — can't safely merge
        const errorMsg = `Cannot merge into invalid existing automations.json: ${validation.errors.join('; ')}`
        for (const entry of entries) {
          result.failed.push({ id: automationLabel(entry), error: errorMsg })
        }
        return result
      }
    } catch (err) {
      if (mode === 'overwrite') {
        result.warnings.push(`Existing automations.json is unreadable (${err}), starting fresh in overwrite mode`)
        existingConfig = { version: 2, automations: {} }
      } else {
        const errorMsg = `Cannot read existing automations.json: ${err}`
        for (const entry of entries) {
          result.failed.push({ id: automationLabel(entry), error: errorMsg })
        }
        return result
      }
    }
  } else {
    // No existing file — create new
    existingConfig = { version: 2, automations: {} }
  }

  const overwrittenIds = new Set<string>()

  // Merge entries
  for (const entry of entries) {
    // Backfill ID if missing
    const id = entry.id || generateShortId()
    const matcher: AutomationMatcher = { ...entry.matcher, id }
    const label = entry.name ?? id

    // Check if automation with this ID already exists
    const existing = findMatcherById(existingConfig.automations, id)

    if (existing) {
      if (mode === 'skip') {
        result.skipped.push(label)
        continue
      }
      // Overwrite: remove old, insert new at same position
      existingConfig.automations[existing.event]!.splice(existing.index, 1)
      // Clean up empty event arrays
      if (existingConfig.automations[existing.event]!.length === 0) {
        delete existingConfig.automations[existing.event]
      }
      overwrittenIds.add(id)
    }

    // Insert into the target event's matcher array
    if (!existingConfig.automations[entry.event]) {
      existingConfig.automations[entry.event] = []
    }
    existingConfig.automations[entry.event]!.push(matcher)
    result.imported.push(label)
  }

  // Validate the merged full config (schema + semantic: regex, cron, timezone, conditions)
  const mergedValidation = validateAutomationsConfig({
    version: existingConfig.version,
    automations: existingConfig.automations,
  })

  if (!mergedValidation.valid) {
    // Reject the entire import — merged config is invalid
    const errorMsg = `Merged automations config is invalid: ${mergedValidation.errors.join('; ')}`
    result.imported = []
    result.skipped = []
    for (const entry of entries) {
      result.failed.push({ id: automationLabel(entry), error: errorMsg })
    }
    return result
  }

  const retryPath = join(workspaceRootPath, AUTOMATIONS_RETRY_QUEUE_FILE)
  let retrySnapshot: string | null = null
  if (overwrittenIds.size > 0) {
    try {
      const ownedRetryPath = resolveAutomationOwnedPath(workspaceRootPath, retryPath)
      retrySnapshot = existsSync(ownedRetryPath) ? readFileSync(ownedRetryPath, 'utf-8') : null
    } catch {
      const error = 'Automation retry cleanup failed; import was not committed'
      result.imported = []
      for (const entry of entries) result.failed.push({ id: automationLabel(entry), error })
      return result
    }
    if (!filterJsonlByMatcherIds(workspaceRootPath, retryPath, overwrittenIds)) {
      const error = 'Automation retry cleanup failed; import was not committed'
      result.imported = []
      for (const entry of entries) result.failed.push({ id: automationLabel(entry), error })
      return result
    }
  }

  // Write atomically: temp file + rename
  try {
    const configObj = {
      version: existingConfig.version ?? 2,
      automations: existingConfig.automations,
    }
    const tmpPath = configPath + `.tmp-${randomUUID().slice(0, 8)}`
    writeFileSync(tmpPath, JSON.stringify(configObj, null, 2) + '\n', 'utf-8')
    renameSync(tmpPath, configPath)
  } catch (err) {
    let restoreError = ''
    if (overwrittenIds.size > 0) {
      try {
        const ownedRetryPath = resolveAutomationOwnedPath(workspaceRootPath, retryPath)
        if (retrySnapshot === null) rmSync(ownedRetryPath, { force: true })
        else writeFileSync(ownedRetryPath, retrySnapshot, 'utf-8')
      } catch (restoreErr) {
        restoreError = `; failed to restore automation retry queue: ${restoreErr}`
      }
    }
    const errorMsg = `Failed to write automations.json: ${err}${restoreError}`
    result.imported = []
    for (const entry of entries) {
      result.failed.push({ id: automationLabel(entry), error: errorMsg })
    }
    return result
  }

  // Selectively clear history + retry queue for overwritten matcher IDs
  if (overwrittenIds.size > 0) {
    const historyPath = join(workspaceRootPath, AUTOMATIONS_HISTORY_FILE)
    const historyCleanupSucceeded = filterJsonlByMatcherIds(
      workspaceRootPath,
      historyPath,
      overwrittenIds,
    )
    result.warnings.push(historyCleanupSucceeded
      ? `Cleared history/retry entries for ${overwrittenIds.size} overwritten automation(s)`
      : `Automation history cleanup failed for ${overwrittenIds.size} overwritten automation(s)`)
  }

  return result
}
