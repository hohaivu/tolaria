import { isImageAttachmentCandidateFile, isImageAttachmentCandidatePath } from '../lib/aiChatImages'
import type { NoteReference } from '../utils/ai-context'
import type { InlineSelectionRange } from './inlineWikilinkDom'
import { replaceInlineSelection } from './inlineWikilinkEdits'
import { normalizeInlineWikilinkValue } from './inlineWikilinkTokens'

export function hasUnsupportedClipboardPayload(clipboardData: DataTransfer) {
  if (clipboardData.files.length > 0) return true

  return Array.from(clipboardData.items).some((item) => item.kind === 'file' || item.type.startsWith('image/'))
}

function extractClipboardFiles(clipboardData: DataTransfer): File[] {
  const files = Array.from(clipboardData.files ?? [])
  if (files.length > 0) return files

  const itemFiles: File[] = []
  for (const item of Array.from(clipboardData.items ?? [])) {
    if (item.kind !== 'file') continue
    const file = typeof item.getAsFile === 'function' ? item.getAsFile() : null
    if (file) itemFiles.push(file)
  }
  return itemFiles
}

export function partitionDroppedImagePaths(paths: string[]): { imagePaths: string[]; textPaths: string[] } {
  const imagePaths: string[] = []
  const textPaths: string[] = []
  for (const path of paths) {
    if (isImageAttachmentCandidatePath(path)) imagePaths.push(path)
    else textPaths.push(path)
  }
  return { imagePaths, textPaths }
}

export function extractDroppedImageFiles(dataTransfer: DataTransfer): File[] {
  return extractClipboardFiles(dataTransfer).filter(isImageAttachmentCandidateFile)
}

export function extractPastedImageFiles(clipboardData: DataTransfer): File[] {
  const pastedFiles = extractClipboardFiles(clipboardData)
  const hasImageItem = Array.from(clipboardData.items ?? []).some(
    (item) => item.type.startsWith('image/'),
  )
  return pastedFiles.some(isImageAttachmentCandidateFile) || (hasImageItem && pastedFiles.length > 0)
    ? pastedFiles
    : []
}

export function containsUnsupportedInlineContent(editor: HTMLDivElement) {
  return editor.querySelector('img, picture, video, audio, canvas, figure, iframe, object') !== null
}

export function deleteToLineStart(
  value: string,
  selection: InlineSelectionRange,
): { value: string; selection: InlineSelectionRange } | null {
  const start = Math.max(0, Math.min(selection.start, selection.end, value.length))
  const end = Math.max(start, Math.min(Math.max(selection.start, selection.end), value.length))
  if (start !== end) return replaceInlineSelection(value, { start, end }, '')

  const lineStart = start === 0 ? 0 : value.lastIndexOf('\n', start - 1) + 1
  if (lineStart === start) return null

  return replaceInlineSelection(value, { start: lineStart, end: start }, '')
}

export function submitInlineValue({
  onSubmit,
  submitOnEmpty,
  value,
  references,
}: {
  onSubmit?: (text: string, references: NoteReference[]) => void
  submitOnEmpty: boolean
  value: string
  references: NoteReference[]
}) {
  if (!onSubmit) return
  const normalizedValue = normalizeInlineWikilinkValue(value)
  if (!submitOnEmpty && !normalizedValue.trim()) return
  onSubmit(normalizedValue, references)
}
