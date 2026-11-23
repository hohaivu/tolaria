import { useState } from 'react'
import { ImageBroken } from '@phosphor-icons/react'
import { ImageLightbox } from './ImageLightbox'
import { filenameFromPath } from '../utils/imageFilenames'
import { createTranslator, type AppLocale } from '../lib/i18n'
import { safeAttachmentAssetUrlFromPath } from '../utils/vaultAttachments'

interface AiMessageImagesProps {
  images: string[]
  locale?: AppLocale
  hasText: boolean
}

export function AiMessageImages({
  images,
  locale = 'en',
  hasText,
}: AiMessageImagesProps) {
  const [failedPaths, setFailedPaths] = useState<Set<string>>(() => new Set())
  const [previewPath, setPreviewPath] = useState<string | null>(null)
  const t = createTranslator(locale)
  const previewTitle = t('ai.panel.images.preview')
  const unavailableLabel = t('ai.panel.images.unavailable')

  const markFailed = (path: string) => {
    setFailedPaths((current) => {
      if (current.has(path)) return current
      const next = new Set(current)
      next.add(path)
      return next
    })
  }

  return (
    <>
      <div
        className="flex flex-wrap gap-1.5"
        style={{ marginBottom: hasText ? 6 : 0 }}
        data-testid="message-images"
      >
        {images.map((path) => (
          failedPaths.has(path) ? (
            <div
              key={path}
              data-testid="message-image-placeholder"
              title={unavailableLabel}
              className="flex h-16 w-16 shrink-0 flex-col items-center justify-center gap-1 rounded-md border border-border bg-muted px-1 text-center text-muted-foreground"
            >
              <ImageBroken size={18} aria-hidden />
              <span className="line-clamp-2 text-[10px] leading-tight">{unavailableLabel}</span>
            </div>
          ) : (
            <button
              key={path}
              type="button"
              onClick={() => setPreviewPath(path)}
              aria-label={previewTitle}
              title={previewTitle}
              data-testid="message-image-thumbnail"
              className="h-16 w-16 shrink-0 cursor-pointer overflow-hidden rounded-md border border-border bg-muted p-0 transition-opacity hover:opacity-90"
            >
              <img
                src={safeAttachmentAssetUrlFromPath({ path })}
                alt={filenameFromPath(path)}
                className="h-full w-full object-cover"
                onError={() => markFailed(path)}
              />
            </button>
          )
        ))}
      </div>
      <ImageLightbox
        image={previewPath
          ? { src: safeAttachmentAssetUrlFromPath({ path: previewPath }), alt: filenameFromPath(previewPath) }
          : null}
        locale={locale}
        onClose={() => setPreviewPath(null)}
      />
    </>
  )
}
