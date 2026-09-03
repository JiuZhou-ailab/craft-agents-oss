// input: Temporary project plus a third-party ~/.agents Source fixture
// output: Proof that SessionToolContext enforces current Host grants and Storyflow-owned roots
// pos: Regression tests for Resource Resolver ownership and live execution revocation

import { afterEach, describe, expect, it } from 'bun:test';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SourceConfig } from '@craft-agent/session-tools-core';
import { createSessionToolContext } from '../session-tool-context.ts';
import { PiAgentToolHost } from '../pi-agent-tool-host.ts';
import { getPiUserSkillsDir } from '../../skills/storage.ts';
import {
  SHARED_AGENTS_SOURCES_DIR,
  loadSource,
} from '../../sources/storage.ts';
import { getSourceGrantRef } from '../../sources/grants.ts';

const TEST_PREFIX = `pi-context-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const touchedPaths = new Set<string>();

afterEach(() => {
  for (const path of touchedPaths) {
    rmSync(path, { recursive: true, force: true });
  }
  touchedPaths.clear();
});

describe('Pi SessionToolContext Source ownership', () => {
  it('rechecks the pool-bound exact capability before every MCP proxy execution', async () => {
    const sourceSlug = 'project__source';
    const poolCapabilityRef = `workspace:${sourceSlug}:definition-1`;
    let currentCapabilityRef = poolCapabilityRef;
    let granted = true;
    let stdioAllowed = true;
    let calls = 0;
    const host = Object.create(PiAgentToolHost.prototype) as Record<string, unknown>;
    host.config = {
      mcpPool: {
        getProxyToolCapability: () => ({ sourceSlug, capabilityRef: poolCapabilityRef }),
        callTool: async () => {
          calls++;
          return { content: 'ok', isError: false };
        },
      },
    };
    host.getSessionToolContext = () => ({
      isSourceExecutionAllowed: () => granted,
      isStdioMcpExecutionAllowed: (candidateSlug: string, capabilityRef?: string) => (
        granted
        && stdioAllowed
        && candidateSlug === sourceSlug
        && capabilityRef === currentCapabilityRef
      ),
    });
    const routeToolCall = (PiAgentToolHost.prototype as unknown as {
      routeToolCall(toolName: string, args: Record<string, unknown>): Promise<{ content: string; isError: boolean }>;
    }).routeToolCall.bind(host);

    const toolName = `mcp__${sourceSlug}__run`;
    await expect(routeToolCall(toolName, {})).resolves.toEqual({ content: 'ok', isError: false });
    currentCapabilityRef = `workspace:${sourceSlug}:definition-2`;
    await expect(routeToolCall(toolName, {})).resolves.toEqual({
      content: `Source "${sourceSlug}" is disabled by Host settings.`,
      isError: true,
    });
    currentCapabilityRef = poolCapabilityRef;
    granted = false;
    await expect(routeToolCall(toolName, {})).resolves.toEqual({
      content: `Source "${sourceSlug}" is disabled by Host settings.`,
      isError: true,
    });
    granted = true;
    stdioAllowed = false;
    await expect(routeToolCall(toolName, {})).resolves.toEqual({
      content: `Source "${sourceSlug}" is disabled by Host settings.`,
      isError: true,
    });
    expect(calls).toBe(1);
  });

  it('does not discover a Source from ~/.agents implicitly', () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), `${TEST_PREFIX}-workspace-`));
    const slug = `${TEST_PREFIX}-shared`;
    const sharedSourceDir = join(SHARED_AGENTS_SOURCES_DIR, slug);
    const sharedConfigPath = join(sharedSourceDir, 'config.json');
    touchedPaths.add(workspaceRoot);
    touchedPaths.add(sharedSourceDir);

    mkdirSync(sharedSourceDir, { recursive: true });
    writeFileSync(sharedConfigPath, JSON.stringify({
      id: `${slug}-id`,
      slug,
      name: 'Externally Owned',
      enabled: false,
      provider: 'test',
      type: 'mcp',
      mcp: { transport: 'stdio', command: 'echo' },
    }, null, 2));
    const originalDefinition = readFileSync(sharedConfigPath);

    const context = createSessionToolContext({
      sessionId: 'test-session',
      workspaceId: 'test-workspace',
      workspacePath: workspaceRoot,
      getHostGrantedSourceRefs: () => [],
      getHostAllowsProjectStdio: () => false,
      onPlanSubmitted: () => {},
      onAuthRequest: () => {},
    });
    expect(context.loadSourceConfig(slug)).toBeUndefined();
    expect(context.isSourceDefinitionReadOnly?.(slug)).toBe(false);
    expect(readFileSync(sharedConfigPath)).toEqual(originalDefinition);
  });

  it('creates and resolves Skills globally from every project context', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), `${TEST_PREFIX}-skills-`));
    const slug = `${TEST_PREFIX}-global-skill`;
    const globalSkillDir = join(getPiUserSkillsDir(), slug);
    touchedPaths.add(workspaceRoot);
    touchedPaths.add(globalSkillDir);

    const projectContext = createSessionToolContext({
      sessionId: 'project-session',
      workspaceId: 'project-workspace',
      workspacePath: workspaceRoot,
      getHostGrantedSourceRefs: () => [],
      getHostAllowsProjectStdio: () => false,
      onPlanSubmitted: () => {},
      onAuthRequest: () => {},
    });
    const content = `---
name: ${slug}
description: "Check a project when asked."
---

# Project check

