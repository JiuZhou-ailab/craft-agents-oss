// input: Local file paths and shared attachment DTOs
// output: File classification, safe loading, and provider-neutral attachment context helpers
// pos: Shared file boundary used before persistence and model-provider adaptation

import { existsSync, readFileSync, statSync, writeFileSync, unlinkSync, renameSync } from 'fs';
import { randomUUID } from 'node:crypto';
import { extname, basename, resolve, relative } from 'path';
import type { AttachmentRepresentationKind } from '@craft-agent/core/types';
import type { FileAttachment } from '../protocol/dto.ts';

export type { FileAttachment } from '../protocol/dto.ts';

/**
 * Strip UTF-8 BOM (Byte Order Mark) from a string.
 * BOM (\uFEFF) can appear when files are written by certain editors or tools
 * and causes JSON.parse() to fail with "Unexpected token" errors.
 */
export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text;
}

/**
 * Parse a JSON string, stripping any leading UTF-8 BOM.
 * Use this instead of raw JSON.parse() for any content that may originate from a file.
 */
export function safeJsonParse(text: string): unknown {
  return JSON.parse(stripBom(text));
}

/**
 * Read and parse a JSON file, handling UTF-8 BOM transparently.
 * Replaces the common JSON.parse(readFileSync(path, 'utf-8')) pattern.
 */
export function readJsonFileSync<T = unknown>(filePath: string): T {
  return JSON.parse(stripBom(readFileSync(filePath, 'utf-8'))) as T;
}

/**
 * Atomically write a file by writing to a temp file then renaming.
 * This prevents partial writes from corrupting the file on crash/interrupt.
 * Uses write-to-temp-then-rename pattern which is atomic on POSIX systems.
 */
export function atomicWriteFileSync(filePath: string, data: string): void {
  const tmpPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tmpPath, data, { flag: 'wx' });
    renameSync(tmpPath, filePath);
  } catch (error) {
    // Clean up temp file if rename failed
    try { unlinkSync(tmpPath); } catch {}
    throw error;
  }
}

// Supported image types for Claude API
const IMAGE_EXTENSIONS: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.tiff': 'image/tiff',
  '.tif': 'image/tiff',
  '.ico': 'image/x-icon',
  '.icns': 'image/x-icns',
  '.heic': 'image/heic',
  '.heif': 'image/heif',
  '.svg': 'image/svg+xml',
};

// Text file extensions
const TEXT_EXTENSIONS = new Set([
  '.txt', '.md', '.json', '.js', '.ts', '.tsx', '.jsx',
  '.py', '.rb', '.go', '.rs', '.java', '.c', '.cpp', '.h',
  '.css', '.scss', '.html', '.xml', '.yaml', '.yml', '.toml',
  '.sh', '.bash', '.zsh', '.fish', '.sql', '.graphql',
  '.env', '.gitignore', '.dockerfile', '.makefile',
  '.csv', '.log', '.conf', '.ini', '.cfg',
]);

// Office file extensions (will be converted to markdown via markitdown-js)
const OFFICE_EXTENSIONS: Record<string, string> = {
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.doc': 'application/msword',
  '.xls': 'application/vnd.ms-excel',
  '.ppt': 'application/vnd.ms-powerpoint',
};

export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const MAX_TEXT_SIZE = 100 * 1024; // 100KB for text files

// Claude API image limits - images exceeding these will fail silently
// See: https://docs.anthropic.com/en/docs/build-with-claude/vision
const MAX_IMAGE_SIZE = 5 * 1024 * 1024; // 5MB - Claude API hard limit
const MAX_IMAGE_DIMENSION = 8000; // 8000x8000 max pixels
const OPTIMAL_IMAGE_EDGE = 1568; // Recommended max edge for quality/cost balance (~1.15MP)

/**
 * Result of validating an image for Claude API compatibility
 */
export interface ImageValidationResult {
  valid: boolean;
  /** Hard error - image cannot be sent */
  error?: string;
  /** Error code for programmatic handling */
  errorCode?: 'dimension_exceeded' | 'size_exceeded';
  /** Warning - image will work but may have issues */
  warning?: string;
  /** Image needs resizing for optimal performance */
  needsResize?: boolean;
  /** Suggested new dimensions if resize needed */
  suggestedSize?: { width: number; height: number };
}

/**
 * Validate an image for Claude API compatibility
 * Returns validation result with errors, warnings, and resize suggestions
 *
 * @param size - File size in bytes
 * @param width - Image width in pixels (optional, for dimension checking)
 * @param height - Image height in pixels (optional, for dimension checking)
 */
