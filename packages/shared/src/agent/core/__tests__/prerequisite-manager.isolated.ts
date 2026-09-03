// input: Source prerequisite fixtures and tool-call events
// output: Prerequisite tracking and reset behavior assertions
// pos: Isolated regression test for host capability prerequisites

/**
 * Tests for PrerequisiteManager
 *
 * Tests the prerequisite reading system that blocks tool calls
 * until required files (like guide.md) have been read.
 */
import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve, join } from 'node:path';
import { PrerequisiteManager } from '../prerequisite-manager.ts';

// Mock existsSync to control guide.md existence
const originalExistsSync = existsSync;
let mockExistsPaths: Set<string> = new Set();

mock.module('node:fs', () => ({
  existsSync: (path: string) => mockExistsPaths.has(path),
  // Re-export anything else the module needs
  readFileSync: originalExistsSync,
}));

const WORKSPACE_ROOT = '/test/workspace';

function guidePath(slug: string): string {
  return resolve(WORKSPACE_ROOT, 'sources', slug, 'guide.md');
}

function browserDocPath(): string {
  return resolve(join(homedir(), '.craft-agent', 'docs', 'browser-tools.md'));
}

describe('PrerequisiteManager', () => {
  let manager: PrerequisiteManager;
  let debugMessages: string[];

  beforeEach(() => {
    debugMessages = [];
    mockExistsPaths = new Set();
    manager = new PrerequisiteManager({
      workspaceRootPath: WORKSPACE_ROOT,
      onDebug: (msg) => debugMessages.push(msg),
    });
  });

  // ============================================================
  // Rule Matching
  // ============================================================

  describe('rule matching', () => {
    it('matches MCP source tools (mcp__{slug}__{tool})', () => {
      mockExistsPaths.add(guidePath('linear'));
      const result = manager.checkPrerequisites('mcp__linear__createIssue');
      expect(result.allowed).toBe(false);
      expect(result.blockReason).toContain('guide.md');
    });

    it('matches API source tools (api_{slug})', () => {
      mockExistsPaths.add(guidePath('github'));
      const result = manager.checkPrerequisites('api_github');
      expect(result.allowed).toBe(false);
      expect(result.blockReason).toContain('guide.md');
    });

    it('does not match built-in tools', () => {
      const result = manager.checkPrerequisites('Read');
      expect(result.allowed).toBe(true);
    });

    it('does not match Bash tool', () => {
      const result = manager.checkPrerequisites('Bash');
      expect(result.allowed).toBe(true);
    });

    it('does not match Write tool', () => {
      const result = manager.checkPrerequisites('Write');
      expect(result.allowed).toBe(true);
    });

    it('exempts session MCP tools', () => {
      mockExistsPaths.add(guidePath('session'));
      const result = manager.checkPrerequisites('mcp__session__SubmitPlan');
      expect(result.allowed).toBe(true);
    });

    it('exempts craft-agents-docs MCP tools', () => {
      mockExistsPaths.add(guidePath('craft-agents-docs'));
      const result = manager.checkPrerequisites('mcp__craft-agents-docs__search');
      expect(result.allowed).toBe(true);
    });

    it('handles malformed MCP tool names (fewer than 3 parts)', () => {
      const result = manager.checkPrerequisites('mcp__linear');
      expect(result.allowed).toBe(true);
    });

    it('matches native browser tools and blocks until browser docs are read', () => {
      const docsPath = browserDocPath();
      mockExistsPaths.add(docsPath);

      const result = manager.checkPrerequisites('browser_snapshot');
      expect(result.allowed).toBe(false);
      expect(result.blockReason).toContain(docsPath);
    });

    it('matches session browser tools and blocks until browser docs are read', () => {
      const docsPath = browserDocPath();
      mockExistsPaths.add(docsPath);

      const result = manager.checkPrerequisites('mcp__session__browser_tool');
      expect(result.allowed).toBe(false);
      expect(result.blockReason).toContain(docsPath);
    });
  });

  // ============================================================
  // Path Resolution
  // ============================================================

  describe('path resolution', () => {
    it('resolves guide.md path from MCP tool name', () => {
      const expected = guidePath('linear');
      mockExistsPaths.add(expected);
      const result = manager.checkPrerequisites('mcp__linear__createIssue');
      expect(result.allowed).toBe(false);
      expect(result.blockReason).toContain(expected);
    });

    it('resolves guide.md path from API tool name', () => {
      const expected = guidePath('slack');
      mockExistsPaths.add(expected);
      const result = manager.checkPrerequisites('api_slack');
      expect(result.allowed).toBe(false);
      expect(result.blockReason).toContain(expected);
    });
  });

  // ============================================================
  // Read Tracking
  // ============================================================

  describe('read tracking', () => {
    it('allows tool after guide.md has been read', () => {
      const guideFile = guidePath('linear');
      mockExistsPaths.add(guideFile);

      // Before reading - blocked
      expect(manager.checkPrerequisites('mcp__linear__createIssue').allowed).toBe(false);

      // Track the read
      manager.trackReadTool({ file_path: guideFile });

      // After reading - allowed
      expect(manager.checkPrerequisites('mcp__linear__createIssue').allowed).toBe(true);
    });

    it('tracks reads using path parameter', () => {
      const guideFile = guidePath('github');
      mockExistsPaths.add(guideFile);

      manager.trackReadTool({ path: guideFile });
      expect(manager.checkPrerequisites('api_github').allowed).toBe(true);
    });

    it('ignores trackReadTool with no path', () => {
      manager.trackReadTool({});
      expect(manager.hasRead('/any/path')).toBe(false);
    });

    it('tracks multiple reads independently', () => {
      const linearGuide = guidePath('linear');
      const slackGuide = guidePath('slack');
      mockExistsPaths.add(linearGuide);
      mockExistsPaths.add(slackGuide);

      manager.trackReadTool({ file_path: linearGuide });

      expect(manager.checkPrerequisites('mcp__linear__createIssue').allowed).toBe(true);
      expect(manager.checkPrerequisites('mcp__slack__sendMessage').allowed).toBe(false);
    });
  });

  // ============================================================
  // Reset
  // ============================================================

  describe('reset', () => {
    it('clears all read state', () => {
      const guideFile = guidePath('linear');
      mockExistsPaths.add(guideFile);

      manager.trackReadTool({ file_path: guideFile });
      expect(manager.checkPrerequisites('mcp__linear__createIssue').allowed).toBe(true);

      manager.resetReadState();
      expect(manager.checkPrerequisites('mcp__linear__createIssue').allowed).toBe(false);
    });

    it('logs debug message on reset', () => {
      manager.trackReadTool({ file_path: '/some/file' });
      manager.resetReadState();
      expect(debugMessages.some((m) => m.includes('reset read state'))).toBe(true);
    });
  });

  // ============================================================
  // Guide Nonexistence
  // ============================================================

  describe('guide nonexistence', () => {
    it('allows tool when guide.md does not exist', () => {
      // Don't add to mockExistsPaths — guide.md doesn't exist
      const result = manager.checkPrerequisites('mcp__linear__createIssue');
      expect(result.allowed).toBe(true);
    });

    it('allows API tool when guide.md does not exist', () => {
      const result = manager.checkPrerequisites('api_github');
      expect(result.allowed).toBe(true);
    });
  });

  // ============================================================
  // Path Normalization
  // ============================================================

  describe('path normalization', () => {
    it('normalizes tilde paths in trackReadTool', () => {
      const guideFile = guidePath('linear');
      mockExistsPaths.add(guideFile);

      // Track with tilde path that expands to the same absolute path
      const tildeRelative = `~/some-file.md`;
      manager.trackReadTool({ file_path: tildeRelative });

      // The expanded path should be tracked
      expect(manager.hasRead(tildeRelative)).toBe(true);
    });
  });

  // ============================================================
  // Max Rejection (graceful fallback)
  // ============================================================

  describe('max rejection', () => {
    it('blocks on first attempt, allows on second for same path', () => {
      mockExistsPaths.add(guidePath('linear'));

      // First attempt — blocked
      const first = manager.checkPrerequisites('mcp__linear__createIssue');
      expect(first.allowed).toBe(false);

      // Second attempt (same source, guide still not read) — allowed through
      const second = manager.checkPrerequisites('mcp__linear__createIssue');
      expect(second.allowed).toBe(true);
    });

    it('tracks rejection counts per source independently', () => {
      mockExistsPaths.add(guidePath('linear'));
      mockExistsPaths.add(guidePath('slack'));

      // Block linear once
      expect(manager.checkPrerequisites('mcp__linear__createIssue').allowed).toBe(false);

      // Slack should still block on first attempt
      expect(manager.checkPrerequisites('mcp__slack__sendMessage').allowed).toBe(false);

      // Linear second attempt — allowed
      expect(manager.checkPrerequisites('mcp__linear__createIssue').allowed).toBe(true);
    });

    it('resets rejection counts on resetReadState', () => {
      mockExistsPaths.add(guidePath('linear'));

      // Exhaust rejections
      manager.checkPrerequisites('mcp__linear__createIssue'); // blocked
      manager.checkPrerequisites('mcp__linear__createIssue'); // allowed (max reached)

      // Reset
      manager.resetReadState();

      // Should block again (rejection count reset)
      expect(manager.checkPrerequisites('mcp__linear__createIssue').allowed).toBe(false);
    });

    it('allows different tools from same source after one rejection', () => {
      mockExistsPaths.add(guidePath('linear'));

      // First tool blocked
      expect(manager.checkPrerequisites('mcp__linear__createIssue').allowed).toBe(false);

      // Different tool from same source — same guide path, already rejected once
      expect(manager.checkPrerequisites('mcp__linear__listIssues').allowed).toBe(true);
    });

    it('does not bypass strict browser prerequisite after repeated rejections', () => {
      const docsPath = browserDocPath();
      mockExistsPaths.add(docsPath);

      expect(manager.checkPrerequisites('browser_open').allowed).toBe(false);
      expect(manager.checkPrerequisites('browser_open').allowed).toBe(false);

      manager.trackReadTool({ file_path: docsPath });
      expect(manager.checkPrerequisites('browser_open').allowed).toBe(true);
    });
  });

  // ============================================================
  // Debug Logging
  // ============================================================

  describe('debug logging', () => {
    it('logs when a tool is blocked', () => {
      mockExistsPaths.add(guidePath('linear'));
      manager.checkPrerequisites('mcp__linear__createIssue');
      expect(debugMessages.some((m) => m.includes('Prerequisite blocked'))).toBe(true);
    });

    it('logs when a read is tracked', () => {
      manager.trackReadTool({ file_path: '/some/file.md' });
      expect(debugMessages.some((m) => m.includes('tracked read'))).toBe(true);
    });
  });
});
