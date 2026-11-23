/**
 * Vault dialog utilities.
 * In Tauri mode, uses the native dialog plugin for folder picking.
 * In browser mode, falls back to window.prompt() for testing.
 */

import { isTauri } from '../mock-tauri'
import {
  isRestartRequiredAfterUpdate,
  markRestartRequiredAfterUpdate,
  RESTART_REQUIRED_FOLDER_PICKER_MESSAGE,
} from '../lib/appUpdater'
import { errorMessage, errorMessageIncludes } from './vaultErrors'

const NS_OPEN_PANEL_UNAVAILABLE_MARKER = 'unexpected NULL returned from +[NSOpenPanel openPanel]'

export class NativeFolderPickerBlockedError extends Error {
  constructor(message = RESTART_REQUIRED_FOLDER_PICKER_MESSAGE) {
    super(message)
    this.name = 'NativeFolderPickerBlockedError'
  }
}

export function isNativeFolderPickerBlockedError(
  error: unknown,
): error is NativeFolderPickerBlockedError {
  return error instanceof NativeFolderPickerBlockedError
}

function isUnavailableNativeFolderPicker(error: unknown): boolean {
  return errorMessageIncludes(error, NS_OPEN_PANEL_UNAVAILABLE_MARKER)
}

export function formatFolderPickerActionError(
  action: string,
  error: unknown,
): string {
  if (isNativeFolderPickerBlockedError(error)) {
    return error.message
  }

  const message = errorMessage(error, '')

  return message ? `${action}: ${message}` : action
}

// Native paths are kept byte-for-byte (a folder name may end in a space); only file URLs are decoded.
function normalizeDialogPath(value: string): string | null {
  if (!value) return null
  if (!value.startsWith('file://')) return value

  try {
    const parsed = new URL(value)
    if (parsed.protocol !== 'file:') return value

    const decodedPath = decodeURIComponent(parsed.pathname)
    if (parsed.hostname) return `//${parsed.hostname}${decodedPath}`
    if (/^\/[A-Za-z]:/.test(decodedPath)) return decodedPath.slice(1)
    return decodedPath
  } catch {
    return value
  }
}

export function normalizeDialogPaths(selected: string | string[] | null): string[] {
  if (!selected) return []
  const items = Array.isArray(selected) ? selected : [selected]
  return items
    .filter((item): item is string => typeof item === 'string')
    .map(normalizeDialogPath)
    .filter((item): item is string => item !== null)
}

let folderPickerRequestInFlight = false

async function pickNativeFolder(title?: string): Promise<string | null> {
  if (isRestartRequiredAfterUpdate()) {
    throw new NativeFolderPickerBlockedError()
  }

  try {
    const { open } = await import('@tauri-apps/plugin-dialog')
    const selected = await open({
      directory: true,
      multiple: false,
      title: title ?? 'Select folder',
    })
    return normalizeDialogPaths(selected)[0] ?? null
  } catch (error) {
    if (isUnavailableNativeFolderPicker(error)) {
      markRestartRequiredAfterUpdate()
      throw new NativeFolderPickerBlockedError()
    }
    throw error
  }
}

/**
 * Opens a native folder picker dialog (Tauri) or falls back to prompt (browser).
 * Returns the selected folder path, or null if the user cancelled.
 */
export const pickFolder = async (title?: string): Promise<string | null> => {
  if (folderPickerRequestInFlight) return null

  folderPickerRequestInFlight = true
  try {
    if (isTauri()) {
      return await pickNativeFolder(title)
    }
    return normalizeDialogPaths(prompt(title ?? 'Enter folder path:'))[0] ?? null
  } finally {
    folderPickerRequestInFlight = false
  }
}
