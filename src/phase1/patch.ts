/**
 * File-block protocol for the Coder/Debugger agents.
 *
 * The Coder and Debugger agents don't return a "file tool call" — they
 * return prose containing full file contents. To turn that into actual
 * disk writes without guessing at markdown code-fence boundaries (which
 * break on nested fences, language tags, etc.), the task prompt sent to
 * those agents demands this exact delimited format:
 *
 *   ===FILE: relative/path/to/file.ts===
 *   <complete file content>
 *   ===END FILE===
 *
 * repeated once per file, or a single "===NO_CHANGES===" line if nothing
 * needs to change. This module only understands that format — it does not
 * attempt to parse markdown code fences.
 */

import fs from "fs";
import path from "path";

export interface FileBlock {
  path: string;
  content: string;
}

const FILE_BLOCK_RE = /===FILE:\s*(.+?)\s*===\r?\n([\s\S]*?)\r?\n===END FILE===/g;

/**
 * Small local models asked for structured JSON (`{content, confidence}`)
 * sometimes get confused between that outer envelope and the ===FILE===
 * block format they're also required to produce, and echo an extra JSON
 * layer inside `content` instead of the raw block text directly — e.g.
 * `content` itself is the string `{"content": "===FILE: ...===\n..."}`.
 * Unwrap that (recursively, in case it happens more than once) before
 * regex-parsing so a confused-but-recoverable response isn't treated as
 * "no file block found".
 */
function unwrapNestedContent(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return text;
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed.content === "string") {
      return unwrapNestedContent(parsed.content);
    }
  } catch {
    // Not valid JSON — treat as plain text.
  }
  return text;
}

export function parseFileBlocks(text: string): FileBlock[] {
  const unwrapped = unwrapNestedContent(text);
  const blocks: FileBlock[] = [];
  let match: RegExpExecArray | null;
  // Reset lastIndex in case the same regex object is reused across calls.
  FILE_BLOCK_RE.lastIndex = 0;
  while ((match = FILE_BLOCK_RE.exec(unwrapped)) !== null) {
    const filePath = match[1].trim();
    const content = match[2];
    if (filePath) {
      blocks.push({ path: filePath, content });
    }
  }
  return blocks;
}

export function isNoChangesResponse(text: string): boolean {
  return /===NO_CHANGES===/.test(text) && parseFileBlocks(text).length === 0;
}

/**
 * Root package name for an import specifier ("@angular/core/testing" ->
 * "@angular/core", "lodash/fp" -> "lodash", "./local" -> "./local" unchanged).
 */
function packageRootName(specifier: string): string {
  const parts = specifier.split("/");
  if (specifier.startsWith("@")) return parts.slice(0, 2).join("/");
  return parts[0];
}

/**
 * Scan written files for bare (non-relative, non-builtin) import/require
 * specifiers that aren't in the repo's actual installed-package list.
 * Mechanical check, not LLM-guessed — this is what caught the Coder
 * hallucinating an `@angular/core` import for a plain utility function that
 * `tsc` also caught, but which the Debugger then failed to act on. Running
 * this immediately after a Coder/Debugger write gives a much more specific,
 * actionable error than a generic TS2307 buried in a typecheck dump.
 */
export function findDisallowedImports(
  files: Map<string, string>,
  allowedPackages: Set<string>
): string[] {
  const errors: string[] = [];
  const importRe = /(?:^|\n)\s*import\s+(?:type\s+)?.*?from\s+['"]([^'"]+)['"]|require\(\s*['"]([^'"]+)['"]\s*\)/g;

  for (const [filePath, content] of files) {
    let match: RegExpExecArray | null;
    importRe.lastIndex = 0;
    while ((match = importRe.exec(content)) !== null) {
      const specifier = match[1] ?? match[2];
      if (!specifier) continue;
      if (specifier.startsWith(".") || specifier.startsWith("/") || specifier.startsWith("node:")) {
        continue; // relative import or explicit node: builtin
      }
      const rootName = packageRootName(specifier);
      if (!allowedPackages.has(rootName) && !allowedPackages.has(specifier)) {
        errors.push(
          `${filePath}: imports "${specifier}", which is not an installed dependency of this project (not in package.json). ` +
            `Rewrite this file without that import — use only plain TypeScript/Bun built-ins or the project's existing dependencies.`
        );
      }
    }
  }

  return errors;
}

/**
 * Instructions appended to any Coder/Debugger task prompt so the model's
 * free-form response is actually machine-parseable.
 */
export const FILE_BLOCK_PROTOCOL_INSTRUCTIONS = `
Output every file you create or modify using EXACTLY this delimited format, one block per file, with no other text outside the blocks and no markdown code fences inside them:

===FILE: relative/path/to/file.ts===
<complete file content, nothing omitted or truncated>
===END FILE===

If, after analysis, no file changes are actually needed, output only the single line:
===NO_CHANGES===

This applies no matter how small the requested change is. A response like
a bare markdown code fence containing just a comment, or a raw
snippet with no ===FILE:=== / ===END FILE=== markers, is NOT valid output
and will be rejected by the parser that reads your response - even when
the change itself really is just one line. If a file's EXISTING CONTENT
was shown to you elsewhere in this prompt, your block for that path is
that entire content with your edit applied, not a summary of the edit.
`;

/**
 * Write parsed file blocks to disk under repoRoot. Refuses to write outside
 * repoRoot (path traversal guard) since this content comes from an LLM.
 * Returns a map of the files actually written (relative path -> content),
 * for the caller to record in the result/diff.
 */
export function applyFileBlocks(
  repoRoot: string,
  blocks: FileBlock[]
): Map<string, string> {
  const written = new Map<string, string>();
  const resolvedRoot = path.resolve(repoRoot);

  for (const block of blocks) {
    const targetPath = path.resolve(resolvedRoot, block.path);
    const relative = path.relative(resolvedRoot, targetPath);

    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error(
        `Refusing to write outside repository root: "${block.path}" resolved to ${targetPath}`
      );
    }

    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, block.content, "utf-8");
    written.set(relative, block.content);
  }

  return written;
}
