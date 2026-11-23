import { useState } from 'react'
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest'
import { render as rtlRender, screen, fireEvent, act, waitFor } from '@testing-library/react'
import { AiPanel, AiPanelView } from './AiPanel'
import { translate } from '../lib/i18n'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { AiPanelController } from './useAiPanelController'
import type { VaultEntry } from '../types'
import { queueAiPrompt } from '../utils/aiPromptBridge'
import { resetAiWorkspaceSessionStoreForTests, setAiWorkspaceSessionMessages } from '../lib/aiWorkspaceSessionStore'
import type { NoteReference } from '../utils/ai-context'
import { bindVaultConfigStore, getVaultConfig, resetVaultConfigStore } from '../utils/vaultConfigStore'

const { trackEventMock } = vi.hoisted(() => ({
  trackEventMock: vi.fn(),
}))

vi.mock('../lib/telemetry', () => ({
  trackEvent: trackEventMock,
}))

// Mock the hooks and utils to isolate component tests
let mockMessages: ReturnType<typeof import('../hooks/useCliAiAgent').useCliAiAgent>['messages'] = []
let mockStatus: ReturnType<typeof import('../hooks/useCliAiAgent').useCliAiAgent>['status'] = 'idle'
const mockSendMessage = vi.fn()
let mockAdmitSend = true
const mockStopMessage = vi.fn()
const mockClearConversation = vi.fn()
const mockAddLocalMarker = vi.fn()
const mockUseCliAiAgent = vi.fn()

vi.mock('../hooks/useCliAiAgent', () => ({
  useCliAiAgent: (...args: unknown[]) => {
    mockUseCliAiAgent(...args)
    return {
      messages: mockMessages,
      status: mockStatus,
      sendMessage: (...args: unknown[]) => {
        mockSendMessage(...args.slice(0, 3))
        if (mockAdmitSend) (args[3] as (() => void) | undefined)?.()
        return Promise.resolve()
      },
      stopMessage: mockStopMessage,
      clearConversation: mockClearConversation,
      addLocalMarker: mockAddLocalMarker,
    }
  },
}))

vi.mock('../utils/ai-chat', () => ({
  nextMessageId: () => `msg-${Date.now()}`,
}))

const makeEntry = (overrides: Partial<VaultEntry> = {}): VaultEntry => ({
  path: '/vault/note/test.md',
  filename: 'test.md',
  title: 'Test Note',
  isA: 'Note',
  aliases: [],
  belongsTo: [],
  relatedTo: [],
  status: null,
  owner: null,
  cadence: null,
  archived: false,
  modifiedAt: 1700000000,
  createdAt: 1700000000,
  fileSize: 100,
  snippet: '',
  wordCount: 0,
  relationships: {},
  icon: null,
  color: null,
  order: null,
  sidebarLabel: null,
  template: null,
  sort: null,
  view: null,
  visible: null,
  organized: false,
  favorite: false,
  favoriteIndex: null,
  listPropertiesDisplay: [],
  outgoingLinks: [],
  properties: {},
  hasH1: false,
  ...overrides,
})

function render(ui: Parameters<typeof rtlRender>[0]) {
  return rtlRender(ui, { wrapper: TooltipProvider })
}

function QueuedPromptTargetHarness({ onTargetChange }: { onTargetChange: (targetId: string) => void }) {
  const [input, setInput] = useState('')
  const [targetId, setTargetId] = useState('agent:claude_code')
  const handleTargetChange = (nextTargetId: string) => {
    onTargetChange(nextTargetId)
    setTargetId(nextTargetId)
  }
  const controller: AiPanelController = {
    agent: {
      messages: [],
      status: 'idle',
      sendMessage: (text: string, references?: NoteReference[]) => {
        mockSendMessage(text, references)
        return Promise.resolve()
      },
      stopMessage: mockStopMessage,
      regenerateMessage: () => Promise.resolve(),
      clearConversation: () => {
        mockClearConversation()
      },
      addLocalMarker: (text: string) => {
        mockAddLocalMarker(text)
      },
    },
    input,
    setInput,
    linkedEntries: [],
    hasContext: false,
    isActive: false,
    permissionMode: 'safe',
    handleSend: (text: string, references: NoteReference[]) => {
      mockSendMessage(text, references)
      setInput('')
    },
    handleStop: mockStopMessage,
    handleNavigateWikilink: vi.fn(),
    handlePermissionModeChange: vi.fn(),
    handleNewChat: vi.fn(),
    resetConversation: mockClearConversation,
  }

  return (
    <AiPanelView
      controller={controller}
      onClose={vi.fn()}
      onQueuedPromptTarget={handleTargetChange}
      showHeader={false}
      targetId={targetId}
    />
  )
}

