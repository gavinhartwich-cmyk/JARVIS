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

export function parseFileBlocks(text: string): FileBlock[] {
  const blocks: FileBlock[] = [];
  let match: RegExpExecArray | null;
  // Reset lastIndex in case the same regex object is reused across calls.
  FILE_BLOCK_RE.lastIndex = 0;
  while ((match = FILE_BLOCK_RE.exec(text)) !== null) {
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
