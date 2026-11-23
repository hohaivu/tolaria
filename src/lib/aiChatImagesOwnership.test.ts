import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { mockInvokeMock } = vi.hoisted(() => ({ mockInvokeMock: vi.fn() }))

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
vi.mock('../mock-tauri', () => ({ isTauri: () => false, mockInvoke: mockInvokeMock }))

const SHARED = '/vault/.tolaria/tmp/1-shared.png'
const sharedMessage = { id: 'm1', userMessage: 'img', images: [SHARED], actions: [], response: 'ok' }

function createStorage(): Storage {
  const store = new Map<string, string>()
  return {
    get length() { return store.size },
    clear: () => store.clear(),
    getItem: (key: string) => store.get(key) ?? null,
    key: (index: number) => Array.from(store.keys())[index] ?? null,
    removeItem: (key: string) => { store.delete(key) },
    setItem: (key: string, value: string) => { store.set(key, value) },
  }
}

async function loadModules() {
  vi.resetModules()
  return {
    images: await import('./aiChatImages'),
    store: await import('./aiWorkspaceSessionStore'),
  }
}

describe('image ownership across renderers', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.stubGlobal('localStorage', createStorage())
    mockInvokeMock.mockReset()
    mockInvokeMock.mockResolvedValue(undefined)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('keeps a closed source released after the renderer is recreated', async () => {
    const first = await loadModules()
    first.store.setAiWorkspaceSessionMessages('chat-src', [sharedMessage])
    first.store.setAiWorkspaceSessionMessages('chat-fork', [sharedMessage])
    first.images.cleanupClosedConversationImages('chat-src', '/vault', ['chat-fork'])
    await vi.advanceTimersByTimeAsync(2000)
    mockInvokeMock.mockClear()

    const second = await loadModules()
    second.store.setAiWorkspaceSessionMessages('chat-fork', [])
    second.images.releaseUnownedImages('/vault', [SHARED], second.store.aiWorkspaceSessionIds())
    await vi.advanceTimersByTimeAsync(0)

    expect(mockInvokeMock).toHaveBeenCalledWith('delete_ai_chat_images', { vaultPath: '/vault', paths: [SHARED] })
  })

  it('keeps an archived (not closed) source as an owner after the renderer is recreated', async () => {
    const first = await loadModules()
    first.store.setAiWorkspaceSessionMessages('chat-src', [sharedMessage])
    first.store.setAiWorkspaceSessionMessages('chat-fork', [sharedMessage])
    await vi.advanceTimersByTimeAsync(2000)

    const second = await loadModules()
    second.store.setAiWorkspaceSessionMessages('chat-fork', [])
    second.images.releaseUnownedImages('/vault', [SHARED], second.store.aiWorkspaceSessionIds())
    await vi.advanceTimersByTimeAsync(0)

    expect(mockInvokeMock).not.toHaveBeenCalled()
  })
})
