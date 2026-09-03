// input: Selected onboarding API setup method, credential status, and optional edit initial values
// output: Credential entry or OAuth connection step for onboarding
// pos: Onboarding credential collection wrapper for provider-specific setup controls

import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { Check, ExternalLink } from "lucide-react"
import type { CredentialSetupMethod } from "./APISetupStep"
import { StepFormLayout, BackButton, ContinueButton } from "./primitives"
import {
  ApiKeyInput,
  type ApiKeyStatus,
  type ApiKeySubmitData,
  OAuthConnect,
  type OAuthStatus,
} from "../apisetup"
import type { CustomEndpointApi } from '@config/llm-connections'

export type CredentialStatus = ApiKeyStatus | OAuthStatus

interface CredentialsStepProps {
  apiSetupMethod: CredentialSetupMethod
  status: CredentialStatus
  errorMessage?: string
  onSubmit: (data: ApiKeySubmitData) => void
  onStartOAuth?: (methodOverride?: CredentialSetupMethod) => void
  onBack: () => void
  // Two-step OAuth flow
  isWaitingForCode?: boolean
  onSubmitAuthCode?: (code: string) => void
  onCancelOAuth?: () => void
  // Device flow (Copilot)
  copilotDeviceCode?: { userCode: string; verificationUri: string }
  // Edit mode (pre-fill existing connection values)
  editInitialValues?: {
    apiKey?: string
    baseUrl?: string
    connectionDefaultModel?: string
    activePreset?: string
    models?: string[]
    customApi?: CustomEndpointApi
  }
}

