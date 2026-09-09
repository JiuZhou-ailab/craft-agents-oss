// input: One activity expressed as labeled input and output content
// output: Flat activity sections in a content-sized modal or narrow-window fullscreen
// pos: Canonical detail surface for a single chat tool invocation
import { useMemo } from 'react'
import JsonView from '@uiw/react-json-view'
import { deepParseJson, craftAgentDarkTheme, craftAgentLightTheme } from '../../lib/json-view'
import { Layers, Check, Copy } from 'lucide-react'
import { PreviewOverlay } from './PreviewOverlay'
import { ShikiCodeViewer } from '../code-viewer/ShikiCodeViewer'
import { TerminalOutput } from '../terminal/TerminalOutput'
import { Markdown } from '../markdown'
import { CodeBlock } from '../markdown/CodeBlock'
import { detectLanguage } from './GenericOverlay'
import type { OverlayCard } from '../../lib/tool-parsers'
import { OVERLAY_LAYOUT } from '../../lib/layout'

export interface ActivityCardsOverlayProps {
  isOpen: boolean
  onClose: () => void
  cards: OverlayCard[]
  title: string
  theme?: 'light' | 'dark'
  onOpenUrl?: (url: string) => void
  onOpenFile?: (path: string) => void
}

export function ActivityCardsOverlay({
  isOpen,
  onClose,
  cards,
  title,
  theme = 'light',
  onOpenUrl,
  onOpenFile,
}: ActivityCardsOverlayProps) {
  const jsonTheme = useMemo(() => (theme === 'dark' ? craftAgentDarkTheme : craftAgentLightTheme), [theme])

  const renderMarkdown = (content: string) => (
    <div className="text-sm">
      <Markdown
        mode="minimal"
        onUrlClick={onOpenUrl}
        onFileClick={onOpenFile}
        hideFirstMermaidExpand={false}
      >
        {content}
      </Markdown>
    </div>
  )

  const renderCard = (card: OverlayCard) => {
    const data = card.data
    const isInputCard = card.id === 'input'
    const commandPreview = card.commandPreview

    if (data.type === 'json') {
      const processedData = deepParseJson(data.data) as object
      return (
        <div className="min-w-0 space-y-4">
          {isInputCard && commandPreview && (
            <div className="bg-background shadow-minimal rounded-[8px] px-4 py-3 font-mono">
              <div className="text-xs font-semibold text-muted-foreground/70 mb-1">Command</div>
              <div className="text-sm text-foreground overflow-x-auto">
                <span className="text-muted-foreground select-none">$ </span>
                <span>{commandPreview}</span>
              </div>
            </div>
          )}

          <div>
            {isInputCard && (
              <div className="text-xs font-semibold text-muted-foreground/70 mb-2 px-1">Input Params</div>
            )}
            <div className="p-4">
              <JsonView value={processedData} style={jsonTheme} collapsed={false} enableClipboard displayDataTypes={false} shortenTextAfterLength={100}>
                <JsonView.Copied
                  render={(props) => {
                    const isCopied = (props as Record<string, unknown>)['data-copied']
                    return isCopied ? (
                      <Check className="ml-1.5 inline-flex cursor-pointer text-green-500" size={10} onClick={props.onClick} />
                    ) : (
                      <Copy className="ml-1.5 inline-flex cursor-pointer text-muted-foreground hover:text-foreground" size={10} onClick={props.onClick} />
                    )
                  }}
                />
              </JsonView>
            </div>
          </div>
        </div>
      )
    }

    if (data.type === 'code') {
      return (
        <ShikiCodeViewer
          code={data.content}
          filePath={data.filePath}
          language={undefined}
          startLine={data.startLine}
          theme={theme}
        />
      )
    }

    if (data.type === 'terminal') {
      return (
        <TerminalOutput
          command={data.command}
          output={data.output}
          exitCode={data.exitCode}
          toolType={data.toolType}
          description={data.description}
          theme={theme}
        />
      )
    }

    if (data.type === 'document') {
      return renderMarkdown(data.content)
    }

    const lang = detectLanguage(data.content)
    if (lang === 'markdown') {
      return renderMarkdown(data.content)
    }

    return (
      <div className="p-4">
        <CodeBlock code={data.content} language={lang} mode="minimal" forcedTheme={theme} />
      </div>
    )
  }

  return (
    <PreviewOverlay
      isOpen={isOpen}
      onClose={onClose}
      theme={theme}
      typeBadge={{ icon: Layers, label: 'Activity', variant: 'blue' }}
      title={title === 'Activity' ? undefined : title}
      modalBreakpoint={OVERLAY_LAYOUT.desktopModalBreakpoint}
      modalSizing="content"
    >
      <div className="w-full min-w-0 space-y-6 px-6">
        {cards.map((card) => (
          <section key={card.id} className="min-w-0">
            {cards.length > 1 && (
              <h3 className="mb-3 text-xs font-semibold text-muted-foreground">{card.label}</h3>
            )}
            {renderCard(card)}
          </section>
        ))}
      </div>
    </PreviewOverlay>
  )
}
