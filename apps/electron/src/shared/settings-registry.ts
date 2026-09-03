// input: Stable settings page identifiers and translation title keys
// output: Canonical settings page list, derived types, and validation helpers
// pos: Shared source of truth for settings routes and navigator order

/**
 * Settings Registry - Single Source of Truth
 *
 * This file defines all settings pages in one place. All other files that need
 * settings page information should import from here.
 *
 * To add a new settings page:
 * 1. Add an entry to SETTINGS_PAGES below
 * 2. Create the page component in renderer/pages/settings/
 * 3. Add to SETTINGS_PAGE_COMPONENTS in renderer/pages/settings/settings-pages.ts
 * 4. Add icon to SETTINGS_ICONS in renderer/components/icons/SettingsIcons.tsx
 *
 * That's it - types, routes, and validation are derived automatically.
 */

/**
 * Settings page definition
 */
export interface SettingsPageDefinition {
  /** Unique identifier used in routes and navigation */
  id: string
  /** i18n key for display label in settings navigator */
  labelKey: string
}

/**
 * The canonical list of all settings pages.
 * Order here determines display order in the settings navigator.
 *
 * ADD NEW PAGES HERE - everything else derives from this list.
 *
 * NOTE: labelKey is an i18n translation key, resolved at render
 * time via t(). Do NOT call i18n.t() here — this module loads before i18n init.
 */
export const SETTINGS_PAGES = [
  { id: 'app' as const, labelKey: 'settings.app.title' },
  { id: 'profile' as const, labelKey: 'settings.profile.title' },
  { id: 'usage' as const, labelKey: 'settings.app.localUsage.title' },
  { id: 'ai' as const, labelKey: 'settings.ai.title' },
  { id: 'appearance' as const, labelKey: 'settings.appearance.title' },
  { id: 'input' as const, labelKey: 'settings.input.title' },
  { id: 'workspace' as const, labelKey: 'settings.workspace.title' },
  { id: 'permissions' as const, labelKey: 'settings.permissions.title' },
  { id: 'labels' as const, labelKey: 'settings.labels.title' },
  { id: 'automations' as const, labelKey: 'settings.automations.title' },
  { id: 'messaging' as const, labelKey: 'settings.messaging.title' },
  { id: 'server' as const, labelKey: 'settings.server.title' },
  { id: 'shortcuts' as const, labelKey: 'settings.shortcuts.title' },
  { id: 'preferences' as const, labelKey: 'settings.preferences.title' },
] satisfies readonly SettingsPageDefinition[]

/**
 * Settings subpage type - derived from SETTINGS_PAGES
 * This replaces the manual union type in types.ts
 */
export type SettingsSubpage = (typeof SETTINGS_PAGES)[number]['id']

/**
 * Array of valid settings subpage IDs - for runtime validation
 */
export const VALID_SETTINGS_SUBPAGES: readonly SettingsSubpage[] = SETTINGS_PAGES.map(p => p.id)

/**
 * Type guard to check if a string is a valid settings subpage
 */
export function isValidSettingsSubpage(value: string): value is SettingsSubpage {
  return VALID_SETTINGS_SUBPAGES.includes(value as SettingsSubpage)
}

/**
 * Get settings page definition by ID
 */
export function getSettingsPage(id: SettingsSubpage): SettingsPageDefinition {
  const page = SETTINGS_PAGES.find(p => p.id === id)
  if (!page) throw new Error(`Unknown settings page: ${id}`)
  return page
}
