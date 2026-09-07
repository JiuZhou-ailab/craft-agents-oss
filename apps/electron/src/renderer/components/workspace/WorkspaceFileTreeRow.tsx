// input: React Arborist node state and workspace file-tree interaction callbacks
// output: Finder-style virtual row with inline rename, review marker, and context menu
// pos: Presentation layer for one visible workspace file-tree entry

import * as React from 'react'
import {
  ChevronRight,
  File,
  FileCode2,
  FileJson2,
  FileText,
  Folder,
  Image as ImageIcon,
  Pencil,
  Trash2,
} from 'lucide-react'
import type { NodeRendererProps } from 'react-arborist'
import { classifyFile } from '@craft-agent/ui/file-classification'
import {
  ContextMenu,
  ContextMenuTrigger,
  StyledContextMenuContent,
  StyledContextMenuItem,
  StyledContextMenuSeparator,
} from '@/components/ui/styled-context-menu'
import { cn } from '@/lib/utils'
import type { WorkspaceFileTreeNode } from './workspace-file-tree-model'

export interface WorkspaceFileTreeMenuAction {
  id: string
  label: string
  icon?: React.ReactNode
  separatorBefore?: boolean
  variant?: 'default' | 'destructive'
  onSelect: () => void
}

export interface WorkspaceFileTreeLabels {
  rename: string
  delete: string
  reviewChanged?: string
}

export interface WorkspaceFileTreeRowContextValue {
  labels: WorkspaceFileTreeLabels
  getMenuActions?: (entry: WorkspaceFileTreeNode) => readonly WorkspaceFileTreeMenuAction[]
  onDelete: (entry: WorkspaceFileTreeNode) => void
  hasReviewDot?: (path: string) => boolean
  onDismissReviewDot?: (path: string) => void
}

export const WorkspaceFileTreeRowContext = React.createContext<WorkspaceFileTreeRowContextValue | null>(null)

function EntryIcon({ entry }: { entry: WorkspaceFileTreeNode }) {
  if (entry.type === 'root' || entry.type === 'directory') return <Folder className="h-3.5 w-3.5" />

  switch (classifyFile(entry.path).type) {
    case 'image':
      return <ImageIcon className="h-3.5 w-3.5" />
    case 'json':
      return <FileJson2 className="h-3.5 w-3.5" />
    case 'code':
      return <FileCode2 className="h-3.5 w-3.5" />
    case 'markdown':
    case 'text':
      return <FileText className="h-3.5 w-3.5" />
    default:
      return <File className="h-3.5 w-3.5" />
  }
}

function RenameInput({ node }: { node: NodeRendererProps<WorkspaceFileTreeNode>['node'] }) {
  const inputRef = React.useRef<HTMLInputElement>(null)

  React.useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])

  return (
    <input
      ref={inputRef}
      defaultValue={node.data.name}
      aria-label={node.data.name}
      className="min-w-0 flex-1 rounded border border-ring/50 bg-background px-1 py-0.5 text-[10px] leading-4 outline-none"
      onBlur={() => node.reset()}
      onClick={event => event.stopPropagation()}
      onKeyDown={(event) => {
        event.stopPropagation()
        if (event.key === 'Escape') node.reset()
        if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
          node.submit(inputRef.current?.value ?? '')
        }
      }}
    />
  )
}

