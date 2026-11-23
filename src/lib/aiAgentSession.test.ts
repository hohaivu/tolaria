import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentStatus, AiAgentMessage } from './aiAgentConversation'
import type { AiModelDefinition, AiModelProvider, AiTarget } from './aiTargets'

const {
  buildAgentSystemPromptMock,
  createStreamCallbacksMock,
  formatMessageWithHistoryMock,
  hydrateNoteReferencesMock,
  nextMessageIdMock,
  streamAiAgentMock,
  streamAiModelMock,
  trackEventMock,
  trimHistoryMock,
  agentDefinitionOverrides,
} = vi.hoisted(() => ({
  buildAgentSystemPromptMock: vi.fn(() => 'SYSTEM'),
  createStreamCallbacksMock: vi.fn(() => ({ stream: 'callbacks' })),
  formatMessageWithHistoryMock: vi.fn((_history: unknown, prompt: string) => `formatted:${prompt}`),
  hydrateNoteReferencesMock: vi.fn(async (references: unknown) => references),
  nextMessageIdMock: vi.fn(),
  streamAiAgentMock: vi.fn(async () => {}),
  streamAiModelMock: vi.fn(async () => {}),
  trackEventMock: vi.fn(),
  trimHistoryMock: vi.fn((history: unknown) => history),
  agentDefinitionOverrides: {} as Record<string, { readsImagePaths?: boolean }>,
}))

vi.mock('../utils/ai-agent', () => ({
  buildAgentSystemPrompt: buildAgentSystemPromptMock,
}))

vi.mock('../utils/ai-chat', () => ({
  MAX_HISTORY_TOKENS: 100_000,
  formatMessageWithHistory: formatMessageWithHistoryMock,
  nextMessageId: nextMessageIdMock,
  trimHistory: trimHistoryMock,
}))

vi.mock('./aiAgentStreamCallbacks', () => ({
  createStreamCallbacks: createStreamCallbacksMock,
}))

vi.mock('../utils/streamAiAgent', () => ({
  streamAiAgent: streamAiAgentMock,
}))

vi.mock('../utils/streamAiModel', () => ({
  streamAiModel: streamAiModelMock,
}))

vi.mock('../utils/ai-reference-content', () => ({
  hydrateNoteReferences: hydrateNoteReferencesMock,
}))

vi.mock('./telemetry', () => ({
  trackEvent: trackEventMock,
}))

vi.mock('./aiAgents', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./aiAgents')>()
  return {
    ...actual,
    getAiAgentDefinition: (agent: Parameters<typeof actual.getAiAgentDefinition>[0]) => {
      const def = actual.getAiAgentDefinition(agent)
      const override = agentDefinitionOverrides[agent]
      return override ? { ...def, ...override } : def
    },
  }
})

import {
  clearAgentConversation,
  regenerateAgentMessage,
  sendAgentMessage,
  stopAgentMessage,
  type AiAgentSessionRuntime,
} from './aiAgentSession'

function createRuntime(
  initialMessages: AiAgentMessage[] = [],
  initialStatus: AgentStatus = 'idle',
) {
  let messages = initialMessages
  let status = initialStatus

  const messagesRef = { current: messages }
  const statusRef = { current: status }

  const setMessages = vi.fn((next: AiAgentMessage[] | ((current: AiAgentMessage[]) => AiAgentMessage[])) => {
    messages = typeof next === 'function' ? next(messages) : next
    messagesRef.current = messages
  })
  const setStatus = vi.fn((next: AgentStatus | ((current: AgentStatus) => AgentStatus)) => {
    status = typeof next === 'function' ? next(status) : next
    statusRef.current = status
  })

  const runtime: AiAgentSessionRuntime = {
    setMessages,
    setStatus,
    abortRef: { current: { aborted: true } },
    responseAccRef: { current: 'stale response' },
    fileCallbacksRef: { current: { onVaultChanged: vi.fn() } },
    toolInputMapRef: { current: new Map([['stale-tool', { tool: 'Write', input: '{"path":"/stale.md"}' }]]) },
    messagesRef,
    statusRef,
  }

  return {
    runtime,
    getMessages: () => messages,
    getStatus: () => status,
  }
}

type RuntimeFixture = ReturnType<typeof createRuntime>