export function validateImageForClaudeAPI(
  size: number,
  width?: number,
  height?: number
): ImageValidationResult {
  // Check file size first (hard limit - cannot resize to fix)
  if (size > MAX_IMAGE_SIZE) {
    const sizeMB = (size / 1024 / 1024).toFixed(1);
    return {
      valid: false,
      errorCode: 'size_exceeded',
      error: `Image too large (${sizeMB}MB). Claude API limit is 5MB. Please resize or compress the image.`,
    };
  }

  // Check dimensions if provided
  if (width !== undefined && height !== undefined) {
    // Hard limit on dimensions - can be fixed by resizing
    if (width > MAX_IMAGE_DIMENSION || height > MAX_IMAGE_DIMENSION) {
      return {
        valid: false,
        errorCode: 'dimension_exceeded',
        error: `Image dimensions too large (${width}×${height}). Maximum is ${MAX_IMAGE_DIMENSION}×${MAX_IMAGE_DIMENSION} pixels.`,
      };
    }

    // Check if resize is recommended for optimal performance
    const maxEdge = Math.max(width, height);
    if (maxEdge > OPTIMAL_IMAGE_EDGE) {
      const scale = OPTIMAL_IMAGE_EDGE / maxEdge;
      return {
        valid: true,
        needsResize: true,
        warning: `Large image (${width}×${height}). Will be resized to optimize tokens and latency.`,
        suggestedSize: {
          width: Math.round(width * scale),
          height: Math.round(height * scale),
        },
      };
    }
  }

  return { valid: true };
}

// Export constants for use in other modules
export const IMAGE_LIMITS = {
  MAX_SIZE: MAX_IMAGE_SIZE,
  /** Max raw file size before base64 encoding (base64 inflates by 4/3, so 5MB base64 ≈ 3.75MB raw) */
  MAX_RAW_SIZE: Math.floor(MAX_IMAGE_SIZE * 3 / 4),
  MAX_DIMENSION: MAX_IMAGE_DIMENSION,
  OPTIMAL_EDGE: OPTIMAL_IMAGE_EDGE,
  /** JPEG quality for photo-like images */
  JPEG_QUALITY_HIGH: 90,
  /** JPEG quality for fallback compression when size still exceeds limits */
  JPEG_QUALITY_FALLBACK: 75,
} as const;


/**
 * Resolve a path (handle ~ expansion)
 */
export function resolvePath(filePath: string): string {
  if (filePath.startsWith('~/')) {
    const home = process.env.HOME || process.env.USERPROFILE || '';
    return resolve(home, filePath.slice(2));
  }
  return resolve(filePath);
}

/**
 * Determine the type of a file based on extension
 * Falls back to 'text' for unknown extensions (will try to read as text)
 */
export function getFileType(filePath: string): 'image' | 'text' | 'pdf' | 'office' | 'unknown' {
  const ext = extname(filePath).toLowerCase();

  if (ext in IMAGE_EXTENSIONS) {
    return 'image';
  }
  if (ext === '.pdf') {
    return 'pdf';
  }
  if (ext in OFFICE_EXTENSIONS) {
    return 'office';
  }
  if (TEXT_EXTENSIONS.has(ext)) {
    return 'text';
  }

  // For unknown extensions, default to 'text' - we'll try to read it as text
  // Binary files will show garbled content but at least they'll attach
  return 'text';
}

/**
 * Get MIME type for a file
 */
export function getMimeType(filePath: string): string {
  const ext = extname(filePath).toLowerCase();

  const imageMime = IMAGE_EXTENSIONS[ext];
  if (imageMime) {
    return imageMime;
  }
  if (ext === '.pdf') {
    return 'application/pdf';
  }
  const officeMime = OFFICE_EXTENSIONS[ext];
  if (officeMime) {
    return officeMime;
  }

  // Default to text for known text extensions
  if (TEXT_EXTENSIONS.has(ext)) {
    return 'text/plain';
  }

  return 'application/octet-stream';
}

export function getAttachmentRepresentationPath(
  attachment: FileAttachment,
  kind: AttachmentRepresentationKind,
): string | undefined {
  const representedPath = attachment.representations?.find(representation => representation.kind === kind)?.path;
  if (representedPath) return representedPath;
  if (kind === 'original') return attachment.storedPath || attachment.path;
  if (kind === 'markdown') return attachment.markdownPath;
  return undefined;
}

/**
 * Describe durable attachment paths without teaching providers about file formats.
 * Providers may still add native image/PDF content blocks after this shared context.
 */
export function formatAttachmentContextForModel(attachment: FileAttachment): string {
  const originalPath = getAttachmentRepresentationPath(attachment, 'original');
  const readablePath = getAttachmentRepresentationPath(attachment, 'markdown');
  const label = attachment.type === 'image'
    ? 'Attached image'
    : attachment.type === 'pdf'
      ? 'Attached PDF'
      : 'Attached file';
  const parts = [`[${label}: ${attachment.name}]`];
  if (originalPath) parts.push(`[Stored at: ${originalPath}]`);
  if (readablePath && readablePath !== originalPath) parts.push(`[Readable version: ${readablePath}]`);
  return parts.join('\n');
}

