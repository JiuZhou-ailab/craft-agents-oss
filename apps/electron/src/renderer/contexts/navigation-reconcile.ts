// input: URL parameters, navigation routes, and auto-selection policy
// output: Initial-route and panel-route reconciliation decisions
// pos: Pure navigation policy shared by NavigationContext and behavior tests

import { buildRouteFromNavigationState, parseRouteToNavigationState } from '../../shared/route-parser'
import type { ViewRoute } from '../../shared/routes'
import type { NavigationState } from '../../shared/types'

export interface AutoSelectionOptions {
  skipAutoSelect?: boolean
}

export type AutoSelectionResolver = (
  state: NavigationState,
  options?: AutoSelectionOptions
) => NavigationState

export function shouldDefaultInitialRouteToWriting(params: URLSearchParams): boolean {
  return !params.get('route') && !params.get('panels')
}

/**
 * Normalize a panel route during URL reconciliation.
 *
 * Ensures route state is resolved through the same validation and
 * auto-selection policy used by normal navigation.
 */
export function normalizePanelRouteForReconcile(
  route: ViewRoute,
  resolveAutoSelection: AutoSelectionResolver,
  options?: AutoSelectionOptions,
): ViewRoute {
  const navState = parseRouteToNavigationState(route)
  if (!navState) return route

  const resolved = resolveAutoSelection(navState, options)
  return buildRouteFromNavigationState(resolved) as ViewRoute
}
