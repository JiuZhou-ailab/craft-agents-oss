// input: Available skills/sources, selected source slugs, and composer actions
// output: Add menu with searchable hover submenus and skill/source selection
// pos: Desktop composer attachment and resource picker; owns only menu UI state
import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { DatabaseZap, Paperclip, Plus, Zap } from 'lucide-react'
import { DropdownMenuCheckboxItem } from '@/components/ui/dropdown-menu'
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuSub,
  StyledDropdownMenuContent, StyledDropdownMenuItem,
  StyledDropdownMenuSubTrigger, StyledDropdownMenuSubContent,
} from '@/components/ui/styled-dropdown'
import { SourceAvatar } from '@/components/ui/source-avatar'
import { createSlashSkillItems } from '@/components/ui/slash-command-menu'
import type { LoadedSkill, LoadedSource } from '../../../../shared/types'

interface InputAddMenuProps {
  disabled?: boolean
  skills: LoadedSkill[]
  sources: LoadedSource[]
  selectedSourceSlugs: string[]
  onAttach: () => void
  onSelectSkill: (skill: LoadedSkill) => void
  onToggleSource?: (slug: string) => void
}

function handleSearchKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
  if (event.key === 'Escape' || event.key === 'Tab') return
  event.stopPropagation() // Keep typing out of the menu's typeahead and arrow handlers.
  if (event.key === 'ArrowDown') {
    event.preventDefault()
    event.currentTarget.closest('[role="menu"]')
      ?.querySelector<HTMLElement>('[role^="menuitem"]:not([data-disabled])')?.focus()
  }
}

export function InputAddMenu({ disabled, skills, sources, selectedSourceSlugs, onAttach, onSelectSkill, onToggleSource }: InputAddMenuProps) {
  const { t } = useTranslation()
  const [skillQuery, setSkillQuery] = React.useState('')
  const [sourceQuery, setSourceQuery] = React.useState('')
  const selectedSkill = React.useRef<LoadedSkill | null>(null)
  const skillItems = createSlashSkillItems(skills).filter(item => (item.searchText ?? item.label.toLowerCase()).includes(skillQuery.trim().toLowerCase()))
  const sourceItems = sources.filter(source => `${source.config.name} ${source.config.slug} ${source.config.tagline ?? ''}`.toLowerCase().includes(sourceQuery.trim().toLowerCase()))
  const searchClass = 'mx-2 my-1 h-8 min-w-0 shrink-0 border-b border-border/50 bg-transparent text-[13px] outline-none'

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button" data-tutorial="source-selector-button"
          aria-label={`${t('chat.attachFiles')} / ${t('chat.chooseSkills')} / ${t('chat.chooseSources')}`}
          disabled={disabled}
          className="input-toolbar-btn inline-flex h-7 w-7 shrink-0 select-none items-center justify-center rounded-[6px] text-foreground outline-none transition-colors hover:bg-foreground/5 active:bg-foreground/10 focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
        >
          <Plus className="h-4 w-4" />
        </button>
      </DropdownMenuTrigger>
      <StyledDropdownMenuContent side="top" align="start" sideOffset={6} onCloseAutoFocus={event => {
        if (!selectedSkill.current) return
        event.preventDefault()
        const skill = selectedSkill.current
        selectedSkill.current = null
        onSelectSkill(skill)
      }}>
        <StyledDropdownMenuItem onSelect={onAttach}>
          <Paperclip /><span>{t('chat.attachFiles')}</span>
        </StyledDropdownMenuItem>
        <DropdownMenuSub onOpenChange={() => setSkillQuery('')}>
          <StyledDropdownMenuSubTrigger><Zap /><span>{t('chat.chooseSkills')}</span></StyledDropdownMenuSubTrigger>
          <StyledDropdownMenuSubContent className="w-80 max-w-[calc(100vw-24px)] max-h-80 overflow-y-auto whitespace-normal">
            {skills.length > 0 && <input aria-label={t('chat.chooseSkills')} placeholder={t('common.search')} value={skillQuery} onChange={event => setSkillQuery(event.target.value)} onKeyDown={handleSearchKeyDown} className={searchClass} />}
            {skillItems.map(item => (
              <StyledDropdownMenuItem key={item.id} className="shrink-0" onSelect={() => { selectedSkill.current = item.skill }}>
                <Zap className="shrink-0" />
                <span className="min-w-0" title={item.description}>
                  <span className="block truncate">{item.label}</span>
                  <span className="text-xs text-muted-foreground line-clamp-2">{item.description}</span>
                </span>
              </StyledDropdownMenuItem>
            ))}
            {skillItems.length === 0 && <StyledDropdownMenuItem disabled>{t(skills.length ? 'globalSearch.empty' : 'skillsList.noSkillsConfigured')}</StyledDropdownMenuItem>}
          </StyledDropdownMenuSubContent>
        </DropdownMenuSub>
        {onToggleSource && (
          <DropdownMenuSub onOpenChange={() => setSourceQuery('')}>
            <StyledDropdownMenuSubTrigger><DatabaseZap /><span>{t('chat.chooseSources')}</span></StyledDropdownMenuSubTrigger>
            <StyledDropdownMenuSubContent className="w-80 max-w-[calc(100vw-24px)] max-h-80 overflow-y-auto whitespace-normal">
              {sources.length > 0 && <input aria-label={t('chat.chooseSources')} placeholder={t('common.search')} value={sourceQuery} onChange={event => setSourceQuery(event.target.value)} onKeyDown={handleSearchKeyDown} className={searchClass} />}
              {sourceItems.map((source, index) => (
                <DropdownMenuCheckboxItem key={source.config.slug} className="shrink-0"
                  data-tutorial={index === 0 ? 'source-dropdown-item-first' : undefined}
                  checked={selectedSourceSlugs.includes(source.config.slug)}
                  onSelect={event => event.preventDefault()}
                  onCheckedChange={() => onToggleSource(source.config.slug)}
                >
                  <SourceAvatar source={source} size="xs" />
                  <span className="min-w-0" title={source.config.tagline}>
                    <span className="block truncate">{source.config.name}</span>
                    {source.config.tagline && <span className="text-xs text-muted-foreground line-clamp-2">{source.config.tagline}</span>}
                  </span>
                </DropdownMenuCheckboxItem>
              ))}
              {sourceItems.length === 0 && <StyledDropdownMenuItem disabled>{t(sources.length ? 'globalSearch.empty' : 'sourcesList.noSourcesConfigured')}</StyledDropdownMenuItem>}
            </StyledDropdownMenuSubContent>
          </DropdownMenuSub>
        )}
      </StyledDropdownMenuContent>
    </DropdownMenu>
  )
}
