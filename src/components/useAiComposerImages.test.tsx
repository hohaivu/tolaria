import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { dialogOpenMock, stageFileMock, stagePathMock, deleteImagesMock } = vi.hoisted(() => ({
  dialogOpenMock: vi.fn(),
  stageFileMock: vi.fn(),
  stagePathMock: vi.fn(),
  deleteImagesMock: vi.fn(async () => {}),
}))

vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: dialogOpenMock,
}))

vi.mock('../lib/aiChatImages', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/aiChatImages')>()
  return {
    ...actual,
    stageAiChatImageFile: stageFileMock,
    stageAiChatImageFromPath: stagePathMock,
    deleteAiChatImages: deleteImagesMock,
  }
})

import {
  MAX_AI_CHAT_IMAGE_BYTES,
  cleanupClosedConversationImages,
  getSessionDraftImages,
  setSessionDraftImages,
} from '../lib/aiChatImages'
import { useAiComposerImages } from './useAiComposerImages'

describe('useAiComposerImages', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setSessionDraftImages('session-1', [])
  })

  it('rejects >15 MiB, HEIC, and non-image files before staging and shows localized toasts', async () => {
    const onToast = vi.fn()
    const { result } = renderHook(() => useAiComposerImages({ vaultPath: '/vault', locale: 'en', onToast }))

    const oversized = { name: 'huge.png', type: 'image/png', size: MAX_AI_CHAT_IMAGE_BYTES + 1 } as File
    const heic = new File(['heic'], 'photo.heic', { type: 'image/heic' })
    const pdf = new File(['pdf'], 'doc.pdf', { type: 'application/pdf' })

    await act(async () => {
      await result.current.attachImages({ files: [oversized, heic, pdf] })
    })

    expect(stageFileMock).not.toHaveBeenCalled()
    expect(result.current.images).toEqual([])
    expect(onToast).toHaveBeenCalledWith('Images must be 15 MB or smaller.')
    expect(onToast).toHaveBeenCalledWith('Only PNG, JPEG, GIF, and WebP images are supported.')
  })

  it('enforces at most 4 images per message and rejects the 5th without staging', async () => {
    const onToast = vi.fn()
    let counter = 0
    stageFileMock.mockImplementation(async (_vault: string, file: File) => `/vault/.tolaria/tmp/${++counter}-${file.name}`)

    const { result } = renderHook(() => useAiComposerImages({ vaultPath: '/vault', locale: 'en', onToast }))

    const files = [1, 2, 3, 4, 5].map((index) => new File(['img'], `shot-${index}.png`, { type: 'image/png' }))

    await act(async () => {
      await result.current.attachImages({ files })
    })

    expect(stageFileMock).toHaveBeenCalledTimes(4)
    expect(result.current.images).toHaveLength(4)
    expect(onToast).toHaveBeenCalledWith('You can attach up to 4 images per message.')
  })

  it('maps Rust staging error codes (unsupported_type / too_large) to localized toasts', async () => {
    const onToast = vi.fn()
    stagePathMock
      .mockRejectedValueOnce(new Error('too_large'))
      .mockRejectedValueOnce(new Error('unsupported_type'))

    const { result } = renderHook(() => useAiComposerImages({ vaultPath: '/vault', locale: 'en', onToast }))

    await act(async () => {
      await result.current.attachImages({ paths: ['/tmp/big.png', '/tmp/weird.png'] })
    })

    expect(result.current.images).toEqual([])
    expect(onToast).toHaveBeenCalledWith('Images must be 15 MB or smaller.')
    expect(onToast).toHaveBeenCalledWith('Only PNG, JPEG, GIF, and WebP images are supported.')
  })

  it('opens the native file dialog on pickImages and stages selected paths', async () => {
    dialogOpenMock.mockResolvedValue(['/Users/test/one.png', '/Users/test/two.webp'])
    stagePathMock
      .mockResolvedValueOnce('/vault/.tolaria/tmp/1-one.png')
      .mockResolvedValueOnce('/vault/.tolaria/tmp/2-two.webp')

    const { result } = renderHook(() => useAiComposerImages({ vaultPath: '/vault', locale: 'en' }))

    await act(async () => {
      await result.current.pickImages()
    })

    expect(dialogOpenMock).toHaveBeenCalledWith({
      multiple: true,
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp'] }],
    })
    expect(result.current.images).toEqual([
      '/vault/.tolaria/tmp/1-one.png',
      '/vault/.tolaria/tmp/2-two.webp',
    ])
  })

  it('deletes on removeImage and keeps files on consumeImages', async () => {
    stagePathMock
      .mockResolvedValueOnce('/vault/.tolaria/tmp/1-a.png')
      .mockResolvedValueOnce('/vault/.tolaria/tmp/2-b.png')

    const { result } = renderHook(() => useAiComposerImages({
      vaultPath: '/vault',
      sessionId: 'session-1',
      locale: 'en',
    }))

    await act(async () => {
      await result.current.attachImages({ paths: ['/tmp/a.png', '/tmp/b.png'] })
    })

    act(() => {
      result.current.removeImage('/vault/.tolaria/tmp/1-a.png')
    })

    expect(deleteImagesMock).toHaveBeenCalledWith('/vault', ['/vault/.tolaria/tmp/1-a.png'])
    expect(result.current.images).toEqual(['/vault/.tolaria/tmp/2-b.png'])

    deleteImagesMock.mockClear()
    let consumed: string[] = []
    act(() => {
      consumed = result.current.consumeImages()
    })
    expect(consumed).toEqual(['/vault/.tolaria/tmp/2-b.png'])
    expect(result.current.images).toEqual([])
    expect(deleteImagesMock).not.toHaveBeenCalled()
  })
  describe('staging that resolves after the draft was retired', () => {
    function deferStaging() {
      let resolveStage!: (path: string) => void
      stagePathMock.mockReturnValueOnce(new Promise<string>((resolve) => { resolveStage = resolve }))
      return (path: string) => resolveStage(path)
    }

    it('deletes the late file and leaves the draft empty after the conversation closes', async () => {
      const resolveStage = deferStaging()
      const { result } = renderHook(() => useAiComposerImages({ vaultPath: '/vault', sessionId: 'session-1' }))

      let pending!: Promise<void>
      act(() => { pending = result.current.attachImages({ paths: ['/tmp/late.png'] }) })
      cleanupClosedConversationImages('session-1', '/vault', [])
      await act(async () => {
        resolveStage('/vault/.tolaria/tmp/late.png')
        await pending
      })

      expect(getSessionDraftImages('session-1')).toEqual([])
      expect(deleteImagesMock).toHaveBeenCalledWith('/vault', ['/vault/.tolaria/tmp/late.png'])
    })

    it('deletes the late file after a chat reset and still accepts the next paste', async () => {
      const resolveStage = deferStaging()
      const { result } = renderHook(() => useAiComposerImages({ vaultPath: '/vault', sessionId: 'session-1' }))

      let pending!: Promise<void>
      act(() => { pending = result.current.attachImages({ paths: ['/tmp/late.png'] }) })
      act(() => { result.current.discardImages() })
      await act(async () => {
        resolveStage('/vault/.tolaria/tmp/late.png')
        await pending
      })
      expect(result.current.images).toEqual([])
      expect(deleteImagesMock).toHaveBeenCalledWith('/vault', ['/vault/.tolaria/tmp/late.png'])

      stagePathMock.mockResolvedValueOnce('/vault/.tolaria/tmp/next.png')
      await act(async () => { await result.current.attachImages({ paths: ['/tmp/next.png'] }) })
      expect(result.current.images).toEqual(['/vault/.tolaria/tmp/next.png'])
    })

    it('deletes the late file when a session-less composer unmounts first', async () => {
      const resolveStage = deferStaging()
      const { result, unmount } = renderHook(() => useAiComposerImages({ vaultPath: '/vault' }))

      let pending!: Promise<void>
      act(() => { pending = result.current.attachImages({ paths: ['/tmp/late.png'] }) })
      unmount()
      await act(async () => {
        resolveStage('/vault/.tolaria/tmp/late.png')
        await pending
      })

      expect(deleteImagesMock).toHaveBeenCalledWith('/vault', ['/vault/.tolaria/tmp/late.png'])
    })

    it('stops a two-image batch when the draft closes while the first entry is staging and rejects', async () => {
      let rejectStage!: (error: Error) => void
      stagePathMock.mockReturnValueOnce(new Promise<string>((_, reject) => { rejectStage = reject }))
      stagePathMock.mockResolvedValue('/vault/.tolaria/tmp/second.png')
      const onToast = vi.fn()
      const { result } = renderHook(() => useAiComposerImages({ vaultPath: '/vault', sessionId: 'session-1', onToast }))

      let pending!: Promise<void>
      act(() => { pending = result.current.attachImages({ paths: ['/tmp/first.png', '/tmp/second.png'] }) })
      cleanupClosedConversationImages('session-1', '/vault', [])
      await act(async () => {
        rejectStage(new Error('boom'))
        await pending
      })

      expect(stagePathMock).toHaveBeenCalledTimes(1)
      expect(getSessionDraftImages('session-1')).toEqual([])
      expect(onToast).not.toHaveBeenCalled()
    })

    it('stops a picker selection that returns after the draft was reset', async () => {
      let resolvePicker!: (paths: string[]) => void
      dialogOpenMock.mockReturnValueOnce(new Promise<string[]>((resolve) => { resolvePicker = resolve }))
      const { result } = renderHook(() => useAiComposerImages({ vaultPath: '/vault', sessionId: 'session-1' }))

      let pending!: Promise<void>
      act(() => { pending = result.current.pickImages() })
      await vi.waitFor(() => expect(dialogOpenMock).toHaveBeenCalled())
      act(() => { result.current.discardImages() })
      await act(async () => {
        resolvePicker(['/tmp/picked.png'])
        await pending
      })

      expect(stagePathMock).not.toHaveBeenCalled()
      expect(result.current.images).toEqual([])
    })
  })
})
