---
type: ADR
id: "0308"
title: "AI chat images staged in a vault temp folder"
status: active
date: 2026-11-23
---

## Context
Users attach images to AI agent messages. CLI agents read a file path from the prompt and run from the vault folder (ADR 0092). The copies must not reach git or the notes list.

## Decision
Stage images in `<vault>/.tolaria/tmp/`. Add `.tolaria/` to `.git/info/exclude` when the vault has a `.git` directory. Never edit `.gitignore`. Clear the folder at main-window start. Delete a conversation's files when it closes or resets. The copies stay local: git ignores them and a restart clears them.

## Consequence
- Agents read images inside their working folder, and the vault scan skips dot-folders, so staged files stay out of the notes list.
- A restart clears the files. Old bubbles show a placeholder.
- API models get no image paths: their only tool is `create_note`, so they cannot read a file. Base64 for API models is a follow-up.
- Rejected: `attachments/` (tracked by git) and OS temp (outside the agent folder).
