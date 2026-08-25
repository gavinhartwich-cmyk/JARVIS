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

      // Safety check: prevent reading system files
      if (filePath.includes("/etc") || filePath.includes("/sys")) {
        return {
          success: false,
          error: "Access denied: Cannot read system files",
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

      // Safety check: prevent writing to system areas
      if (filePath.includes("/etc") || filePath.includes("/sys")) {
        return {
          success: false,
          error: "Access denied: Cannot write to system directories",
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

      // Safety check: prevent deleting critical files
      if (
        filePath.includes(".env") ||
        filePath.includes("/etc") ||
        filePath.includes("/sys")
      ) {
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
