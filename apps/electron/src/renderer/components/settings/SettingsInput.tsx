// input: Text setting values, labels, validation state, and change handlers
// output: Compact text inputs for standalone and card-based settings
// pos: Shared renderer control for single-line settings values

/**
 * SettingsInput
 *
 * Text input with label for settings pages.
 * Supports password type with show/hide toggle.
 */

import * as React from 'react'
import { Eye, EyeOff } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { cn } from '@/lib/utils'
import { settingsUI } from './SettingsUIConstants'

export interface SettingsInputProps {
  /** Input label */
  label?: string
  /** Optional description below label */
  description?: string
  /** Current value */
  value: string
  /** Change handler */
  onChange: (value: string) => void
  /** Placeholder text */
  placeholder?: string
  /** Input type */
  type?: 'text' | 'password' | 'email' | 'url'
  /** Disabled state */
  disabled?: boolean
  /** Error message */
  error?: string
  /** Action button next to input */
  action?: React.ReactNode
  /** Additional className */
  className?: string
  /** Whether inside a card */
  inCard?: boolean
  /** onBlur handler */
  onBlur?: () => void
  /** onKeyDown handler */
  onKeyDown?: (e: React.KeyboardEvent) => void
}

/**
 * SettingsInput - Text input with label
 *
 * @example
 * <SettingsInput
 *   label="Name"
 *   value={name}
 *   onChange={setName}
 *   placeholder="Enter your name..."
 * />
 */
export function SettingsInput({
  label,
  description,
  value,
  onChange,
  placeholder,
  type = 'text',
  disabled,
  error,
  action,
  className,
  inCard = false,
  onBlur,
  onKeyDown,
}: SettingsInputProps) {
  const id = React.useId()
  const errorId = `${id}-error`
  const [showPassword, setShowPassword] = React.useState(false)
  const isPassword = type === 'password'
  const inputType = isPassword && showPassword ? 'text' : type

  return (
    <div
      className={cn(
        'space-y-1',
        inCard && 'px-4 py-3',
        className
      )}
    >
      {label && (
        <div className={settingsUI.labelGroup}>
          <Label htmlFor={id} className={settingsUI.label}>
            {label}
          </Label>
          {description && (
            <p className={cn(settingsUI.description, settingsUI.labelDescriptionGap)}>{description}</p>
          )}
        </div>
      )}
      <div className="flex gap-2">
        <div className="relative flex-1">
          <Input
            id={id}
            type={inputType}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder={placeholder}
            disabled={disabled}
            aria-invalid={Boolean(error)}
            aria-describedby={error ? errorId : undefined}
            onBlur={onBlur}
            onKeyDown={onKeyDown}
            className={cn(
              'border-foreground/10 bg-muted/40 shadow-none hover:bg-muted/60 focus-visible:border-foreground/25 focus-visible:bg-background focus-visible:ring-2 focus-visible:ring-foreground/50',
              error && 'border-destructive focus-visible:ring-destructive/20',
              isPassword && 'pr-10'
            )}
          />
          {isPassword && (
            <button
              type="button"
              onClick={() => setShowPassword(!showPassword)}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
              tabIndex={-1}
            >
              {showPassword ? (
                <EyeOff className="size-4" />
              ) : (
                <Eye className="size-4" />
              )}
            </button>
          )}
        </div>
        {action}
      </div>
      {error && <p id={errorId} className="text-sm text-destructive">{error}</p>}
    </div>
  )
}

/**
 * SettingsInputRow - Inline input with label on left
 *
 * For settings where the input should be on the right side
 */
export interface SettingsInputRowProps {
  /** Row label */
  label: string
  /** Optional description below label */
  description?: string
  /** Current value */
  value: string
  /** Change handler */
  onChange: (value: string) => void
  /** Placeholder text */
  placeholder?: string
  /** Input type */
  type?: 'text' | 'password' | 'email' | 'url'
  /** Disabled state */
  disabled?: boolean
  /** Error message */
  error?: string
  /** Additional className */
  className?: string
  /** Whether inside a card */
  inCard?: boolean
}

