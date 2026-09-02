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

/**
 * [ADDED 2026-09-02] Targeted find/replace edit for an EXISTING file — the
 * real fix for a confirmed-live bug: the Coder agent hit
 * "The operation timed out." reproducing a real ~770-line file, because
 * ===FILE=== blocks require the model to output the ENTIRE file (7000-9000+
 * output tokens for a file that size) even when the actual requested change
 * is one line. Two earlier passes tried raising the per-call timeout and
 * token cap - both real fixes for smaller files, neither fixes the
 * underlying scaling problem, because output cost still scales with FILE
 * size, not EDIT size. An ===EDIT=== block only costs tokens proportional
 * to the change itself: a small, verbatim FIND anchor (must match the
 * file's real current content exactly - the model can only get this right
 * because existingFileContext() already shows it the real file) plus the
 * REPLACE text. See applyEditBlocks() for how this gets applied, and
 * developer.ts's step4_ImplementCode for how a bad/non-unique anchor
 * becomes a specific, retry-able error rather than a silent wrong edit.
 */
export interface EditBlock {
  path: string;
  find: string;
  replace: string;
}

const FILE_BLOCK_RE = /===FILE:\s*(.+?)\s*===\r?\n([\s\S]*?)\r?\n===END FILE===/g;
const EDIT_BLOCK_RE =
  /===EDIT:\s*(.+?)\s*===\r?\n<<<<<<< FIND\r?\n([\s\S]*?)\r?\n=======\r?\n([\s\S]*?)\r?\n>>>>>>> REPLACE\r?\n===END EDIT===/g;

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

export function parseEditBlocks(text: string): EditBlock[] {
  const unwrapped = unwrapNestedContent(text);
  const blocks: EditBlock[] = [];
  let match: RegExpExecArray | null;
  EDIT_BLOCK_RE.lastIndex = 0;
  while ((match = EDIT_BLOCK_RE.exec(unwrapped)) !== null) {
    const filePath = match[1].trim();
    const find = match[2];
    const replace = match[3];
    if (filePath) {
      blocks.push({ path: filePath, find, replace });
    }
  }
  return blocks;
}

export function isNoChangesResponse(text: string): boolean {
  return /===NO_CHANGES===/.test(text) && parseFileBlocks(text).length === 0 && parseEditBlocks(text).length === 0;
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
There are two block formats. Use EDIT for a targeted change to a file whose
EXISTING CONTENT was shown to you elsewhere in this prompt — it is almost
always the right choice for an existing file, and REQUIRED whenever your
change touches only part of that file. Use FILE only for a brand-new file,
or when the change genuinely replaces nearly all of an existing file's
content.

===EDIT: relative/path/to/file.ts===
<<<<<<< FIND
<a short, VERBATIM excerpt copied exactly from that file's real EXISTING
CONTENT shown to you - same whitespace, same indentation, same everything.
Include just enough surrounding lines that this excerpt appears EXACTLY
ONCE in the file - not the whole file, not a paraphrase or a description
of the location.>
=======
<the replacement text for that exact excerpt>
>>>>>>> REPLACE
===END EDIT===

You may output several ===EDIT=== blocks for the same file if you need to
change more than one place in it — each one is applied independently, so
each FIND excerpt must still be unique and exact on its own.

===FILE: relative/path/to/new-file.ts===
<complete file content, nothing omitted or truncated>
===END FILE===

If, after analysis, no changes are actually needed, output only the single line:
===NO_CHANGES===

This applies no matter how small the requested change is. A response like
a bare markdown code fence containing just a comment, or a raw snippet with
no ===EDIT:=== / ===FILE:=== markers, is NOT valid output and will be
rejected by the parser that reads your response - even when the change
itself really is just one line. Output nothing outside these blocks, and no
markdown code fences inside them.
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

function truncateForError(text: string, maxLength = 200): string {
  return text.length > maxLength ? text.slice(0, maxLength) + "..." : text;
}

/**
 * [ADDED 2026-09-02] Apply ===EDIT=== blocks - a targeted find/replace
 * against a file's REAL current content, instead of applyFileBlocks'
 * whole-file overwrite. See EditBlock's own comment above for why this
 * exists (a confirmed-live Coder-agent timeout on large files).
 *
 * Deliberately returns errors instead of throwing: a bad or non-unique
 * FIND anchor is a normal, expected, retry-able model mistake (same
 * category as the existing FILE_BLOCK format-mismatch/truncation
 * failures developer.ts already retries with a blunter prompt) - not a
 * codebase-level exception. The error messages are specific enough for a
 * retry to actually self-correct: which file, whether the anchor was
 * missing vs. ambiguous, and a truncated echo of what was searched for.
 *
 * Multiple ===EDIT=== blocks targeting the same file are applied in
 * order against each other's output (not each re-read from disk), so a
 * second edit can target content the first edit just introduced.
 */
export function applyEditBlocks(
  repoRoot: string,
  blocks: EditBlock[]
): { written: Map<string, string>; errors: string[] } {
  const written = new Map<string, string>();
  const errors: string[] = [];
  const resolvedRoot = path.resolve(repoRoot);
  const currentContent = new Map<string, string>();

  for (const block of blocks) {
    const targetPath = path.resolve(resolvedRoot, block.path);
    const relative = path.relative(resolvedRoot, targetPath);

    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      errors.push(`Refusing to edit outside repository root: "${block.path}" resolved to ${targetPath}`);
      continue;
    }

    let content = currentContent.get(relative);
    if (content === undefined) {
      if (!fs.existsSync(targetPath)) {
        errors.push(
          `===EDIT=== block targets "${block.path}", but that file doesn't exist on disk. Use a ===FILE=== block instead for a new file.`
        );
        continue;
      }
      content = fs.readFileSync(targetPath, "utf-8");
    }

    if (block.find.length === 0) {
      errors.push(`===EDIT=== block for "${block.path}" has an empty FIND section - it must contain a real excerpt of the file's current content.`);
      continue;
    }

    const occurrences = content.split(block.find).length - 1;
    if (occurrences === 0) {
      errors.push(
        `===EDIT=== block for "${block.path}": the FIND text was not found verbatim in the file's current content. ` +
          `It must match exactly, including whitespace and indentation - copy it directly from the EXISTING CONTENT shown to you, don't retype or paraphrase it. ` +
          `FIND started with: ${truncateForError(block.find)}`
      );
      continue;
    }
    if (occurrences > 1) {
      errors.push(
        `===EDIT=== block for "${block.path}": the FIND text matches ${occurrences} different places in the file, not exactly one. ` +
          `Include more surrounding context (a few more lines before/after) so it uniquely identifies a single location. ` +
          `FIND started with: ${truncateForError(block.find)}`
      );
      continue;
    }

    // Function-form replacer, not a plain string - String.prototype.replace
    // treats a string replacement's "$&"/"$1"/"$$" etc. as special
    // patterns, which would silently corrupt a REPLACE text that happens
    // to contain a literal "$" (e.g. real code using template literals or
    // regex). The function form always inserts the text verbatim.
    const newContent = content.replace(block.find, () => block.replace);
    currentContent.set(relative, newContent);
    written.set(relative, newContent);
  }

  for (const [relative, content] of currentContent) {
    const targetPath = path.resolve(resolvedRoot, relative);
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, content, "utf-8");
  }

  return { written, errors };
}
