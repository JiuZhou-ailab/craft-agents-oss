/**
 * Skills Storage
 *
 * input: Pi user Skill directory, legacy Storyflow directory, and SKILL.md documents
 * output: Compatibility Skill discovery and canonical user mutation operations
 * pos: Synchronous compatibility API; workspace discovery lives in pi-catalog.ts
 */

import {
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
  lstatSync,
  mkdirSync,
  writeFileSync,
} from 'fs';
import { join } from 'path';
import matter from 'gray-matter';
import {
  SkillMetadataSchema,
  validateSkillContent,
  validateSkillSlug,
} from '@craft-agent/session-tools-core';
import type {
  LoadedSkill,
  SkillMetadata,
} from './types.ts';
import { resolveResourceRoots } from '../resources/resolver.ts';
import { assertSymlinkFreeTree } from '../workspaces/paths.ts';
import { getPiAgentDir } from '../config/pi-user-paths.ts';
import {
  validateIconValue,
  findIconFile,
  downloadIcon,
  needsIconDownload,
} from '../utils/icon.ts';

/**
 * Normalize requiredSources frontmatter to a clean string array.
 * Accepts a single string or array of strings, trims whitespace, and deduplicates.
 */
function normalizeRequiredSources(value: unknown): string[] | undefined {
  const asArray = typeof value === 'string'
    ? [value]
    : Array.isArray(value)
      ? value
      : undefined;

  if (!asArray) return undefined;

  const normalized = Array.from(new Set(
    asArray
      .filter((entry): entry is string => typeof entry === 'string')
      .map(entry => entry.trim())
      .filter(Boolean)
  ));

  return normalized.length > 0 ? normalized : undefined;
}

// ============================================================
// Parsing
// ============================================================

/**
 * Parse SKILL.md content and extract frontmatter + body
 */
export function parseSkillFile(content: string): { metadata: SkillMetadata; body: string } | null {
  try {
    const parsed = matter(content);
    const metadataResult = SkillMetadataSchema.safeParse(parsed.data);
    if (!metadataResult.success) return null;
    const data = metadataResult.data;

    // Validate and extract optional icon field
    // Only accepts emoji or URL - rejects inline SVG and relative paths
    const icon = validateIconValue(data.icon, 'Skills');

    return {
      metadata: {
        name: data.name,
        displayName: data.metadata?.displayName,
        description: data.description,
        globs: data.globs,
        alwaysAllow: data.alwaysAllow,
        icon,
        requiredSources: normalizeRequiredSources(data.requiredSources),
      },
      body: parsed.content,
    };
  } catch {
    return null;
  }
}

/** Validate that a portable SKILL.md belongs to the directory slug that will contain it. */
export function validateSkillDocumentForSlug(content: string, slug: string): string | null {
  const result = validateSkillContent(content, slug);
  return result.valid ? null : (result.errors[0]?.message ?? 'Invalid SKILL.md');
}

// ============================================================
// Load Operations
// ============================================================

/**
 * Load a single skill from a directory
 * @param skillsDir - Absolute path to skills directory
 * @param slug - Skill directory name
 * @param source - Where this skill is loaded from
 */
function loadSkillFromDir(
  skillsDir: string,
  slug: string,
): LoadedSkill | null {
  if (!isValidSkillSlug(slug)) return null;

  const skillDir = join(skillsDir, slug);
  const skillFile = join(skillDir, 'SKILL.md');

  // Check directory exists
  if (!existsSync(skillDir) || !lstatSync(skillDir).isDirectory()) {
    return null;
  }

  try {
    assertSymlinkFreeTree(skillDir);
  } catch {
    return null;
  }

  // Check SKILL.md exists
  if (!existsSync(skillFile)) {
    return null;
  }

  // Read and parse SKILL.md
  let content: string;
  try {
    content = readFileSync(skillFile, 'utf-8');
  } catch {
    return null;
  }

  if (!validateSkillContent(content, slug).valid) return null;
  const parsed = parseSkillFile(content);
  if (!parsed) {
    return null;
  }

  return {
    slug,
    metadata: parsed.metadata,
    content: parsed.body,
    iconPath: findIconFile(skillDir),
    path: skillDir,
    filePath: skillFile,
    scope: 'user',
    source: 'storyflow-compat',
    origin: 'top-level',
  };
}

/**
 * Load all skills from a directory
 * @param skillsDir - Absolute path to skills directory
 * @param source - Where these skills are loaded from
 */
