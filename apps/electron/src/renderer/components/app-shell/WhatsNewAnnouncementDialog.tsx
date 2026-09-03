// input: Short What's New announcement copy and dialog callbacks
// output: App-native update announcement dialog for the first launch after an update
// pos: Lightweight renderer surface between startup policy and full release notes overlay


import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import type { WhatsNewAnnouncementCopy } from './whats-new-announcement'

interface WhatsNewAnnouncementDialogProps {
  open: boolean
  copy: WhatsNewAnnouncementCopy | null
  accentColor?: string
  onOpenChange: (open: boolean) => void
  onShowDetails: () => void
}

export function WhatsNewAnnouncementDialog({
  open,
  copy,
  accentColor,
  onOpenChange,
  onShowDetails,
}: WhatsNewAnnouncementDialogProps) {
  if (!copy) return null

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="md" className="max-h-[calc(100dvh-2rem)] gap-0 overflow-hidden p-0">
        <DialogHeader className="gap-0 px-6 pt-6 pr-12 text-left">
          <p className="mb-2 text-[11px] font-medium text-muted-foreground">
            {copy.versionLabel}
          </p>
          <DialogTitle className="text-[20px] leading-7 tracking-[-0.01em]">
            {copy.title}
          </DialogTitle>
          <DialogDescription className="mt-2 max-w-[44ch] text-[13px] leading-5 text-foreground/65">
            {copy.summary}
          </DialogDescription>
        </DialogHeader>

        {copy.guideItems.length > 0 && (
          <div className="min-h-0 overflow-y-auto px-6 pt-5">
            <ul
              className="space-y-2.5 border-l-2 pl-4 text-[13px] leading-5 text-foreground/85"
              style={{ borderLeftColor: accentColor ?? 'var(--accent)' }}
            >
              {copy.guideItems.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </div>
        )}

        <DialogFooter className="mt-5 border-t border-border/60 px-6 py-4">
          <Button type="button" variant="ghost" onClick={onShowDetails}>
            {copy.secondaryActionLabel}
          </Button>
          <Button type="button" onClick={() => onOpenChange(false)}>
            {copy.primaryActionLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