export function CredentialsStep({
  apiSetupMethod,
  status,
  errorMessage,
  onSubmit,
  onStartOAuth,
  onBack,
  isWaitingForCode,
  onSubmitAuthCode,
  onCancelOAuth,
  copilotDeviceCode,
  editInitialValues,
}: CredentialsStepProps) {
  const { t } = useTranslation()
  const isClaudeOAuth = apiSetupMethod === 'claude_oauth'
  const isChatGptOAuth = apiSetupMethod === 'pi_chatgpt_oauth'
  const isCopilotOAuth = apiSetupMethod === 'pi_copilot_oauth'
  const isPiApiKey = apiSetupMethod === 'pi_api_key'

  // Copilot device code clipboard handling
  const [copiedCode, setCopiedCode] = useState(false)

  // Auto-copy device code to clipboard when it appears
  useEffect(() => {
    let clearCopiedTimer: ReturnType<typeof setTimeout> | null = null

    if (copilotDeviceCode?.userCode) {
      navigator.clipboard.writeText(copilotDeviceCode.userCode).then(() => {
        setCopiedCode(true)
        clearCopiedTimer = setTimeout(() => setCopiedCode(false), 2000)
      }).catch(() => {
        // Clipboard write failed, user can still click to copy
      })
    }

    return () => {
      if (clearCopiedTimer) clearTimeout(clearCopiedTimer)
    }
  }, [copilotDeviceCode?.userCode])

  const handleCopyCode = () => {
    if (copilotDeviceCode?.userCode) {
      navigator.clipboard.writeText(copilotDeviceCode.userCode).then(() => {
        setCopiedCode(true)
        setTimeout(() => setCopiedCode(false), 2000)
      })
    }
  }

  // --- ChatGPT OAuth flow (native browser OAuth) ---
  if (isChatGptOAuth) {
    return (
      <StepFormLayout
        title={t("onboarding.credentials.connectChatGPT")}
        description={t("onboarding.credentials.connectChatGPTDesc")}
        actions={
          <>
            <BackButton onClick={onBack} disabled={status === 'validating'} />
            <ContinueButton
              onClick={() => onStartOAuth?.()}
              className="gap-2"
              loading={status === 'validating'}
              loadingText={t("common.connecting")}
            >
              <ExternalLink className="size-4" />
              {t("onboarding.credentials.signInChatGPT")}
            </ContinueButton>
          </>
        }
      >
        <div className="space-y-4">
          <div className="rounded-xl bg-foreground-2 p-4 text-sm text-muted-foreground">
            <p>{t("onboarding.credentials.chatGPTInstructions")}</p>
          </div>
          {status === 'error' && errorMessage && (
            <div className="rounded-lg bg-destructive/10 text-destructive text-sm p-3">
              {errorMessage}
            </div>
          )}
          {status === 'success' && (
            <div className="rounded-lg bg-success/10 text-success text-sm p-3">
              {t("onboarding.credentials.chatGPTConnected")}
            </div>
          )}
        </div>
      </StepFormLayout>
    )
  }

  // --- Copilot OAuth flow (device flow) ---
  if (isCopilotOAuth) {
    return (
      <StepFormLayout
        title={t("onboarding.credentials.connectGitHub")}
        description={t("onboarding.credentials.connectGitHubDesc")}
        actions={
          <>
            <BackButton onClick={onBack} disabled={status === 'validating'} />
            <ContinueButton
              onClick={() => onStartOAuth?.()}
              className="gap-2"
              loading={status === 'validating'}
              loadingText={t("onboarding.credentials.waitingForAuth")}
            >
              <ExternalLink className="size-4" />
              {t("onboarding.credentials.signInGitHub")}
            </ContinueButton>
          </>
        }
      >
        <div className="space-y-4">
          {copilotDeviceCode ? (
            <div className="rounded-xl bg-foreground-2 p-4 text-sm space-y-3">
              <p className="text-muted-foreground text-center">
                {t("onboarding.credentials.enterCodeOnGitHub")}
              </p>
              <div className="flex flex-col items-center justify-center gap-2">
                <button
                  type="button"
                  onClick={handleCopyCode}
                  className="text-2xl font-mono font-bold tracking-widest text-foreground px-4 py-2 rounded-lg bg-background border border-border hover:bg-foreground-2 transition-colors cursor-pointer"
                >
                  {copilotDeviceCode.userCode}
                </button>
                <span className={`text-xs text-muted-foreground flex items-center gap-1 transition-opacity ${copiedCode ? 'opacity-100' : 'opacity-0'}`}>
                  <Check className="size-3" />
                  {t("onboarding.credentials.copiedToClipboard")}
                </span>
              </div>
              <p className="text-muted-foreground text-xs text-center">
                {t("onboarding.credentials.browserOpenedGitHub")}
              </p>
            </div>
          ) : (
            <div className="rounded-xl bg-foreground-2 p-4 text-sm text-muted-foreground text-center">
              <p>{t("onboarding.credentials.clickToSignInGitHub")}</p>
            </div>
          )}
          {status === 'error' && errorMessage && (
            <div className="rounded-lg bg-destructive/10 text-destructive text-sm p-3 text-center">
              {errorMessage}
            </div>
          )}
          {status === 'success' && (
            <div className="rounded-lg bg-success/10 text-success text-sm p-3 text-center">
              {t("onboarding.credentials.copilotConnected")}
            </div>
          )}
        </div>
      </StepFormLayout>
    )
  }

  // --- Claude OAuth flow ---
  if (isClaudeOAuth) {
    // Waiting for authorization code entry
    if (isWaitingForCode) {
      return (
        <StepFormLayout
          title={t("onboarding.credentials.enterAuthCode")}
          description={t("onboarding.credentials.copyCodeInstruction")}
          actions={
            <>
              <BackButton onClick={onCancelOAuth} disabled={status === 'validating'}>{t("common.cancel")}</BackButton>
              <ContinueButton
                type="submit"
                form="auth-code-form"
                disabled={false}
                loading={status === 'validating'}
                loadingText={t("common.connecting")}
              />
            </>
          }
        >
          <OAuthConnect
            status={status as OAuthStatus}
            errorMessage={errorMessage}
            isWaitingForCode={true}
            onStartOAuth={onStartOAuth!}
            onSubmitAuthCode={onSubmitAuthCode}
            onCancelOAuth={onCancelOAuth}
          />
        </StepFormLayout>
      )
    }

    return (
      <StepFormLayout
        title={t("onboarding.credentials.connectClaude")}
        description={t("onboarding.credentials.claudeSubscriptionDesc")}
        actions={
          <>
            <BackButton onClick={onBack} disabled={status === 'validating'} />
            <ContinueButton
              onClick={() => onStartOAuth?.()}
              className="gap-2"
              loading={status === 'validating'}
              loadingText={t("common.connecting")}
            >
              <ExternalLink className="size-4" />
              {t("onboarding.credentials.signInClaude")}
            </ContinueButton>
          </>
        }
      >
        <OAuthConnect
          status={status as OAuthStatus}
          errorMessage={errorMessage}
          isWaitingForCode={false}
          onStartOAuth={onStartOAuth!}
          onSubmitAuthCode={onSubmitAuthCode}
          onCancelOAuth={onCancelOAuth}
        />
      </StepFormLayout>
    )
  }

  // --- API Key flow ---
  // Determine provider type and description based on selected method
  const providerType = isPiApiKey ? 'pi_api_key' : 'anthropic'
  const apiKeyDescription = isPiApiKey
    ? "Select a provider preset and enter the API key. For arbitrary Anthropic-compatible endpoints, use Anthropic API Key mode."
    : "Enter your API key. Optionally configure a custom endpoint for OpenRouter, Ollama, or compatible APIs."

  const effectiveInitialValues = editInitialValues

  const apiKeyInputKey = [
    apiSetupMethod,
    effectiveInitialValues?.activePreset ?? '',
    effectiveInitialValues?.baseUrl ?? '',
    effectiveInitialValues?.connectionDefaultModel ?? '',
    (effectiveInitialValues?.models ?? []).join('|'),
    effectiveInitialValues?.customApi ?? '',
  ].join('::')

  return (
    <StepFormLayout
      title={t("onboarding.credentials.apiConfiguration")}
      description={apiKeyDescription}
      actions={
        <>
          <BackButton onClick={onBack} disabled={status === 'validating'} />
          <ContinueButton
            type="submit"
            form="api-key-form"
            disabled={false}
            loading={status === 'validating'}
            loadingText={t("common.validating")}
          />
        </>
      }
    >
      <ApiKeyInput
        key={apiKeyInputKey}
        status={status as ApiKeyStatus}
        errorMessage={errorMessage}
        onSubmit={onSubmit}
        providerType={providerType}
        initialValues={effectiveInitialValues}
      />
    </StepFormLayout>
  )
}