function EntryContextMenu({
  node,
  context,
}: {
  node: NodeRendererProps<WorkspaceFileTreeNode>['node']
  context: WorkspaceFileTreeRowContextValue
}) {
  const entry = node.data
  const extraActions = context.getMenuActions?.(entry) ?? []
  const canMutate = entry.type !== 'root'
  if (extraActions.length === 0 && !canMutate) return null

  return (
    <StyledContextMenuContent>
      {extraActions.map(action => (
        <React.Fragment key={action.id}>
          {action.separatorBefore ? <StyledContextMenuSeparator /> : null}
          <StyledContextMenuItem
            variant={action.variant}
            onSelect={action.onSelect}
          >
            {action.icon}
            {action.label}
          </StyledContextMenuItem>
        </React.Fragment>
      ))}
      {extraActions.length > 0 && canMutate ? <StyledContextMenuSeparator /> : null}
      {canMutate ? (
        <>
          <StyledContextMenuItem onSelect={() => void node.edit()}>
            <Pencil className="h-3.5 w-3.5" />
            {context.labels.rename}
          </StyledContextMenuItem>
          <StyledContextMenuItem
            variant="destructive"
            onSelect={() => context.onDelete(entry)}
          >
            <Trash2 className="h-3.5 w-3.5" />
            {context.labels.delete}
          </StyledContextMenuItem>
        </>
      ) : null}
    </StyledContextMenuContent>
  )
}

export function WorkspaceFileTreeRow({
  node,
  style,
  dragHandle,
}: NodeRendererProps<WorkspaceFileTreeNode>) {
  const context = React.useContext(WorkspaceFileTreeRowContext)
  if (!context) throw new Error('WorkspaceFileTreeRow must be rendered inside WorkspaceFileTreeRowContext')

  const entry = node.data
  const reviewChanged = entry.type === 'file' && context.hasReviewDot?.(entry.path)
  const row = (
    <div
      ref={dragHandle}
      style={style}
      data-tutorial={entry.type === 'root' ? 'writing-catalog' : undefined}
      className={cn(
        'group flex h-full min-w-0 items-center gap-1.5 rounded-[6px] px-2 text-[10px] outline-none',
        'text-foreground/85 hover:bg-foreground/[0.045]',
        entry.type === 'root' && 'font-medium',
        (entry.type === 'root' || node.isSelected) && 'bg-foreground/[0.07]',
        node.isFocused && entry.type !== 'root' && 'ring-1 ring-inset ring-ring/60',
        node.willReceiveDrop && 'bg-accent/10 ring-1 ring-inset ring-accent/40',
        node.isDragging && 'opacity-40',
      )}
      title={entry.relativePath || entry.path}
    >
      <button
        type="button"
        tabIndex={-1}
        aria-label={node.isOpen ? 'Collapse folder' : 'Expand folder'}
        className={cn(
          'flex h-4 w-4 shrink-0 items-center justify-center rounded text-muted-foreground',
          node.isLeaf && 'invisible',
        )}
        onClick={(event) => {
          event.preventDefault()
          event.stopPropagation()
          node.toggle()
        }}
      >
        <ChevronRight className={cn('h-3.5 w-3.5 transition-transform', node.isOpen && 'rotate-90')} />
      </button>
      {reviewChanged ? (
        <button
          type="button"
          tabIndex={-1}
          title={context.labels.reviewChanged}
          aria-label={context.labels.reviewChanged}
          className="flex h-3.5 w-3.5 shrink-0 items-center justify-center"
          onClick={(event) => {
            event.preventDefault()
            event.stopPropagation()
            context.onDismissReviewDot?.(entry.path)
          }}
        >
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 ring-2 ring-background" />
        </button>
      ) : null}
      <span className="flex h-4 w-4 shrink-0 items-center justify-center text-muted-foreground">
        <EntryIcon entry={entry} />
      </span>
      {node.isEditing ? (
        <RenameInput node={node} />
      ) : (
        <span className="min-w-0 flex-1 truncate text-left">{entry.name}</span>
      )}
      {entry.type !== 'file' && entry.fileCount > 0 ? (
        <span className="ml-auto text-[10px] text-foreground/30 opacity-0 transition-opacity group-hover:opacity-100">
          {entry.fileCount}
        </span>
      ) : null}
    </div>
  )

  const menu = <EntryContextMenu node={node} context={context} />
  if (!menu) return row

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{row}</ContextMenuTrigger>
      {menu}
    </ContextMenu>
  )
}
