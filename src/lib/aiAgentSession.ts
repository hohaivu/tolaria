import type { Dispatch, MutableRefObject, SetStateAction } from 'react'
import {
  appendLocalResponse,
  appendLocalMarker,
  appendStreamingMessage,
  buildFormattedMessage,
  createMissingAgentResponse,
  type AgentStatus,
  type AgentExecutionContext,
  type AiAgentMessage,
  type PendingUserPrompt,
} from './aiAgentConversation'
import type { AgentFileCallbacks } from './aiAgentFileOperations'
import { createStreamCallbacks } from './aiAgentStreamCallbacks'
import type { ToolInvocation } from './aiAgentMessageState'
import { trackAiAgentMessageBlocked, trackAiAgentMessageSent, trackAiAgentResponseStopped } from './productAnalytics'
import { streamAiAgent } from '../utils/streamAiAgent'
import { streamAiModel } from '../utils/streamAiModel'
import { hydrateNoteReferences } from '../utils/ai-reference-content'
import { createTranslator } from './i18n'
import { getAiAgentDefinition } from './aiAgents'

export interface AiAgentAbortState {
  aborted: boolean
  controller?: AbortController
}

export interface AiAgentSessionRuntime {
  setMessages: Dispatch<SetStateAction<AiAgentMessage[]>>
  setStatus: Dispatch<SetStateAction<AgentStatus>>
  abortRef: MutableRefObject<AiAgentAbortState>
  responseAccRef: MutableRefObject<string>
  fileCallbacksRef: MutableRefObject<AgentFileCallbacks | undefined>
  toolInputMapRef: MutableRefObject<Map<string, ToolInvocation>>
  messagesRef: MutableRefObject<AiAgentMessage[]>
  statusRef: MutableRefObject<AgentStatus>
}

interface SendAgentMessageOptions {
  runtime: AiAgentSessionRuntime
  context: AgentExecutionContext
  prompt: PendingUserPrompt
}

interface RegenerateAgentMessageOptions {
  runtime: AiAgentSessionRuntime
  context: AgentExecutionContext
  messageId: string
}

interface SelectedTargetStreamRequest {
  context: AgentExecutionContext
  formattedMessage: string
  systemPrompt: string
  attachments?: string[]
  callbacks: ReturnType<typeof createStreamCallbacks>
  signal?: AbortSignal
}

export function canTargetReadImagePaths(
  context: Pick<AgentExecutionContext, 'agent' | 'target'>,
): boolean {
  if (context.target?.kind === 'api_model') return false
  return getAiAgentDefinition(context.agent).readsImagePaths
}

export function resolveTargetLabel(
  context: Pick<AgentExecutionContext, 'agent' | 'target'>,
): string {
  return context.target?.label ?? getAiAgentDefinition(context.agent).label
}

function normalizePrompt(prompt: PendingUserPrompt): PendingUserPrompt {
  const images = prompt.images?.map((path) => path.trim()).filter(Boolean)
  return {
    text: prompt.text.trim(),
    references: prompt.references && prompt.references.length > 0 ? prompt.references : undefined,
    ...(images && images.length > 0 ? { images } : {}),
  }
}

function completedMessageCount(messages: AiAgentMessage[]): number {
  return messages.filter((message) => !message.isStreaming && !message.localMarker).length
}

function shouldIgnorePrompt(status: AgentStatus, prompt: PendingUserPrompt): boolean {
  const hasContent = Boolean(prompt.text) || Boolean(prompt.images && prompt.images.length > 0)
  return !hasContent || status === 'thinking' || status === 'tool-executing'
}

function blockMissingVault(runtime: AiAgentSessionRuntime, context: AgentExecutionContext, prompt: PendingUserPrompt): void {
  trackAiAgentMessageBlocked(context.agent, 'missing_vault')
  appendLocalResponse(runtime.setMessages, prompt, 'No vault loaded. Open a vault first.')
}

function blockUnavailableAgent(runtime: AiAgentSessionRuntime, context: AgentExecutionContext, prompt: PendingUserPrompt): void {
  trackAiAgentMessageBlocked(context.agent, 'agent_unavailable')
  appendLocalResponse(
    runtime.setMessages,
    prompt,
    createMissingAgentResponse(context.agent),
  )
}

function blockUnsupportedImages(context: AgentExecutionContext): void {
  trackAiAgentMessageBlocked(context.agent, 'images_unsupported')
  const t = createTranslator(context.locale ?? 'en')
  context.onToast?.(t('ai.panel.images.unsupported', { agent: resolveTargetLabel(context) }))
}

async function streamWithSelectedTarget({
  context,
  formattedMessage,
  systemPrompt,
  attachments,
  callbacks,
  signal,
}: SelectedTargetStreamRequest): Promise<void> {
  if (context.target?.kind === 'api_model') {
    await streamAiModel({
      provider: context.target.provider,
      model: context.target.model,
      message: formattedMessage,
      systemPrompt,
      vaultPath: context.vaultPath,
      vaultPaths: context.vaultPaths,
      callbacks,
    })
    return
  }

  await streamAiAgent({
    agent: context.agent,
    ...(context.model?.trim() ? { model: context.model.trim() } : {}),
    message: formattedMessage,
    systemPrompt,
    vaultPath: context.vaultPath,
    vaultPaths: context.vaultPaths,
    permissionMode: context.permissionMode,
    attachments: attachments ?? [],
    callbacks,
    signal,
  })
}

