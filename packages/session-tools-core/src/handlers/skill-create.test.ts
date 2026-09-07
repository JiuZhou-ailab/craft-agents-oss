// input: In-memory Storyflow Skill store callbacks and candidate SKILL.md documents
// output: Proof that conversational creation validates, creates once, and validates globally
// pos: Small regression check for the mutating Skill session-tool boundary

import { describe, expect, it } from 'bun:test';
import type { SessionToolContext, SkillDocument } from '../context.ts';
import { handleSkillCreate } from './skill-create.ts';
import { handleSkillValidate } from './skill-validate.ts';

const VALID_SKILL = `---
name: release-check
description: "Check a release when the user asks whether it is ready."
---

# Release check

Verify the current release evidence before reporting readiness.
`;

function createContext(): SessionToolContext {
  const skills = new Map<string, SkillDocument>();
  return {
    sessionId: 'session-1',
    workspacePath: '/product/runtime/free',
    workspaceId: 'free-conversations',
    get sourcesPath() { return '/product/runtime/free/sources'; },
    get skillsPath() { return '/product/skills'; },
    plansFolderPath: '/product/runtime/free/plans',
    callbacks: {
      onPlanSubmitted: () => {},
      onAuthRequest: () => {},
    },
    fs: {
      exists: () => false,
      readFile: () => { throw new Error('unexpected fallback read'); },
      readFileBuffer: () => Buffer.from(''),
      writeFile: () => {},
      isDirectory: () => false,
      readdir: () => [],
      stat: () => ({ size: 0, isDirectory: () => false }),
    },
    loadSourceConfig: () => null,
    resolveSourcePath: () => null,
    isSourceExecutionAllowed: () => false,
    createSkillDocument: (slug, content) => {
      if (skills.has(slug)) throw new Error(`Skill already exists: ${slug}`);
      const document = {
        path: `/product/skills/${slug}/SKILL.md`,
        content,
      };
      skills.set(slug, document);
      return document;
    },
    loadSkillDocument: (slug) => skills.get(slug) ?? null,
  };
}

describe('skill_create', () => {
  it('creates a confirmed valid global document once and validates it', async () => {
    const ctx = createContext();

    const created = await handleSkillCreate(ctx, {
      skillSlug: 'release-check',
      content: VALID_SKILL,
    });
    expect(created.isError).not.toBe(true);
    expect(created.content[0]?.text).toContain('/product/skills/release-check/SKILL.md');

    const validated = await handleSkillValidate(ctx, {
      skillSlug: 'release-check',
    });
    expect(validated.isError).toBe(false);
    expect(validated.content[0]?.text).toContain('Validation passed');

    const duplicate = await handleSkillCreate(ctx, {
      skillSlug: 'release-check',
      content: VALID_SKILL,
    });
    expect(duplicate.isError).toBe(true);
    expect(duplicate.content[0]?.text).toContain('already exists');
  });

  it('rejects invalid content before calling the store', async () => {
    let createCalls = 0;
    const ctx = createContext();
    ctx.createSkillDocument = () => {
      createCalls += 1;
      throw new Error('should not run');
    };

    const result = await handleSkillCreate(ctx, {
      skillSlug: 'release-check',
      content: '# Missing frontmatter',
    });

    expect(result.isError).toBe(true);
    expect(createCalls).toBe(0);
  });

  it('reports global store errors', async () => {
    const ctx = createContext();
    ctx.createSkillDocument = () => {
      throw new Error('Global Skill store unavailable');
    };

    const result = await handleSkillCreate(ctx, {
      skillSlug: 'release-check',
      content: VALID_SKILL,
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('Global Skill store unavailable');
  });
});