const completedHistory: AiAgentMessage = {
  id: 'msg-1',
  userMessage: 'Previous question',
  actions: [],
  response: 'Previous answer',
}
const streamingHistory: AiAgentMessage = {
  id: 'msg-2',
  userMessage: 'Ignored streaming question',
  actions: [],
  isStreaming: true,
}
const expectedChatHistory = [
  { role: 'user', content: 'Previous question', id: 'msg-1' },
  { role: 'assistant', content: 'Previous answer', id: 'msg-1-resp' },
]
const apiModelProvider: AiModelProvider = {
  id: 'openai',
  name: 'OpenAI',
  kind: 'open_ai',
  base_url: 'https://api.openai.com/v1',
  api_key_storage: 'local_file',
  api_key_env_var: null,
  models: [],
}
const apiModel: AiModelDefinition = {
  id: 'gpt-5-nano',
  display_name: 'GPT-5 nano',
  context_window: null,
  max_output_tokens: null,
  capabilities: {
    streaming: false,
    tools: false,
    vision: false,
    json_mode: false,
    reasoning: false,
  },
}
const apiTarget: AiTarget = {
  kind: 'api_model',
  provider: apiModelProvider,
  model: apiModel,
  id: 'model:openai/gpt-5-nano',
  label: 'OpenAI · GPT-5 nano',
  shortLabel: 'GPT-5 nano',
}

function expectStreamingRuntimeState(session: RuntimeFixture): void {
  expect(session.runtime.abortRef.current.aborted).toBe(false)
  expect(session.runtime.abortRef.current.controller).toBeInstanceOf(AbortController)
  expect(session.runtime.responseAccRef.current).toBe('')
  expect(session.runtime.toolInputMapRef.current.size).toBe(0)
  expect(session.getStatus()).toBe('thinking')
  expect(session.getMessages().at(-1)).toEqual({
    userMessage: 'Latest question',
    references: [{ path: '/vault/ref.md', title: 'Ref' }],
    actions: [],
    isStreaming: true,
    id: 'msg-stream',
  })
}

function expectFormattedHistoryUsed(): void {
  expect(trimHistoryMock).toHaveBeenCalledWith(expectedChatHistory, 100_000)
  expect(formatMessageWithHistoryMock).toHaveBeenCalledWith(
    expectedChatHistory,
    expect.stringContaining('Latest question'),
  )
  expect(formatMessageWithHistoryMock).toHaveBeenCalledWith(
    expectedChatHistory,
    expect.stringContaining('/vault/ref.md'),
  )
}

function expectStreamingRequest(runtime: RuntimeFixture['runtime']): void {
  expect(createStreamCallbacksMock).toHaveBeenCalledWith(expect.objectContaining({
    messageId: 'msg-stream',
    locale: 'it-IT',
    vaultPath: '/vault',
    setMessages: runtime.setMessages,
    setStatus: runtime.setStatus,
  }))
  expect(streamAiAgentMock).toHaveBeenCalledWith(expect.objectContaining({
    agent: 'codex',
    message: expect.stringContaining('formatted:Latest question'),
    systemPrompt: 'SYSTEM',
    vaultPath: '/vault',
    permissionMode: 'power_user',
    callbacks: { stream: 'callbacks' },
    signal: expect.any(AbortSignal),
  }))
}

function expectApiModelStreamingRequest(runtime: RuntimeFixture['runtime']): void {
  expect(createStreamCallbacksMock).toHaveBeenCalledWith(expect.objectContaining({
    messageId: 'msg-stream',
    vaultPath: '/vault',
    setMessages: runtime.setMessages,
    setStatus: runtime.setStatus,
  }))
  expect(streamAiModelMock).toHaveBeenCalledWith({
    provider: apiModelProvider,
    model: apiModel,
    message: expect.stringContaining('formatted:Latest question'),
    systemPrompt: 'SYSTEM',
    vaultPath: '/vault',
    vaultPaths: ['/vault', '/team-vault'],
    callbacks: { stream: 'callbacks' },
  })
}

