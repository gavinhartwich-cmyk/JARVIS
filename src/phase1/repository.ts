/**
 * Repository Tools for Phase 1
 *
 * JARVIS Developer must understand code repositories:
 * - Navigate structure
 * - Understand file organization
 * - Read and analyze code
 * - Identify dependencies
 * - Map relationships
 */

import fs from "fs";
import path from "path";

export interface FileInfo {
  path: string;
  type: "file" | "directory";
  size: number;
  lastModified: Date;
  extension?: string;
}

export interface RepositoryStructure {
  root: string;
  files: FileInfo[];
  directories: string[];
  stats: {
    totalFiles: number;
    totalDirs: number;
    languages: Record<string, number>;
  };
}

/**
 * Repository Explorer - Understand repo structure
 */
export class RepositoryExplorer {
  private root: string;
  private ignoredDirs = [
    "node_modules",
    ".git",
    "dist",
    "build",
    "target",
    ".venv",
    "venv",
    "__pycache__",
  ];

  constructor(rootPath: string) {
    if (!fs.existsSync(rootPath)) {
      throw new Error(`Repository root not found: ${rootPath}`);
    }
    this.root = rootPath;
  }

  /**
   * Get repository structure overview
   */
  async getStructure(maxDepth = 3): Promise<RepositoryStructure> {
    const files: FileInfo[] = [];
    const directories: string[] = [];
    const languages: Record<string, number> = {};

    const walk = (dir: string, depth = 0) => {
      if (depth > maxDepth) return;

      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });

        for (const entry of entries) {
          // Skip ignored directories
          if (entry.isDirectory() && this.ignoredDirs.includes(entry.name)) {
            continue;
          }

          const fullPath = path.join(dir, entry.name);
          const relativePath = path.relative(this.root, fullPath);

          if (entry.isDirectory()) {
            directories.push(relativePath);
            walk(fullPath, depth + 1);
          } else {
            const stat = fs.statSync(fullPath);
            const ext = path.extname(entry.name);

            files.push({
              path: relativePath,
              type: "file",
              size: stat.size,
              lastModified: stat.mtime,
              extension: ext,
            });

            // Count languages
            if (ext) {
              languages[ext] = (languages[ext] || 0) + 1;
            }
          }
        }
      } catch (error) {
        console.warn(`Error reading directory ${dir}:`, error);
      }
    };

    walk(this.root);

    return {
      root: this.root,
      files,
      directories,
      stats: {
        totalFiles: files.length,
        totalDirs: directories.length,
        languages,
      },
    };
  }

  /**
   * Find files by pattern
   */
  async findFiles(pattern: RegExp | string): Promise<string[]> {
    const regex = pattern instanceof RegExp ? pattern : new RegExp(pattern);
    const structure = await this.getStructure();

    return structure.files
      .filter((f) => regex.test(f.path))
      .map((f) => f.path);
  }

  /**
   * Get main language of repository
   */
  async getPrimaryLanguage(): Promise<string> {
    const structure = await this.getStructure();
    let maxExt = "";
    let maxCount = 0;

    for (const [ext, count] of Object.entries(structure.stats.languages)) {
      if (count > maxCount) {
        maxCount = count;
        maxExt = ext;
      }
    }

    return maxExt;
  }

  /**
   * Get repository metadata (package.json, pyproject.toml, etc)
   */
  async getMetadata(): Promise<Record<string, any>> {
    const metadata: Record<string, any> = {};

    // Check for package.json
    const pkgPath = path.join(this.root, "package.json");
    if (fs.existsSync(pkgPath)) {
      metadata.package = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
    }

    // Check for pyproject.toml
    const pyProjPath = path.join(this.root, "pyproject.toml");
    if (fs.existsSync(pyProjPath)) {
      metadata.pyproject = fs.readFileSync(pyProjPath, "utf-8");
    }

    // Check for Cargo.toml
    const cargoPath = path.join(this.root, "Cargo.toml");
    if (fs.existsSync(cargoPath)) {
      metadata.cargo = fs.readFileSync(cargoPath, "utf-8");
    }

    // Check for README
    const readmePath = path.join(this.root, "README.md");
    if (fs.existsSync(readmePath)) {
      metadata.readme = fs.readFileSync(readmePath, "utf-8").slice(0, 1000);
    }

    return metadata;
  }
}

