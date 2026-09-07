/**
 * Sources Atom
 *
 * Simple atom for storing workspace sources.
 * Used by source discovery and management pages.
 */

import { atom } from 'jotai'
import type { LoadedSource } from '../../shared/types'

/**
 * Atom to store the current workspace's sources.
 * AppShell populates this when sources are loaded.
 * Source pages read it for lists, connection state, and installed-source lookup.
 */
export const sourcesAtom = atom<LoadedSource[]>([])
