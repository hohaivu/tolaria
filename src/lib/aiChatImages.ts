import { invoke } from '@tauri-apps/api/core'
import { isTauri, mockInvoke } from '../mock-tauri'
import type { AiAgentMessage } from './aiAgentConversation'
import { aiWorkspaceSessionSnapshot } from './aiWorkspaceSessionStore'
import { bytesToBase64 } from './vaultBackend/commandVaultBackend'

export const MAX_AI_CHAT_IMAGES = 4
export const MAX_AI_CHAT_IMAGE_BYTES = 15 * 1024 * 1024
export const ALLOWED_AI_CHAT_IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp'] as const

const ALLOWED_EXTENSION_SET = new Set<string>(ALLOWED_AI_CHAT_IMAGE_EXTENSIONS)
const ALLOWED_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])
const IMAGE_CANDIDATE_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'heic', 'heif', 'bmp', 'svg', 'tif', 'tiff', 'avif', 'ico',
])
const MIME_TO_DEFAULT_FILENAME = new Map<string, string>([
  ['image/png', 'image.png'],
  ['image/jpeg', 'image.jpg'],
  ['image/gif', 'image.gif'],
  ['image/webp', 'image.webp'],
])

const EMPTY_DRAFT_IMAGES: string[] = []
const clearedVaultPaths = new Set<string>()
const sessionDraftImages = new Map<string, string[]>()
const sessionDraftListeners = new Map<string, Set<() => void>>()

export interface AttachImagesPayload {
  files?: File[]
  paths?: string[]
}

export type AiChatImageValidationError = 'unsupported_type' | 'too_large'
export type AiChatImageStageError = AiChatImageValidationError | 'failed'

function callCommand<T>(command: string, args: Record<string, unknown>): Promise<T> {
  return isTauri() ? invoke<T>(command, args) : mockInvoke<T>(command, args)
}

export function filenameFromPath(path: string): string {
  return path.split(/[\\/]/u).pop() || path
}

function extensionFromFilename(filename: string): string {
  const base = filenameFromPath(filename)
  const dotIndex = base.lastIndexOf('.')
  if (dotIndex <= 0 || dotIndex === base.length - 1) return ''
  return base.slice(dotIndex + 1).toLowerCase()
}

function isAllowedAiChatImageExtension(filenameOrPath: string): boolean {
  return ALLOWED_EXTENSION_SET.has(extensionFromFilename(filenameOrPath))
}

export function isImageAttachmentCandidatePath(path: string): boolean {
  return IMAGE_CANDIDATE_EXTENSIONS.has(extensionFromFilename(path))
}

export function isImageAttachmentCandidateFile(file: File): boolean {
  return file.type.toLowerCase().startsWith('image/') || isImageAttachmentCandidatePath(file.name)
}

export function normalizeStagingFilename(file: File): string {
  if (isAllowedAiChatImageExtension(file.name)) return file.name
  return MIME_TO_DEFAULT_FILENAME.get(file.type.toLowerCase()) ?? (file.name || 'image')
}

export function validateAiChatImageFile(file: File): AiChatImageValidationError | null {
  const mime = file.type.toLowerCase()
  const ext = extensionFromFilename(file.name)

  if (mime && mime !== 'application/octet-stream') {
    if (!ALLOWED_MIME_TYPES.has(mime)) return 'unsupported_type'
    if (ext && !ALLOWED_EXTENSION_SET.has(ext)) return 'unsupported_type'
  } else if (!ALLOWED_EXTENSION_SET.has(ext)) {
    return 'unsupported_type'
  }

  if (file.size > MAX_AI_CHAT_IMAGE_BYTES) return 'too_large'
  return null
}

export function validateAiChatImagePath(path: string): 'unsupported_type' | null {
  return isAllowedAiChatImageExtension(path) ? null : 'unsupported_type'
}

export function classifyAiChatImageStageError(error: unknown): AiChatImageStageError {
  const message = error instanceof Error ? error.message : String(error)
  if (message.includes('too_large')) return 'too_large'
  if (message.includes('unsupported_type')) return 'unsupported_type'
  return 'failed'
}

export function collectMessageImages(messages: readonly AiAgentMessage[]): string[] {
  const unique = new Set<string>()
  for (const message of messages) {
    for (const imagePath of message.images ?? []) {
      if (imagePath) unique.add(imagePath)
    }
  }
  return Array.from(unique)
}

