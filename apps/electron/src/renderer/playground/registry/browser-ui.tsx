import { useCallback, useState } from 'react'
import type { ComponentEntry } from './types'
import {
  BrowserControls,
  BrowserEmptyStateCard,
} from '@craft-agent/ui'
import { AnimatePresence, motion } from 'motion/react'
import { EMPTY_STATE_PROMPT_SAMPLES } from '@/components/browser/empty-state-prompts'
import { BROWSER_LIVE_FX_BORDER, getBrowserLiveFxCornerRadii } from '../../../shared/browser-live-fx'
import { routes } from '../../../shared/routes'
import { isLinux, isMac, isWindows } from '@/lib/platform'

type RunState = 'completed' | 'running' | 'failed'
type Scenario = 'core' | 'all-native-tools' | 'browser-tool-wrapper' | 'full-matrix'
type AgentVisualState = 'idle' | 'active' | 'failed'
type BrowserSurfaceMode = 'content' | 'empty-state'

const PLAYGROUND_LIVE_FX_CORNERS = getBrowserLiveFxCornerRadii(
  isMac
    ? 'darwin'
    : isWindows
      ? 'win32'
      : isLinux
        ? 'linux'
        : 'other',
)

function getLiveFxPayload(scenario: Scenario, runState: RunState): { active: boolean; label: string; cursor: { x: number; y: number } | null } {
  if (runState === 'failed') {
    return {
      active: true,
      label: 'Action failed — verify refs and retry',
      cursor: null,
    }
  }

  if (runState === 'running') {
    const cursorByScenario: Record<Scenario, { x: number; y: number } | null> = {
      core: { x: 296, y: 252 },
      'all-native-tools': { x: 426, y: 214 },
      'browser-tool-wrapper': { x: 342, y: 304 },
      'full-matrix': { x: 382, y: 246 },
    }

    return {
      active: true,
      label: 'Craft Agents are working…',
      cursor: cursorByScenario[scenario],
    }
  }

  return {
    active: false,
    label: '',
    cursor: null,
  }
}

function getLiveFxPayloadFromAgentState(
  scenario: Scenario,
  agentState: AgentVisualState,
): { active: boolean; label: string; cursor: { x: number; y: number } | null } {
  switch (agentState) {
    case 'failed':
      return getLiveFxPayload(scenario, 'failed')
    case 'active':
      return getLiveFxPayload(scenario, 'running')
    case 'idle':
    default:
      return getLiveFxPayload(scenario, 'completed')
  }
}

function BrowserAgentEmptyState({
  title,
  description,
  showExamplePrompts,
  showSafetyHint,
}: {
  title: string
  description: string
  showExamplePrompts: boolean
  showSafetyHint: boolean
}) {
  const handlePromptSelect = useCallback(async (prompt: string) => {
    const deepLinkRoute = routes.action.newSession({ input: prompt, send: true })
    const deepLinkUrl = `craftagents://${deepLinkRoute}`

    try {
      if (typeof window !== 'undefined' && window.electronAPI?.openUrl) {
        await window.electronAPI.openUrl(deepLinkUrl)
        return
      }

      if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(prompt)
      }
      console.info('[BrowserEmptyState] Prompt copied (Electron API unavailable):', prompt)
    } catch (error) {
      console.warn('[BrowserEmptyState] Failed to open prompt deep link:', error)
    }
  }, [])

  return (
    <BrowserEmptyStateCard
      title={title}
      description={description}
      prompts={EMPTY_STATE_PROMPT_SAMPLES}
      showExamplePrompts={showExamplePrompts}
      showSafetyHint={showSafetyHint}
      onPromptSelect={(sample) => void handlePromptSelect(sample.full)}
    />
  )
}

function BrowserMockPageSurface({
  className,
  mode = 'content',
  emptyStateTitle = 'This browser is ready for your Agents - and you ;)',
  emptyStateDescription = 'Ask any session to use this browser (or open another one) to complete tasks like research, form filling, QA checks, or data extraction.',
  showExamplePrompts = true,
  showSafetyHint = true,
}: {
  className?: string
  mode?: BrowserSurfaceMode
  emptyStateTitle?: string
  emptyStateDescription?: string
  showExamplePrompts?: boolean
  showSafetyHint?: boolean
}) {
  if (mode === 'empty-state') {
    return (
      <div className={className ?? 'absolute inset-0 p-6 z-10'}>
        <BrowserAgentEmptyState
          title={emptyStateTitle}
          description={emptyStateDescription}
          showExamplePrompts={showExamplePrompts}
          showSafetyHint={showSafetyHint}
        />
      </div>
    )
  }

  return (
    <div className={className ?? 'absolute inset-0 p-6 z-10'}>
      <div className="h-10 rounded-lg border border-foreground/10 bg-background/80 backdrop-blur-sm" />
      <div className="mt-4 grid grid-cols-3 gap-3">
        <div className="h-24 rounded-lg bg-foreground/5" />
        <div className="h-24 rounded-lg bg-foreground/5" />
        <div className="h-24 rounded-lg bg-foreground/5" />
      </div>
      <div className="mt-4 space-y-2">
        <div className="h-4 w-[70%] rounded bg-foreground/10" />
        <div className="h-4 w-[85%] rounded bg-foreground/8" />
        <div className="h-4 w-[60%] rounded bg-foreground/10" />
      </div>
    </div>
  )
}

