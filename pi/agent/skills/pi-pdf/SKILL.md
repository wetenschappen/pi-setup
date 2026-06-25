---
name: pi-pdf
description: Local PDF extraction for math textbooks and structured documents. Extracts text as Markdown, converts pages to LLM-optimized images, searches content, and reports metadata. Includes auto-batching, smart truncation, and temp cleanup.
---

# Pi PDF Tools

Single `pdf` tool with four actions: `read` (default), `info`, `text`, `images`.

**IMPORTANT RULE**: NEVER try to use bash tools like `pdftotext`, `pdfgrep`, or `grep` to extract or search text from PDFs. Always use this extension or its Python backend.

## Searching PDFs

The `pdf` tool itself does not have a search action. To search for a string across one or multiple PDFs, you **MUST** use the Python backend directly in a bash command. 
**CRITICAL**: You must use the virtual environment's python executable (`~/.pi-pdf-venv/bin/python3`), NOT the system `python3`:

```bash
~/.pi-pdf-venv/bin/python3 ~/.pi-pdf-venv/pdf_tools.py search "path/to/file.pdf" "query"
```
*Note: You can run this in a `for` loop to search multiple files.*

## Important: File Path Resolution

**When users type `@` in the TUI**, they get a file picker menu. The selected item is passed with an `@` prefix (e.g., `@wisk-methodes/`). The PDF tool automatically resolves these references to actual filesystem paths.

**Always use the path as received from the user.** The tool handles `@`-prefix resolution internally.

### Path Examples

| User types | Tool receives | Resolves to |
|------------|---------------|-------------|
| `@wisk-methodes/` | `@wisk-methodes/` | `/home/user/wisk-methodes/` |
| `./docs/textbook.pdf` | `./docs/textbook.pdf` | `/home/user/docs/textbook.pdf` |
| `/absolute/path/file.pdf` | `/absolute/path/file.pdf` | `/absolute/path/file.pdf` |

### Finding Files

If you receive a directory reference (like `@folder/`), first list the contents to find PDF files:

```bash
ls "@folder/"           # List directory contents
find . -name "*.pdf"     # Find all PDFs in current directory
```

Then use the full path to the PDF file in your `pdf()` calls.

## Usage

```typescript
// 1. Smart Read (Recommended Default)
pdf(action="read", file="physics.pdf") 
// Automatically detects size and returns the right mix of text/images/overview without hitting limits.

// 2. Explicit Actions (Advanced)
pdf(action="info",   file="physics.pdf")
pdf(action="text",   file="physics.pdf", pages="1-10")
pdf(action="images", file="physics.pdf", pages="1-10")
```

## Features

| Feature | What it does |
|---------|-------------|
| **Auto-batching** | Images grouped in batches of 8 to stay within provider limits |
| **Smart truncation** | Text >25K chars shows summary + first chunk; request narrower pages for more |
| **Temp cleanup** | Temp dirs deleted automatically on session shutdown |
| **Provider-aware sizing** | Use `max_dim` param to tune image size per provider (default: 1024px) |
| **Token estimates** | Always shown so you can budget context usage |
| **Path resolution** | Handles `@`-prefix file picker references automatically |
| **File discovery** | When given a directory, suggests available PDF files |

## Technical Reference

For implementation details, architecture, and troubleshooting see:
`~/.pi/agent/extensions/pdf-tools/TECHNICAL.md`

Key files:
- `~/.pi-pdf-venv/pdf_tools.py` — Python backend (info, text, images, search)
- `~/.pi/agent/extensions/pdf-tools/index.ts` — TypeScript extension
- `~/.pi/agent/extensions/pdf-tools/TECHNICAL.md` — Full technical docs
