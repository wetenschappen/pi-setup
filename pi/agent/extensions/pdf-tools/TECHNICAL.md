# PDF Tool — Technical Documentation

> **File:** `~/.pi/agent/extensions/pdf-tools/index.ts`  
> **Backend:** `~/.pi-pdf-venv/pdf_tools.py`  
> **Skill:** `~/.pi/agent/skills/pi-pdf/SKILL.md`

---

## Architecture Overview

```
┌─────────────────────────────────────────────────┐
│                  Pi Agent (LLM)                  │
│  Calls: pdf(file="doc.pdf")                     │
└───────────────┬─────────────────────┬───────────┘
                │                     │
                ▼                     ▼
┌───────────────────────┐   ┌──────────────────────┐
│  TypeScript Extension │──▶│ Python Backend        │
│  ~/.pi/agent/         │   │ ~/.pi-pdf-venv/       │
│  extensions/pdf-tools │◀──│ pdf_tools.py          │
│  /index.ts            │   │                      │
│                       │   │ pymupdf + pymupdf4llm │
│  Guards / batches /   │   │                      │
│  truncates / cleans   │   │ CLI interface via     │
│                       │   │ execSync()            │
└───────────────────────┘   └──────────────────────┘
```

**Data flow:**

1. LLM emits `pdf(file="textbook.pdf")` (or with explicit `action`, `pages`, etc.)
2. Pi extension framework validates parameters against TypeBox schema
3. `execute()` is called — the TypeScript handler
4. Handler calls the Python backend via `execSync()`, passing JSON args
5. Python returns JSON via stdout
6. TypeScript handler post-processes (batches images, truncates text, formats output)
7. Result returned as `{ content: [{ type: "text", text: "..." }], details: {...} }`
8. `renderResult()` formats a one-line TUI summary; `renderCall()` shows the call

---

## Key Design Decisions

### Why TypeScript + Python hybrid?

| Layer | Language | Reason |
|-------|----------|--------|
| Tool registration, rendering, guardrails | TypeScript | Must run in Pi's Node.js extension runtime |
| Heavy lifting (PDF parsing, rendering) | Python | `pymupdf` / `pymupdf4llm` are mature, fast, handle tables natively |

Communication: `execSync()` with JSON over stdin/stdout. A Python venv at `~/.pi-pdf-venv/` keeps dependencies isolated.

### Why 1024px as default max image dimension?

LLM vision providers (Claude, Gemini, etc.) price images by tile size (typically 768×768 or 512×512 tiles). A 1024px edge produces at most 2 tiles. Higher values (1568px) caused "Multimodal data corrupted" errors on some providers. 1024px balances legibility with provider compatibility.

### Why batch size 8?

One provider enforced "At most 8 image(s) per prompt". Grouping into batches of 8 guarantees compatibility. This is configurable via `BATCH_SIZE` in the extension.

### Why JPEG at quality 85?

JPEG at Q85 gives ~200-300KB per page vs 500-800KB for PNG at similar dimensions. The visual quality loss is negligible for textbook content. Smaller files = fewer tokens at tile-based providers.

---

## Python Backend (`pdf_tools.py`)

### Commands

| Command | Args | Returns |
|---------|------|---------|
| `info <file>` | — | `{file, pages, title, author, subject, format}` |
| `text <file> [pages] [--no-tables]` | pages: `"1-5"`, `"1,3,7"`, `"all"` | `{text, chars, tokens_estimated}` |
| `images <file> <pages> [--dpi N] [--max-dim N]` | required: pages | `{temp_dir, images: [{page, path, width, height, size_bytes}], count}` |
| `search <file> <query>` | query string | `{query, matches, results: [{page, context}]}` |

### Key functions

#### `parse_pages(spec, total_pages)`
Parses `"1-5"`, `"1,3,7"`, `"all"` → list of 0-indexed ints. Returns `None` for "all" so downstream can pass to pymupdf4llm natively.

#### `info(pdf_path)`
Uses `pymupdf.open()` → reads metadata dictionary + `page_count` + first page dimensions. Closes doc promptly.

#### `to_text(pdf_path, pages, no_tables)`
Uses `pymupdf4llm.to_markdown()` which:
- Preserves table structure as Markdown tables
- Extracts headings, lists, paragraphs
- Skips images (renders as `**==> picture omitted` markers)
- Returns flat Markdown string

Token estimate: `len(text) // 4` (rough: ~4 chars per token in typical textbook text).