/**
 * Read a file and return attachment info
 */
export function readFileAttachment(filePath: string): FileAttachment | null {
  try {
    const resolved = resolvePath(filePath);

    if (!existsSync(resolved)) {
      return null;
    }

    const stats = statSync(resolved);

    if (!stats.isFile()) {
      return null;
    }

    if (stats.size > MAX_ATTACHMENT_BYTES) {
      throw new Error(`File too large: ${basename(resolved)} (${Math.round(stats.size / 1024 / 1024)}MB > 20MB limit)`);
    }

    const type = getFileType(resolved);
    const mimeType = getMimeType(resolved);
    const name = basename(resolved);

    const attachment: FileAttachment = {
      type,
      path: resolved,
      name,
      mimeType,
      size: stats.size,
    };

    if (type === 'image') {
      // Read as base64 for images
      const buffer = readFileSync(resolved);
      attachment.base64 = buffer.toString('base64');
    } else if (type === 'text') {
      // Keep the complete original bytes separate from the bounded readable preview.
      const buffer = readFileSync(resolved);
      attachment.base64 = buffer.toString('base64');
      if (stats.size > MAX_TEXT_SIZE) {
        // Read only first part of large text files
        attachment.text = buffer.toString('utf-8').slice(0, MAX_TEXT_SIZE) +
          `\n\n[File truncated - showing first ${MAX_TEXT_SIZE / 1024}KB of ${Math.round(stats.size / 1024)}KB]`;
      } else {
        attachment.text = readFileSync(resolved, 'utf-8');
      }
    } else if (type === 'pdf') {
      // Read PDF as base64
      const buffer = readFileSync(resolved);
      attachment.base64 = buffer.toString('base64');
    } else if (type === 'office') {
      // Read Office files as base64 (will be converted to markdown later)
      const buffer = readFileSync(resolved);
      attachment.base64 = buffer.toString('base64');
    }

    return attachment;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('File too large')) {
      throw error;
    }
    return null;
  }
}


/**
 * Format a single absolute path to relative if it's within cwd
 * @param absolutePath - The absolute path to format
 * @param cwd - Current working directory (defaults to process.cwd())
 * @returns Relative path prefixed with ./ or original path if outside cwd
 */
export function formatSinglePathToRelative(absolutePath: string, cwd?: string): string {
  const basePath = cwd || process.cwd();

  if (absolutePath.startsWith(basePath)) {
    const relativePath = relative(basePath, absolutePath);
    if (relativePath && !relativePath.startsWith('..') && !relativePath.startsWith('./')) {
      return './' + relativePath;
    }
    return relativePath || absolutePath;
  }
  return absolutePath;
}

/**
 * Format absolute file paths in text to relative paths from cwd
 * Converts paths like /Users/john/project/src/file.ts to ./src/file.ts
 *
 * @param text - Text containing file paths
 * @param cwd - Current working directory (defaults to process.cwd())
 * @returns Text with absolute paths converted to relative paths
 */
export function formatPathsToRelative(text: string, cwd?: string): string {
  const basePath = cwd || process.cwd();

  // Regex to match absolute file paths
  // Matches paths starting with / followed by path segments
  // Handles paths with common file extensions and directory paths
  const absolutePathRegex = /(\/(?:Users|home|var|tmp|opt|etc)[^\s\n:,\]\})"'`]*)/g;

  return text.replace(absolutePathRegex, (match) => {
    return formatSinglePathToRelative(match, basePath);
  });
}

/**
 * Format file paths in tool input objects to relative paths
 * Handles common tool input patterns like { file_path: "..." } or { path: "..." }
 *
 * @param input - Tool input object
 * @param cwd - Current working directory (defaults to process.cwd())
 * @returns New object with paths formatted to relative
 */
export function formatToolInputPaths(
  input: Record<string, unknown> | undefined,
  cwd?: string
): Record<string, unknown> | undefined {
  if (!input) return input;

  const result: Record<string, unknown> = {};
  const pathKeys = ['file_path', 'path', 'directory', 'folder', 'source', 'destination', 'target'];

  for (const [key, value] of Object.entries(input)) {
    if (typeof value === 'string' && pathKeys.includes(key) && value.startsWith('/')) {
      result[key] = formatSinglePathToRelative(value, cwd);
    } else if (typeof value === 'string') {
      // Also format paths embedded in string values
      result[key] = formatPathsToRelative(value, cwd);
    } else {
      result[key] = value;
    }
  }

  return result;
}
