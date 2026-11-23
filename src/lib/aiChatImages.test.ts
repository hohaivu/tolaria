import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { invokeMock, mockInvokeMock, isTauriMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  mockInvokeMock: vi.fn(),
  isTauriMock: vi.fn(() => true),
}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
}))

vi.mock('../mock-tauri', () => ({
  isTauri: isTauriMock,
  mockInvoke: mockInvokeMock,
}))

import {
  MAX_AI_CHAT_IMAGE_BYTES,
  classifyAiChatImageStageError,
  cleanupClosedConversationImages,
  clearAiChatImagesOnceForVault,
  deleteAiChatImages,
  getSessionDraftImages,
  isImageAttachmentCandidateFile,
  isImageAttachmentCandidatePath,
  normalizeStagingFilename,
  reclaimSessionImages,
  setSessionDraftImages,
  stageAiChatImageFile,
  stageAiChatImageFromPath,
  validateAiChatImageFile,
  validateAiChatImagePath,
} from './aiChatImages'
import {
  resetAiWorkspaceSessionStoreForTests,
  setAiWorkspaceSessionMessages,
} from './aiWorkspaceSessionStore'

describe('aiChatImages', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    isTauriMock.mockReturnValue(true)
    resetAiWorkspaceSessionStoreForTests()
    setSessionDraftImages('chat-a', [])
    setSessionDraftImages('chat-b', [])
  })

  afterEach(() => {
    resetAiWorkspaceSessionStoreForTests()
  })

  it('validates allowed image types, rejects HEIC/non-images, and enforces the 15 MiB limit', () => {
    expect(validateAiChatImageFile(new File(['ok'], 'shot.PNG', { type: 'image/png' }))).toBeNull()
    expect(validateAiChatImageFile(new File(['ok'], 'photo.jpeg', { type: 'image/jpeg' }))).toBeNull()
    expect(validateAiChatImageFile(new File(['ok'], 'anim.gif', { type: 'image/gif' }))).toBeNull()
    expect(validateAiChatImageFile(new File(['ok'], 'pic.webp', { type: 'image/webp' }))).toBeNull()

    expect(validateAiChatImageFile(new File(['heic'], 'photo.heic', { type: 'image/heic' }))).toBe('unsupported_type')
    expect(validateAiChatImageFile(new File(['heif'], 'photo.HEIF', { type: '' }))).toBe('unsupported_type')
    expect(validateAiChatImageFile(new File(['pdf'], 'doc.pdf', { type: 'application/pdf' }))).toBe('unsupported_type')
    expect(validateAiChatImageFile(new File(['svg'], 'icon.svg', { type: 'image/svg+xml' }))).toBe('unsupported_type')

    const oversized = {
      name: 'huge.png',
      type: 'image/png',
      size: MAX_AI_CHAT_IMAGE_BYTES + 1,
    } as File
    expect(validateAiChatImageFile(oversized)).toBe('too_large')

    expect(validateAiChatImagePath('/tmp/pic.WEBP')).toBeNull()
    expect(validateAiChatImagePath('/tmp/photo.heic')).toBe('unsupported_type')
    expect(validateAiChatImagePath('/tmp/notes.md')).toBe('unsupported_type')
  })

  it('normalizes clipboard screenshot filenames with missing extensions and encodes base64 for staging', async () => {
    const clipboardPng = new File([new Uint8Array([1, 2, 3, 4])], '', { type: 'image/png' })
    expect(normalizeStagingFilename(clipboardPng)).toBe('image.png')

    invokeMock.mockResolvedValue('/vault/.tolaria/tmp/1700000000000-image.png')
    const staged = await stageAiChatImageFile('/vault', clipboardPng)

    expect(staged).toBe('/vault/.tolaria/tmp/1700000000000-image.png')
    expect(invokeMock).toHaveBeenCalledWith('stage_ai_chat_image', {
      vaultPath: '/vault',
      filename: 'image.png',
      dataBase64: 'AQIDBA==',
    })
  })

  it('routes path staging and deletion through mockInvoke outside Tauri and classifies errors', async () => {
    isTauriMock.mockReturnValue(false)
    mockInvokeMock.mockResolvedValue('/vault/.tolaria/tmp/1700000000000-pic.jpg')

    const staged = await stageAiChatImageFromPath('/vault', '/Users/test/pic.jpg')
    expect(staged).toBe('/vault/.tolaria/tmp/1700000000000-pic.jpg')
    expect(mockInvokeMock).toHaveBeenCalledWith('stage_ai_chat_image_from_path', {
      vaultPath: '/vault',
      sourcePath: '/Users/test/pic.jpg',
    })

    await deleteAiChatImages('/vault', [staged])
    expect(mockInvokeMock).toHaveBeenCalledWith('delete_ai_chat_images', {
      vaultPath: '/vault',
      paths: [staged],
    })

    expect(classifyAiChatImageStageError(new Error('unsupported_type'))).toBe('unsupported_type')
    expect(classifyAiChatImageStageError('too_large')).toBe('too_large')
    expect(classifyAiChatImageStageError('disk full')).toBe('failed')
  })

  it('clears staged images at most once per vault path in Tauri mode', async () => {
    invokeMock.mockResolvedValue(null)

    await clearAiChatImagesOnceForVault('/vault-startup-once')
    await clearAiChatImagesOnceForVault('/vault-startup-once')
    expect(invokeMock).toHaveBeenCalledTimes(1)
    expect(invokeMock).toHaveBeenCalledWith('clear_ai_chat_images', { vaultPath: '/vault-startup-once' })

    isTauriMock.mockReturnValue(false)
    await clearAiChatImagesOnceForVault('/vault-startup-browser')
    expect(mockInvokeMock).not.toHaveBeenCalled()
  })

  it('cleans up only the closed conversation message and draft images', async () => {
    const closedMsgImg = '/vault/.tolaria/tmp/1-closed-msg.png'
    const closedDraftImg = '/vault/.tolaria/tmp/2-closed-draft.png'
    const sharedImg = '/vault/.tolaria/tmp/3-shared-fork.png'
    const otherImg = '/vault/.tolaria/tmp/4-other.png'

    setAiWorkspaceSessionMessages('chat-a', [
      { id: 'm1', userMessage: 'a', images: [closedMsgImg, sharedImg], actions: [] },
    ])
    setAiWorkspaceSessionMessages('chat-b', [
      { id: 'm2', userMessage: 'b', images: [sharedImg, otherImg], actions: [] },
    ])
    setSessionDraftImages('chat-a', [closedDraftImg])
    setSessionDraftImages('chat-b', ['/vault/.tolaria/tmp/5-other-draft.png'])

    invokeMock.mockResolvedValue(null)
    cleanupClosedConversationImages('chat-a', '/vault', ['chat-b'])

    await vi.waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('delete_ai_chat_images', {
        vaultPath: '/vault',
        paths: [closedMsgImg, closedDraftImg],
      })
    })
    expect(getSessionDraftImages('chat-a')).toEqual([])
    expect(getSessionDraftImages('chat-b')).toEqual(['/vault/.tolaria/tmp/5-other-draft.png'])
  })

  it('releases a shared file when the last of two closed owners closes, not before', async () => {
    const shared = '/vault/.tolaria/tmp/1-shared.png'
    setAiWorkspaceSessionMessages('chat-src', [{ id: 'm1', userMessage: 'a', images: [shared], actions: [] }])
    setAiWorkspaceSessionMessages('chat-fork', [{ id: 'm1', userMessage: 'a', images: [shared], actions: [] }])
    invokeMock.mockResolvedValue(null)

    cleanupClosedConversationImages('chat-src', '/vault', ['chat-fork'])
    expect(invokeMock).not.toHaveBeenCalled()

    cleanupClosedConversationImages('chat-fork', '/vault', ['chat-src'])
    await vi.waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('delete_ai_chat_images', { vaultPath: '/vault', paths: [shared] })
    })
    expect(invokeMock).toHaveBeenCalledTimes(1)
  })

  it('counts a restored conversation as an owner again', () => {
    const shared = '/vault/.tolaria/tmp/1-shared.png'
    setAiWorkspaceSessionMessages('chat-src', [{ id: 'm1', userMessage: 'a', images: [shared], actions: [] }])
    setAiWorkspaceSessionMessages('chat-fork', [{ id: 'm1', userMessage: 'a', images: [shared], actions: [] }])

    cleanupClosedConversationImages('chat-src', '/vault', ['chat-fork'])
    reclaimSessionImages('chat-src')
    cleanupClosedConversationImages('chat-fork', '/vault', ['chat-src'])

    expect(invokeMock).not.toHaveBeenCalled()
  })

  it('deletes a staged file under the vault that staged it, not the active editor vault', async () => {
    const staged = '/vaultA/.tolaria/tmp/1-shot.png'
    setAiWorkspaceSessionMessages('chat-a', [{ id: 'm1', userMessage: 'a', images: [staged], actions: [] }])
    invokeMock.mockResolvedValue(null)

    cleanupClosedConversationImages('chat-a', '/vaultB', [])

    await vi.waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('delete_ai_chat_images', { vaultPath: '/vaultA', paths: [staged] })
    })
    expect(invokeMock).not.toHaveBeenCalledWith('delete_ai_chat_images', expect.objectContaining({ vaultPath: '/vaultB' }))
  })

  it('sends one delete per staging vault and falls back to the given vault for unrecognised paths', async () => {
    invokeMock.mockResolvedValue(null)

    await deleteAiChatImages('/vaultB', [
      '/vaultA/.tolaria/tmp/1-a.png',
      'C:\\vaultC\\.tolaria\\tmp\\2-c.png',
      '/elsewhere/3-d.png',
    ])

    expect(invokeMock).toHaveBeenCalledWith('delete_ai_chat_images', { vaultPath: '/vaultA', paths: ['/vaultA/.tolaria/tmp/1-a.png'] })
    expect(invokeMock).toHaveBeenCalledWith('delete_ai_chat_images', { vaultPath: 'C:\\vaultC', paths: ['C:\\vaultC\\.tolaria\\tmp\\2-c.png'] })
    expect(invokeMock).toHaveBeenCalledWith('delete_ai_chat_images', { vaultPath: '/vaultB', paths: ['/elsewhere/3-d.png'] })
  })

  it('routes HEIC and HEIF to the chat rejection path as image candidates', () => {
    expect(isImageAttachmentCandidatePath('/tmp/IMG_1.HEIC')).toBe(true)
    expect(isImageAttachmentCandidatePath('/tmp/IMG_2.heif')).toBe(true)
    expect(isImageAttachmentCandidateFile(new File(['x'], 'IMG_3.heic'))).toBe(true)
    expect(isImageAttachmentCandidatePath('/tmp/notes.txt')).toBe(false)
  })
})
