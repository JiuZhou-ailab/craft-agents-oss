// input: Chat text, globally identified Skills, project Sources, and cached entity icons
// output: Parsed mentions and canonical badge metadata for persisted messages
// pos: Renderer adapter preserving legacy mention reads while emitting global Skill references

/**
 * Utilities for parsing [bracket] mentions from chat messages.
 */

import type { ContentBadge } from '@craft-agent/core'
import type { MentionItemType } from '@/components/ui/mention-menu'
import type { LoadedSkill, LoadedSource } from '../../shared/types'
import { getSourceIconSync, getSkillIconSync } from './icon-cache'

// Import and re-export parsing functions from shared (pure string operations, no renderer deps)
import { parseMentions, resolveSkillMentions, resolveSourceMentions, type ParsedMentions } from '@craft-agent/shared/mentions'
export { parseMentions, resolveSkillMentions, resolveSourceMentions, type ParsedMentions }

// ============================================================================
// Constants
// ============================================================================

// Workspace ID character class for regex: word chars, spaces (NOT newlines), hyphens, dots
// Using literal space instead of \s to avoid matching newlines which would break parsing
const WS_ID_CHARS = '[\\w .-]'

// ============================================================================
// Types
// ============================================================================

export interface MentionMatch {
  type: MentionItemType
  id: string
  /** Full match text including @ prefix */
  fullMatch: string
  /** Start index in the original text */
  startIndex: number
}

// ============================================================================
// Matching Functions (renderer-specific, use MentionItemType)
// ============================================================================

/**
 * Find all mention matches in text with their positions
 *
 * @param text - The message text to search
 * @param availableSkillSlugs - Valid skill slugs
 * @param availableSourceSlugs - Valid source slugs
 * @returns Array of mention matches with positions
 */
export function findMentionMatches(
  text: string,
  availableSkillSlugs: string[],
  availableSourceSlugs: string[]
): MentionMatch[] {
  const matches: MentionMatch[] = []

  // Match source mentions: [source:slug]
  const sourcePattern = /(\[source:([\w-]+)\])/g
  let match
  while ((match = sourcePattern.exec(text)) !== null) {
    const slug = match[2]
    if (availableSourceSlugs.includes(slug)) {
      matches.push({
        type: 'source',
        id: slug,
        fullMatch: match[1],
        startIndex: match.index,
      })
    }
  }

  // Match skill mentions: [skill:slug] or [skill:workspaceId:slug]
  // The pattern captures the full match and extracts the slug (last component)
  // Workspace IDs can contain spaces, hyphens, underscores, and dots
  const skillPattern = new RegExp(`(\\[skill:(?:${WS_ID_CHARS}+:)?([\\w-]+)\\])`, 'g')
  while ((match = skillPattern.exec(text)) !== null) {
    const slug = match[2]
    if (availableSkillSlugs.includes(slug)) {
      matches.push({
        type: 'skill',
        id: slug,
        fullMatch: match[1],
        startIndex: match.index,
      })
    }
  }

  // Match file mentions: [file:path]
  const filePattern = /(\[file:([^\]]+)\])/g
  while ((match = filePattern.exec(text)) !== null) {
    matches.push({
      type: 'file',
      id: match[2],
      fullMatch: match[1],
      startIndex: match.index,
    })
  }

  // Match folder mentions: [folder:path]
  const folderPattern = /(\[folder:([^\]]+)\])/g
  while ((match = folderPattern.exec(text)) !== null) {
    matches.push({
      type: 'folder',
      id: match[2],
      fullMatch: match[1],
      startIndex: match.index,
    })
  }

  // Sort by position
  return matches.sort((a, b) => a.startIndex - b.startIndex)
}

/**
 * Check if text contains any valid mentions
 */
export function hasMentions(
  text: string,
  availableSkillSlugs: string[],
  availableSourceSlugs: string[]
): boolean {
  const mentions = parseMentions(text, availableSkillSlugs, availableSourceSlugs)
  return mentions.skills.length > 0 || mentions.sources.length > 0 || mentions.files.length > 0 || mentions.folders.length > 0
}

// ============================================================================
// Badge Extraction
// ============================================================================

/**
 * Extract ContentBadge array from message text.
 * Used when sending messages to store badge metadata for display.
 *
 * Each badge is self-contained with label, icon (base64), and position.
 *
 * @param text - Message text with mentions
 * @param skills - Available skills (for label lookup)
 * @param sources - Available sources (for label lookup)
 * @param workspaceId - Workspace ID (for icon lookup)
 * @returns Array of ContentBadge objects
 */
export function extractBadges(
  text: string,
  skills: LoadedSkill[],
  sources: LoadedSource[],
  workspaceId: string
): ContentBadge[] {
  const skillSlugs = skills.map(s => s.slug)
  const sourceSlugs = sources.map(s => s.config.slug)
  const matches = findMentionMatches(text, skillSlugs, sourceSlugs)

  // Build lookup maps to avoid linear scans per match
  const skillsBySlug = new Map(skills.map(s => [s.slug, s]))
  const sourcesBySlug = new Map(sources.map(s => [s.config.slug, s]))

  return matches.map(match => {
    let label = match.id
    let iconDataUrl: string | undefined
    let filePath: string | undefined

    if (match.type === 'skill') {
      const skill = skillsBySlug.get(match.id)
      label = skill?.metadata.displayName ?? skill?.metadata.name ?? match.id

      // Get cached icon as data URL (preserves mime type for SVG, PNG, etc.)
      iconDataUrl = getSkillIconSync(workspaceId, match.id) ?? undefined
    } else if (match.type === 'source') {
      const source = sourcesBySlug.get(match.id)
      label = source?.config.name || match.id

      // Get cached icon as data URL (preserves mime type for SVG, PNG, etc.)
      iconDataUrl = getSourceIconSync(workspaceId, match.id) ?? undefined
    } else if (match.type === 'file') {
      // Show filename as label, full relative path stored for tooltip
      label = match.id.split('/').pop() || match.id
      filePath = match.id
    } else if (match.type === 'folder') {
      // Show folder name as label, full relative path stored for tooltip
      label = match.id.split('/').pop() || match.id
      filePath = match.id
    }

    // Skill identity is global. Legacy qualified input is accepted by the
    // parser but all newly persisted badge metadata uses the canonical form.
    const rawText = match.type === 'skill'
      ? `[skill:${match.id}]`
      : match.fullMatch

    return {
      type: match.type as 'source' | 'skill' | 'file' | 'folder',
      label,
      rawText,
      iconDataUrl,
      filePath,
      start: match.startIndex,
      end: match.startIndex + match.fullMatch.length,
    }
  })
}
