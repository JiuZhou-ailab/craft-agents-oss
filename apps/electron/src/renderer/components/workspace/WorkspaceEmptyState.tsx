// input: Valid project identity, root path, and existing workspace actions
// output: Actionable start page body aligned with the chat opening surface
// pos: Writing-workspace start page below the shared document-tab header

import { useTranslation } from 'react-i18next'
import {
  resolveChatOpeningPrompt,
  type ChatOpeningCommandAction,
  type ChatOpeningCommand,
} from '@/components/app-shell/chat-opening'

interface WorkspaceEmptyStateProps {
  workspaceName: string
  rootPath: string
  onCreateFile: () => void
  onImportFiles: () => void
  onOpenSkills: () => void
}

export function WorkspaceEmptyState({
  workspaceName,
  rootPath,
  onCreateFile,
  onImportFiles,
  onOpenSkills,
}: WorkspaceEmptyStateProps) {
  const { t } = useTranslation()
  const opening = resolveChatOpeningPrompt({
    workspaceName,
    isProject: true,
    hasUserContent: false,
  })

  const runCommand = (command: ChatOpeningCommand) => {
    if (command === 'create-file') onCreateFile()
    else if (command === 'import-files') onImportFiles()
    else onOpenSkills()
  }

  return (
    <div
      data-testid="workspace-empty-state"
      className="flex h-full min-h-0 flex-1 items-center justify-center overflow-y-auto px-5 py-8"
      aria-label={workspaceName}
    >
      <div className="w-full max-w-[320px]">
        <div className="text-center">
          <h2 className="text-[15px] font-medium leading-5 text-foreground">
            {t(opening.titleKey)}
          </h2>
          <p className="mt-1.5 text-xs text-muted-foreground">
            {t('chatOpening.contextProject', { workspaceName })}
          </p>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground/70">
            {t(opening.hintKey)}
          </p>
        </div>

        <div className="mt-5 space-y-3 text-left">
          {opening.sections.map((section) => (
            <section key={section.id}>
              <div className="mb-2 px-1 text-[11px] font-medium text-muted-foreground">
                {t(section.labelKey)}
              </div>
              <div className="flex flex-col gap-2">
                {section.actions
                  .filter((action): action is ChatOpeningCommandAction => action.kind === 'command')
                  .map((action) => (
                    <button
                      key={action.id}
                      type="button"
                      data-workspace-action={action.command}
                      onClick={() => runCommand(action.command)}
                      className="min-h-[44px] rounded-[7px] border border-border/60 bg-background px-3 py-1.5 text-left shadow-minimal transition-[background-color,border-color,transform] hover:border-foreground/20 hover:bg-foreground/[0.03] active:translate-y-px focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                    >
                      <span className="block text-[13px] font-medium text-foreground/85">
                        {t(action.labelKey)}
                      </span>
                      <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">
                        {t(action.descriptionKey)}
                      </span>
                    </button>
                  ))}
              </div>
            </section>
          ))}
        </div>

        <div
          className="mt-5 w-full truncate rounded-[6px] bg-foreground/[0.03] px-2.5 py-1.5 font-mono text-[10px] text-muted-foreground/65"
          title={rootPath}
        >
          {rootPath}
        </div>
      </div>
    </div>
  )
}
