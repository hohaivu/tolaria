import { useCallback, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import type { VaultEntry } from '../types'
import type { NoteReference } from '../utils/ai-context'
import { buildTypeEntryMap } from '../utils/typeColors'
import { deleteInlineSelection, replaceInlineSelection, selectedInlineText } from './inlineWikilinkEdits'
import {
  buildInlineWikilinkSegments,
  extractInlineWikilinkReferences,
  findActiveWikilinkQuery,
} from './inlineWikilinkText'
import { extractDroppedPathText, formatDroppedPathList } from './inlineWikilinkDropText'
import { readSelectionRange, serializeInlineNode, type InlineSelectionRange } from './inlineWikilinkDom'
import {
  buildPendingPasteState,
  type PendingPasteState,
  shouldRecoverPendingPaste,
} from './inlineWikilinkPasteRecovery'
import { InlineWikilinkEditorField, InlineWikilinkPaletteLayout } from './InlineWikilinkParts'
import { InlineWikilinkSuggestionMenu } from './InlineWikilinkSuggestionMenu'
import { handleInlineWikilinkKeyDown } from './inlineWikilinkKeydown'
import { useInlineWikilinkSelection } from './useInlineWikilinkSelection'
import { useInlineWikilinkSuggestionsState } from './useInlineWikilinkSuggestionsState'
import { normalizeInlineWikilinkValue } from './inlineWikilinkTokens'
import { isInsertBeforeInput, isPlainTextBeforeInput } from './inlineWikilinkBeforeInput'
import {
  collapseSelectionRange,
  fullSelectionRange,
  isCommandBackspaceShortcut,
  isCompositionKeyboardEvent,
  isLineBreakShortcut,
  isNativeCompositionBeforeInput,
  isSelectAllShortcut,
} from './inlineWikilinkInputEvents'
import {
  containsUnsupportedInlineContent,
  deleteToLineStart,
  extractClipboardFiles,
  hasUnsupportedClipboardPayload,
  submitInlineValue,
} from './inlineWikilinkInputOperations'
import { restorePendingRemountState } from './inlineWikilinkRemountState'
import { useNativePathDrop } from './useNativePathDrop'
import { translate, type AppLocale } from '../lib/i18n'
import {
  filenameFromPath,
  isImageAttachmentCandidateFile,
  isImageAttachmentCandidatePath,
  type AttachImagesPayload,
} from '../lib/aiChatImages'
import { createImageDropClaim } from '../utils/imageDropClaim'

interface InlineWikilinkInputProps {
  entries: VaultEntry[]
  value: string
  locale?: AppLocale
  onChange: (value: string) => void
  onSubmit?: (text: string, references: NoteReference[]) => void
  onAttachImages?: (payload: AttachImagesPayload) => void
  onUnsupportedPaste?: (message: string) => void
  submitOnEmpty?: boolean
  disabled?: boolean
  placeholder?: string
  placeholderClassName?: string
  inputRef?: React.RefObject<HTMLDivElement | null>
  dataTestId?: string
  editorClassName?: string
  editorStyle?: CSSProperties
  suggestionListVariant?: 'floating' | 'palette'
  suggestionEmptyLabel?: string
  paletteHeader?: ReactNode
  paletteEmptyState?: ReactNode
  paletteFooter?: ReactNode
}

const POST_COMPOSITION_TEXT_INPUT_SETTLE_MS = 120

function usePostCompositionTextInputSettle() {
  const isSettlingCompositionRef = useRef(false)
  const compositionSettleTimerRef = useRef<number | null>(null)
  const clearCompositionSettleWindow = useCallback(() => {
    isSettlingCompositionRef.current = false
    if (compositionSettleTimerRef.current === null) return

    window.clearTimeout(compositionSettleTimerRef.current)
    compositionSettleTimerRef.current = null
  }, [])
  const startCompositionSettleWindow = useCallback(
    (onSettled: () => void) => {
      clearCompositionSettleWindow()
      isSettlingCompositionRef.current = true
      compositionSettleTimerRef.current = window.setTimeout(() => {
        compositionSettleTimerRef.current = null
        onSettled()
      }, POST_COMPOSITION_TEXT_INPUT_SETTLE_MS)
    },
    [clearCompositionSettleWindow],
  )

  useLayoutEffect(() => () => clearCompositionSettleWindow(), [clearCompositionSettleWindow])

  return {
    clearCompositionSettleWindow,
    hasPendingCompositionFlush: () => compositionSettleTimerRef.current !== null,
    isSettlingCompositionRef,
    startCompositionSettleWindow,
  }
}

export function InlineWikilinkInput(options: InlineWikilinkInputProps) {
  const {
    entries,
    value,
    locale = 'en',
    onChange,
    onSubmit,
    onAttachImages,
    onUnsupportedPaste,
    submitOnEmpty = false,
    disabled = false,
    placeholder,
    placeholderClassName,
    inputRef,
    dataTestId = 'agent-input',
    editorClassName,
    editorStyle,
    suggestionListVariant = 'floating',
    suggestionEmptyLabel = 'No matching notes',
    paletteHeader,
    paletteEmptyState,
    paletteFooter,
  } = options
  const [renderVersion, forceRender] = useState(0)
  const isComposingRef = useRef(false)
  const segments = useMemo(() => buildInlineWikilinkSegments(value, entries), [entries, value])
  const typeEntryMap = useMemo(() => buildTypeEntryMap(entries), [entries])
  const {
    editorRef,
    selectionRange,
    selectionIndex,
    setSelectionRange,
    setCombinedRef,
    syncSelectionRange,
    focusSelectionRange,
  } = useInlineWikilinkSelection({
    value,
    onChange,
    inputRef,
    isComposingRef,
  })
  const pendingPasteRef = useRef<PendingPasteState | null>(null)
  const pendingCompositionInputRef = useRef(false)
  const handledFileDropRef = useRef(false)
  const dropClaimRef = useRef(createImageDropClaim())
  const pendingFocusAfterRemountRef = useRef<InlineSelectionRange | null>(null)
  const pendingScrollTopAfterRemountRef = useRef<number | null>(null)
  const {
    clearCompositionSettleWindow,
    hasPendingCompositionFlush,
    isSettlingCompositionRef,
    startCompositionSettleWindow,
  } = usePostCompositionTextInputSettle()
  useLayoutEffect(() => {
    void renderVersion
    restorePendingRemountState(
      editorRef.current,
      focusSelectionRange,
      pendingFocusAfterRemountRef,
      pendingScrollTopAfterRemountRef,
    )
  }, [editorRef, focusSelectionRange, renderVersion])
  const activeQuery = useMemo(
    () => (selectionRange.start === selectionRange.end ? findActiveWikilinkQuery(value, selectionIndex) : null),
    [selectionIndex, selectionRange.end, selectionRange.start, value],
  )
  const references = useMemo(() => extractInlineWikilinkReferences(value, entries), [entries, value])
  const { suggestions, selectedSuggestionIndex, setSuggestionIndex, selectSuggestion, cycleSuggestions } =
    useInlineWikilinkSuggestionsState({
      activeQueryKey: activeQuery ? `${activeQuery.start}:${activeQuery.query}` : '',
      entries,
      query: activeQuery?.query ?? null,
      value,
      selectionIndex,
      onChange,
      onSelectionIndexChange: (nextSelectionIndex) => setSelectionRange(collapseSelectionRange(nextSelectionIndex)),
      focusSelectionAt: (nextSelectionIndex) => focusSelectionRange(collapseSelectionRange(nextSelectionIndex)),
    })
  const insertTransferText = useCallback(
    (text: string, focusAfterInsert = false) => {
      const editor = editorRef.current
      const currentSelectionRange = editor && !focusAfterInsert ? readSelectionRange(editor) : selectionRange
      const nextState = replaceInlineSelection(value, currentSelectionRange, text)
      const shouldRestoreFocus = focusAfterInsert || document.activeElement === editor

      onChange(nextState.value)
      setSelectionRange(nextState.selection)
      pendingFocusAfterRemountRef.current = shouldRestoreFocus ? nextState.selection : null
      pendingScrollTopAfterRemountRef.current = editor?.scrollTop ?? null
      forceRender((current) => current + 1)
    },
    [editorRef, onChange, selectionRange, setSelectionRange, value],
  )
  const insertNativePathDrop = (paths: string[]) => {
    if (onAttachImages) {
      const imagePaths = paths.filter(isImageAttachmentCandidatePath)
      const nonImagePaths = paths.filter((path) => !isImageAttachmentCandidatePath(path))
      if (imagePaths.length > 0 && dropClaimRef.current.claim({
        channel: 'native',
        filenames: imagePaths.map(filenameFromPath),
      })) {
        onAttachImages({ paths: imagePaths })
      }
      const droppedPathText = formatDroppedPathList(nonImagePaths)
      if (droppedPathText) insertTransferText(droppedPathText, true)
      return
    }

    const droppedPathText = formatDroppedPathList(paths)
    if (!droppedPathText) return

    insertTransferText(droppedPathText, true)
  }
  useNativePathDrop({
    targetRef: editorRef,
    disabled,
    onPathDrop: insertNativePathDrop,
  })
  const notifyUnsupportedPaste = useCallback(
    () => onUnsupportedPaste?.(translate(locale, 'ai.panel.unsupportedPaste')),
    [locale, onUnsupportedPaste],
  )
  const recoverUnsupportedMutation = () => {
    pendingCompositionInputRef.current = false
    pendingPasteRef.current = null
    notifyUnsupportedPaste()
    forceRender((current) => current + 1)
    setSelectionRange({ ...selectionRange })
  }
  const deleteContent = (direction: 'backward' | 'forward') => {
    const nextState = deleteInlineSelection(value, selectionRange, segments, direction)
    if (!nextState) return
    onChange(nextState.value)
    setSelectionRange(nextState.selection)
  }
  const deleteContentToLineStart = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!isCommandBackspaceShortcut(event)) return false
    if (isCompositionKeyboardEvent(event, isComposingRef.current)) return false

    const editor = editorRef.current
    const currentSelectionRange = editor ? readSelectionRange(editor) : selectionRange
    const nextState = deleteToLineStart(value, currentSelectionRange)

    event.preventDefault()
    event.stopPropagation()

    if (!nextState) return true

    onChange(nextState.value)
    setSelectionRange(nextState.selection)
    pendingFocusAfterRemountRef.current = nextState.selection
    forceRender((current) => current + 1)
    return true
  }
  const selectAllContent = () => {
    const nextSelection = fullSelectionRange(value)
    setSelectionRange(nextSelection)
    focusSelectionRange(nextSelection)
  }
  const cutSelectedContent = (event: React.ClipboardEvent<HTMLDivElement>) => {
    if (disabled) return

    const editor = editorRef.current
    const currentSelectionRange = editor ? readSelectionRange(editor) : selectionRange
    const selectedText = selectedInlineText(value, currentSelectionRange)
    if (!selectedText) return

    event.preventDefault()
    event.clipboardData.setData('text/plain', normalizeInlineWikilinkValue(selectedText))

    const nextState = deleteInlineSelection(value, currentSelectionRange, segments, 'backward')
    if (!nextState) return

    onChange(nextState.value)
    setSelectionRange(nextState.selection)
    pendingFocusAfterRemountRef.current = nextState.selection
    forceRender((current) => current + 1)
  }
  const handleBeforeInput = useCallback(
    (nativeEvent: InputEvent) => {
      if (disabled) return

      if (!isInsertBeforeInput(nativeEvent)) return

      if (
        isNativeCompositionBeforeInput(
          nativeEvent,
          isComposingRef.current,
          pendingCompositionInputRef.current,
          isSettlingCompositionRef.current,
        )
      )
        return

      if (nativeEvent.inputType === 'insertLineBreak') {
        nativeEvent.preventDefault()
        insertTransferText('\n')
        return
      }

      if (isPlainTextBeforeInput(nativeEvent)) {
        nativeEvent.preventDefault()
        insertTransferText(nativeEvent.data)
        return
      }

      const dataTransfer = nativeEvent.dataTransfer
      if (!dataTransfer || !hasUnsupportedClipboardPayload(dataTransfer)) return

      if (nativeEvent.inputType === 'insertFromDrop' && handledFileDropRef.current) {
        handledFileDropRef.current = false
        nativeEvent.preventDefault()
        return
      }

      if (nativeEvent.inputType === 'insertFromDrop') {
        const droppedPathText = extractDroppedPathText(dataTransfer)
        if (droppedPathText) {
          nativeEvent.preventDefault()
          insertTransferText(droppedPathText)
          return
        }
      }

      nativeEvent.preventDefault()
      notifyUnsupportedPaste()
    },
    [disabled, insertTransferText, isSettlingCompositionRef, notifyUnsupportedPaste],
  )
  useLayoutEffect(() => {
    void renderVersion
    const editor = editorRef.current
    if (!editor) return

    editor.addEventListener('beforeinput', handleBeforeInput as EventListener)
    return () => editor.removeEventListener('beforeinput', handleBeforeInput as EventListener)
  }, [editorRef, handleBeforeInput, renderVersion])
  const handleDragOver = (event: React.DragEvent<HTMLDivElement>) => {
    if (disabled || !onAttachImages) return
    if (hasUnsupportedClipboardPayload(event.dataTransfer)) {
      event.preventDefault()
    }
  }
  const handleDrop = (event: React.DragEvent<HTMLDivElement>) => {
    if (disabled) return
    if (!hasUnsupportedClipboardPayload(event.dataTransfer)) return

    if (onAttachImages) {
      const droppedFiles = Array.from(event.dataTransfer.files ?? [])
      const imageFiles = droppedFiles.filter(isImageAttachmentCandidateFile)
      if (imageFiles.length > 0) {
        handledFileDropRef.current = true
        event.preventDefault()
        if (dropClaimRef.current.claim({
          channel: 'dom',
          filenames: imageFiles.map((file) => file.name),
        })) {
          onAttachImages({ files: imageFiles })
        }
        return
      }
    }

    handledFileDropRef.current = true
    const droppedPathText = extractDroppedPathText(event.dataTransfer)
    event.preventDefault()

    if (!droppedPathText) {
      notifyUnsupportedPaste()
      return
    }

    insertTransferText(droppedPathText)
  }
  const handlePaste = (event: React.ClipboardEvent<HTMLDivElement>) => {
    if (disabled) return

    if (onAttachImages) {
      const pastedFiles = extractClipboardFiles(event.clipboardData)
      const hasImageItem = Array.from(event.clipboardData.items ?? []).some(
        (item) => item.type.startsWith('image/'),
      )
      if (pastedFiles.some(isImageAttachmentCandidateFile) || (hasImageItem && pastedFiles.length > 0)) {
        event.preventDefault()
        onAttachImages({ files: pastedFiles })
        return
      }
    }

    if (hasUnsupportedClipboardPayload(event.clipboardData)) {
      event.preventDefault()
      notifyUnsupportedPaste()
      return
    }

    const pastedText = normalizeInlineWikilinkValue(event.clipboardData.getData('text/plain'))
    if (!pastedText) return

    const nextState = replaceInlineSelection(value, selectionRange, pastedText)
    pendingPasteRef.current = buildPendingPasteState(value, selectionRange, pastedText)

    event.preventDefault()
    onChange(nextState.value)
    setSelectionRange(nextState.selection)
  }
  const syncValueFromEditor = () => {
    const editor = editorRef.current
    if (editor && containsUnsupportedInlineContent(editor)) {
      recoverUnsupportedMutation()
      return
    }

    const pendingPaste = pendingPasteRef.current
    if (editor && pendingPaste) {
      const nextValue = normalizeInlineWikilinkValue(serializeInlineNode(editor))
      pendingPasteRef.current = null

      if (shouldRecoverPendingPaste(nextValue, pendingPaste)) {
        onChange(pendingPaste.expectedValue)
        forceRender((current) => current + 1)
        setSelectionRange({ ...pendingPaste.expectedSelection })
        return
      }
    }

    if (!editor) return

    const nextValue = normalizeInlineWikilinkValue(serializeInlineNode(editor))
    const nextSelection = readSelectionRange(editor)
    const clampedSelection: InlineSelectionRange = {
      start: Math.min(nextSelection.start, nextValue.length),
      end: Math.min(nextSelection.end, nextValue.length),
    }

    const shouldRestoreFocus = document.activeElement === editor
    pendingFocusAfterRemountRef.current = shouldRestoreFocus ? clampedSelection : null
    onChange(nextValue)
    setSelectionRange(clampedSelection)
    forceRender((current) => current + 1)
  }
  const flushPendingCompositionInput = (compositionEditor?: HTMLDivElement | null) => {
    if (isComposingRef.current) return
    const hadPendingInput = pendingCompositionInputRef.current
    pendingCompositionInputRef.current = false

    const editor = compositionEditor ?? editorRef.current
    if (!editor) return

    if (containsUnsupportedInlineContent(editor)) {
      recoverUnsupportedMutation()
      return
    }

    const nextValue = normalizeInlineWikilinkValue(serializeInlineNode(editor))
    if (!hadPendingInput && nextValue === value) return

    const nextSelection = readSelectionRange(editor)
    const clampedSelection: InlineSelectionRange = {
      start: Math.min(nextSelection.start, nextValue.length),
      end: Math.min(nextSelection.end, nextValue.length),
    }
    const shouldRestoreFocus = document.activeElement === editor || document.activeElement === editorRef.current
    pendingFocusAfterRemountRef.current = shouldRestoreFocus ? clampedSelection : null
    onChange(nextValue)
    setSelectionRange(clampedSelection)
    forceRender((current) => current + 1)
  }
  const handleCompositionStart = () => {
    clearCompositionSettleWindow()
    isComposingRef.current = true
  }
  const handleCompositionUpdate = () => {
    isComposingRef.current = true
  }
  const handleCompositionEnd = (compositionEditor: HTMLDivElement) => {
    isComposingRef.current = false
    startCompositionSettleWindow(() => flushPendingCompositionInput(compositionEditor))
  }
  const handleInput = () => {
    if (disabled) return

    if (isComposingRef.current) {
      pendingCompositionInputRef.current = true
      return
    }

    if (isSettlingCompositionRef.current && hasPendingCompositionFlush()) {
      pendingCompositionInputRef.current = true
      return
    }

    clearCompositionSettleWindow()
    pendingCompositionInputRef.current = false
    syncValueFromEditor()
  }
  const submitValue = () => {
    const currentValue = editorRef.current
      ? normalizeInlineWikilinkValue(serializeInlineNode(editorRef.current))
      : value
    const currentReferences =
      currentValue === value ? references : extractInlineWikilinkReferences(currentValue, entries)

    submitInlineValue({
      onSubmit,
      submitOnEmpty,
      value: currentValue,
      references: currentReferences,
    })
  }
  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!disabled && isLineBreakShortcut(event, isComposingRef.current)) {
      event.preventDefault()
      insertTransferText('\n')
      return
    }

    if (isSelectAllShortcut(event)) {
      event.preventDefault()
      selectAllContent()
      return
    }

    if (!disabled && deleteContentToLineStart(event)) {
      return
    }

    handleInlineWikilinkKeyDown({
      event,
      disabled,
      isComposing: isComposingRef.current,
      suggestionsOpen: suggestions.length > 0,
      onCycleSuggestions: cycleSuggestions,
      onSelectSuggestion: () => selectSuggestion(selectedSuggestionIndex),
      onDeleteContent: deleteContent,
      canSubmit: onSubmit !== undefined,
      onSubmit: submitValue,
    })
  }
  const editor = (
    <InlineWikilinkEditorField
      key={renderVersion}
      value={value}
      placeholder={placeholder}
      disabled={disabled}
      inputRef={setCombinedRef}
      dataTestId={dataTestId}
      placeholderClassName={placeholderClassName}
      editorClassName={editorClassName}
      editorStyle={editorStyle}
      onCompositionEnd={handleCompositionEnd}
      onCompositionStart={handleCompositionStart}
      onCompositionUpdate={handleCompositionUpdate}
      onInput={handleInput}
      onKeyDown={handleKeyDown}
      onCut={cutSelectedContent}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
      onPaste={handlePaste}
      onSelectionChange={syncSelectionRange}
      segments={segments}
      typeEntryMap={typeEntryMap}
    />
  )
  const suggestionList = (
    <InlineWikilinkSuggestionMenu
      suggestions={suggestions}
      selectedSuggestionIndex={selectedSuggestionIndex}
      setSuggestionIndex={setSuggestionIndex}
      selectSuggestion={selectSuggestion}
      typeEntryMap={typeEntryMap}
      suggestionListVariant={suggestionListVariant}
      suggestionEmptyLabel={suggestionEmptyLabel}
    />
  )
  if (suggestionListVariant === 'palette') {
    return (
      <InlineWikilinkPaletteLayout
        header={paletteHeader}
        editor={editor}
        suggestionList={suggestionList}
        emptyState={paletteEmptyState}
        footer={paletteFooter}
      />
    )
  }
  return (
    <div className="relative">
      {editor}
      {suggestionList}
    </div>
  )
}
