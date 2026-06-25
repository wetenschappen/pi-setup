/**
 * PDF Tool Extension
 *
 * Single unified tool with a smart "read" action:
 *   pdf(action="read", file="textbook.pdf")
 *   → Auto-detects size, extracts text, identifies images, handles limits
 *
 * Manual actions still available for power users:
 *   pdf(action="info",   file="...")
 *   pdf(action="text",   file="...", pages="1-10")
 *   pdf(action="images", file="...", pages="1-10")
 *
 * Requires: pymupdf, pymupdf4llm (in ~/.pi-pdf-venv)
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Text } from "@earendil-works/pi-tui";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, rmSync, promises as fsPromises } from "node:fs";
import { homedir } from "node:os";
import { resolve, basename as pathBasename } from "node:path";

const execAsync = promisify(exec);

const VENV_PYTHON = `${homedir()}/.pi-pdf-venv/bin/python3`;
const SCRIPT_PATH = `${homedir()}/.pi-pdf-venv/pdf_tools.py`;
const BATCH_SIZE = 8;
const MAX_LARGE_TEXT_CHARS = 25000;

const tempDirs: Set<string> = new Set();
const tempFiles: Set<string> = new Set();

// ─── Helpers ─────────────────────────────────────────────

/**
 * Resolve a file path that might use @-prefix notation.
 * 
 * When users type @ in the TUI, they get a file picker menu.
 * The selected item might be passed as:
 *   - `@foldername/` (relative reference)
 *   - `@foldername/subfolder/file.pdf`
 *   - Or a proper absolute/relative path
 * 
 * This function resolves these to actual filesystem paths.
 */
function resolveFilePath(file: string, cwd: string): Promise<string> {
  return new Promise(async (resolvePromise) => {
    // If it's already an absolute path and exists, return it
    if (file.startsWith("/") && existsSync(file)) {
      return resolvePromise(file);
    }
  
    // Handle @-prefix references (file picker output)
    if (file.startsWith("@")) {
      const ref = file.slice(1); // Remove the @ prefix
      
      // Try resolving relative to cwd
      const candidates = [
        resolve(cwd, ref),           // ./ref
        resolve(cwd, ref.replace(/\/$/, "")),  // Without trailing slash
        resolve(cwd, "." + ref),    // ./ref (explicit)
        resolve(homedir(), ref),     // ~/ref
      ];
      
      for (const candidate of candidates) {
        if (existsSync(candidate)) {
          return resolvePromise(candidate);
        }
      }
      
      // If not found, try to find similar directory names in cwd
      try {
        const entries = await fsPromises.readdir(cwd);
        const cleanRef = ref.replace(/\/$/, "").toLowerCase();
        for (const entry of entries) {
          if (entry.toLowerCase().includes(cleanRef) || cleanRef.includes(entry.toLowerCase())) {
            const fullPath = resolve(cwd, entry);
            const stat = await fsPromises.stat(fullPath);
            if (stat.isDirectory()) {
              return resolvePromise(fullPath);
            }
          }
        }
      } catch {
        // Ignore errors during directory search
      }
      
      // Return the best guess (will fail later with a clear error)
      return resolvePromise(resolve(cwd, ref));
    }
  
    // Regular relative path - resolve against cwd
    return resolvePromise(resolve(cwd, file));
  });
}

/**
 * Find PDF files in a directory recursively.
 */
async function findPdfFiles(dir: string, maxDepth: number = 3): Promise<string[]> {
  const results: string[] = [];
  
  async function walk(currentDir: string, depth: number) {
    if (depth > maxDepth) return;
    try {
      const entries = await fsPromises.readdir(currentDir);
      for (const entry of entries) {
        const fullPath = resolve(currentDir, entry);
        try {
          const stat = await fsPromises.stat(fullPath);
          if (stat.isDirectory() && !entry.startsWith(".")) {
            await walk(fullPath, depth + 1);
          } else if (entry.toLowerCase().endsWith(".pdf")) {
            results.push(fullPath);
          }
        } catch {
          // Skip inaccessible entries
        }
      }
    } catch {
      // Skip inaccessible directories
    }
  }
  
  await walk(dir, 0);
  return results;
}

