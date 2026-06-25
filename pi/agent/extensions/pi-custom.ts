/**
 * pi-custom.ts — Unified Pi extension
 *
 * Single file replacing pi-zentui + agy-compact.ts with zero conflicts.
 * ONE colour system: ~/.pi/agent/themes/high-contrast-dark.json
 * Tweaking visuals = edit the theme file only. Nothing else fights over colours.
 *
 * Owns:
 *   • User message boxes     ─── border + > rail
 *   • Tool call rendering    AGY-style: ● ToolName(arg)  └─ result
 *   • Footer                 Stats on left | Model info on right
 *   • Prompt input box       > rail on the left
 *   • Thinking suppression   hides <thinking> blocks from old turns
 */

import type {
	EditToolDetails,
	ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import {
	AssistantMessageComponent,
	UserMessageComponent,
	CustomEditor,
	createBashTool,
	createEditTool,
	createFindTool,
	createGrepTool,
	createLsTool,
	createReadTool,
	createWriteTool,
} from "@earendil-works/pi-coding-agent";
import { Text, visibleWidth, truncateToWidth } from "@earendil-works/pi-tui";

// ─── Tiny helpers ─────────────────────────────────────────────────────────────

function formatNum(n: number): string {
	if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
	if (n >= 1_000) return (n / 1_000).toFixed(1) + "k";
	return String(n);
}

function findText(value: unknown): string | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const rec = value as Record<string, unknown>;
	if (typeof rec.text === "string") return rec.text;
	if (Array.isArray(rec.children)) {
		for (const child of rec.children) {
			const t = findText(child);
			if (t !== undefined) return t;
		}
	}
	return undefined;
}

// ─── Extension entry point ────────────────────────────────────────────────────

