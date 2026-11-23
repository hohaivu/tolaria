const HEIC_EXTENSIONS = new Set(['heic', 'heif'])

export function filenameFromPath(path: string): string {
  return path.split(/[\\/]/u).pop() || path
}

export function extensionFromFilename(filenameOrPath: string): string {
  const base = filenameFromPath(filenameOrPath)
  const dotIndex = base.lastIndexOf('.')
  if (dotIndex <= 0 || dotIndex === base.length - 1) return ''
  return base.slice(dotIndex + 1).toLowerCase()
}

export function isHeicFilename(filenameOrPath: string): boolean {
  return HEIC_EXTENSIONS.has(extensionFromFilename(filenameOrPath))
}