function BrowserEdgeShaderFx({ className = 'absolute inset-0 pointer-events-none z-20', rounded = false }: { className?: string; rounded?: boolean }) {
  return (
    <div
      className={className}
      style={{
        borderTopLeftRadius: rounded ? PLAYGROUND_LIVE_FX_CORNERS.topLeft : undefined,
        borderTopRightRadius: rounded ? PLAYGROUND_LIVE_FX_CORNERS.topRight : undefined,
        borderBottomLeftRadius: rounded ? PLAYGROUND_LIVE_FX_CORNERS.bottomLeft : undefined,
        borderBottomRightRadius: rounded ? PLAYGROUND_LIVE_FX_CORNERS.bottomRight : undefined,
        borderWidth: BROWSER_LIVE_FX_BORDER.width,
        borderStyle: BROWSER_LIVE_FX_BORDER.style,
        borderColor: BROWSER_LIVE_FX_BORDER.color,
        boxShadow: BROWSER_LIVE_FX_BORDER.boxShadow,
      }}
    />
  )
}

function BrowserFramePlayground({
  initialUrl,
  loading,
  agentState,
  themeColor,
  surfaceMode,
  emptyStateTitle,
  emptyStateDescription,
  showExamplePrompts,
  showSafetyHint,
}: {
  initialUrl: string
  loading: boolean
  agentState: AgentVisualState
  themeColor: string
  surfaceMode: BrowserSurfaceMode
  emptyStateTitle: string
  emptyStateDescription: string
  showExamplePrompts: boolean
  showSafetyHint: boolean
}) {
  const [url, setUrl] = useState(initialUrl)
  const scenario: Scenario = 'full-matrix'
  const liveFx = getLiveFxPayloadFromAgentState(scenario, agentState)

  return (
    <div className="w-full h-[700px] rounded-xl border border-border overflow-hidden bg-background shadow-sm flex">
      <div className="flex-1 min-w-0">
        <BrowserControls
          url={url}
          loading={loading}
          onNavigate={setUrl}
          onUrlChange={setUrl}
          themeColor={themeColor || undefined}
          urlBarClassName="max-w-[600px]"
          className="border-b-0"
        />
        <div className="h-[calc(100%-48px)] bg-foreground-2">
          <div className="relative h-full w-full bg-background overflow-hidden">
            <BrowserMockPageSurface
              className="absolute inset-0 p-6"
              mode={surfaceMode}
              emptyStateTitle={emptyStateTitle}
              emptyStateDescription={emptyStateDescription}
              showExamplePrompts={showExamplePrompts}
              showSafetyHint={showSafetyHint}
            />

            <AnimatePresence>
              {liveFx.active && (
                <motion.div
                  className="absolute inset-0 pointer-events-none z-20"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.2, ease: 'easeOut' }}
                >
                  <BrowserEdgeShaderFx className="absolute inset-0" rounded />

                  <div
                    className="absolute text-[11px]"
                    style={{
                      top: '8px',
                      right: '8px',
                      padding: '4px 8px',
                      borderRadius: '7px',
                      font: '11px -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif',
                      background: 'rgba(2, 6, 23, 0.82)',
                      color: 'rgba(236, 254, 255, 0.95)',
                      backdropFilter: 'blur(4px)',
                    }}
                  >
                    {liveFx.label}
                  </div>

                  {liveFx.cursor && (
                    <motion.div
                      className="absolute"
                      style={{
                        width: '18px',
                        height: '22px',
                        left: liveFx.cursor.x - 2,
                        top: liveFx.cursor.y - 2,
                        filter: 'drop-shadow(0 0 8px rgba(0,0,0,0.35))',
                      }}
                      initial={{ opacity: 0, scale: 0.95 }}
                      animate={{ opacity: 1, scale: 1 }}
                      transition={{ duration: 0.16, ease: 'easeOut' }}
                    >
                      <div
                        className="h-full w-full bg-black"
                        style={{
                          clipPath: 'polygon(0% 0%, 0% 100%, 34% 73%, 51% 100%, 66% 94%, 48% 67%, 100% 67%)',
                          borderRadius: '2px',
                          outline: '1px solid rgba(255,255,255,0.75)',
                        }}
                      />
                    </motion.div>
                  )}
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </div>
      </div>

    </div>
  )
}

