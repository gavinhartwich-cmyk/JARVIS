/**
 * File System Tools
 * Allow JARVIS to read, write, and manipulate files
 */

import { Tool, ToolResult, ParameterDefinition } from "./types";
import * as fs from "fs/promises";
import * as path from "path";

// BufferEncoding is a global ambient type (from bun-types/@types/node),
// not a named export of the "buffer" module — no import needed.
const VALID_ENCODINGS: readonly BufferEncoding[] = [
  "utf-8", "utf8", "ascii", "base64", "base64url", "hex", "latin1", "binary", "ucs2", "ucs-2", "utf16le",
];

function toBufferEncoding(value: unknown): BufferEncoding {
  const encoding = String(value || "utf-8");
  if ((VALID_ENCODINGS as string[]).includes(encoding)) {
    return encoding as BufferEncoding;
  }
  throw new Error(`Unsupported encoding: ${encoding}`);
}

/**
 * SECURITY FIX (2026-08-28, full-codebase review per Gavin's "spare no
 * line of code" request): the previous guard on all three tools below was
 * `filePath.includes("/etc") || filePath.includes("/sys")` (plus
 * `.includes(".env")` for delete only) — a raw substring check on the
 * UNRESOLVED path string. That's trivially bypassed: `/home/gavin/.ssh/
 * id_rsa`, `~/.aws/credentials`, `C:\Users\gavin\.env`, or
 * `/home/gavin/../../etc/shadow` (until resolved, the literal string
 * still contains "/etc" here, but a caller could just as easily reach
 * `/etc` via a symlink or a differently-spelled equivalent path that
 * doesn't) all pass straight through — once a caller clears the
 * `"normal"`-tier authorization gate (no PIN required, just the
 * device-session-recognized user), read_file could pull SSH private
 * keys, cloud credentials, or JARVIS's own .env (containing
 * OMNIROUTE_API_KEY) outright, and write/delete had the identical gap
 * for anything not literally containing "/etc" or "/sys".
 *
 * This does NOT restrict these tools to one sandboxed root directory —
 * that would be a much bigger, more disruptive design change (JARVIS is
 * meant to read arbitrary files on the user's machine as a personal
 * assistant, not just files inside its own repo) and isn't this review's
 * call to make unilaterally. What it does do: resolve+normalize the path
 * first (so `..` traversal and case/separator differences can't slip
 * past the check the way a raw substring match can), and match against a
 * real, meaningfully wider set of credential/secret locations by path
 * SEGMENT rather than raw substring (so `/etcetera/notes.txt` isn't a
 * false positive the way naive substring matching would also get wrong
 * in the other direction).
 */
const SENSITIVE_SEGMENTS = new Set([
  ".ssh", ".aws", ".azure", ".gcloud", ".kube", ".gnupg", ".docker",
  "etc", "sys", "proc", "windows", "system32", "programdata",
]);
const SENSITIVE_FILENAME_PATTERN = /^(id_rsa|id_ed25519|id_ecdsa|id_dsa.*|.*\.pem|.*\.pfx|.*\.ppk|credentials|\.env(\..*)?|\.npmrc|\.netrc)$/i;

function isSensitivePath(rawPath: string): boolean {
  const resolved = path.resolve(rawPath);
  const segments = resolved.split(/[\\/]+/).filter(Boolean);
  const filename = segments[segments.length - 1] ?? "";
  if (SENSITIVE_FILENAME_PATTERN.test(filename)) return true;
  return segments.some((seg) => SENSITIVE_SEGMENTS.has(seg.toLowerCase()));
}

export class ReadFileTool implements Tool {
  name = "read_file";
  description = "Read the contents of a file";
  parameters: Record<string, ParameterDefinition> = {
    path: {
      type: "string",
      description: "Absolute path to the file to read",
      required: true,
    },
    encoding: {
      type: "string",
      description: "File encoding (default: utf-8)",
      required: false,
      default: "utf-8",
    },
  };
  requiresApproval = false;

