import { describe, expect, it } from 'vitest'
import { extensionFromFilename, filenameFromPath, isHeicFilename } from './imageFilenames'

describe('imageFilenames', () => {
  it('reads the basename from POSIX and Windows paths', () => {
    expect(filenameFromPath('/Users/a/shot.png')).toBe('shot.png')
    expect(filenameFromPath('C:\\pics\\shot.PNG')).toBe('shot.PNG')
  })

  it('lowercases the extension and ignores names without one', () => {
    expect(extensionFromFilename('/a/Shot.JPG')).toBe('jpg')
    expect(extensionFromFilename('png')).toBe('')
    expect(extensionFromFilename('.png')).toBe('')
    expect(extensionFromFilename('shot.')).toBe('')
  })

  it('recognises HEIC and HEIF names', () => {
    expect(isHeicFilename('IMG_1.HEIC')).toBe(true)
    expect(isHeicFilename('/a/IMG_1.heif')).toBe(true)
    expect(isHeicFilename('IMG_1.png')).toBe(false)
  })
})