#### `to_images(pdf_path, pages, dpi=150, max_dim=1024)`
1. Opens document, parses page list
2. Creates temp dir at `/tmp/pi_pdf_XXXXXX/`
3. For each page:
   - Calculates scale: `dpi / 72` × `max_dim` cap
   - Renders with `pymupdf.Matrix(scale, scale)`
   - Saves as `page_0001.jpg` with `jpg_quality=85`
4. Returns paths + dimensions + byte sizes

#### `search_text(pdf_path, query)`
Simple substring search in `page.get_text()`. Returns context (60 chars before/after match). Case-insensitive.

### Dependencies

- `pymupdf` (v1.25+): PyMuPDF, handles PDF I/O, rendering, text extraction
- `pymupdf4llm`: Higher-level Markdown extraction with table preservation

Install:
```bash
python3 -m venv ~/.pi-pdf-venv
~/.pi-pdf-venv/bin/pip install pymupdf4llm pymupdf
```

---

## TypeScript Extension (`index.ts`)

### Tool Schema

```typescript
parameters: Type.Object({
  action: Type.Optional(Type.Union([
    Type.Literal("read"),    // default — smart auto-detect
    Type.Literal("info"),    // metadata
    Type.Literal("text"),    // Markdown extraction
    Type.Literal("images"),  // JPEG conversion
  ])),
  file:     Type.String(),
  pages:    Type.Optional(Type.String()),
  dpi:      Type.Optional(Type.Number()),
  max_dim:  Type.Optional(Type.Number()),
})
```

### Lifecycle hooks

| Hook | Purpose |
|------|---------|
| `session_start` | Notifies user "PDF tool ready" |
| `session_shutdown` | Cleans up `/tmp/pi_pdf_*` temp dirs |

### Smart Read Strategy

The `smartRead()` function implements three strategies based on page count:

```
smartRead(file)
  │
  ├─ meta = info(file)
  │
  ├─ total ≤ 5  → "full" strategy
  │    text = to_text("all")
  │    images = to_images("all")
  │    return { strategy: "full", text, images, ... }
  │
  ├─ total ≤ 30 → "medium" strategy  
  │    text = to_text("all")
  │    Scan text for "==> picture" markers → imagePages[]
  │    Truncate if >25K chars
  │    return { strategy: "medium", text, imagePages, ... }
  │
  └─ total > 30 → "large" strategy
       text = to_text("1-3")  // overview only
       return { strategy: "large", overview, ... }
```

### Image auto-batching

When `action="images"` or `action="read"` produces images, the extension groups them:

```
BATCH_SIZE = 8

for (i = 0; i < images.length; i += BATCH_SIZE) {
  batch = images.slice(i, i + BATCH_SIZE)
  lines.push(`Batch ${n}/${total}: pages ${nums} (${kb}KB)`)
  for (img of batch) {
    lines.push(`  p${img.page}: ${img.path}`)
  }
}
```

The output tells the LLM exactly which files to `read()`. If there are multiple batches, only one batch at a time should be loaded to stay within the provider's 8-image limit.

### Text truncation guard

```typescript
const MAX_LARGE_TEXT_CHARS = 25000  // ~6K tokens
```

When extracted text exceeds this, the extension returns a truncated version with a banner:

```
36,100 chars (~9,025 tokens) • pages: all

**Text truncated.** Showing first 25K of 36K chars.
Request a narrower page range for the rest.
---
(actual content starts here)
```

This prevents accidentally flooding the LLM context with an entire textbook.

### TUI rendering

| Element | Behavior |
|---------|----------|
| `renderCall` | `● PDF(filename, read)` — green bullet |
| `renderResult` (collapsed) | One-line summary: `  └─ 66 pages, large PDF` / `  └─ 12 pages in 2 batches` |
| `renderResult` (expanded) | Shows first 30 lines of content / all image paths per batch |
| Progress | `  └─ reading…` during execution |

### Temp file cleanup

All temp directories created by the Python backend are tracked in a Set:

```typescript
const tempDirs: Set<string> = new Set();
// On each images call: tempDirs.add(result.temp_dir)
// On session_shutdown: rmSync(dir, { recursive: true, force: true })
```

---

## Usage Patterns

### Default (recommended)

```typescript
pdf(file="textbook.pdf")
// Smart auto-detect: full / medium / large strategy
```

### Explicit actions (advanced)

```typescript
pdf(action="info",   file="textbook.pdf")
pdf(action="text",   file="textbook.pdf", pages="10-20")
pdf(action="images", file="textbook.pdf", pages="10-20")
pdf(action="images", file="textbook.pdf", pages="1-8", dpi=200, max_dim=768)
```