describe('AiPanel', () => {
  let originalMockHandlers: Record<string, (args?: unknown) => unknown> | undefined

  beforeEach(() => {
    originalMockHandlers = window.__mockHandlers ? { ...window.__mockHandlers } : undefined
    mockMessages = []
    mockStatus = 'idle'
    mockSendMessage.mockReset()
    mockAdmitSend = true
    mockStopMessage.mockReset()
    mockClearConversation.mockReset()
    mockAddLocalMarker.mockReset()
    mockUseCliAiAgent.mockReset()
    trackEventMock.mockClear()
    resetVaultConfigStore()
    bindVaultConfigStore({
      zoom: null,
      view_mode: null,
      editor_mode: null,
      note_layout: null,
      tag_colors: null,
      status_colors: null,
      property_display_modes: null,
      inbox: null,
      allNotes: null,
      ai_agent_permission_mode: 'safe',
    }, vi.fn())
  })

  afterEach(() => {
    if (originalMockHandlers) {
      window.__mockHandlers = originalMockHandlers
    }
  })

  it('renders panel with the default CLI agent header', () => {
    render(<AiPanel onClose={vi.fn()} vaultPath="/tmp/vault" />)
    expect(screen.getByText('AI Agent')).toBeTruthy()
    expect(screen.getByText('Claude Code · Safe')).toBeTruthy()
  })

  it('passes the vault permission mode to the AI agent session', () => {
    bindVaultConfigStore({
      ...getVaultConfig(),
      ai_agent_permission_mode: 'power_user',
    }, vi.fn())

    render(<AiPanel onClose={vi.fn()} vaultPath="/tmp/vault" />)

    expect(screen.getByText('Claude Code · Power User')).toBeTruthy()
    expect(mockUseCliAiAgent).toHaveBeenCalledWith(
      '/tmp/vault',
      undefined,
      undefined,
      expect.any(Object),
      expect.objectContaining({ permissionMode: 'power_user' }),
    )
  })

  it('persists permission mode changes and records a local transcript marker', () => {
    const save = vi.fn()
    bindVaultConfigStore({
      ...getVaultConfig(),
      ai_agent_permission_mode: 'safe',
    }, save)
    mockMessages = [{
      userMessage: 'Existing question',
      actions: [],
      response: 'Existing answer.',
      id: 'msg-existing',
    }]

    render(<AiPanel onClose={vi.fn()} vaultPath="/tmp/vault" />)
    fireEvent.click(screen.getByRole('radio', { name: 'Power User' }))

    expect(getVaultConfig().ai_agent_permission_mode).toBe('power_user')
    expect(save).toHaveBeenLastCalledWith(expect.objectContaining({
      ai_agent_permission_mode: 'power_user',
    }))
    expect(mockAddLocalMarker).toHaveBeenCalledWith(
      'AI permission mode changed to Power User. It will apply to the next message.',
    )
    expect(trackEventMock).toHaveBeenCalledWith('ai_agent_permission_mode_changed', {
      agent: 'claude_code',
      permission_mode: 'power_user',
    })
  })

  it('disables permission mode changes while the AI agent is running', () => {
    mockStatus = 'thinking'

    render(<AiPanel onClose={vi.fn()} vaultPath="/tmp/vault" />)

    expect(screen.getByRole('radio', { name: 'Vault Safe' })).toBeDisabled()
    expect(screen.getByRole('radio', { name: 'Power User' })).toBeDisabled()
  })

  it('replaces the composer send button with a stop button while the AI agent is running', () => {
    mockStatus = 'thinking'

    render(<AiPanel onClose={vi.fn()} vaultPath="/tmp/vault" />)

    expect(screen.queryByTestId('agent-send')).toBeNull()
    const stopButton = screen.getByRole('button', { name: 'Stop response' })
    expect(stopButton).toHaveAttribute('data-testid', 'agent-stop')
    expect(stopButton).not.toBeDisabled()

    fireEvent.click(stopButton)

    expect(mockStopMessage).toHaveBeenCalledOnce()
  })

  it('renders the permission mode toggle with high contrast selected state and per-mode tooltips', async () => {
    render(<AiPanel onClose={vi.fn()} vaultPath="/tmp/vault" />)

    expect(screen.getByTestId('ai-permission-mode-toggle')).toHaveClass('border', 'bg-muted')

    const safeMode = screen.getByRole('radio', { name: 'Vault Safe' })
    const powerUserMode = screen.getByRole('radio', { name: 'Power User' })
    expect(safeMode).toHaveAttribute('aria-checked', 'true')
    expect(safeMode).toHaveClass('bg-background', 'text-foreground', 'shadow-xs')
    expect(powerUserMode).toHaveClass('text-muted-foreground')

    fireEvent.focus(safeMode)

    expect(await screen.findByTestId('ai-permission-mode-tooltip')).toHaveTextContent(
      'Vault Safe keeps agents limited to file, search, and edit tools.',
    )

    fireEvent.blur(safeMode)
    fireEvent.focus(powerUserMode)

    await waitFor(() => {
      expect(screen.getByTestId('ai-permission-mode-tooltip')).toHaveTextContent(
        'Power User also allows local shell commands for this vault.',
      )
    })
  })

  it('renders data-testid ai-panel', () => {
    render(<AiPanel onClose={vi.fn()} vaultPath="/tmp/vault" />)
    expect(screen.getByTestId('ai-panel')).toBeTruthy()
  })

  it('caps long AI agent drafts inside a scrollable composer while keeping send visible', () => {
    render(<AiPanel onClose={vi.fn()} vaultPath="/tmp/vault" />)

    const editor = screen.getByTestId('agent-input')
    editor.textContent = Array.from({ length: 40 }, (_, index) => `Line ${index + 1}`).join('\n')
    fireEvent.input(editor)

    expect(editor).toHaveClass('max-h-[120px]', 'overflow-y-auto', 'overscroll-contain')
    expect(editor).toHaveStyle({ maxHeight: '120px', overflowY: 'auto' })
    expect(screen.getByTestId('agent-send')).toBeVisible()
  })

  it('calls onClose when close button is clicked', () => {
    const onClose = vi.fn()
    render(<AiPanel onClose={onClose} vaultPath="/tmp/vault" />)
    const panel = screen.getByTestId('ai-panel')
    const buttons = panel.querySelectorAll('button')
    const closeBtn = Array.from(buttons).find(b => b.title?.includes('Close'))
    expect(closeBtn).toBeTruthy()
    fireEvent.click(closeBtn!)
    expect(onClose).toHaveBeenCalled()
  })

  it('starts a new AI chat when the header action is clicked', () => {
    render(<AiPanel onClose={vi.fn()} vaultPath="/tmp/vault" />)
    fireEvent.click(screen.getByTitle('New AI chat'))
    expect(mockClearConversation).toHaveBeenCalledOnce()
  })

  it('keeps the MCP config action out of the AI panel header', () => {
    render(<AiPanel onClose={vi.fn()} vaultPath="/tmp/vault" />)

    expect(screen.queryByRole('button', { name: 'Copy MCP config' })).toBeNull()
  })

  it('renders empty state without context', () => {
    render(<AiPanel onClose={vi.fn()} vaultPath="/tmp/vault" />)
    expect(screen.getByText('Open a note, then ask Claude Code about it')).toBeTruthy()
  })

  it('renders contextual empty state when active entry is provided', () => {
    const entry = makeEntry({ title: 'My Note' })
    render(
      <AiPanel onClose={vi.fn()} vaultPath="/tmp/vault" activeEntry={entry} entries={[entry]} />
    )
    expect(screen.getByText('Ask anything to Claude Code')).toBeTruthy()
  })

  it('does not render a context bar for the active entry', () => {
    const entry = makeEntry({ title: 'My Note' })
    render(
      <AiPanel onClose={vi.fn()} vaultPath="/tmp/vault" activeEntry={entry} entries={[entry]} />
    )
    expect(screen.queryByTestId('context-bar')).toBeNull()
    expect(screen.queryByText('My Note')).toBeNull()
  })

  it('does not show linked count in a sub-header', () => {
    const linked = makeEntry({ path: '/vault/linked.md', title: 'Linked Note' })
    const entry = makeEntry({ title: 'My Note', outgoingLinks: ['Linked Note'] })
    render(
      <AiPanel
        onClose={vi.fn()} vaultPath="/tmp/vault"
        activeEntry={entry} entries={[entry, linked]}
             />
    )
    expect(screen.queryByText('+ 1 linked')).toBeNull()
    expect(screen.queryByTestId('context-bar')).toBeNull()
  })

  it('renders input field enabled', () => {
    render(<AiPanel onClose={vi.fn()} vaultPath="/tmp/vault" />)
    const input = screen.getByTestId('agent-input')
    expect(input).toBeTruthy()
    expect(input).toHaveAttribute('contenteditable', 'true')
  })

  it('has send button disabled when input is empty', () => {
    render(<AiPanel onClose={vi.fn()} vaultPath="/tmp/vault" />)
    const sendBtn = screen.getByTestId('agent-send')
    expect((sendBtn as HTMLButtonElement).disabled).toBe(true)
  })

  it('shows active agent placeholder when active entry exists', () => {
    const entry = makeEntry({ title: 'My Note' })
    render(
      <AiPanel onClose={vi.fn()} vaultPath="/tmp/vault" activeEntry={entry} entries={[entry]} />
    )
    const input = screen.getByTestId('agent-input')
    expect(input).toHaveAttribute('aria-placeholder', 'Ask Claude Code')
  })

  it('shows active agent placeholder when no active entry', () => {
    render(<AiPanel onClose={vi.fn()} vaultPath="/tmp/vault" />)
    const input = screen.getByTestId('agent-input')
    expect(input).toHaveAttribute('aria-placeholder', 'Ask Claude Code')
  })

  it('uses the selected AI agent in the placeholder', () => {
    render(
      <AiPanel
        onClose={vi.fn()}
        vaultPath="/tmp/vault"
        defaultAiAgent="codex"
        defaultAiAgentReady
      />,
    )
    expect(screen.getByTestId('agent-input')).toHaveAttribute('aria-placeholder', 'Ask Codex')
  })

  it('disables sending while the selected AI agent is still loading', () => {
    render(
      <AiPanel
        onClose={vi.fn()}
        vaultPath="/tmp/vault"
        defaultAiAgent="codex"
        defaultAiAgentReadiness="checking"
      />,
    )

    expect(screen.getByText('Checking availability')).toBeTruthy()
    expect(screen.getByTestId('agent-input')).toHaveAttribute('aria-placeholder', 'Checking AI agent availability...')
    expect(screen.getByTestId('agent-send')).toBeDisabled()
  })

  it('auto-focuses input on mount', async () => {
    vi.useFakeTimers()
    render(<AiPanel onClose={vi.fn()} vaultPath="/tmp/vault" />)
    await act(() => { vi.advanceTimersByTime(1) })
    const input = screen.getByTestId('agent-input')
    expect(document.activeElement).toBe(input)
    vi.useRealTimers()
  })

  it('focuses the panel shell when reopening with existing messages', async () => {
    vi.useFakeTimers()
    mockMessages = [{
      userMessage: 'Remember this',
      actions: [],
      response: 'Still here.',
      id: 'msg-3',
    }]
    render(<AiPanel onClose={vi.fn()} vaultPath="/tmp/vault" />)
    await act(() => { vi.advanceTimersByTime(1) })
    expect(document.activeElement).toBe(screen.getByTestId('ai-panel'))
    vi.useRealTimers()
  })

  it('does not steal composer focus after a response when the send button becomes enabled', async () => {
    vi.useFakeTimers()
    mockMessages = [{
      userMessage: 'First question',
      actions: [],
      response: 'First answer.',
      id: 'msg-3',
    }]
    render(<AiPanel onClose={vi.fn()} vaultPath="/tmp/vault" />)

    const input = screen.getByTestId('agent-input')
    input.focus()
    input.textContent = 'f'
    fireEvent.input(input)

    await act(() => { vi.advanceTimersByTime(1) })

    expect(screen.getByTestId('agent-send')).toBeEnabled()
    expect(document.activeElement).toBe(screen.getByTestId('agent-input'))
    vi.useRealTimers()
  })

  it('calls onClose when Escape is pressed while panel has focus', async () => {
    vi.useFakeTimers()
    const onClose = vi.fn()
    render(<AiPanel onClose={onClose} vaultPath="/tmp/vault" />)
    await act(() => { vi.advanceTimersByTime(1) })
    // Input is focused inside the panel, so Escape should trigger onClose
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledOnce()
    vi.useRealTimers()
  })

  it('calls onClose when Escape is pressed on panel element', () => {
    const onClose = vi.fn()
    render(<AiPanel onClose={onClose} vaultPath="/tmp/vault" />)
    const panel = screen.getByTestId('ai-panel')
    panel.focus()
    fireEvent.keyDown(panel, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('clicking a wikilink in AI response calls onOpenNote with the target', () => {
    mockMessages = [{
      userMessage: 'Tell me about notes',
      actions: [],
      response: 'Check out [[Build Laputa App]] for details.',
      id: 'msg-1',
    }]
    const onOpenNote = vi.fn()
    const { container } = render(
      <AiPanel onClose={vi.fn()} vaultPath="/tmp/vault" onOpenNote={onOpenNote} />,
    )
    const wikilink = container.querySelector('.chat-wikilink')
    expect(wikilink).toBeTruthy()
    expect(wikilink!.textContent).toBe('Build Laputa App')
    fireEvent.click(wikilink!)
    expect(onOpenNote).toHaveBeenCalledWith('Build Laputa App')
  })

  it('renders wikilinks with special characters and clicking works', () => {
    mockMessages = [{
      userMessage: 'Tell me about meetings',
      actions: [],
      response: 'See [[Meeting — 2024/01/15]] and [[Pasta Carbonara]].',
      id: 'msg-2',
    }]
    const onOpenNote = vi.fn()
    const { container } = render(
      <AiPanel onClose={vi.fn()} vaultPath="/tmp/vault" onOpenNote={onOpenNote} />,
    )
    const wikilinks = container.querySelectorAll('.chat-wikilink')
    expect(wikilinks).toHaveLength(2)
    fireEvent.click(wikilinks[0])
    expect(onOpenNote).toHaveBeenCalledWith('Meeting — 2024/01/15')
    fireEvent.click(wikilinks[1])
    expect(onOpenNote).toHaveBeenCalledWith('Pasta Carbonara')
  })

  it('auto-sends a queued prompt from the command palette bridge', async () => {
    render(<AiPanel onClose={vi.fn()} vaultPath="/tmp/vault" entries={[makeEntry({ path: '/vault/alpha.md', filename: 'alpha.md', title: 'Alpha', isA: 'Project' })]} />)

    await act(async () => {
      queueAiPrompt('summarize [[alpha]]', [
        { title: 'Alpha', path: '/vault/alpha.md', type: 'Project' },
      ])
    })

    expect(mockClearConversation).toHaveBeenCalledOnce()
    expect(mockSendMessage).toHaveBeenCalledWith('summarize [[alpha]]', [
      { title: 'Alpha', path: '/vault/alpha.md', type: 'Project' },
    ])
    expect(screen.getByTestId('agent-send')).toBeDisabled()
  })

  it('retargets a queued prompt before sending when the active target differs', async () => {
    const onTargetChange = vi.fn()
    render(<QueuedPromptTargetHarness onTargetChange={onTargetChange} />)

    await act(async () => {
      queueAiPrompt('ask codex', [], 'agent:codex')
    })

    await waitFor(() => {
      expect(onTargetChange).toHaveBeenCalledWith('agent:codex')
      expect(mockClearConversation).toHaveBeenCalledOnce()
      expect(mockSendMessage).toHaveBeenCalledWith('ask codex', [])
    })
  })

  it('surfaces an unsupported non-image paste notice without locking the composer', () => {
    const onUnsupportedAiPaste = vi.fn()
    const entry = makeEntry({ title: 'My Note' })

    render(
      <AiPanel
        onClose={vi.fn()}
        vaultPath="/tmp/vault"
        activeEntry={entry}
        entries={[entry]}
        onUnsupportedAiPaste={onUnsupportedAiPaste}
      />,
    )

    fireEvent.paste(screen.getByTestId('agent-input'), {
      clipboardData: {
        getData: vi.fn(() => ''),
        files: [new File(['pdf'], 'spec.pdf', { type: 'application/pdf' })],
        items: [{ kind: 'file', type: 'application/pdf' }],
      },
    })

    expect(onUnsupportedAiPaste).toHaveBeenCalledWith(translate('en', 'ai.panel.unsupportedPaste'))
    expect(screen.getByTestId('agent-input').textContent).not.toContain('spec.pdf')
  })

  it('attaches pasted images, enables image-only sends, and cleans up removed or cleared images', async () => {
    let stageSeq = 0
    const deleteSpy = vi.fn(() => null)
    window.__mockHandlers = {
      ...window.__mockHandlers,
      stage_ai_chat_image: (args?: unknown) => {
        const { vaultPath, filename } = args as { vaultPath: string; filename: string }
        return `${vaultPath}/.tolaria/tmp/${++stageSeq}-${filename}`
      },
      delete_ai_chat_images: deleteSpy,
    }

    const { rerender } = render(<AiPanel onClose={vi.fn()} vaultPath="/tmp/vault" />)
    expect(screen.getByTestId('agent-attach-image')).toBeEnabled()
    expect(screen.getByTestId('agent-send')).toBeDisabled()

    const firstPng = new File(['png-1'], 'first.png', { type: 'image/png' })
    const secondPng = new File(['png-2'], 'second.png', { type: 'image/png' })
    fireEvent.paste(screen.getByTestId('agent-input'), {
      clipboardData: {
        getData: vi.fn(() => ''),
        files: [firstPng, secondPng],
        items: [
          { kind: 'file', type: 'image/png', getAsFile: () => firstPng },
          { kind: 'file', type: 'image/png', getAsFile: () => secondPng },
        ],
      },
    })

    await waitFor(() => {
      expect(screen.getAllByTestId('composer-image-item')).toHaveLength(2)
    })
    expect(screen.getByTestId('agent-send')).toBeEnabled()

    fireEvent.click(screen.getAllByTestId('composer-image-remove')[0])
    await waitFor(() => {
      expect(screen.getAllByTestId('composer-image-item')).toHaveLength(1)
    })
    await waitFor(() => {
      expect(deleteSpy).toHaveBeenCalledWith({
        vaultPath: '/tmp/vault',
        paths: ['/tmp/vault/.tolaria/tmp/1-first.png'],
      })
    })

    deleteSpy.mockClear()
    fireEvent.click(screen.getByTestId('agent-send'))
    expect(mockSendMessage).toHaveBeenCalledWith('', [], ['/tmp/vault/.tolaria/tmp/2-second.png'])
    expect(screen.queryByTestId('composer-image-strip')).toBeNull()
    expect(deleteSpy).not.toHaveBeenCalled()

    mockMessages = [{
      id: 'msg-sent',
      userMessage: '',
      images: ['/tmp/vault/.tolaria/tmp/2-second.png'],
      actions: [],
      response: 'Done',
    }]
    rerender(<AiPanel onClose={vi.fn()} vaultPath="/tmp/vault" />)
    const thirdPng = new File(['png-3'], 'third.png', { type: 'image/png' })
    fireEvent.paste(screen.getByTestId('agent-input'), {
      clipboardData: {
        getData: vi.fn(() => ''),
        files: [thirdPng],
        items: [{ kind: 'file', type: 'image/png', getAsFile: () => thirdPng }],
      },
    })
    await waitFor(() => {
      expect(screen.getAllByTestId('composer-image-item')).toHaveLength(1)
    })

    fireEvent.click(screen.getByTitle('New AI chat'))
    await waitFor(() => {
      expect(deleteSpy).toHaveBeenCalledWith({
        vaultPath: '/tmp/vault',
        paths: [
          '/tmp/vault/.tolaria/tmp/2-second.png',
          '/tmp/vault/.tolaria/tmp/3-third.png',
        ],
      })
    })
    expect(mockClearConversation).toHaveBeenCalledOnce()
  })

  it('keeps composer images and draft intact when the session rejects the image send', async () => {
    mockAdmitSend = false
    window.__mockHandlers = {
      ...window.__mockHandlers,
      stage_ai_chat_image: () => '/tmp/vault/.tolaria/tmp/1-blocked.png',
    }
    render(<AiPanel onClose={vi.fn()} vaultPath="/tmp/vault" />)

    const png = new File(['png'], 'blocked.png', { type: 'image/png' })
    fireEvent.paste(screen.getByTestId('agent-input'), {
      clipboardData: {
        getData: vi.fn(() => ''),
        files: [png],
        items: [{ kind: 'file', type: 'image/png', getAsFile: () => png }],
      },
    })

    await waitFor(() => {
      expect(screen.getAllByTestId('composer-image-item')).toHaveLength(1)
    })

    fireEvent.click(screen.getByTestId('agent-send'))
    expect(mockSendMessage).toHaveBeenCalledWith('', [], ['/tmp/vault/.tolaria/tmp/1-blocked.png'])
    expect(screen.getAllByTestId('composer-image-item')).toHaveLength(1)
  })

  describe('conversation reset releases images by ownership', () => {
    const shared = '/tmp/vault/.tolaria/tmp/1-shared.png'
    const sourceOnly = '/tmp/vault/.tolaria/tmp/2-source.png'
    const draft = '/tmp/vault/.tolaria/tmp/3-draft.png'
    const deleteSpy = vi.fn(() => null)

    async function renderWithSentAndDraftImages() {
      window.__mockHandlers = {
        ...window.__mockHandlers,
        stage_ai_chat_image: () => draft,
        delete_ai_chat_images: deleteSpy,
      }
      mockMessages = [{ id: 'm1', userMessage: 'img', images: [shared, sourceOnly], actions: [], response: 'ok' }]
      render(<AiPanel onClose={vi.fn()} vaultPath="/tmp/vault" />)
      const png = new File(['png'], 'draft.png', { type: 'image/png' })
      fireEvent.paste(screen.getByTestId('agent-input'), {
        clipboardData: { getData: vi.fn(() => ''), files: [png], items: [{ kind: 'file', type: 'image/png', getAsFile: () => png }] },
      })
      await waitFor(() => { expect(screen.getAllByTestId('composer-image-item')).toHaveLength(1) })
    }

    beforeEach(() => {
      deleteSpy.mockClear()
      resetAiWorkspaceSessionStoreForTests()
    })

    afterEach(() => {
      resetAiWorkspaceSessionStoreForTests()
    })

    it('keeps a sent image that a fork still owns when the source chat is reset', async () => {
      setAiWorkspaceSessionMessages('chat-fork', [{ id: 'm1', userMessage: 'img', images: [shared], actions: [] }])
      await renderWithSentAndDraftImages()

      fireEvent.click(screen.getByTitle('New AI chat'))

      await waitFor(() => {
        expect(deleteSpy).toHaveBeenCalledWith({ vaultPath: '/tmp/vault', paths: [sourceOnly, draft] })
      })
      expect(deleteSpy).toHaveBeenCalledTimes(1)
    })

    it('releases sent and draft images and keeps the request text-only when a palette prompt resets the chat', async () => {
      await renderWithSentAndDraftImages()

      await act(async () => { queueAiPrompt('summarize', []) })

      await waitFor(() => {
        expect(deleteSpy).toHaveBeenCalledWith({ vaultPath: '/tmp/vault', paths: [shared, sourceOnly, draft] })
      })
      expect(mockClearConversation).toHaveBeenCalledOnce()
      expect(mockSendMessage).toHaveBeenCalledWith('summarize', [])
      expect(screen.queryByTestId('composer-image-strip')).toBeNull()
    })
  })
})