describe('aiAgentSession', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    buildAgentSystemPromptMock.mockReturnValue('SYSTEM')
    createStreamCallbacksMock.mockReturnValue({ stream: 'callbacks' })
    formatMessageWithHistoryMock.mockImplementation((_history: unknown, prompt: string) => `formatted:${prompt}`)
    trimHistoryMock.mockImplementation((history: unknown) => history)
    streamAiAgentMock.mockResolvedValue(undefined)
    hydrateNoteReferencesMock.mockImplementation(async (references: unknown) => references)
    trackEventMock.mockClear()
    for (const key of Object.keys(agentDefinitionOverrides)) {
      delete agentDefinitionOverrides[key]
    }
  })

  async function expectLocalResponse(options: {
    messageId: string
    context: {
      agent: 'claude_code' | 'codex' | 'copilot' | 'opencode' | 'pi' | 'antigravity'
      ready: boolean
      vaultPath: string
      permissionMode: 'safe' | 'power_user'
    }
    prompt: { text: string; references?: [] }
    reason: 'agent_unavailable' | 'missing_vault'
    response: string
  }) {
    nextMessageIdMock.mockReturnValue(options.messageId)
    const { runtime, getMessages } = createRuntime()

    await sendAgentMessage({
      runtime,
      context: options.context,
      prompt: options.prompt,
    })

    expect(getMessages()).toEqual([
      {
        userMessage: options.prompt.text,
        references: undefined,
        actions: [],
        response: options.response,
        id: options.messageId,
      },
    ])
    expect(streamAiAgentMock).not.toHaveBeenCalled()
    expect(trackEventMock).toHaveBeenCalledWith('ai_agent_message_blocked', {
      agent: options.context.agent,
      reason: options.reason,
    })
  }

  it('ignores blank prompts and busy runtimes', async () => {
    const idleRuntime = createRuntime()
    await sendAgentMessage({
      runtime: idleRuntime.runtime,
      context: { agent: 'codex', ready: true, vaultPath: '/vault', permissionMode: 'safe' },
      prompt: { text: '   ' },
    })

    const busyRuntime = createRuntime([], 'thinking')
    await sendAgentMessage({
      runtime: busyRuntime.runtime,
      context: { agent: 'codex', ready: true, vaultPath: '/vault', permissionMode: 'safe' },
      prompt: { text: 'Question' },
    })

    expect(idleRuntime.getMessages()).toEqual([])
    expect(busyRuntime.getMessages()).toEqual([])
    expect(streamAiAgentMock).not.toHaveBeenCalled()
  })

  it('appends local fallback responses when the session cannot stream', async () => {
    const fallbackCases = [
      {
        messageId: 'msg-local',
        context: { agent: 'codex', ready: true, vaultPath: '', permissionMode: 'safe' },
        prompt: { text: 'Open a note' },
        reason: 'missing_vault',
        response: 'No vault loaded. Open a vault first.',
      },
      {
        messageId: 'msg-missing',
        context: { agent: 'codex', ready: false, vaultPath: '/vault', permissionMode: 'safe' },
        prompt: { text: 'Open a note', references: [] },
        reason: 'agent_unavailable',
        response:
          'Codex is not available on this machine. Install it or switch the default AI agent in Settings.',
      },
    ] as const

    for (const fallbackCase of fallbackCases) {
      await expectLocalResponse(fallbackCase)
    }
  })

  it('starts a streaming session with formatted history and fresh refs', async () => {
    nextMessageIdMock.mockReturnValue('msg-stream')
    const session = createRuntime([
      completedHistory,
      streamingHistory,
    ])

    await sendAgentMessage({
      runtime: session.runtime,
      context: {
        agent: 'codex',
        locale: 'it-IT',
        model: 'gpt-5.6-sol',
        ready: true,
        vaultPath: '/vault',
        permissionMode: 'power_user',
        systemPromptOverride: 'OVERRIDE',
      },
      prompt: {
        text: '  Latest question  ',
        references: [{ path: '/vault/ref.md', title: 'Ref' }],
      },
    })

    expectStreamingRuntimeState(session)
    expect(hydrateNoteReferencesMock).toHaveBeenCalledWith([{ path: '/vault/ref.md', title: 'Ref' }], '/vault')
    expectFormattedHistoryUsed()
    expect(buildAgentSystemPromptMock).toHaveBeenCalledWith({
      agent: 'codex',
      permissionMode: 'power_user',
      vaultContext: 'OVERRIDE',
    })
    expectStreamingRequest(session.runtime)
    expect(streamAiAgentMock).toHaveBeenCalledWith(expect.objectContaining({
      model: 'gpt-5.6-sol',
      attachments: [],
    }))
    expect(trackEventMock).toHaveBeenCalledWith('ai_agent_message_sent', {
      agent: 'codex',
      permission_mode: 'power_user',
      has_context: 1,
      reference_count: 1,
      history_message_count: 1,
      image_count: 0,
    })
  })

  it('omits an explicit model when the agent default is selected', async () => {
    nextMessageIdMock.mockReturnValue('msg-stream')
    const session = createRuntime()

    await sendAgentMessage({
      runtime: session.runtime,
      context: {
        agent: 'claude_code',
        ready: true,
        vaultPath: '/vault',
        permissionMode: 'safe',
      },
      prompt: { text: 'Use the agent default' },
    })

    expect(streamAiAgentMock).toHaveBeenCalledWith(expect.not.objectContaining({
      model: expect.anything(),
    }))
  })

  it('passes vault roots to api model streams for native note tools', async () => {
    nextMessageIdMock.mockReturnValue('msg-stream')
    const session = createRuntime([
      completedHistory,
      streamingHistory,
    ])

    await sendAgentMessage({
      runtime: session.runtime,
      context: {
        agent: 'codex',
        target: apiTarget,
        ready: true,
        vaultPath: '/vault',
        vaultPaths: ['/vault', '/team-vault'],
        permissionMode: 'safe',
      },
      prompt: {
        text: '  Latest question  ',
        references: [{ path: '/vault/ref.md', title: 'Ref' }],
      },
    })

    expectStreamingRuntimeState(session)
    expectFormattedHistoryUsed()
    expectApiModelStreamingRequest(session.runtime)
    expect(streamAiAgentMock).not.toHaveBeenCalled()
  })

  it('clears the conversation and resets runtime refs', () => {
    const { runtime } = createRuntime([
      { id: 'msg-1', userMessage: 'Question', actions: [] },
    ], 'done')

    clearAgentConversation(runtime)

    expect(runtime.abortRef.current.aborted).toBe(true)
    expect(runtime.responseAccRef.current).toBe('')
    expect(runtime.toolInputMapRef.current.size).toBe(0)
    expect(runtime.setMessages).toHaveBeenCalledWith([])
    expect(runtime.setStatus).toHaveBeenCalledWith('idle')
  })

  it('stops the active stream and marks the streaming message as stopped', async () => {
    nextMessageIdMock.mockReturnValue('msg-stream')
    const session = createRuntime()
    let streamSignal: AbortSignal | undefined
    streamAiAgentMock.mockImplementation(async ({ signal }: { signal?: AbortSignal }) => new Promise<void>((resolve) => {
      streamSignal = signal
      signal?.addEventListener('abort', () => resolve(), { once: true })
    }))

    const pending = sendAgentMessage({
      runtime: session.runtime,
      context: {
        agent: 'codex',
        ready: true,
        vaultPath: '/vault',
        permissionMode: 'safe',
      },
      prompt: { text: '  Latest question  ' },
    })
    await Promise.resolve()
    await Promise.resolve()

    stopAgentMessage(session.runtime, { agent: 'codex', locale: 'en' })
    await pending

    expect(streamSignal?.aborted).toBe(true)
    expect(session.runtime.abortRef.current.aborted).toBe(true)
    expect(session.getStatus()).toBe('idle')
    expect(session.getMessages()).toEqual([{
      userMessage: 'Latest question',
      actions: [],
      isStreaming: false,
      reasoningDone: true,
      response: 'Stopped.',
      id: 'msg-stream',
    }])
    expect(trackEventMock).toHaveBeenCalledWith('ai_agent_response_stopped', {
      agent: 'codex',
      had_partial_response: 0,
      tool_count: 0,
    })
  })

  it('sends an image-only message with attachments and image_count analytics', async () => {
    nextMessageIdMock.mockReturnValue('msg-img-only')
    const session = createRuntime()
    const stagedPath = '/vault/.tolaria/tmp/1700000000001-shot.png'
    const onAdmitted = vi.fn()

    await sendAgentMessage({
      runtime: session.runtime,
      context: {
        agent: 'claude_code',
        ready: true,
        vaultPath: '/vault',
        permissionMode: 'safe',
      },
      onAdmitted,
      prompt: {
        text: '   ',
        images: [stagedPath],
      },
    })

    expect(session.getMessages()).toEqual([{
      userMessage: '',
      references: undefined,
      images: [stagedPath],
      actions: [],
      isStreaming: true,
      id: 'msg-img-only',
    }])
    expect(onAdmitted).toHaveBeenCalledOnce()
    expect(streamAiAgentMock).toHaveBeenCalledWith(expect.objectContaining({
      attachments: [stagedPath],
    }))
    expect(trackEventMock).toHaveBeenCalledWith('ai_agent_message_sent', expect.objectContaining({
      agent: 'claude_code',
      image_count: 1,
    }))
  })

  it('blocks image sends on API-model targets with a localized toast and analytics', async () => {
    const onToast = vi.fn()
    const onAdmitted = vi.fn()
    const session = createRuntime()

    await sendAgentMessage({
      runtime: session.runtime,
      context: {
        agent: 'claude_code',
        target: apiTarget,
        locale: 'en',
        ready: true,
        vaultPath: '/vault',
        permissionMode: 'safe',
        onToast,
      },
      onAdmitted,
      prompt: {
        text: 'Describe this',
        images: ['/vault/.tolaria/tmp/1700000000001-shot.png'],
      },
    })

    expect(onAdmitted).not.toHaveBeenCalled()
    expect(streamAiModelMock).not.toHaveBeenCalled()
    expect(streamAiAgentMock).not.toHaveBeenCalled()
    expect(session.getMessages()).toEqual([])
    expect(onToast).toHaveBeenCalledWith('OpenAI · GPT-5 nano does not support image attachments.')
    expect(trackEventMock).toHaveBeenCalledWith('ai_agent_message_blocked', {
      agent: 'claude_code',
      reason: 'images_unsupported',
    })
  })

  it('blocks image sends when an agent has readsImagePaths set to false', async () => {
    agentDefinitionOverrides.codex = { readsImagePaths: false }
    const onToast = vi.fn()
    const session = createRuntime()

    await sendAgentMessage({
      runtime: session.runtime,
      context: {
        agent: 'codex',
        locale: 'en',
        ready: true,
        vaultPath: '/vault',
        permissionMode: 'safe',
        onToast,
      },
      prompt: {
        text: 'Check screenshot',
        images: ['/vault/.tolaria/tmp/1700000000001-shot.png'],
      },
    })

    expect(streamAiAgentMock).not.toHaveBeenCalled()
    expect(session.getMessages()).toEqual([])
    expect(onToast).toHaveBeenCalledWith('Codex does not support image attachments.')
    expect(trackEventMock).toHaveBeenCalledWith('ai_agent_message_blocked', {
      agent: 'codex',
      reason: 'images_unsupported',
    })
  })

  it('resends the original message images when regenerating and keeps message if target cannot read images', async () => {
    const stagedPath = '/vault/.tolaria/tmp/1700000000002-chart.png'
    const session = createRuntime([{
      id: 'msg-img-1',
      userMessage: 'Summarize chart',
      images: [stagedPath],
      actions: [],
      response: 'Initial answer',
    }])
    nextMessageIdMock.mockReturnValue('msg-img-regen')

    await regenerateAgentMessage({
      runtime: session.runtime,
      context: {
        agent: 'claude_code',
        ready: true,
        vaultPath: '/vault',
        permissionMode: 'safe',
      },
      messageId: 'msg-img-1',
    })

    expect(streamAiAgentMock).toHaveBeenCalledWith(expect.objectContaining({
      attachments: [stagedPath],
    }))
    expect(session.getMessages()).toHaveLength(1)
    expect(session.getMessages()[0]?.images).toEqual([stagedPath])

    session.runtime.setStatus('idle')
    const onToast = vi.fn()
    await regenerateAgentMessage({
      runtime: session.runtime,
      context: {
        agent: 'claude_code',
        target: apiTarget,
        ready: true,
        vaultPath: '/vault',
        permissionMode: 'safe',
        onToast,
      },
      messageId: 'msg-img-regen',
    })

    expect(streamAiModelMock).not.toHaveBeenCalled()
    expect(onToast).toHaveBeenCalledWith('OpenAI · GPT-5 nano does not support image attachments.')
    expect(session.getMessages()).toHaveLength(1)
  })

  it('reports only image paths of discarded later turns when regenerating an earlier message', async () => {
    const kept = '/vault/.tolaria/tmp/1-kept.png'
    const later = '/vault/.tolaria/tmp/2-later.png'
    const session = createRuntime([
      { id: 'msg-a', userMessage: 'first', images: [kept], actions: [], response: 'A' },
      { id: 'msg-b', userMessage: 'second', images: [later, kept], actions: [], response: 'B' },
    ])
    nextMessageIdMock.mockReturnValue('msg-a-regen')
    const onImagesDiscarded = vi.fn()

    await regenerateAgentMessage({
      runtime: session.runtime,
      context: { agent: 'claude_code', ready: true, vaultPath: '/vault', permissionMode: 'safe' },
      messageId: 'msg-a',
      onImagesDiscarded,
    })

    expect(onImagesDiscarded).toHaveBeenCalledTimes(1)
    expect(onImagesDiscarded).toHaveBeenCalledWith([later])
  })
})