### Search across PDFs

```typescript
// Not a direct tool action — use the Python backend:
python3 ~/.pi-pdf-venv/pdf_tools.py search file.pdf "query"
```

---

## Provider Compatibility

| Constraint | Where enforced | Value |
|------------|---------------|-------|
| Max images per prompt | Extension (batching) | 8 (BATCH_SIZE) |
| Max image dimension | Backend + extension default | 1024px (max_dim) |
| Image format | Backend | JPEG, quality 85 |
| Text truncation | Extension | 25K chars (~6K tokens) |

To tune for a specific provider, adjust in `index.ts`:

```typescript
const BATCH_SIZE = 8;           // Some providers: 5, 10, 20
const MAX_LARGE_TEXT_CHARS = 25000; // Reduce for smaller context models
```

For per-request overrides, use explicit params:

```typescript
pdf(action="images", file="doc.pdf", pages="1-5", max_dim=768)
// Smaller images for stricter providers
```

---

## Troubleshooting

### TUI freezes during processing

**Fixed:** The tool now uses async execution (`execAsync`) instead of synchronous `execSync`. This prevents the TUI from freezing while Python processes PDFs.

Progress updates are now shown via `onUpdate`:
- `  └─ Fetching metadata...`
- `  └─ Extracting text...`
- `  └─ Converting pages to images...`

### "Python venv not found"
```bash
python3 -m venv ~/.pi-pdf-venv
~/.pi-pdf-venv/bin/pip install pymupdf4llm pymupdf
```

### "File not found" with @ prefix
When users select a file/folder using the `@` file picker, they see `@foldername/` in the input. The tool now automatically resolves these references:

1. Strips the `@` prefix
2. Resolves relative to current working directory
3. Searches for similar directory names if exact match not found
4. Provides helpful error with available PDF files if resolution fails

**For the LLM:** Always use the path as received from the user. The tool handles resolution internally. If you receive a directory reference, list its contents first to find PDF files.

### "Multimodal data corrupted"
The generated images are too large for the provider. Either:
- Reduce `max_dim` (try 768 or 512)
- Reduce `dpi` (try 100)
- The provider may not support image input at all (check models.json)

### "At most 8 image(s) per prompt"
The extension auto-batches, but the LLM may try to `read()` more than 8 images at once. The batch output tells the LLM which 8 to read together.

### Images appear blank or wrong
Some PDFs use embedded fonts that don't render to pixmaps correctly. Try the text extraction instead. If diagrams are critical, the image route is the only option.

### Text has garbled characters
pymupdf4llm handles most standard fonts. For unusual embedded fonts, try `--no-tables` flag:

```typescript
// Not exposed via extension — call backend directly:
python3 ~/.pi-pdf-venv/pdf_tools.py text file.pdf all --no-tables
```

### Temp files accumulating
Shouldn't happen — `session_shutdown` hook cleans up. If Pi crashes, check `/tmp/pi_pdf_*` and remove manually:

```bash
rm -rf /tmp/pi_pdf_*
```

## Path Resolution Algorithm

When the `file` parameter is received:

1. **Absolute path**: If it starts with `/` and exists, use it directly
2. **@-prefix reference**: 
   - Strip the `@` prefix
   - Try resolving against: cwd, cwd without trailing slash, explicit `./`, and `~/`
   - If not found, search for similar directory names in cwd (case-insensitive)
   - Return best guess (will fail later with clear error if invalid)
3. **Relative path**: Resolve against current working directory

This allows seamless handling of:
- `@wisk-methodes/` → `/home/user/wisk-methodes/`
- `@docs/textbook.pdf` → `/home/user/docs/textbook.pdf`
- `./relative/path.pdf` → `/absolute/path/relative/path.pdf`
- `/absolute/path.pdf` → `/absolute/path.pdf`

---

## File Locations

| File | Purpose |
|------|---------|
| `~/.pi-pdf-venv/pdf_tools.py` | Python backend (4 commands: info, text, images, search) |
| `~/.pi-pdf-venv/bin/python3` | Python venv interpreter |
| `~/.pi/agent/extensions/pdf-tools/index.ts` | TypeScript extension (registers `pdf` tool) |
| `~/.pi/agent/skills/pi-pdf/SKILL.md` | Skill documentation (usage guide for LLM) |
| `~/.pi/agent/extensions/pi-custom.ts` | Optional: custom tool rendering (wraps `pi.registerTool`) |
| `/tmp/pi_pdf_*` | Temp image files (auto-cleaned on session end) |
