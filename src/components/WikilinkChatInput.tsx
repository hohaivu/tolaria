import type { CSSProperties } from 'react'
import type { AttachImagesPayload } from '../lib/aiChatImages'
import type { AppLocale } from '../lib/i18n'
import type { VaultEntry } from '../types'
import type { NoteReference } from '../utils/ai-context'
import { InlineWikilinkInput } from './InlineWikilinkInput'

interface WikilinkChatInputProps {
  entries: VaultEntry[]
  value: string
  locale?: AppLocale
  onChange: (value: string) => void
  onSend: (text: string, references: NoteReference[]) => void
  onAttachImages?: (payload: AttachImagesPayload) => void
  onUnsupportedPaste?: (message: string) => void
  submitOnEmpty?: boolean
  disabled?: boolean
  placeholder?: string
  placeholderClassName?: string
  inputRef?: React.RefObject<HTMLDivElement | null>
  editorClassName?: string
  editorStyle?: CSSProperties
}

export function WikilinkChatInput(options: WikilinkChatInputProps) {
  const {
    entries,
    value,
    locale,
    onChange,
    onSend,
    onAttachImages,
    onUnsupportedPaste,
    submitOnEmpty,
    disabled,
    placeholder,
    placeholderClassName,
    inputRef,
    editorClassName,
    editorStyle,
  } = options
  return (
    <InlineWikilinkInput
      entries={entries}
      value={value}
      locale={locale}
      onChange={onChange}
      onSubmit={onSend}
      onAttachImages={onAttachImages}
      onUnsupportedPaste={onUnsupportedPaste}
      submitOnEmpty={submitOnEmpty}
      disabled={disabled}
      placeholder={placeholder}
      placeholderClassName={placeholderClassName}
      inputRef={inputRef}
      editorClassName={editorClassName}
      editorStyle={editorStyle}
    />
  )
}
