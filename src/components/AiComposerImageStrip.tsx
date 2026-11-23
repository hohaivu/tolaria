import { useState } from 'react'
import { ImageBroken, X } from '@phosphor-icons/react'
import { Button } from '@/components/ui/button'
import { filenameFromPath } from '../lib/aiChatImages'
import { createTranslator, type AppLocale } from '../lib/i18n'
import { safeAttachmentAssetUrlFromPath } from '../utils/vaultAttachments'

interface AiComposerImageStripProps {
  images: string[]
  disabled?: boolean
  locale?: AppLocale
  onRemove: (path: string) => void
}

function ComposerImageThumbnail({ path }: { path: string }) {
  const [failed, setFailed] = useState(false)

  if (failed) {
    return (
      <div className="flex h-full w-full items-center justify-center text-muted-foreground">
        <ImageBroken size={18} aria-hidden />
      </div>
    )
  }

  return (
    <img
      src={safeAttachmentAssetUrlFromPath({ path })}
      alt={filenameFromPath(path)}
      className="h-full w-full object-cover"
      onError={() => setFailed(true)}
    />
  )
}

export function AiComposerImageStrip({
  images,
  disabled = false,
  locale = 'en',
  onRemove,
}: AiComposerImageStripProps) {
  if (images.length === 0) return null

  const t = createTranslator(locale)
  const removeLabel = t('ai.panel.images.remove')

  return (
    <div className="flex flex-wrap gap-1.5 pb-1.5" data-testid="composer-image-strip">
      {images.map((path) => (
        <div
          key={path}
          className="relative h-14 w-14 shrink-0 overflow-hidden rounded-md border border-border bg-muted"
          data-testid="composer-image-item"
        >
          <ComposerImageThumbnail path={path} />
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            disabled={disabled}
            onClick={() => onRemove(path)}
            aria-label={removeLabel}
            title={removeLabel}
            data-testid="composer-image-remove"
            className="absolute right-0.5 top-0.5 h-4 w-4 rounded-full border border-border bg-background p-0 text-foreground shadow-xs hover:bg-accent"
          >
            <X size={10} weight="bold" />
          </Button>
        </div>
      ))}
    </div>
  )
}
