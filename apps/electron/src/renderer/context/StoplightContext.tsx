// input: Focused-mode state and optional numeric leading inset from the shell layout
// output: Shared macOS traffic-light compensation consumed by panel headers
// pos: Renderer context that keeps title geometry synchronized with rail animation

/**
 * StoplightContext
 *
 * Provides stoplight (macOS traffic lights) compensation state to child components.
 * The numeric inset keeps panel titles on the same screen coordinate while the
 * activity rail collapses, instead of interpolating between incompatible CSS values.
 *
 * Used by MainContentPanel to propagate focused mode state to all pages without
 * requiring each page to handle it explicitly.
 */

import { createContext, useContext } from 'react'

export interface StoplightCompensation {
  enabled: boolean
  leadingInset?: number
}

const StoplightContext = createContext<StoplightCompensation>({ enabled: false })

export const StoplightProvider = StoplightContext.Provider

/**
 * Returns both the focused-mode flag and its numeric title inset so the rail
 * and title can share one spring interpolation without a one-frame jump.
 */
export function useStoplightCompensation(): StoplightCompensation {
  return useContext(StoplightContext)
}