  async execute(parameters: Record<string, unknown>): Promise<ToolResult> {
    const startTime = Date.now();

    try {
      const filePath = String(parameters.path);
      const encoding = toBufferEncoding(parameters.encoding);

      // Safety check: prevent reading system/credential files (real
      // resolved-path + segment check — see isSensitivePath() above)
      if (isSensitivePath(filePath)) {
        return {
          success: false,
          error: "Access denied: Cannot read system or credential files",
          executionTime: Date.now() - startTime,
        };
      }

      const content = await fs.readFile(filePath, { encoding });

      return {
        success: true,
        data: { path: filePath, content, size: content.length },
        executionTime: Date.now() - startTime,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        executionTime: Date.now() - startTime,
      };
    }
  }
}

export class WriteFileTool implements Tool {
  name = "write_file";
  description = "Write content to a file (creates if doesn't exist)";
  parameters: Record<string, ParameterDefinition> = {
    path: {
      type: "string",
      description: "Absolute path to the file to write",
      required: true,
    },
    content: {
      type: "string",
      description: "Content to write to the file",
      required: true,
    },
    append: {
      type: "boolean",
      description: "Append instead of overwrite (default: false)",
      required: false,
      default: false,
    },
  };
  requiresApproval = true; // Writing always requires approval

  async execute(parameters: Record<string, unknown>): Promise<ToolResult> {
    const startTime = Date.now();

    try {
      const filePath = String(parameters.path);
      const content = String(parameters.content);
      const append = Boolean(parameters.append || false);

      // Safety check: prevent writing to system/credential locations (real
      // resolved-path + segment check — see isSensitivePath() above)
      if (isSensitivePath(filePath)) {
        return {
          success: false,
          error: "Access denied: Cannot write to system or credential files",
          executionTime: Date.now() - startTime,
        };
      }

      // Create directory if needed
      const dir = path.dirname(filePath);
      await fs.mkdir(dir, { recursive: true });

      if (append) {
        await fs.appendFile(filePath, content);
      } else {
        await fs.writeFile(filePath, content);
      }

      return {
        success: true,
        data: { path: filePath, bytesWritten: content.length },
        executionTime: Date.now() - startTime,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        executionTime: Date.now() - startTime,
      };
    }
  }
}

export class ListFilesTool implements Tool {
  name = "list_files";
  description = "List files in a directory";
  parameters: Record<string, ParameterDefinition> = {
    path: {
      type: "string",
      description: "Directory path to list",
      required: true,
    },
    recursive: {
      type: "boolean",
      description: "Recursively list subdirectories (default: false)",
      required: false,
      default: false,
    },
  };
  requiresApproval = false;

  async execute(parameters: Record<string, unknown>): Promise<ToolResult> {
    const startTime = Date.now();

    try {
      const dirPath = String(parameters.path);
      const recursive = Boolean(parameters.recursive || false);

      const files = await fs.readdir(dirPath, { recursive });

      return {
        success: true,
        data: { path: dirPath, files, count: files.length },
        executionTime: Date.now() - startTime,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        executionTime: Date.now() - startTime,
      };
    }
  }
}

export class DeleteFileTool implements Tool {
  name = "delete_file";
  description = "Delete a file";
  parameters: Record<string, ParameterDefinition> = {
    path: {
      type: "string",
      description: "Absolute path to the file to delete",
      required: true,
    },
  };
  requiresApproval = true; // Deletion always requires approval

  async execute(parameters: Record<string, unknown>): Promise<ToolResult> {
    const startTime = Date.now();

    try {
      const filePath = String(parameters.path);

      // Safety check: prevent deleting critical files (real resolved-path +
      // segment check — see isSensitivePath() above)
      if (isSensitivePath(filePath)) {
        return {
          success: false,
          error: "Access denied: Cannot delete protected files",
          executionTime: Date.now() - startTime,
        };
      }

      await fs.unlink(filePath);

      return {
        success: true,
        data: { path: filePath, deleted: true },
        executionTime: Date.now() - startTime,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        executionTime: Date.now() - startTime,
      };
    }
  }
}
