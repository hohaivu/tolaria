---
type: Note
_organized: true
---

# AI chat image attachments

The AI chat image attachment domain lets a user send up to four images with a message to a local CLI agent. The app stores each image inside the vault, and the agent reads the file from its path. This domain covers the composer, the staging files, the prompt contract, the vision gate, the cleanup, and the analytics.

## Terms

- **Staged image**: a copy of a user image in the vault folder `<vault>/.tolaria/tmp/`. The name has the form `<millis>-<name>`.
- **Draft image**: a staged image that the composer holds before send.
- **Message image**: a staged image that a sent user message keeps.
- **Vision gate**: the check that blocks a send when the target cannot read an image path.

## Entry points

| Entry point | Code | Notes |
| --- | --- | --- |
| Paste | `src/components/InlineWikilinkInput.tsx` (`handlePaste`) | Image files go to `onAttachImages`. Other unsupported payloads show a toast. |
| Drop (DOM) | `InlineWikilinkInput.tsx` (`handleDrop`) | Image files go to `onAttachImages`. |
| Drop (native path) | `InlineWikilinkInput.tsx` (`insertNativePathDrop`) | Image paths go to `onAttachImages`. Other paths insert as text. |
| Paperclip button | `src/components/AiPanelChrome.tsx` (`ComposerAttachButton`) | Opens the Tauri file picker. |
| Composer hook | `src/components/useAiComposerImages.ts` | Owns the draft list, staging, and removal. |

`AiPanelComposer` in `src/components/AiPanelChrome.tsx` serves both the AI panel and the AI workspace window. The command palette AI mode does not pass `onAttachImages`. It keeps the text-only paste and drop behaviour.

## Flows and states

1. The user adds an image through paste, drop, or the paperclip.
2. The frontend checks the MIME type and the size. Then it calls a staging command.
3. The Rust side writes the file and returns its absolute path. The composer shows a thumbnail.
4. The user sends the message. The request carries the paths in `attachments`.
5. The Rust side appends the paths to the prompt. The message keeps the paths.
6. The bubble shows the thumbnails. A click opens `ImageLightbox`.

A message with images has one of these outcomes:

- **Sent**: the composer clears its draft list. The files stay on disk for the message.
- **Blocked by the vision gate**: the composer keeps the draft images. A toast names the target.
- **Failed to stage**: a toast explains the reason.

## Limits and checks

- Each message takes at most 4 images. Reason: the owner chose this limit.
- Each image takes at most 15 MiB. Reason: the owner chose this limit.
- Allowed types are PNG, JPEG, GIF, and WebP. Reason: the owner chose these types.
- HEIC and HEIF are rejected on the client. Reason: the owner chose to reject them, as the note drop does.
- The Rust side checks the extension and the size again. Reason: the command accepts data from the renderer.
- Rejected files never reach staging. The app shows a toast and never drops a file silently. Reason: the owner chose visible rejection.

## Storage

- `src-tauri/src/ai_chat_images.rs` writes staged images to `<vault>/.tolaria/tmp/`. Reason: the vault scan and search skip folders that start with `.`, so staged files do not appear as notes.
- The module adds `.tolaria/` to `.git/info/exclude` once. It acts only when `.git` is a directory. Reason: the owner chose a local exclude, so the user `.gitignore` stays unchanged.
- The module never writes `.gitignore`. Reason: the user owns that file.
- The module deletes files only when they are direct children of the canonical tmp folder. Reason: not stated in the code.

## Prompt contract

- `AiAgentStreamRequest` has an `attachments` field. Old callers that omit it get an empty list. Reason: the field uses `#[serde(default)]`.
- `prepare_attachments()` in `src-tauri/src/ai_agents.rs` validates each path. It checks that each path is inside the tmp folder.
- `append_attachments_to_message` adds an "Attached images" block to the message text. It runs before the agent adapter starts.
- The append step is idempotent. Reason: not stated in the code.
- No CLI image flag changes. Reason: the design chose one path in the prompt for all eight agents.

## Vision gate

- `canTargetReadImagePaths` in `src/lib/aiAgentSession.ts` returns false for API-model targets.
- The same function returns the agent flag `readsImagePaths` for CLI agents. All eight CLI agents set the flag to true.
- A blocked send does not reach `streamAiAgent`. The toast `ai.panel.images.unsupported` names the target.
- The analytics event `ai_agent_message_blocked` carries the reason `images_unsupported`.
- Reason for the API-model rule: the only tool for API models is `create_note`, so the model cannot read a path.

## Lifecycle and cleanup

| Event | Action | Code |
| --- | --- | --- |
| App start (main window) | Clears the tmp folder once for each vault path in the run | `clearAiChatImagesOnceForVault` in `src/App.tsx` |
| Workspace window | Never clears the tmp folder | `src/App.tsx` skips the call when `noteWindowParams` is set |
| Draft image removed | Deletes that file | `useAiComposerImages.removeImage` |
| New chat | Deletes the message images and the draft images | `useAiPanelController` (`handleNewChat`) |
| Conversation closed | Deletes its message and draft images, except paths that other open sessions still use | `cleanupClosedConversationImages` in `src/lib/aiChatImages.ts` |

- Reason for the startup clear: staged files do not outlive the app run.
- Reason for keeping shared paths: a path can appear in more than one open session.
- A missing file renders a placeholder in the bubble. Reason: a restart clears the files, but sessions keep the paths.

## Sessions and persistence

- Sessions store paths only. No base64 data and no file bytes enter a session. Reason: the design chose paths only.
- `AiAgentMessage.images` and `PendingUserPrompt.images` hold the paths.

## Analytics

- `ai_agent_message_sent` carries `image_count`. The value is 0 when no image is sent.
- `ai_agent_message_blocked` carries the reason `images_unsupported`.
- The events carry counts only. They never carry paths or file names. Reason: ADR 0101 forbids paths and file names in product analytics.

## Copy

- All copy comes from keys under `ai.panel.images.*` and `ai.panel.unsupportedPaste` in `src/lib/locales/en.json`.
- The paste message moved from a constant in `InlineWikilinkInput.tsx` to `en.json`.

## Related decisions

- [ADR 0308](../adr/0308-ai-chat-image-temp-folder.md): in-vault tmp folder and local git exclude.
- [ADR 0092](../adr/0092-vault-ai-agent-permission-modes.md): agents run from the vault folder, so the tmp folder stays in their working directory.
- [ADR 0101](../adr/0101-categorical-product-analytics-events.md): categorical analytics only.

## Open questions

- Agent path reads are not confirmed by a real run. The manual smoke in `pnpm tauri dev` has not run for all eight agents. Each agent may treat `.tolaria/` as hidden when it searches. A direct path read should still work.
- The thumbnail load from `.tolaria/tmp` through the asset protocol is not confirmed in `pnpm tauri dev`. The bubble and strip show a placeholder when a load fails.
- API-model targets with vision cannot receive images. Base64 image content for API models is a follow-up.
