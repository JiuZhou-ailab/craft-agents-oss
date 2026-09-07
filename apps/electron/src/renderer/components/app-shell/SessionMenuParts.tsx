import * as React from 'react'
import { useTranslation } from "react-i18next"
import { Check, Globe, Copy, RefreshCw, Link2Off } from 'lucide-react'
import { toast } from 'sonner'
import type { MenuComponents } from '@/components/ui/menu-context'
import { getStatusIconStyle, type SessionStatusId, type SessionStatus } from '@/config/session-status-config'
import { sortLabelsForDisplay, type LabelConfig } from '@craft-agent/shared/labels'
import { LabelIcon } from '@/components/ui/label-icon'

export interface ShareMenuItemsProps {
  sessionId: string
  sharedUrl: string
  menu: Pick<MenuComponents, 'MenuItem' | 'Separator'>
}

export function ShareMenuItems({ sessionId, sharedUrl, menu }: ShareMenuItemsProps) {
  const { t } = useTranslation()
  const { MenuItem, Separator } = menu

  const handleOpenInBrowser = () => {
    window.electronAPI.openUrl(sharedUrl)
  }

  const handleCopyLink = async () => {
    await navigator.clipboard.writeText(sharedUrl)
    toast.success(t("toast.linkCopied"))
  }

  const handleUpdateShare = async () => {
    const result = await window.electronAPI.sessionCommand(sessionId, { type: 'updateShare' })
    if (result && 'success' in result && result.success) {
      toast.success(t("chat.shareUpdated"))
    } else {
      const errorMsg = result && 'error' in result ? result.error : undefined
      toast.error(t("chat.failedToUpdateShare"), { description: errorMsg })
    }
  }

  const handleRevokeShare = async () => {
    const result = await window.electronAPI.sessionCommand(sessionId, { type: 'revokeShare' })
    if (result && 'success' in result && result.success) {
      toast.success(t("chat.sharingStopped"))
    } else {
      const errorMsg = result && 'error' in result ? result.error : undefined
      toast.error(t("chat.failedToStopSharing"), { description: errorMsg })
    }
  }

  return (
    <>
      <MenuItem onClick={handleOpenInBrowser}>
        <Globe className="h-3.5 w-3.5" />
        <span className="flex-1">{t("sessionMenu.openInBrowser")}</span>
      </MenuItem>
      <MenuItem onClick={handleCopyLink}>
        <Copy className="h-3.5 w-3.5" />
        <span className="flex-1">{t("sessionMenu.copyLink")}</span>
      </MenuItem>
      <MenuItem onClick={handleUpdateShare}>
        <RefreshCw className="h-3.5 w-3.5" />
        <span className="flex-1">{t("sessionMenu.updateShare")}</span>
      </MenuItem>
      <Separator />
      <MenuItem onClick={handleRevokeShare} variant="destructive">
        <Link2Off className="h-3.5 w-3.5" />
        <span className="flex-1">{t("sessionMenu.stopSharing")}</span>
      </MenuItem>
    </>
  )
}

export interface StatusMenuItemsProps {
  sessionStatuses: SessionStatus[]
  activeStateId?: SessionStatusId | null
  onSelect: (stateId: SessionStatusId) => void
  menu: Pick<MenuComponents, 'MenuItem'>
}

export function StatusMenuItems({
  sessionStatuses,
  activeStateId,
  onSelect,
  menu,
}: StatusMenuItemsProps) {
  const { MenuItem } = menu

  return (
    <>
      {sessionStatuses.map((state) => {
        const bareIcon = React.isValidElement(state.icon)
          ? React.cloneElement(state.icon as React.ReactElement<{ bare?: boolean }>, { bare: true })
          : state.icon
        return (
          <MenuItem
            key={state.id}
            onClick={() => onSelect(state.id)}
            className={activeStateId === state.id ? 'bg-foreground/5' : ''}
          >
            <span style={getStatusIconStyle(state)}>
              {bareIcon}
            </span>
            <span className="flex-1">{state.label}</span>
          </MenuItem>
        )
      })}
    </>
  )
}

export interface LabelMenuItemsProps {
  labels: LabelConfig[]
  appliedLabelIds: Set<string>
  onToggle: (labelId: string) => void
  menu: Pick<MenuComponents, 'MenuItem' | 'Separator' | 'Sub' | 'SubTrigger' | 'SubContent'>
}

/**
 * Precompute applied label counts for each subtree so nested menu triggers can
 * show selection counts without recursively rescanning descendant labels.
 */
function buildAppliedCountByLabelId(labels: LabelConfig[], appliedIds: Set<string>): Map<string, number> {
  const countById = new Map<string, number>()
  const visit = (label: LabelConfig): number => {
    let count = appliedIds.has(label.id) ? 1 : 0
    for (const child of label.children ?? []) {
      count += visit(child)
    }
    countById.set(label.id, count)
    return count
  }
  for (const label of labels) {
    visit(label)
  }
  return countById
}

/**
 * LabelMenuItems - Recursive component for rendering label tree as nested sub-menus.
 *
 * Labels with children render as nested Sub/SubTrigger/SubContent menus (the parent
 * itself appears as the first toggleable item inside its submenu, followed by children).
 * Leaf labels render as simple toggleable menu items with checkmarks.
 * Parent triggers show a count of applied descendants so users can see where selections are.
 */
export function LabelMenuItems({
  labels,
  appliedLabelIds,
  onToggle,
  menu,
}: LabelMenuItemsProps) {
  const { MenuItem, Separator, Sub, SubTrigger, SubContent } = menu
  const displayLabels = React.useMemo(() => sortLabelsForDisplay(labels), [labels])
  const appliedCountById = React.useMemo(
    () => buildAppliedCountByLabelId(displayLabels, appliedLabelIds),
    [displayLabels, appliedLabelIds]
  )

  const renderItems = (nodes: LabelConfig[]): React.ReactNode => (
    <>
      {nodes.map(label => {
        const hasChildren = label.children && label.children.length > 0
        const isApplied = appliedLabelIds.has(label.id)

        if (hasChildren) {
          const subtreeCount = appliedCountById.get(label.id) ?? 0

          return (
            <Sub key={label.id}>
              <SubTrigger>
                <LabelIcon label={label} size="sm" hasChildren />
                <span className="flex-1">{label.name}</span>
                {subtreeCount > 0 && (
                  <span className="text-[10px] text-foreground/50 tabular-nums -mr-2.5">
                    {subtreeCount}
                  </span>
                )}
              </SubTrigger>
              <SubContent>
                <MenuItem
                  onSelect={(e: Event) => {
                    e.preventDefault()
                    onToggle(label.id)
                  }}
                >
                  <LabelIcon label={label} size="sm" hasChildren />
                  <span className="flex-1">{label.name}</span>
                  <span className="w-3.5 ml-4">
                    {isApplied && <Check className="h-3.5 w-3.5 text-foreground" />}
                  </span>
                </MenuItem>
                <Separator />
                {renderItems(label.children!)}
              </SubContent>
            </Sub>
          )
        }

        return (
          <MenuItem
            key={label.id}
            onSelect={(e: Event) => {
              e.preventDefault()
              onToggle(label.id)
            }}
          >
            <LabelIcon label={label} size="sm" />
            <span className="flex-1">{label.name}</span>
            <span className="w-3.5 ml-4">
              {isApplied && <Check className="h-3.5 w-3.5 text-foreground" />}
            </span>
          </MenuItem>
        )
      })}
    </>
  )

  return renderItems(displayLabels)
}
