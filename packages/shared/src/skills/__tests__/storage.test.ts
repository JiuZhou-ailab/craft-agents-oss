// input: Pi user and legacy Skill fixtures, invalid documents, caches, and symlinks
// output: Regression coverage for compatibility reads and canonical user mutations
// pos: Synchronous compatibility boundary beneath Pi-native project discovery

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolveResourceRoots } from '../../resources/resolver.ts';
import {
  createSkill,
  deleteSkill,
  getPiUserSkillsDir,
  invalidateSkillsCache,
  isValidSkillSlug,
  listSkillSlugs,
  loadAllSkills,
  loadSkill,
  skillExists,
} from '../storage.ts';

const globalSkillsDir = resolveResourceRoots().skillsPath;
const userSkillsDir = getPiUserSkillsDir();
const testPrefix = `test-global-skills-${process.pid}-`;
const touchedGlobalPaths = new Set<string>();
let tempDir: string;

function writeSkill(
  skillsDir: string,
  slug: string,
  options: {
    description?: string;
    content?: string;
    requiredSources?: unknown;
  } = {},
): string {
  const skillDir = join(skillsDir, slug);
  mkdirSync(skillDir, { recursive: true });
  const requiredSources = options.requiredSources === undefined
    ? ''
    : `\nrequiredSources: ${JSON.stringify(options.requiredSources)}`;
  writeFileSync(join(skillDir, 'SKILL.md'), `---
name: ${slug}
description: ${options.description ?? `Test Skill ${slug}`}${requiredSources}
---

${options.content ?? `Instructions for ${slug}.`}
`);
  return skillDir;
}

function globalSlug(suffix: string): string {
  return `${testPrefix}${suffix}`;
}

beforeEach(() => {
  invalidateSkillsCache();
  tempDir = mkdtempSync(join(tmpdir(), 'storyflow-global-skills-'));
});

afterEach(() => {
  invalidateSkillsCache();
  for (const path of touchedGlobalPaths) {
    rmSync(path, { recursive: true, force: true });
  }
  touchedGlobalPaths.clear();
  rmSync(tempDir, { recursive: true, force: true });
});

describe('global Skill storage', () => {
  it('loads only global Skills and normalizes required Sources', () => {
    const slug = globalSlug('load');
    touchedGlobalPaths.add(writeSkill(globalSkillsDir, slug, {
      requiredSources: ['linear', ' github ', 'linear', 123],
    }));
    writeSkill(join(tempDir, '.pi', 'skills'), slug, {
      description: 'Ignored project definition',
    });

    const skill = loadSkill(slug);

    expect(skill?.path).toBe(join(globalSkillsDir, slug));
    expect(skill?.metadata.requiredSources).toEqual(['linear', 'github']);
    expect(loadAllSkills().filter(candidate => candidate.slug === slug)).toHaveLength(1);
  });

  it('ignores invalid documents and symlinked Skill trees', () => {
    const invalidSlug = globalSlug('invalid');
    const symlinkSlug = globalSlug('symlink');
    const outside = writeSkill(tempDir, symlinkSlug);
    const invalidDir = join(globalSkillsDir, invalidSlug);
    mkdirSync(invalidDir, { recursive: true });
    writeFileSync(join(invalidDir, 'SKILL.md'), '# Missing frontmatter');
    touchedGlobalPaths.add(invalidDir);
    const symlinkPath = join(globalSkillsDir, symlinkSlug);
    symlinkSync(outside, symlinkPath, 'dir');
    touchedGlobalPaths.add(symlinkPath);

    expect(loadSkill(invalidSlug)).toBeNull();
    expect(loadSkill(symlinkSlug)).toBeNull();
  });

  it('invalidates cached metadata after a global change', () => {
    const slug = globalSlug('cache');
    touchedGlobalPaths.add(writeSkill(globalSkillsDir, slug, {
      description: 'Before',
    }));
    expect(loadAllSkills().find(skill => skill.slug === slug)?.metadata.description).toBe('Before');

    writeSkill(globalSkillsDir, slug, { description: 'After' });
    expect(loadAllSkills().find(skill => skill.slug === slug)?.metadata.description).toBe('Before');

    invalidateSkillsCache();
    expect(loadAllSkills().find(skill => skill.slug === slug)?.metadata.description).toBe('After');
  });

  it('creates once, lists, and deletes from Pi user storage', () => {
    const slug = globalSlug('mutation');
    const content = `---
name: ${slug}
description: Created globally
---

Use globally.
`;
    touchedGlobalPaths.add(join(userSkillsDir, slug));

    const created = createSkill(slug, content);

    expect(created.path).toBe(join(userSkillsDir, slug));
    expect(skillExists(slug)).toBe(true);
    expect(listSkillSlugs()).toContain(slug);
    expect(() => createSkill(slug, content)).toThrow('already exists');
    expect(deleteSkill(slug)).toBe(true);
    expect(skillExists(slug)).toBe(false);
    expect(deleteSkill(slug)).toBe(false);
  });
});

describe('isValidSkillSlug', () => {
  it('accepts Agent Skills identifiers and rejects traversal input', () => {
    expect(isValidSkillSlug('outline-architecture')).toBe(true);
    expect(isValidSkillSlug('../outside')).toBe(false);
    expect(isValidSkillSlug('nested/skill')).toBe(false);
    expect(isValidSkillSlug('Uppercase')).toBe(false);
    expect(isValidSkillSlug('a'.repeat(64))).toBe(true);
    expect(isValidSkillSlug('a'.repeat(65))).toBe(false);
  });
});
