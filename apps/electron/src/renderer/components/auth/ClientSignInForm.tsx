// input: Renderer startup, main-process client auth IPC, and standalone or settings presentation
// output: Reusable managed-account login surface with context-appropriate responsive geometry
// pos: Renderer authentication UI used at managed capability boundaries

import { useEffect, useState, type FormEvent } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import {
  AlertCircle,
  Loader2,
  LockKeyhole,
  LogIn,
  MessageSquareText,
  UserPlus,
} from 'lucide-react'
import { CraftAgentsSymbol } from '@/components/icons/CraftAgentsSymbol'
import { Info_Alert } from '@/components/info/Info_Alert'
import { SettingsCard, SettingsCardContent } from '@/components/settings/SettingsCard'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { cn } from '@/lib/utils'

const AUTH_MOTION_EASE = [0.16, 1, 0.3, 1] as const

type EmailAuthMode = 'sign-in' | 'sign-up'

export function ClientSignInForm({
  emailPasswordEnabled,
  emailSignUpEnabled,
  feishuLoginEnabled,
  usernameLoginEnabled,
  onSignedIn,
  presentation = 'standalone',
}: {
  emailPasswordEnabled: boolean
  emailSignUpEnabled: boolean
  feishuLoginEnabled: boolean
  usernameLoginEnabled: boolean
  onSignedIn: () => Promise<void>
  presentation?: 'standalone' | 'settings'
}) {
  const [identifier, setIdentifier] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [verificationEmail, setVerificationEmail] = useState<string | null>(null)
  const [otp, setOtp] = useState('')
  const [authMode, setAuthMode] = useState<EmailAuthMode>('sign-in')
  const [error, setError] = useState<string | null>(null)
  const [registrationNotice, setRegistrationNotice] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [resendingOtp, setResendingOtp] = useState(false)
  const [feishuSubmitting, setFeishuSubmitting] = useState(false)
  const prefersReducedMotion = useReducedMotion()
  const authPanelMotion = prefersReducedMotion
    ? {}
    : {
        initial: { opacity: 0, y: 10, scale: 0.99 },
        animate: { opacity: 1, y: 0, scale: 1 },
        transition: { duration: 0.22, ease: AUTH_MOTION_EASE },
      }

  useEffect(() => {
    if (!emailSignUpEnabled && authMode === 'sign-up') {
      setAuthMode('sign-in')
      setRegistrationNotice(null)
      setError(null)
    }
  }, [authMode, emailSignUpEnabled])

  async function handleCredentialsSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setSubmitting(true)
    setError(null)
    setRegistrationNotice(null)

    if (authMode === 'sign-up' && !emailSignUpEnabled) {
      setSubmitting(false)
      setError('邮箱注册未开放')
      return
    }

    if (authMode === 'sign-up' && password !== confirmPassword) {
      setSubmitting(false)
      setError('两次输入的密码不一致')
      return
    }

    try {
      if (authMode === 'sign-up') {
        if (!identifier.trim().includes('@')) {
          setError('创建账号需要输入完整邮箱。')
          return
        }
        const result = await window.electronAPI.signUpClient({
          identifier,
          password,
          name: displayName,
        })
        if (result.status === 'verification-required') {
          setVerificationEmail(identifier.trim().toLowerCase())
          setOtp('')
          return
        }
      } else {
        await window.electronAPI.signInClient({ identifier, password })
      }

      await onSignedIn()
    } catch (err) {
      setError(formatClientAuthErrorMessage(err))
    } finally {
      setSubmitting(false)
    }
  }

  async function handleVerificationSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!verificationEmail) return

    setSubmitting(true)
    setError(null)
    setRegistrationNotice(null)
    let verified = false

    try {
      await window.electronAPI.verifyClientEmail({ email: verificationEmail, otp })
      verified = true
      setIdentifier(verificationEmail)
      setVerificationEmail(null)
      setOtp('')
      setConfirmPassword('')
      setAuthMode('sign-in')

      await window.electronAPI.signInClient({ identifier: verificationEmail, password })
      await onSignedIn()
    } catch (err) {
      if (verified) {
        setRegistrationNotice('邮箱验证已完成，可直接登录，无需再次输入验证码。')
      }
      setError(formatClientAuthErrorMessage(err))
    } finally {
      setSubmitting(false)
    }
  }

  async function handleResendVerificationEmail() {
    if (!verificationEmail) return

    setResendingOtp(true)
    setError(null)
    setRegistrationNotice(null)

    try {
      await window.electronAPI.resendClientVerificationEmail({ email: verificationEmail })
      setRegistrationNotice('新的验证码已发送，请检查收件箱和垃圾邮件。')
    } catch (err) {
      setError(formatClientAuthErrorMessage(err))
    } finally {
      setResendingOtp(false)
    }
  }

  function editVerificationEmail() {
    setVerificationEmail(null)
    setOtp('')
    setError(null)
    setRegistrationNotice(null)
  }

  function switchAuthMode(nextMode: EmailAuthMode) {
    if (nextMode === 'sign-up' && !emailSignUpEnabled) return
    setAuthMode(nextMode)
    setError(null)
    setRegistrationNotice(null)
    setPassword('')
    setConfirmPassword('')
    setVerificationEmail(null)
    setOtp('')
  }

  async function handleFeishuSignIn() {
    setFeishuSubmitting(true)
    setError(null)

    try {
      await window.electronAPI.signInWithFeishuClient()
      await onSignedIn()
    } catch (err) {
      setError(formatClientAuthErrorMessage(err))
    } finally {
      setFeishuSubmitting(false)
    }
  }

  async function handleCancelFeishuSignIn() {
    try {
      await window.electronAPI.cancelFeishuSignInClient()
    } catch (err) {
      setError(formatClientAuthErrorMessage(err))
    }
  }

  const formTitle = verificationEmail
    ? '验证邮箱'
    : authMode === 'sign-up' && emailSignUpEnabled
      ? '创建 Storyflow 账号'
      : '登录 Storyflow'
  const formDescription = verificationEmail
    ? `验证码已发送至 ${verificationEmail}。`
    : '登录后可使用 Storyflow 托管模型。'
  const identifierLabel = authMode === 'sign-up'
    ? '邮箱'
    : usernameLoginEnabled ? '用户名或邮箱' : '邮箱'
  const identifierPlaceholder = authMode === 'sign-up'
    ? 'email@example.com'
    : usernameLoginEnabled ? 'zjding 或 email@example.com' : 'email@example.com'
  const isSettingsPresentation = presentation === 'settings'

  return (
    <motion.section
      className={cn('w-full', isSettingsPresentation ? 'max-w-none' : 'max-w-[420px]')}
      {...authPanelMotion}
    >
      <SettingsCard
        className={cn(
          isSettingsPresentation
            ? 'border-border/60 bg-transparent'
            : 'border border-border/60 bg-background shadow-minimal',
        )}
        divided={false}
      >
        <SettingsCardContent
          className={cn(
            isSettingsPresentation
              ? 'grid grid-cols-[minmax(180px,0.72fr)_minmax(320px,1.28fr)] gap-8 px-6 py-7 max-[760px]:grid-cols-1 max-[760px]:gap-6 max-[520px]:p-5'
              : 'p-7 max-[520px]:p-5',
          )}
        >
          <header className={cn(isSettingsPresentation ? 'text-left max-[760px]:text-center' : 'mb-7 text-center')}>
            <div className={cn(
              'flex size-11 items-center justify-center rounded-[10px] bg-foreground-2 shadow-minimal',
              !isSettingsPresentation && 'mx-auto',
              isSettingsPresentation && 'max-[760px]:mx-auto',
            )}>
              <CraftAgentsSymbol className="size-7 text-accent" />
            </div>
            <p className="mt-4 text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
              Storyflow
            </p>
            <h1 className="mt-1 text-[22px] font-semibold leading-7 text-foreground">{formTitle}</h1>
            <p className="mt-2 text-[13px] leading-5 text-muted-foreground">{formDescription}</p>
          </header>

          <div className="space-y-5">
            {verificationEmail ? (
              <form className="space-y-4" onSubmit={handleVerificationSubmit} aria-busy={submitting || resendingOtp}>
                <div className="space-y-1.5">
                  <Label className="text-[13px]" htmlFor="client-auth-otp">邮箱验证码</Label>
                  <Input
                    className="h-10"
                    id="client-auth-otp"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    pattern="[0-9]{6}"
                    maxLength={6}
                    required
                    autoFocus
                    disabled={submitting || resendingOtp}
                    value={otp}
                    onChange={(event) => setOtp(event.target.value.replace(/\D/g, '').slice(0, 6))}
                    aria-describedby="client-auth-otp-help"
                  />
                  <p id="client-auth-otp-help" className="text-[12px] leading-5 text-muted-foreground">
                    请输入邮件中的 6 位数字验证码。
                  </p>
                </div>

                <Button className="h-10 w-full" type="submit" disabled={submitting || resendingOtp}>
                  {submitting ? <Loader2 className="size-4 animate-spin" /> : <LogIn className="size-4" />}
                  验证并登录
                </Button>
                <div className="grid grid-cols-2 gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    disabled={submitting || resendingOtp}
                    onClick={handleResendVerificationEmail}
                  >
                    {resendingOtp ? <Loader2 className="size-4 animate-spin" /> : null}
                    重新发送验证码
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    disabled={submitting || resendingOtp}
                    onClick={editVerificationEmail}
                  >
                    修改邮箱
                  </Button>
                </div>
              </form>
            ) : (
              <>
                {emailPasswordEnabled ? (
                  <form
                    id="client-auth-credentials-form"
                    className="space-y-4"
                    onSubmit={handleCredentialsSubmit}
                    aria-busy={submitting}
                  >
                    <div className="space-y-1.5">
                      <Label className="text-[13px]" htmlFor="client-auth-identifier">
                        {identifierLabel}
                      </Label>
                      <Input
                        className="h-10"
                        id="client-auth-identifier"
                        type={authMode === 'sign-up' ? 'email' : 'text'}
                        autoComplete={authMode === 'sign-up' ? 'email' : 'username'}
                        autoFocus
                        required
                        disabled={submitting || feishuSubmitting}
                        value={identifier}
                        onChange={(event) => setIdentifier(event.target.value)}
                        placeholder={identifierPlaceholder}
                      />
                    </div>

                    <AnimatePresence initial={false}>
                      {authMode === 'sign-up' ? (
                        <motion.div
                          className="space-y-1.5"
                          initial={prefersReducedMotion ? false : { opacity: 0, y: -4 }}
                          animate={{ opacity: 1, y: 0 }}
                          exit={prefersReducedMotion ? undefined : { opacity: 0, y: -4 }}
                          transition={{ duration: 0.16, ease: AUTH_MOTION_EASE }}
                        >
                          <Label className="text-[13px]" htmlFor="client-auth-name">名称（选填）</Label>
                          <Input
                            className="h-10"
                            id="client-auth-name"
                            autoComplete="name"
                            disabled={submitting || feishuSubmitting}
                            value={displayName}
                            onChange={(event) => setDisplayName(event.target.value)}
                            placeholder="你的名字"
                          />
                        </motion.div>
                      ) : null}
                    </AnimatePresence>

                    <div className="space-y-1.5">
                      <Label className="text-[13px]" htmlFor="client-auth-password">密码</Label>
                      <Input
                        className="h-10"
                        id="client-auth-password"
                        type="password"
                        autoComplete={authMode === 'sign-up' ? 'new-password' : 'current-password'}
                        required
                        disabled={submitting || feishuSubmitting}
                        value={password}
                        onChange={(event) => setPassword(event.target.value)}
                      />
                    </div>

                    <AnimatePresence initial={false}>
                      {authMode === 'sign-up' ? (
                        <motion.div
                          className="space-y-1.5"
                          initial={prefersReducedMotion ? false : { opacity: 0, y: -4 }}
                          animate={{ opacity: 1, y: 0 }}
                          exit={prefersReducedMotion ? undefined : { opacity: 0, y: -4 }}
                          transition={{ duration: 0.16, ease: AUTH_MOTION_EASE }}
                        >
                          <Label className="text-[13px]" htmlFor="client-auth-confirm-password">确认密码</Label>
                          <Input
                            className="h-10"
                            id="client-auth-confirm-password"
                            type="password"
                            autoComplete="new-password"
                            required
                            disabled={submitting || feishuSubmitting}
                            value={confirmPassword}
                            onChange={(event) => setConfirmPassword(event.target.value)}
                          />
                        </motion.div>
                      ) : null}
                    </AnimatePresence>

                    <div className={emailSignUpEnabled ? 'grid grid-cols-2 gap-2' : undefined}>
                      <Button
                        className="h-10 w-full"
                        type="submit"
                        disabled={submitting || feishuSubmitting}
                      >
                        {submitting
                          ? <Loader2 className="size-4 animate-spin" />
                          : authMode === 'sign-up'
                            ? <UserPlus className="size-4" />
                            : <LogIn className="size-4" />}
                        {authMode === 'sign-up' ? '创建账号' : '登录'}
                      </Button>
                      {emailSignUpEnabled ? (
                        <Button
                          className="h-10 w-full"
                          type="button"
                          variant="outline"
                          disabled={submitting || feishuSubmitting}
                          onClick={() => switchAuthMode(authMode === 'sign-up' ? 'sign-in' : 'sign-up')}
                        >
                          {authMode === 'sign-up'
                            ? <LogIn className="size-4" />
                            : <UserPlus className="size-4" />}
                          {authMode === 'sign-up' ? '直接登录' : '创建账号'}
                        </Button>
                      ) : null}
                    </div>
                  </form>
                ) : null}

                {emailPasswordEnabled && feishuLoginEnabled ? (
                  <div className="flex items-center gap-3" aria-hidden="true">
                    <div className="h-px flex-1 bg-border/70" />
                    <span className="text-[12px] text-muted-foreground">或</span>
                    <div className="h-px flex-1 bg-border/70" />
                  </div>
                ) : null}

                {feishuLoginEnabled ? (
                  <div className="space-y-2">
                    <Button
                      className="h-10 w-full"
                      type="button"
                      variant={emailPasswordEnabled ? 'outline' : 'default'}
                      disabled={feishuSubmitting || submitting}
                      onClick={handleFeishuSignIn}
                    >
                      {feishuSubmitting
                        ? <Loader2 className="size-4 animate-spin" />
                        : <MessageSquareText className="size-4" />}
                      使用飞书登录
                    </Button>

                    <AnimatePresence initial={false}>
                      {feishuSubmitting ? (
                        <motion.div
                          initial={prefersReducedMotion ? false : { opacity: 0, y: -4 }}
                          animate={{ opacity: 1, y: 0 }}
                          exit={prefersReducedMotion ? undefined : { opacity: 0, y: -4 }}
                          transition={{ duration: 0.16, ease: AUTH_MOTION_EASE }}
                        >
                          <Button
                            className="h-10 w-full"
                            type="button"
                            variant="outline"
                            onClick={handleCancelFeishuSignIn}
                          >
                            取消飞书登录
                          </Button>
                        </motion.div>
                      ) : null}
                    </AnimatePresence>
                  </div>
                ) : null}
              </>
            )}

            <AnimatePresence initial={false}>
              {registrationNotice ? (
                <motion.div
                  initial={prefersReducedMotion ? false : { opacity: 0, y: -4 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={prefersReducedMotion ? undefined : { opacity: 0, y: -4 }}
                  transition={{ duration: 0.16, ease: AUTH_MOTION_EASE }}
                >
                  <Info_Alert variant="info" role="status" aria-live="polite">
                    <Info_Alert.Description className="mt-0 break-words text-[13px] leading-5">
                      {registrationNotice}
                    </Info_Alert.Description>
                  </Info_Alert>
                </motion.div>
              ) : null}
            </AnimatePresence>

            <AnimatePresence initial={false}>
              {error ? (
                <motion.div
                  initial={prefersReducedMotion ? false : { opacity: 0, y: -4 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={prefersReducedMotion ? undefined : { opacity: 0, y: -4 }}
                  transition={{ duration: 0.16, ease: AUTH_MOTION_EASE }}
                >
                  <Info_Alert
                    variant="error"
                    role="alert"
                    aria-live="assertive"
                    icon={<AlertCircle className="size-4" />}
                  >
                    <Info_Alert.Description className="mt-0 break-words text-[13px] leading-5 text-destructive">
                      {error}
                    </Info_Alert.Description>
                  </Info_Alert>
                </motion.div>
              ) : null}
            </AnimatePresence>

            <div className="flex items-start gap-2 border-t border-border/60 pt-4 text-[12px] leading-5 text-muted-foreground">
              <LockKeyhole className="mt-0.5 size-3.5 shrink-0" />
              <p>登录仅用于验证账号，工作区仍保存在本机。</p>
            </div>
          </div>
        </SettingsCardContent>
      </SettingsCard>
    </motion.section>
  )
}

function getErrorMessage(error: unknown): string {
  const message = error instanceof Error
    ? error.message
    : typeof error === 'string'
      ? error
      : '未知错误'

  return message
    .replace(/^Error invoking remote method '[^']+':\s*/u, '')
    .replace(/^Error:\s*/u, '')
}

function formatClientAuthErrorMessage(error: unknown): string {
  const message = getErrorMessage(error)
  if (message === 'Invalid email or password') {
    return '账号或密码不正确。没有账号请先创建账号。'
  }
  if (message === 'Email sign-up is disabled') {
    return '当前未开放邮箱注册。'
  }
  if (message === 'A full email address is required to create an account') {
    return '创建账号需要输入完整邮箱。'
  }
  if (message === 'Neon Auth session is required') return '登录状态已失效，请重新登录。'
  if (message === 'Invalid OTP' || message === 'INVALID_OTP') return '邮箱验证码不正确或已过期。'
  return message
}