async function readFileBytes(file: File): Promise<Uint8Array> {
  if (typeof file.arrayBuffer === 'function') {
    return new Uint8Array(await file.arrayBuffer())
  }
  return new Promise<Uint8Array>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer))
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read image file'))
    reader.readAsArrayBuffer(file)
  })
}

export async function stageAiChatImageFile(vaultPath: string, file: File): Promise<string> {
  const bytes = await readFileBytes(file)
  const dataBase64 = bytesToBase64(bytes)
  return callCommand<string>('stage_ai_chat_image', {
    vaultPath,
    filename: normalizeStagingFilename(file),
    dataBase64,
  })
}

export async function stageAiChatImageFromPath(vaultPath: string, sourcePath: string): Promise<string> {
  return callCommand<string>('stage_ai_chat_image_from_path', {
    vaultPath,
    sourcePath,
  })
}

export async function deleteAiChatImages(vaultPath: string, paths: readonly string[]): Promise<void> {
  const trimmedVault = vaultPath.trim()
  const uniquePaths = Array.from(new Set(paths.map((path) => path.trim()).filter(Boolean)))
  if (!trimmedVault || uniquePaths.length === 0) return

  try {
    await callCommand<void>('delete_ai_chat_images', {
      vaultPath: trimmedVault,
      paths: uniquePaths,
    })
  } catch (error) {
    console.warn('[ai-chat-images] Failed to delete staged images:', error)
  }
}

export async function clearAiChatImagesOnceForVault(vaultPath: string): Promise<void> {
  if (!isTauri()) return
  const trimmedVault = vaultPath.trim()
  if (!trimmedVault || clearedVaultPaths.has(trimmedVault)) return

  clearedVaultPaths.add(trimmedVault)
  try {
    await invoke<void>('clear_ai_chat_images', { vaultPath: trimmedVault })
  } catch (error) {
    console.warn('[ai-chat-images] Failed to clear staged images on startup:', error)
  }
}

function notifyDraftListeners(sessionId: string): void {
  const listeners = sessionDraftListeners.get(sessionId)
  if (!listeners) return
  for (const listener of listeners) listener()
}

export function getSessionDraftImages(sessionId: string): string[] {
  return sessionDraftImages.get(sessionId) ?? EMPTY_DRAFT_IMAGES
}

export function setSessionDraftImages(
  sessionId: string,
  next: string[] | ((current: string[]) => string[]),
): void {
  const current = getSessionDraftImages(sessionId)
  const resolved = typeof next === 'function' ? next(current) : next
  if (resolved.length === 0) {
    if (!sessionDraftImages.has(sessionId)) return
    sessionDraftImages.delete(sessionId)
  } else {
    sessionDraftImages.set(sessionId, resolved)
  }
  notifyDraftListeners(sessionId)
}

export function subscribeSessionDraftImages(sessionId: string, listener: () => void): () => void {
  let listeners = sessionDraftListeners.get(sessionId)
  if (!listeners) {
    listeners = new Set()
    sessionDraftListeners.set(sessionId, listeners)
  }
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) sessionDraftListeners.delete(sessionId)
  }
}

function takeSessionDraftImages(sessionId: string): string[] {
  const current = getSessionDraftImages(sessionId)
  if (current.length === 0) return EMPTY_DRAFT_IMAGES
  sessionDraftImages.delete(sessionId)
  notifyDraftListeners(sessionId)
  return current
}

function sessionImagePaths(sessionId: string): string[] {
  return [
    ...collectMessageImages(aiWorkspaceSessionSnapshot(sessionId).messages),
    ...getSessionDraftImages(sessionId),
  ]
}

export function cleanupClosedConversationImages(
  closedSessionId: string,
  vaultPath: string,
  remainingSessionIds: readonly string[],
): void {
  const closedMessageImages = collectMessageImages(aiWorkspaceSessionSnapshot(closedSessionId).messages)
  const closedDraftImages = takeSessionDraftImages(closedSessionId)
  const candidates = [...closedMessageImages, ...closedDraftImages]
  if (candidates.length === 0) return

  const retained = new Set<string>()
  for (const sessionId of remainingSessionIds) {
    if (sessionId === closedSessionId) continue
    for (const path of sessionImagePaths(sessionId)) {
      retained.add(path)
    }
  }

  void deleteAiChatImages(
    vaultPath,
    candidates.filter((path) => !retained.has(path)),
  )
}