function BrowserEmptyStatePlayground({
  title,
  description,
  showExamplePrompts,
  showSafetyHint,
}: {
  title: string
  description: string
  showExamplePrompts: boolean
  showSafetyHint: boolean
}) {
  return (
    <div className="w-full h-[700px] rounded-xl border border-border overflow-hidden bg-background shadow-sm flex">
      <div className="relative h-full w-full bg-foreground-2 overflow-hidden">
        <BrowserMockPageSurface
          className="absolute inset-0 p-8"
          mode="empty-state"
          emptyStateTitle={title}
          emptyStateDescription={description}
          showExamplePrompts={showExamplePrompts}
          showSafetyHint={showSafetyHint}
        />
      </div>
    </div>
  )
}

export const browserUiComponents: ComponentEntry[] = [
  {
    id: 'browser-frame-playground',
    name: 'Browser Frame (Dedicated Controls)',
    category: 'Browser',
    description: 'Dedicated always-visible browser controls frame for iterating visual design before wiring to native window.',
    component: BrowserFramePlayground,
    layout: 'top',
    props: [
      {
        name: 'initialUrl',
        description: 'Initial URL value shown in the address field.',
        control: { type: 'string' },
        defaultValue: 'https://www.iana.org/help',
      },
      {
        name: 'loading',
        description: 'Website loading state only (URL bar spinner + Stop/Reload).',
        control: { type: 'boolean' },
        defaultValue: false,
      },


      {
        name: 'agentState',
        description: 'Agent activity state only (independent from website loading).',
        control: {
          type: 'select',
          options: [
            { label: 'Idle', value: 'idle' },
            { label: 'Active', value: 'active' },
            { label: 'Failed', value: 'failed' },
          ],
        },
        defaultValue: 'idle',
      },
      {
        name: 'themeColor',
        description: 'Website theme color (hex). Simulates <meta name="theme-color">.',
        control: {
          type: 'select',
          options: [
            { label: 'None', value: '' },
            { label: 'Google Blue (#4285f4)', value: '#4285f4' },
            { label: 'GitHub Dark (#24292e)', value: '#1e2327' },
            { label: 'Stripe Purple (#635bff)', value: '#635bff' },
            { label: 'Slack (#4a154b)', value: '#4a154b' },
            { label: 'Linear (#5e6ad2)', value: 'lch(96.667% 0 282.863 / 1)' },
            { label: 'Twitter/X (#15202b)', value: '#15202b' },
            { label: 'YouTube Red (#ff0000)', value: '#ff0000' },
            { label: 'Light Gray (#f5f5f5)', value: '#f5f5f5' },
            { label: 'White (#ffffff)', value: '#ffffff' },
          ],
        },
        defaultValue: '',
      },
      {
        name: 'surfaceMode',
        description: 'Switch between generic mock page content and the new browser onboarding empty state.',
        control: {
          type: 'select',
          options: [
            { label: 'Empty State', value: 'empty-state' },
            { label: 'Mock Content', value: 'content' },
          ],
        },
        defaultValue: 'empty-state',
      },
      {
        name: 'emptyStateTitle',
        description: 'Main heading shown in the browser empty state.',
        control: { type: 'string' },
        defaultValue: 'This browser is ready for your Agents - and you ;)',
      },
      {
        name: 'emptyStateDescription',
        description: 'Body copy describing how sessions can use this browser window.',
        control: { type: 'string' },
        defaultValue: 'Ask any session to use this browser (or open another one) to complete tasks like research, form filling, QA checks, or data extraction.',
      },
      {
        name: 'showExamplePrompts',
        description: 'Show quick prompt chips that demonstrate browser automation requests.',
        control: { type: 'boolean' },
        defaultValue: true,
      },
      {
        name: 'showSafetyHint',
        description: 'Show a small trust hint explaining that browser control is user-triggered.',
        control: { type: 'boolean' },
        defaultValue: true,
      },

    ],
  },
  {
    id: 'browser-empty-state-playground',
    name: 'Browser Empty State (Agent Guidance)',
    category: 'Browser',
    description: 'Focused preview of the first-load browser empty state message for copy and visual iteration.',
    component: BrowserEmptyStatePlayground,
    layout: 'top',
    props: [
      {
        name: 'title',
        description: 'Main heading for the empty state card.',
        control: { type: 'string' },
        defaultValue: 'This browser is ready for your Agents - and you ;)',
      },
      {
        name: 'description',
        description: 'Explanatory copy shown under the title.',
        control: { type: 'string' },
        defaultValue: 'Ask any session to use this browser (or open another one) to complete tasks like research, form filling, QA checks, or data extraction.',
      },
      {
        name: 'showExamplePrompts',
        description: 'Show quick prompt examples for common browser workflows.',
        control: { type: 'boolean' },
        defaultValue: true,
      },
      {
        name: 'showSafetyHint',
        description: 'Show a subtle note that browser control happens only when requested.',
        control: { type: 'boolean' },
        defaultValue: true,
      },
    ],
  },

]
