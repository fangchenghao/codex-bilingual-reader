# Changelog

## 1.5.0 - 2026-10-21

- Add macOS/Linux support for the preserved-layout PDF workflow. One-click setup now runs `scripts/install-preserved-pdf-runtime.sh`, which provisions a Python 3.10-3.13 virtualenv (via `uv` when available) and installs the pinned `pdf2zh_next` 2.9.0 / `BabelDOC` 0.6.2 engine stack.
- Introduce `scripts/pdf-runtime-paths.mjs`, a shared module that resolves portable, virtualenv, and custom runtime layouts on every platform and normalises proxy/`HF_ENDPOINT` defaults.
- Keep the real `HOME` on macOS/Linux so BabelDOC reuses `~/.cache/babeldoc` instead of re-downloading its ~340 MB layout model and fonts on every run.
- Detect the engine, `pdftoppm`, `pdftotext`, and LibreOffice in their native macOS locations (`/opt/homebrew/bin`, `/Applications/LibreOffice.app`), and lower the default worker count on Apple Silicon.
- Reduce the default inner-margin trim to the actual blank gutter: dual PDFs are measured pixel by pixel so the compaction step can never clip the first character of a translated line.
- Make the path placeholders and installer copy platform neutral, add a macOS GitHub Actions job, and make `npm test` work on systems without a bare `python` executable.

## 1.4.6 - 2026-10-20

- Support Zotero 10: raise `strict_max_version` from `9.*` to `10.*` so the add-on installs and stays enabled on Zotero 10.0.x.
- Verified against Zotero 10.0.6 (Gecko 140): bootstrap startup, preference-pane registration and item-pane/custom-section hooks load without errors.
- Checked for API drift against the Zotero 10.0.6 source; `PreferencePanes`, `ItemPaneManager`, `Reader.open`, `Reader._readers`, `FullText`, `Attachments`, `ProgressWindow` and the `menu_ToolsPopup` / `zotero-itemmenu` anchors are unchanged.

## 1.3.71 - 2026-08-17

- Generate selectable preserved-layout English/Chinese PDFs and import them into Zotero.
- Translate with local Codex CLI or OpenAI-compatible APIs including OpenAI and DeepSeek.
- Batch selected papers with running and waiting task states, cancellation, checkpoints, and resumable translation.
- Track page/fragment progress, elapsed time, actual API token usage, and configurable cost.
- Add Zotero Tools, context-menu, and right-pane integrations with bilingual-PDF preview and center-gap adjustment.