/**
 * Code Reader - Read and parse code files
 */
export class CodeReader {
  /**
   * Read a code file
   */
  static readFile(filePath: string): string {
    if (!fs.existsSync(filePath)) {
      throw new Error(`File not found: ${filePath}`);
    }

    return fs.readFileSync(filePath, "utf-8");
  }

  /**
   * Read file with line numbers
   */
  static readFileWithLines(filePath: string): Array<[number, string]> {
    const content = this.readFile(filePath);
    return content.split("\n").map((line, idx) => [idx + 1, line]);
  }

  /**
   * Get file summary (lines, functions, classes, etc)
   */
  static analyzeFile(filePath: string): {
    lines: number;
    functions: number;
    classes: number;
    imports: number;
  } {
    const content = this.readFile(filePath);
    const lines = content.split("\n").length;

    // Simple pattern matching (not comprehensive but useful)
    const functionCount = (content.match(/^\s*(function|def|const.*=.*=>)/gm) || [])
      .length;
    const classCount = (content.match(/^\s*class\s+/gm) || []).length;
    const importCount = (content.match(/^(import|from|require)\s+/gm) || []).length;

    return {
      lines,
      functions: functionCount,
      classes: classCount,
      imports: importCount,
    };
  }

  /**
   * Extract functions/classes from code
   */
  static extractDefinitions(
    filePath: string
  ): Array<{ name: string; type: string; line: number }> {
    const lines = this.readFileWithLines(filePath);
    const definitions: Array<{ name: string; type: string; line: number }> = [];

    for (const [lineNum, line] of lines) {
      // TypeScript/JavaScript functions
      const funcMatch = line.match(/(export\s+)?(async\s+)?function\s+(\w+)/);
      if (funcMatch) {
        definitions.push({ name: funcMatch[3], type: "function", line: lineNum });
      }

      // Classes
      const classMatch = line.match(/(export\s+)?class\s+(\w+)/);
      if (classMatch) {
        definitions.push({ name: classMatch[2], type: "class", line: lineNum });
      }

      // Interfaces/Types
      const interfaceMatch = line.match(/(export\s+)?(interface|type)\s+(\w+)/);
      if (interfaceMatch) {
        definitions.push({
          name: interfaceMatch[3],
          type: interfaceMatch[2],
          line: lineNum,
        });
      }
    }

    return definitions;
  }
}

/**
 * Dependency Analyzer - Understand code dependencies
 */
export class DependencyAnalyzer {
  /**
   * Extract imports from a file
   */
  static extractImports(filePath: string): string[] {
    const content = CodeReader.readFile(filePath);
    const imports: Set<string> = new Set();

    // ES6 imports
    const es6Imports = content.match(/^import\s+.*?from\s+['"]([^'"]+)['"]/gm);
    if (es6Imports) {
      es6Imports.forEach((imp) => {
        const match = imp.match(/from\s+['"]([^'"]+)['"]/);
        if (match) imports.add(match[1]);
      });
    }

    // CommonJS requires
    const cjsRequires = content.match(/require\(['"]([^'"]+)['"]\)/g);
    if (cjsRequires) {
      cjsRequires.forEach((req) => {
        const match = req.match(/require\(['"]([^'"]+)['"]\)/);
        if (match) imports.add(match[1]);
      });
    }

    return Array.from(imports);
  }

  /**
   * Get all dependencies in a repository
   */
  static async getAllDependencies(rootPath: string): Promise<Set<string>> {
    const explorer = new RepositoryExplorer(rootPath);
    const structure = await explorer.getStructure();
    const allImports: Set<string> = new Set();

    // Find TypeScript/JavaScript files
    const codeFiles = structure.files.filter(
      (f) => f.extension === ".ts" || f.extension === ".js"
    );

    for (const file of codeFiles) {
      try {
        const imports = this.extractImports(path.join(rootPath, file.path));
        imports.forEach((imp) => allImports.add(imp));
      } catch (error) {
        // Skip files that can't be read
      }
    }

    return allImports;
  }
}