Inspect the current project evidence.
`;
    const created = await projectContext.createSkillDocument?.(slug, content);
    expect(created?.path).toBe(join(globalSkillDir, 'SKILL.md'));
    expect(projectContext.loadSkillDocument?.(slug)?.content).toBe(content);
    expect(projectContext.skillsPath).toBe(getPiUserSkillsDir());
  });

  it('requires the exact Host grant and stable Project identity for Source execution', () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), `${TEST_PREFIX}-grant-`));
    const sourceSlug = `${TEST_PREFIX}-project-source`;
    const sourceDir = join(workspaceRoot, '.craft-agent', 'sources', sourceSlug);
    const configPath = join(sourceDir, 'config.json');
    touchedPaths.add(workspaceRoot);
    mkdirSync(sourceDir, { recursive: true });
    writeFileSync(configPath, JSON.stringify({
      id: 'source-id',
      slug: sourceSlug,
      name: 'Project Source',
      enabled: true,
      isAuthenticated: true,
      connectionStatus: 'connected',
      provider: 'test',
      type: 'api',
      api: { baseUrl: 'https://first.example', authType: 'bearer' },
    }));

    const loaded = loadSource(workspaceRoot, sourceSlug, 'project-stable');
    expect(loaded?.workspaceId).toBe('project-stable');
    const exactRef = getSourceGrantRef(loaded!);
    let liveRefs = [exactRef];
    const denied = createSessionToolContext({
      sessionId: 'denied-session',
      workspaceId: 'project-stable',
      workspacePath: workspaceRoot,
      getHostGrantedSourceRefs: () => [],
      getHostAllowsProjectStdio: () => false,
      onPlanSubmitted: () => {},
      onAuthRequest: () => {},
    });
    const granted = createSessionToolContext({
      sessionId: 'granted-session',
      workspaceId: 'project-stable',
      workspacePath: workspaceRoot,
      getHostGrantedSourceRefs: () => liveRefs,
      getHostAllowsProjectStdio: () => false,
      onPlanSubmitted: () => {},
      onAuthRequest: () => {},
    });

    expect(denied.isSourceExecutionAllowed(sourceSlug)).toBe(false);
    expect(granted.isSourceExecutionAllowed(sourceSlug)).toBe(true);

    liveRefs = [];
    expect(granted.isSourceExecutionAllowed(sourceSlug)).toBe(false);
    liveRefs = [exactRef];

    const revoked = JSON.parse(readFileSync(configPath, 'utf-8'));
    revoked.isAuthenticated = false;
    revoked.connectionStatus = 'needs_auth';
    writeFileSync(configPath, JSON.stringify(revoked));
    expect(granted.isSourceExecutionAllowed(sourceSlug)).toBe(true);

    const replacement = { ...revoked, isAuthenticated: true, connectionStatus: 'connected' };
    replacement.api.baseUrl = 'https://replacement.example';
    writeFileSync(configPath, JSON.stringify(replacement));
    expect(granted.isSourceExecutionAllowed(sourceSlug)).toBe(false);
    expect(() => granted.saveSourceConfig?.({
      ...loaded!.config,
      connectionStatus: 'connected',
    } as SourceConfig)).toThrow('Source definition changed while testing');
    expect(JSON.parse(readFileSync(configPath, 'utf-8')).api.baseUrl)
      .toBe('https://replacement.example');
  });

  it('reads the current Host stdio grant for every execution attempt', () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), `${TEST_PREFIX}-stdio-grant-`));
    const sourceSlug = `${TEST_PREFIX}-project-stdio`;
    const sourceDir = join(workspaceRoot, '.craft-agent', 'sources', sourceSlug);
    touchedPaths.add(workspaceRoot);
    mkdirSync(sourceDir, { recursive: true });
    writeFileSync(join(sourceDir, 'config.json'), JSON.stringify({
      id: 'stdio-source-id',
      slug: sourceSlug,
      name: 'Project stdio Source',
      enabled: true,
      provider: 'test',
      type: 'mcp',
      mcp: { transport: 'stdio', command: 'echo' },
    }));

    const loaded = loadSource(workspaceRoot, sourceSlug, 'project-stable');
    const exactRef = getSourceGrantRef(loaded!);
    let liveRefs = [exactRef];
    let hostAllowsProjectStdio = true;
    const context = createSessionToolContext({
      sessionId: 'stdio-session',
      workspaceId: 'project-stable',
      workspacePath: workspaceRoot,
      getHostGrantedSourceRefs: () => liveRefs,
      getHostAllowsProjectStdio: () => hostAllowsProjectStdio,
      onPlanSubmitted: () => {},
      onAuthRequest: () => {},
    });

    expect(context.isStdioMcpExecutionAllowed?.(sourceSlug, exactRef)).toBe(true);
    hostAllowsProjectStdio = false;
    expect(context.isStdioMcpExecutionAllowed?.(sourceSlug, exactRef)).toBe(false);
    hostAllowsProjectStdio = true;

    const replacement = JSON.parse(readFileSync(join(sourceDir, 'config.json'), 'utf-8'));
    replacement.mcp.command = 'replacement-command';
    writeFileSync(join(sourceDir, 'config.json'), JSON.stringify(replacement));
    liveRefs = [getSourceGrantRef(loadSource(workspaceRoot, sourceSlug, 'project-stable')!)];

    expect(context.isStdioMcpExecutionAllowed?.(sourceSlug, exactRef)).toBe(false);
    expect(context.isStdioMcpExecutionAllowed?.(sourceSlug, liveRefs[0])).toBe(true);
  });
});