export function SettingsInputRow({
  label,
  description,
  value,
  onChange,
  placeholder,
  type = 'text',
  disabled,
  error,
  className,
  inCard = true,
}: SettingsInputRowProps) {
  const id = React.useId()
  const errorId = `${id}-error`

  return (
    <div
      data-layout="settings-row"
      className={cn(
        'flex items-center justify-between',
        inCard ? 'px-4 py-3' : 'py-3',
        className
      )}
    >
      <div className="flex-1 min-w-0">
        <Label htmlFor={id} className={settingsUI.label}>
          {label}
        </Label>
        {description && (
          <p className={cn(settingsUI.description, settingsUI.labelDescriptionGap)}>{description}</p>
        )}
        {error && <p id={errorId} className={cn('text-sm text-destructive', settingsUI.labelDescriptionGap)}>{error}</p>}
      </div>
      <div data-layout="settings-control" className="ml-4 shrink-0">
        <Input
          id={id}
          type={type}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          disabled={disabled}
          aria-invalid={Boolean(error)}
          aria-describedby={error ? errorId : undefined}
          className={cn(
            'w-[200px] border-foreground/10 bg-muted/40 shadow-none hover:bg-muted/60 focus-visible:border-foreground/25 focus-visible:bg-background focus-visible:ring-2 focus-visible:ring-foreground/50',
            error && 'border-destructive focus-visible:ring-destructive/20'
          )}
        />
      </div>
    </div>
  )
}

/**
 * SettingsSecretInput - Password input with show/hide and optional validation
 *
 * Specialized for API keys, tokens, etc.
 */
export interface SettingsSecretInputProps {
  /** Input label */
  label?: string
  /** Optional description */
  description?: string
  /** Current value */
  value: string
  /** Change handler */
  onChange: (value: string) => void
  /** Placeholder text */
  placeholder?: string
  /** Disabled state */
  disabled?: boolean
  /** Error message */
  error?: string
  /** Additional className */
  className?: string
  /** Whether inside a card */
  inCard?: boolean
  /** onBlur handler */
  onBlur?: () => void
}

export function SettingsSecretInput({
  label,
  description,
  value,
  onChange,
  placeholder = 'Enter value...',
  disabled,
  error,
  className,
  inCard = false,
  onBlur,
}: SettingsSecretInputProps) {
  const id = React.useId()
  const errorId = `${id}-error`
  const [showValue, setShowValue] = React.useState(false)

  return (
    <div
      className={cn(
        'space-y-1',
        inCard && 'px-4 py-3',
        className
      )}
    >
      {label && (
        <div className={settingsUI.labelGroup}>
          <Label htmlFor={id} className={settingsUI.label}>
            {label}
          </Label>
          {description && (
            <p className={cn(settingsUI.description, settingsUI.labelDescriptionGap)}>{description}</p>
          )}
        </div>
      )}
      <div className="relative">
        <Input
          id={id}
          type={showValue ? 'text' : 'password'}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          disabled={disabled}
          aria-invalid={Boolean(error)}
          aria-describedby={error ? errorId : undefined}
          onBlur={onBlur}
          className={cn(
            'pr-10 border-foreground/10 bg-muted/40 shadow-none hover:bg-muted/60 focus-visible:border-foreground/25 focus-visible:bg-background focus-visible:ring-2 focus-visible:ring-foreground/50',
            error && 'border-destructive focus-visible:ring-destructive/20'
          )}
        />
        <button
          type="button"
          onClick={() => setShowValue(!showValue)}
          className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
          tabIndex={-1}
        >
          {showValue ? (
            <EyeOff className="size-4" />
          ) : (
            <Eye className="size-4" />
          )}
        </button>
      </div>
      {error && <p id={errorId} className="text-sm text-destructive">{error}</p>}
    </div>
  )
}
