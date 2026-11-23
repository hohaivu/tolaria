import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { createTranslator, type AppLocale } from '../lib/i18n'
import { normalizeDialogPaths } from '../utils/vault-dialog'
import {
  ALLOWED_AI_CHAT_IMAGE_EXTENSIONS,
  MAX_AI_CHAT_IMAGES,
  classifyAiChatImageStageError,
  deleteAiChatImages,
  getSessionDraftImages,
  retireSessionDraft,
  sessionDraftEpoch,
  setSessionDraftImages,
  stageAiChatImageFile,
  stageAiChatImageFromPath,
  subscribeSessionDraftImages,
  validateAiChatImageFile,
  validateAiChatImagePath,
  type AiChatImageStageError,
  type AttachImagesPayload,
} from '../lib/aiChatImages'

const EMPTY_IMAGES: string[] = []

export interface AiPanelComposerImagesController {
  images: string[]
  attachImages: (payload: AttachImagesPayload) => Promise<void>
  pickImages: () => Promise<void>
  removeImage: (path: string) => void
  consumeImages: () => string[]
  /** Like consumeImages, and also discards staging still in flight (chat reset). */
  discardImages: () => string[]
}

interface UseAiComposerImagesOptions {
  vaultPath: string
  sessionId?: string
  locale?: AppLocale
  onToast?: (message: string) => void
}

function stageErrorToast(
  reason: AiChatImageStageError,
  t: ReturnType<typeof createTranslator>,
): string {
  switch (reason) {
    case 'too_large':
      return t('ai.panel.images.tooLarge')
    case 'unsupported_type':
      return t('ai.panel.images.unsupportedType')
    default:
      return t('ai.panel.images.stageFailed')
  }
}