async function runPdfTool(command: string, ...args: string[]): Promise<any> {
  const escaped = args.map(a => `"${a.replace(/"/g, '\\"')}"`).join(" ");
  const cmd = `"${VENV_PYTHON}" "${SCRIPT_PATH}" ${command} ${escaped}`;
  try {
    const { stdout, stderr } = await execAsync(cmd, { encoding: "utf-8", maxBuffer: 50 * 1024 * 1024 });
    let result = JSON.parse(stdout);
    
    // Handle huge payload written to a temp file
    if (result._out_file) {
      tempFiles.add(result._out_file);
      const fileContent = await fsPromises.readFile(result._out_file, "utf-8");
      result = JSON.parse(fileContent);
      // Clean it up immediately since we have it in memory
      await fsPromises.rm(result._out_file, { force: true }).catch(() => {});
      tempFiles.delete(result._out_file);
    }
    return result;
  } catch (error: any) {
    const stderr = error.stderr || "";
    const msg = stderr ? `Python Error:\n${stderr}` : error.message;
    throw new Error(msg);
  }
}

function checkEnv(): string | null {
  if (!existsSync(VENV_PYTHON))
    return "Python venv not found. Run: python3 -m venv ~/.pi-pdf-venv && ~/.pi-pdf-venv/bin/pip install pymupdf4llm pymupdf";
  if (!existsSync(SCRIPT_PATH))
    return "PDF tools script not found at ~/.pi-pdf-venv/pdf_tools.py";
  return null;
}

function basename(p: string): string {
  return pathBasename(p);
}

// ─── Smart "read" orchestrator ──────────────────────────

async function smartRead(file: string, onUpdate?: (text: string) => void): Promise<any> {
  onUpdate?.("Reading document and analyzing metadata...");
  const result = await runPdfTool("smart_read", file);
  if (result.temp_dir) tempDirs.add(result.temp_dir);
  return result;
}

// ─── Tool Definition ─────────────────────────────────────