function stoppedResponseText(response: string, locale: AgentExecutionContext['locale']): string {
  const stopped = createTranslator(locale ?? 'en')('ai.panel.stoppedResponse')
  const partial = response.trim()
  return partial ? `${partial}\n\n${stopped}` : stopped
}

export async function sendAgentMessage({
  runtime,
  context,
  prompt,
}: SendAgentMessageOptions): Promise<void> {
  const currentStatus = runtime.statusRef.current
  const normalizedPrompt = normalizePrompt(prompt)

  if (shouldIgnorePrompt(currentStatus, normalizedPrompt)) return

  if (!context.vaultPath) {
    blockMissingVault(runtime, context, normalizedPrompt)
    return
  }

  if (!context.ready) {
    blockUnavailableAgent(runtime, context, normalizedPrompt)
    return
  }

  if (normalizedPrompt.images && normalizedPrompt.images.length > 0 && !canTargetReadImagePaths(context)) {
    blockUnsupportedImages(context)
    return
  }

  trackAiAgentMessageSent({
    agent: context.agent,
    permissionMode: context.permissionMode,
    hasContext: !!context.systemPromptOverride,
    referenceCount: normalizedPrompt.references?.length ?? 0,
    historyMessageCount: completedMessageCount(runtime.messagesRef.current),
    imageCount: normalizedPrompt.images?.length ?? 0,
  })

  const controller = new AbortController()
  const abortState: AiAgentAbortState = {
    aborted: false,
    controller,
  }
  runtime.abortRef.current = abortState
  runtime.responseAccRef.current = ''
  runtime.toolInputMapRef.current = new Map()

  const messageId = appendStreamingMessage(runtime.setMessages, normalizedPrompt)
  runtime.setStatus('thinking')
  const promptForAgent = {
    ...normalizedPrompt,
    references: await hydrateNoteReferences(normalizedPrompt.references, context.vaultPath),
  }

  const { formattedMessage, systemPrompt } = buildFormattedMessage(
    context,
    runtime.messagesRef.current,
    promptForAgent,
  )

  const callbacks = createStreamCallbacks({
    agent: context.agent,
    locale: context.locale,
    messageId,
    vaultPath: context.vaultPath,
    setMessages: runtime.setMessages,
    setStatus: runtime.setStatus,
    abortRef: { current: abortState },
    responseAccRef: runtime.responseAccRef,
    toolInputMapRef: runtime.toolInputMapRef,
    fileCallbacksRef: runtime.fileCallbacksRef,
  })

  await streamWithSelectedTarget({
    context,
    formattedMessage,
    systemPrompt,
    attachments: normalizedPrompt.images,
    callbacks,
    signal: controller.signal,
  })
}

export async function regenerateAgentMessage({
  runtime,
  context,
  messageId,
}: RegenerateAgentMessageOptions): Promise<void> {
  const currentMessages = runtime.messagesRef.current
  const messageIndex = currentMessages.findIndex((message) => message.id === messageId)
  const message = currentMessages[messageIndex]
  if (!message || message.localMarker || runtime.statusRef.current === 'thinking' || runtime.statusRef.current === 'tool-executing') return
  if (message.images && message.images.length > 0 && !canTargetReadImagePaths(context)) {
    blockUnsupportedImages(context)
    return
  }

  const preservedMessages = currentMessages.slice(0, messageIndex)
  runtime.abortRef.current = { aborted: false }
  runtime.responseAccRef.current = ''
  runtime.toolInputMapRef.current = new Map()
  runtime.messagesRef.current = preservedMessages
  runtime.statusRef.current = 'idle'
  runtime.setMessages(preservedMessages)
  runtime.setStatus('idle')

  await sendAgentMessage({
    runtime,
    context,
    prompt: {
      text: message.userMessage,
      references: message.references,
      images: message.images,
    },
  })
}

export function addAgentLocalMarker(
  runtime: Pick<AiAgentSessionRuntime, 'setMessages'>,
  text: string,
): void {
  appendLocalMarker(runtime.setMessages, text)
}

export function clearAgentConversation(runtime: Pick<AiAgentSessionRuntime, 'abortRef' | 'responseAccRef' | 'toolInputMapRef' | 'setMessages' | 'setStatus'>): void {
  runtime.abortRef.current.aborted = true
  runtime.abortRef.current.controller?.abort()
  runtime.responseAccRef.current = ''
  runtime.toolInputMapRef.current = new Map()
  runtime.setMessages([])
  runtime.setStatus('idle')
}

export function stopAgentMessage(
  runtime: AiAgentSessionRuntime,
  context: Pick<AgentExecutionContext, 'agent' | 'locale'>,
): void {
  if (!runtime.abortRef.current.controller || runtime.abortRef.current.aborted) return

  runtime.abortRef.current.aborted = true
  runtime.abortRef.current.controller.abort()
  const response = runtime.responseAccRef.current
  const toolCount = runtime.toolInputMapRef.current.size
  trackAiAgentResponseStopped(context.agent, response, toolCount)

  runtime.setMessages((current) => current.map((message) => (
    message.isStreaming
      ? {
          ...message,
          isStreaming: false,
          reasoningDone: true,
          response: stoppedResponseText(response, context.locale),
          actions: message.actions.map((action) => (
            action.status === 'pending' ? { ...action, status: 'error' as const } : action
          )),
        }
      : message
  )))
  runtime.responseAccRef.current = ''
  runtime.toolInputMapRef.current = new Map()
  runtime.setStatus('idle')
}