export function useAiComposerImages({
  vaultPath,
  sessionId,
  locale = 'en',
  onToast,
}: UseAiComposerImagesOptions): AiPanelComposerImagesController {
  const [localImages, setLocalImages] = useState<string[]>([])
  const subscribeDraft = useCallback(
    (listener: () => void) => (sessionId ? subscribeSessionDraftImages(sessionId, listener) : () => {}),
    [sessionId],
  )
  const getDraftSnapshot = useCallback(
    () => (sessionId ? getSessionDraftImages(sessionId) : EMPTY_IMAGES),
    [sessionId],
  )
  const sharedImages = useSyncExternalStore(subscribeDraft, getDraftSnapshot, getDraftSnapshot)
  const images = sessionId ? sharedImages : localImages

  const imagesRef = useRef<string[]>(images)
  const pendingCountRef = useRef(0)
  const pickerInFlightRef = useRef(false)
  const localEpochRef = useRef(0)

  useEffect(() => {
    imagesRef.current = images
  }, [images])

  // A local (session-less) draft dies with the component; session drafts outlive it.
  useEffect(() => () => {
    localEpochRef.current += 1
  }, [])

  const draftEpoch = useCallback(
    () => (sessionId ? sessionDraftEpoch(sessionId) : localEpochRef.current),
    [sessionId],
  )

  const readImages = useCallback(
    () => (sessionId ? getSessionDraftImages(sessionId) : imagesRef.current),
    [sessionId],
  )

  const updateImages = useCallback(
    (updater: (current: string[]) => string[]) => {
      const next = updater(readImages())
      imagesRef.current = next
      if (sessionId) {
        setSessionDraftImages(sessionId, next)
      } else {
        setLocalImages(next)
      }
    },
    [readImages, sessionId],
  )

  // The draft lifetime is sampled once per gesture, so a close or reset anywhere in a batch retires all of it.
  const attachWithinDraft = useCallback(
    async ({ files = [], paths = [] }: AttachImagesPayload, gestureEpoch: number) => {
      const t = createTranslator(locale)
      if (!vaultPath.trim()) {
        if (files.length > 0 || paths.length > 0) onToast?.(t('ai.panel.images.stageFailed'))
        return
      }

      const stageEntry = async (
        validationError: 'unsupported_type' | 'too_large' | null,
        stage: () => Promise<string>,
      ): Promise<'staged' | 'limit' | 'error' | 'discarded'> => {
        if (draftEpoch() !== gestureEpoch) return 'discarded'
        if (validationError) {
          onToast?.(stageErrorToast(validationError, t))
          return 'error'
        }
        if (readImages().length + pendingCountRef.current >= MAX_AI_CHAT_IMAGES) {
          onToast?.(t('ai.panel.images.tooMany', { count: MAX_AI_CHAT_IMAGES }))
          return 'limit'
        }

        pendingCountRef.current += 1
        try {
          const stagedPath = await stage()
          if (draftEpoch() !== gestureEpoch) {
            void deleteAiChatImages(vaultPath, [stagedPath])
            return 'discarded'
          }
          updateImages((current) => (current.includes(stagedPath) ? current : [...current, stagedPath]))
          return 'staged'
        } catch (error) {
          if (draftEpoch() !== gestureEpoch) return 'discarded'
          onToast?.(stageErrorToast(classifyAiChatImageStageError(error), t))
          return 'error'
        } finally {
          pendingCountRef.current -= 1
        }
      }

      for (const file of files) {
        const outcome = await stageEntry(
          validateAiChatImageFile(file),
          () => stageAiChatImageFile(vaultPath, file),
        )
        if (outcome === 'limit' || outcome === 'discarded') return
      }

      for (const sourcePath of paths) {
        const outcome = await stageEntry(
          validateAiChatImagePath(sourcePath),
          () => stageAiChatImageFromPath(vaultPath, sourcePath),
        )
        if (outcome === 'limit' || outcome === 'discarded') return
      }
    },
    [draftEpoch, locale, onToast, readImages, updateImages, vaultPath],
  )

  const attachImages = useCallback(
    (payload: AttachImagesPayload) => attachWithinDraft(payload, draftEpoch()),
    [attachWithinDraft, draftEpoch],
  )

  const pickImages = useCallback(async () => {
    if (pickerInFlightRef.current) return

    const t = createTranslator(locale)
    if (readImages().length + pendingCountRef.current >= MAX_AI_CHAT_IMAGES) {
      onToast?.(t('ai.panel.images.tooMany', { count: MAX_AI_CHAT_IMAGES }))
      return
    }

    pickerInFlightRef.current = true
    const gestureEpoch = draftEpoch()
    try {
      const { open } = await import('@tauri-apps/plugin-dialog')
      const selected = await open({
        multiple: true,
        filters: [{
          name: t('ai.panel.images.filterName'),
          extensions: [...ALLOWED_AI_CHAT_IMAGE_EXTENSIONS],
        }],
      })
      const paths = normalizeDialogPaths(selected)
      if (paths.length > 0) {
        await attachWithinDraft({ paths }, gestureEpoch)
      }
    } catch {
      onToast?.(t('ai.panel.images.stageFailed'))
    } finally {
      pickerInFlightRef.current = false
    }
  }, [attachWithinDraft, draftEpoch, locale, onToast, readImages])

  const removeImage = useCallback(
    (path: string) => {
      updateImages((current) => current.filter((item) => item !== path))
      void deleteAiChatImages(vaultPath, [path])
    },
    [updateImages, vaultPath],
  )

  const consumeImages = useCallback(() => {
    const current = readImages()
    if (current.length === 0) return EMPTY_IMAGES
    updateImages(() => EMPTY_IMAGES)
    return current
  }, [readImages, updateImages])

  const discardImages = useCallback(() => {
    if (sessionId) retireSessionDraft(sessionId)
    else localEpochRef.current += 1
    return consumeImages()
  }, [consumeImages, sessionId])

  return {
    images,
    attachImages,
    pickImages,
    removeImage,
    consumeImages,
    discardImages,
  }
}