function loadSkillsFromDir(
  skillsDir: string,
): LoadedSkill[] {
  if (!existsSync(skillsDir)) {
    return [];
  }

  const skills: LoadedSkill[] = [];

  try {
    const entries = readdirSync(skillsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const skill = loadSkillFromDir(skillsDir, entry.name);
      if (skill) {
        skills.push(skill);
      }
    }
  } catch {
    // Ignore errors reading skills directory
  }

  return skills;
}

/**
 * Load a single global Skill.
 * @param slug - Skill directory name
 */
export function loadSkill(slug: string): LoadedSkill | null {
  if (!isValidSkillSlug(slug)) return null;
  return loadSkillFromDir(getPiUserSkillsDir(), slug)
    ?? loadSkillFromDir(resolveResourceRoots().skillsPath, slug);
}

// ── Skills cache ────────────────────────────────────────────────────────
// The result rarely changes during a session and is invalidated by the global watcher.

let skillsCache: LoadedSkill[] | undefined;

/** Invalidate the Skills cache after a global Skill file event. */
export function invalidateSkillsCache(): void {
  skillsCache = undefined;
}

/**
 * Load all global Skills.
 */
export function loadAllSkills(): LoadedSkill[] {
  if (skillsCache) return skillsCache;
  const skills = [
    ...loadSkillsFromDir(getPiUserSkillsDir()),
    ...loadSkillsFromDir(resolveResourceRoots().skillsPath),
  ];
  skillsCache = Array.from(
    new Map(skills.map(skill => [skill.slug, skill])).values(),
  );
  return skillsCache;
}

/**
 * Get icon path for a skill
 * @param slug - Skill directory name
 */
export function getSkillIconPath(
  slug: string,
): string | null {
  const skillDir = loadSkill(slug)?.path;
  return skillDir ? findIconFile(skillDir) || null : null;
}

// ============================================================
// Mutation Operations
// ============================================================

/**
 * Create a global Skill. Existing definitions are never overwritten.
 */
export function createSkill(
  slug: string,
  content: string,
): LoadedSkill {
  const validationError = validateSkillDocumentForSlug(content, slug);
  if (validationError) throw new Error(validationError);

  const targetDirectory = getPiUserSkillsDir();
  mkdirSync(targetDirectory, { recursive: true });

  const skillDir = join(targetDirectory, slug);
  if (existsSync(skillDir)) throw new Error(`Skill already exists: ${slug}`);

  mkdirSync(skillDir);
  writeFileSync(join(skillDir, 'SKILL.md'), content, { encoding: 'utf-8', flag: 'wx' });
  invalidateSkillsCache();

  const skill = loadSkill(slug);
  if (!skill) throw new Error(`Failed to load created Skill: ${slug}`);
  return skill;
}

/**
 * Delete a global Skill definition.
 * @param slug - Skill directory name
 */
export function deleteSkill(slug: string): boolean {
  if (!isValidSkillSlug(slug)) return false;

  const skill = loadSkill(slug);
  if (!skill) return false;

  try {
    const mutableRoots = [
      getPiUserSkillsDir(),
      resolveResourceRoots().skillsPath,
    ];
    if (!mutableRoots.some(root => skill.path === join(root, slug))) return false;
    assertSymlinkFreeTree(skill.path);
    rmSync(skill.path, { recursive: true });
    invalidateSkillsCache();
    return true;
  } catch {
    return false;
  }
}

// ============================================================
// Utility Functions
// ============================================================

/**
 * Check if a global Skill exists.
 * @param slug - Skill directory name
 */
export function skillExists(slug: string): boolean {
  return !!loadSkill(slug);
}

/** Agent Skills-compatible slug guard used before joining untrusted input. */
export function isValidSkillSlug(slug: string): boolean {
  return validateSkillSlug(slug).valid;
}

/** Canonical user Skill directory shared with Pi and skills.sh installers. */
export function getPiUserSkillsDir(): string {
  return join(getPiAgentDir(), 'skills');
}

/**
 * List global Skill slugs.
 */
export function listSkillSlugs(): string[] {
  return loadAllSkills().map((skill) => skill.slug);
}

// ============================================================
// Icon Download (uses shared utilities)
// ============================================================

/**
 * Download an icon from a URL and save it to the skill directory.
 * Returns the path to the downloaded icon, or null on failure.
 */
export async function downloadSkillIcon(
  skillDir: string,
  iconUrl: string
): Promise<string | null> {
  return downloadIcon(skillDir, iconUrl, 'Skills');
}

/**
 * Check if a skill needs its icon downloaded.
 * Returns true if metadata has a URL icon and no local icon file exists.
 */
export function skillNeedsIconDownload(skill: LoadedSkill): boolean {
  return needsIconDownload(skill.metadata.icon, skill.iconPath);
}

// Re-export icon utilities for convenience
export { isIconUrl } from '../utils/icon.ts';