export default async function (pi: ExtensionAPI) {


	// ── 1. Thinking suppression ───────────────────────────────────────────────
	if (AssistantMessageComponent?.prototype) {
		const origUpdate = AssistantMessageComponent.prototype.updateContent;
		if (origUpdate && !(AssistantMessageComponent.prototype as any).__customThinkingPatched) {
			AssistantMessageComponent.prototype.updateContent = function (message: any) {
				if (this.hideThinkingBlock && Array.isArray(message?.content)) {
					message = {
						...message,
						content: message.content.filter(
							(c: any) => c.type !== "thinking" && c.type !== "redacted_thinking",
						),
					};
				}
				return origUpdate.call(this, message);
			};
			(AssistantMessageComponent.prototype as any).__customThinkingPatched = true;
		}
	}

	// ── 2. User message boxes — ─── border + > rail ───────────────────────────
	if (UserMessageComponent?.prototype && !(UserMessageComponent.prototype as any).__customPatched) {
		const origRender: ((w: number) => string[]) | undefined =
			(UserMessageComponent.prototype as any).render;

		(UserMessageComponent.prototype as any).render = function (width: number): string[] {
			if (width <= 0) return [""];
			const text = findText(this);
			if (text === undefined) {
				return origRender ? origRender.call(this, width) : [""];
			}

			const theme: any = (UserMessageComponent.prototype as any).__customGetTheme?.();
			const RAIL_WIDTH = 2;
			const innerWidth = Math.max(1, width - RAIL_WIDTH);

			const colBorder = (s: string) => (theme ? theme.fg("border", s) : s);
			const colAccent = (s: string) => (theme ? theme.fg("accent", s) : s);
			const colText   = (s: string) => (theme ? theme.fg("userMessageText", s) : s);

			const border = colBorder("─".repeat(width));
			const railPrefix = colAccent(">") + " ";

			const paragraphs = text.split(/\r?\n/);
			const contentLines: string[] = [];
			for (const para of paragraphs) {
				const trimmed = para.trim();
				if (!trimmed) { contentLines.push(""); continue; }
				const words = trimmed.split(/\s+/);
				let cur = "";
				for (const word of words) {
					if (!cur) { cur = word; continue; }
					if (cur.length + 1 + word.length <= innerWidth) {
						cur += " " + word;
					} else {
						contentLines.push(cur);
						cur = word;
					}
				}
				if (cur) contentLines.push(cur);
			}
			if (contentLines.length === 0) contentLines.push("");

			const rendered = contentLines.map(line => truncateToWidth(`${railPrefix}${colText(line)}`, width));
			return [border, ...rendered, border];
		};

		(UserMessageComponent.prototype as any).__customPatched = true;
	}

	// ── 3. Tool rendering — AGY style ─────────────────────────────────────────

	const TOOL_NAME_MAP: Record<string, string> = {
		ls:    "ListDir",
		read:  "Read",
		write: "Write",
		edit:  "Edit",
		bash:  "Bash",
		grep:  "Grep",
		find:  "Find",
	};

	function renderCallLine(theme: any, toolName: string, argText: string): string {
		return (
			theme.fg("success", "● ") +
			theme.bold(theme.fg("toolTitle", toolName)) +
			theme.fg("dim", "(") +
			theme.fg("text", argText) +
			theme.fg("dim", ")") +
			theme.fg("dim", " (ctrl+o to expand)")
		);
	}

	const origRegister = pi.registerTool.bind(pi);
	pi.registerTool = function (tool: any) {
		const name: string = tool.name ?? "";
		const displayName =
			TOOL_NAME_MAP[name] ?? (name.charAt(0).toUpperCase() + name.slice(1));

		tool.renderShell = "self";

		// Skip if tool already has custom renderers (e.g., PDF tool)
		if (!tool.renderCall) {
		tool.renderCall = function (args: any, theme: any): InstanceType<typeof Text> {
			let argText = "";
			if (name === "bash") {
				argText = args.command ?? "";
				if (argText.length > 90) argText = argText.slice(0, 87) + "…";
			} else if (["read", "write", "edit", "ls"].includes(name)) {
				argText = args.path ?? args.file_path ?? "";
				if (name === "write" && args.content) {
					argText += `, ${(args.content as string).split("\n").length} lines`;
				}
			} else if (["grep", "find"].includes(name)) {
				argText = `${args.pattern ?? ""}, ${args.path ?? "."}`;
			} else {
				argText = Object.values(args).map(String).join(", ");
				if (argText.length > 90) argText = argText.slice(0, 87) + "…";
			}
			return new Text(renderCallLine(theme, displayName, argText), 0, 0);
		};

		tool.renderResult = function (
			result: any,
			options: any,
			theme: any,
			context: any,
		): InstanceType<typeof Text> {
			if (context.isPartial) {
				const verb =
					name === "bash"  ? "running"   :
					name === "read"  ? "reading"   :
					name === "write" ? "writing"   : "executing";
				return new Text(theme.fg("warning", `  └─ ${verb}…`), 0, 0);
			}

			const content = result.content?.[0];
			const output: string = content?.type === "text" ? content.text : "";

			if (content?.type === "image")
				return new Text(theme.fg("success", "  └─ image loaded"), 0, 0);

			if (name === "write") {
				if (content?.type === "text" && content.text.startsWith("Error"))
					return new Text(theme.fg("error", `  └─ ${content.text.split("\n")[0]}`), 0, 0);
				return new Text(theme.fg("success", "  └─ written"), 0, 0);
			}

			if (name === "edit") {
				if (content?.type === "text" && content.text.startsWith("Error"))
					return new Text(theme.fg("error", `  └─ ${content.text.split("\n")[0]}`), 0, 0);
				const details = result.details as EditToolDetails | undefined;
				if (!details?.diff) return new Text(theme.fg("success", "  └─ applied"), 0, 0);
				const diffLines = details.diff.split("\n");
				let additions = 0, removals = 0;
				for (const line of diffLines) {
					if (line.startsWith("+") && !line.startsWith("+++")) additions++;
					if (line.startsWith("-") && !line.startsWith("---")) removals++;
				}
				let text =
					theme.fg("success", `  └─ +${additions}`) +
					theme.fg("text", " / ") +
					theme.fg("error", `-${removals}`);
				if (options.expanded) {
					for (const line of diffLines.slice(0, 30)) {
						if (line.startsWith("+") && !line.startsWith("+++")) text += `\n    ${theme.fg("success", line)}`;
						else if (line.startsWith("-") && !line.startsWith("---")) text += `\n    ${theme.fg("error", line)}`;
						else text += `\n    ${theme.fg("text", line)}`;
					}
					if (diffLines.length > 30)
						text += `\n    ${theme.fg("text", `… ${diffLines.length - 30} more diff lines`)}`;
				}
				return new Text(text, 0, 0);
			}

			const lineCount = output.split("\n").filter(l => l.trim()).length;
			const label = context.isError ? "failed" : "done";
			let text = context.isError
				? theme.fg("error", `  └─ ${label}`)
				: theme.fg("success", `  └─ ${label}`);
			if (lineCount > 0) text += theme.fg("text", ` (${lineCount} lines)`);
			if (options.expanded && output) {
				const lines = output.split("\n").slice(0, 25);
				for (const line of lines) text += `\n    ${theme.fg("text", line || " ")}`;
				if (output.split("\n").length > 25)
					text += `\n    ${theme.fg("text", `… ${output.split("\n").length - 25} more lines`)}`;
			}
			return new Text(text, 0, 0);
		};
		} // end if (!tool.renderCall)

		return origRegister(tool);
	};

	const cwd = process.cwd();
	for (const create of [
		createBashTool, createReadTool, createWriteTool, createEditTool,
		createLsTool,   createGrepTool, createFindTool,
	]) {
		try { pi.registerTool((create as any)(cwd) as any); } catch {}
	}

	// ── 4. Setup Hooks (Editor prompt rail + Footer) ─────────────────────────
	pi.on("session_start", (_event: any, ctx: any) => {
		(UserMessageComponent.prototype as any).__customGetTheme = () => ctx.ui.theme;

		// Inject '>' rail into the editor input box and remove its borders
		const origFactory = ctx.ui.getEditorComponent();
		ctx.ui.setEditorComponent((tui: any, theme: any, keybindings: any) => {
			const editor = origFactory
				? origFactory(tui, theme, keybindings)
				: new CustomEditor(tui, theme, keybindings, { paddingX: 2 });

			// paddingX=2 reserves space for our "> " rail without breaking cursor math
			editor.paddingX = 2;

			const origRender = editor.render.bind(editor);
			editor.render = (width: number): string[] => {
				// If width is too small, fall back to original render
				if (width <= 4) return origRender(width);

				// Capture the theme—frequently null/undefined during startup frames
				const currentTheme: any = ctx.ui?.theme;
				const RAIL = currentTheme ? currentTheme.fg("accent", "> ") : "> ";

				let lines: string[];
				try {
					lines = origRender(width);
				} catch {
					return [RAIL + " ".repeat(Math.max(0, width - 2))];
				}

				if (!lines || lines.length < 2) return lines;

				// ─── Editor.render() output layout ───────────────────────────
				//   index 0:         top border    ──── or scroll-up indicator
				//   index 1 … M:     text lines    (M = visibleLines.length)
				//   index M+1:       bottom border ──── or scroll-down indicator
				//   index M+2 … end: autocomplete   (if active)
				//
				// Autocomplete count = lines after bottom border
				// Bottom border is always at index: lines.length - 1 - autocompleteCount

				// Count autocomplete lines by finding the first non-border suffix
				let autoCount = 0;
				// Simple autocomplete detection: lines after a ── line are autocomplete
				let foundBottomBorder = false;
				for (let i = lines.length - 1; i >= 0; i--) {
					const trimmed = lines[i].replace(/\x1b\[[0-9;]*m/g, "").trim();
					// Bottom border is a horizontal line (all ─ or ─── ↑/↓ N more ───)
					if (trimmed.startsWith("─") && !trimmed.includes(" ")) {
						if (!foundBottomBorder) {
							foundBottomBorder = true;
							continue;
						}
					}
					if (!foundBottomBorder) {
						autoCount++;
					} else {
						break;
					}
				}
				// Fallback: if detection failed, assume standard 3-line layout + autocomplete
				if (!foundBottomBorder) {
					// Standard layout: 1 top border + N text + 1 bottom + A autocomplete
					// bottomBorderIndex = lines.length - 1 - autoCount
					// where autoCount is guessed as lines after index 2 if there are > 3 total
					if (lines.length > 3) autoCount = lines.length - 3;
				}

				const bottomBorderIdx = lines.length - 1 - autoCount;
				const textStartIdx = 1;  // text lines start after top border
				const textEndIdx = bottomBorderIdx; // text lines end before bottom border

				const processed: string[] = [];
				for (let i = 0; i < lines.length; i++) {
					// Text lines (between top and bottom borders): replace left padding with RAIL
					if (i >= textStartIdx && i < textEndIdx) {
						const line = lines[i];
						// Strip the left padding and prepend RAIL, considering ANSI codes
						const stripped = line.replace(/^(?:\x1b\[[0-9;]*m)*\s*/, (match) => match.replace(/\s/g, ""));
						processed.push(truncateToWidth(RAIL + stripped, width, ""));
					} else {
						// Top border, bottom border, and autocomplete lines: keep as-is
						processed.push(lines[i]);
					}
				}

				// If we filtered everything out (shouldn't happen), return a fallback
				if (processed.length === 0) {
					return [RAIL + " ".repeat(Math.max(0, width - 2))];
				}

				return processed;
			};

			return editor;
		});

	});
}