export default function pdfToolExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "pdf",
    label: "PDF",
    description: "Read PDF files. Default action='read' auto-detects size and returns the right amount of content without hitting limits.",
    promptSnippet: "Extract PDF text, images, or metadata",
    promptGuidelines: [
      "Use pdf(action='read', file='...') as the default — it auto-handles pagination, batching, and limits.",
      "For text-heavy PDFs, use pdf(action='text', file='...', pages='1-10').",
      "For formulas/diagrams, use pdf(action='images', file='...', pages='1-10') then read tool to view.",
      "For large PDFs, 'read' shows an overview; request specific pages after.",
      "When user types @ and selects from file picker, use the path as-is (e.g., @folder/). The tool resolves it automatically.",
      "If given a directory reference, first list contents with ls or find to locate PDF files.",
    ],
    parameters: Type.Object({
      action: Type.Optional(Type.Union([
        Type.Literal("read"),
        Type.Literal("info"),
        Type.Literal("text"),
        Type.Literal("images"),
      ], {
        description: "read: auto (default), info: metadata, text: Markdown, images: JPEGs",
      })),
      file: Type.String({ description: "Path to the PDF file" }),
      pages: Type.Optional(Type.String({
        description: 'Page range: "1-5", "1,3,7", or "all". For text/images actions.',
      })),
      dpi: Type.Optional(Type.Number({
        description: "Image resolution (default: 150). Only for images action.",
      })),
      max_dim: Type.Optional(Type.Number({
        description: "Max image edge in pixels (default: 1024). Only for images action.",
      })),
    }),

    renderShell: "self" as const,

    renderCall(args: any, theme: any): InstanceType<typeof Text> {
      const file = basename(args.file || "");
      const action = args.action || "read";
      let argText = file;
      if (action !== "read" && args.pages) argText += `, p${args.pages}`;
      if (action === "read") argText += ", read";
      return new Text(
        theme.fg("success", "● ") +
        theme.bold(theme.fg("toolTitle", "PDF")) +
        theme.fg("dim", "(") +
        theme.fg("text", argText) +
        theme.fg("dim", ") (ctrl+o to expand)"),
        0, 0
      );
    },

    renderResult(result: any, options: any, theme: any, context: any): InstanceType<typeof Text> {
      if (context.isPartial) return new Text(theme.fg("warning", "  └─ reading…"), 0, 0);
      const content = result.content?.[0];
      if (content?.type !== "text") return new Text(theme.fg("success", "  └─ done"), 0, 0);
      const text = content.text as string;
      if (context.isError || text.startsWith("Error"))
        return new Text(theme.fg("error", `  └─ ${text.split("\n")[0]}`), 0, 0);

      const firstLine = text.split("\n")[0] || "done";
      const details = result.details as any;

      // Images with batches
      if (details?.batches !== undefined) {
        const label = theme.fg("success", `  └─ ${details.count} page(s) in ${details.batches} batch(es)`);
        if (options.expanded && details.images) {
          let expanded = label;
          for (const batch of details.images) {
            expanded += `\n  ${theme.fg("accent", `Batch ${batch.batch}/${details.batches}`)}:`;
            for (const img of batch.pages) {
              expanded += `\n    ${theme.fg("text", `p${img.page}: ${img.path}`)}`;
            }
          }
          return new Text(expanded, 0, 0);
        }
        return new Text(label, 0, 0);
      }

      // Smart read with image pages
      if (details?.strategy === "medium" && details?.image_pages?.length) {
        const ips = (details.image_pages as number[]).filter((p: number) => p > 0);
        let label = theme.fg("success", `  └─ ${details.pages} pages, ${ips.length} with diagrams`);
        if (!options.expanded) return new Text(label, 0, 0);
        let expanded = label;
        const lines = text.split("\n").slice(1);
        for (const line of lines) expanded += `\n    ${theme.fg("text", line || " ")}`;
        return new Text(expanded, 0, 0);
      }

      const label = theme.fg("success", `  └─ ${firstLine}`);
      if (options.expanded) {
        const lines = text.split("\n").slice(0, 30);
        let expanded = label;
        for (const line of lines) expanded += `\n    ${theme.fg("text", line || " ")}`;
        if (text.split("\n").length > 30)
          expanded += `\n    ${theme.fg("text", `… ${text.split("\n").length - 30} more lines`)}`;
        return new Text(expanded, 0, 0);
      }
      return new Text(label, 0, 0);
    },

    async execute(_toolCallId: string, params: any, _signal: any, _onUpdate: any, ctx: any) {
      const err = checkEnv();
      if (err) return { content: [{ type: "text" as const, text: `Error: ${err}` }], isError: true };

      const { action: rawAction, file: rawFile, pages, dpi, max_dim } = params;
      const action = rawAction || "read";
      
      // Validate file parameter
      if (!rawFile || rawFile.trim() === "") {
        return {
          content: [{ type: "text" as const, text: "Error: No file specified. Use pdf(file='path/to/file.pdf') to read a PDF." }],
          isError: true,
        };
      }
      
      // Resolve the file path (handles @-prefix references)
      const cwd = ctx?.cwd || process.cwd();
      const file = await resolveFilePath(rawFile, cwd);

      // Check if file exists
      if (!existsSync(file)) {
        const isAtRef = rawFile.startsWith("@");
        const dirname = resolve(cwd, rawFile.replace(/^@/, "").replace(/\/[^/]*$/, ""));
        
        // Try to find PDFs in the referenced directory
        let hint = "";
        if (isAtRef || existsSync(dirname)) {
          const searchDir = isAtRef ? resolve(cwd, rawFile.replace(/^@/, "").replace(/\/$/, "")) : dirname;
          if (existsSync(searchDir)) {
            const pdfs = await findPdfFiles(searchDir);
            if (pdfs.length > 0) {
              hint = `\n\nFound ${pdfs.length} PDF file(s) in '${basename(searchDir)}':\n` +
                     pdfs.slice(0, 10).map(p => `  • ${p}`).join("\n") +
                     (pdfs.length > 10 ? `\n  ... and ${pdfs.length - 10} more` : "");
            }
          }
        }
        
        return {
          content: [{
            type: "text" as const,
            text: `Error: File not found: ${rawFile}` +
                  (isAtRef ? `\n\nThe @ prefix is notation for the file picker. Use the actual path instead.` : "") +
                  hint +
                  "\n\nTip: Use 'ls' or 'find' commands to locate the correct path.",
          }],
          isError: true,
        };
      }

      try {
        // ─── READ (smart auto-detect) ────────────────────────
        if (action === "read") {
          const result = await smartRead(file, (msg) => _onUpdate?.({ content: [{ type: "text" as const, text: `  └─ ${msg}` }] }));

          if (result.strategy === "full") {
            const lines: string[] = [];
            lines.push(`${result.info}`);
            lines.push(`Strategy: full read (small PDF)`);
            lines.push(`Text: ${result.chars.toLocaleString()} chars (~${result.tokens.toLocaleString()} tokens)`);
            lines.push(`Pages with images: ${result.images.length}`);
            lines.push("");
            lines.push("--- Full Text ---");
            lines.push(result.text);
            lines.push("");
            if (result.images.length > 0) {
              lines.push("--- Images ---");
              lines.push("Use read tool to view these pages:");
              for (const img of result.images) {
                lines.push(`  p${img.page}: ${img.path}`);
              }
            }
            return {
              content: [{ type: "text" as const, text: lines.join("\n") }],
              details: { strategy: "full", pages: result.pages, images: result.images, temp_dir: result.temp_dir },
            };
          }

          if (result.strategy === "medium") {
            const text = result.text as string;
            const truncated = text.length > MAX_LARGE_TEXT_CHARS
              ? text.slice(0, MAX_LARGE_TEXT_CHARS) + `\n\n... (${(text.length - MAX_LARGE_TEXT_CHARS).toLocaleString()} more chars — request a narrower page range for full text)`
              : text;
            const imagePages = (result.image_pages as number[]).filter((p: number) => p > 0);

            const lines: string[] = [];
            lines.push(`${result.info}`);
            lines.push(`Strategy: medium read (${result.pages} pages)`);
            lines.push(`Text: ${result.chars.toLocaleString()} chars (~${result.tokens.toLocaleString()} tokens)`);
            if (imagePages.length > 0) {
              lines.push(`Pages with diagrams: ${imagePages.length} (request pdf(action="images", file="${basename(file)}", pages="...") to view them)`);
            }
            lines.push("");
            lines.push("--- Content ---");
            lines.push(truncated);
            return {
              content: [{ type: "text" as const, text: lines.join("\n") }],
              details: { strategy: "medium", pages: result.pages, image_pages: imagePages, chars: result.chars },
            };
          }

          if (result.strategy === "large") {
            const lines: string[] = [];
            lines.push(`${result.info}`);
            lines.push(`Strategy: large PDF (${result.pages} pages) — showing overview only`);
            lines.push(`Full text would be ~${Math.round(result.pages * 500).toLocaleString()} tokens`);
            lines.push("");
            lines.push("--- Overview (pages 1-3) ---");
            lines.push(result.overview);
            lines.push("");
            lines.push(`--- Next steps ---`);
            lines.push(`• Extract specific section: pdf(action="text", file="${basename(file)}", pages="10-20")`);
            lines.push(`• View diagrams:      pdf(action="images", file="${basename(file)}", pages="10-20")`);
            return {
              content: [{ type: "text" as const, text: lines.join("\n") }],
              details: { strategy: "large", pages: result.pages, overview_chars: result.overview_chars },
            };
          }

          return { content: [{ type: "text" as const, text: "Error: unknown PDF structure" }], isError: true };
        }

        // ─── INFO ────────────────────────────────────────────
        if (action === "info") {
          _onUpdate?.({ content: [{ type: "text" as const, text: "  └─ Fetching metadata..." }] });
          const result = await runPdfTool("info", file);
          const summary = `${result.pages} pages • ${result.format}`;
          const details = [
            result.title ? `Title: ${result.title}` : null,
            result.author ? `Author: ${result.author}` : null,
            `Est. tokens: ~${Math.round(result.pages * 500)} text / ~${result.pages * 200} images`,
          ].filter(Boolean).join(" • ");
          const tip = `Use pdf(action="read", file="${basename(file)}") for a smart read that auto-handles limits.`;
          return {
            content: [{ type: "text" as const, text: `${summary}\n${details}\n\n${tip}` }],
            details: result,
          };
        }

        // ─── TEXT ────────────────────────────────────────────
        if (action === "text") {
          const pageArg = pages || "all";
          _onUpdate?.({ content: [{ type: "text" as const, text: `  └─ Extracting text (pages ${pageArg})...` }] });
          const result = await runPdfTool("text", file, pageArg);
          const text = result.text as string;
          const chars = result.chars as number;
          const tokens = result.tokens_estimated as number;

          if (chars > MAX_LARGE_TEXT_CHARS) {
            return {
              content: [{
                type: "text" as const,
                text: [
                  `${chars.toLocaleString()} chars (~${tokens.toLocaleString()} tokens) • pages: ${pageArg}`,
                  "",
                  `**Text truncated.** Showing first ${(MAX_LARGE_TEXT_CHARS / 1000).toFixed(0)}K of ${(chars / 1000).toFixed(0)}K chars.`,
                  `Request a narrower page range for the rest.`,
                  "",
                  "---",
                  "",
                  text.slice(0, MAX_LARGE_TEXT_CHARS),
                ].join("\n"),
              }],
              details: { chars, tokens_estimated: tokens, pages: pageArg, truncated: true },
            };
          }

          return {
            content: [{ type: "text" as const, text: `${chars.toLocaleString()} chars (~${tokens.toLocaleString()} tokens) • pages: ${pageArg}\n${text}` }],
            details: { chars, tokens_estimated: tokens, pages: pageArg },
          };
        }

        // ─── IMAGES ──────────────────────────────────────────
        if (action === "images") {
          if (!pages) return { content: [{ type: "text" as const, text: "Error: pages required for images action" }], isError: true };
          const dpiArg = dpi?.toString() || "150";
          const maxDimArg = max_dim?.toString() || "1024";
          _onUpdate?.({ content: [{ type: "text" as const, text: `  └─ Converting pages ${pages} to images...` }] });
          const result = await runPdfTool("images", file, pages, "--dpi", dpiArg, "--max-dim", maxDimArg);
          if (result.count === 0) return { content: [{ type: "text" as const, text: "No matching pages." }] };
          if (result.temp_dir) tempDirs.add(result.temp_dir);

          const batches = [];
          for (let i = 0; i < result.images.length; i += BATCH_SIZE) {
            batches.push({ batch: batches.length + 1, pages: result.images.slice(i, i + BATCH_SIZE) });
          }

          const lines = [
            `${result.count} page(s) converted (≤${maxDimArg}px)`,
            batches.length > 1 ? `Batched: ${batches.length} groups of ≤${BATCH_SIZE} (provider limit)` : "",
            "",
            "Use read tool on these paths:",
            "",
          ];
          for (const batch of batches) {
            const pageNums = batch.pages.map((p: any) => p.page).join(", ");
            const totalKB = Math.round(batch.pages.reduce((s: number, p: any) => s + p.size_bytes, 0) / 1024);
            lines.push(`  Batch ${batch.batch}/${batches.length}: pages ${pageNums} (${totalKB}KB)`);
            for (const img of batch.pages) {
              lines.push(`    p${img.page}: ${img.path}`);
            }
          }

          return {
            content: [{ type: "text" as const, text: lines.join("\n") }],
            details: { temp_dir: result.temp_dir, images: batches, count: result.count, batches: batches.length, batch_size: BATCH_SIZE },
          };
        }

        return { content: [{ type: "text" as const, text: `Error: unknown action '${action}'` }], isError: true };
      } catch (e: any) {
        return { content: [{ type: "text" as const, text: `Error: ${e.message}` }], isError: true };
      }
    },
  });

  // ── Cleanup temp dirs ─────────────────────────────────
  pi.on("session_shutdown", async () => {
    for (const dir of tempDirs) {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
    tempDirs.clear();
    for (const file of tempFiles) {
      try { rmSync(file, { force: true }); } catch { /* ignore */ }
    }
    tempFiles.clear();
  });

  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.notify("PDF tool ready", "info");
  });
}
