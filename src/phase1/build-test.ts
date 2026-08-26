/**
 * Real build/test execution for the Builder and Tester pipeline steps.
 *
 * Deliberately NOT LLM-backed: "does this compile" and "do these tests
 * pass" are objective, mechanically-checkable facts. Asking a model to
 * guess at build/test status (as the original stubs implicitly did by
 * always returning `success: false`) produces exactly the kind of
 * fake-looking, non-actionable result this project has already had to
 * fix once (see the Phase 0 "uniform 70% confidence" bug).
 */

import { execSync } from "child_process";
import fs from "fs";
import path from "path";

export interface BuildResult {
  success: boolean;
  errors: string[];
  warnings: string[];
  output: string;
  durationMs: number;
}

export interface TestResult {
  configured: boolean; // false = no test files found, not a failure
  passed: number;
  failed: number;
  output: string;
  durationMs: number;
}

/**
 * Install dependencies if they're missing. The pipeline operates on repos
 * checked out fresh (e.g. a scratch clone for a feature branch), which have
 * no node_modules — found via a real run where every typecheck failed with
 * "Cannot find type definition file for 'bun-types'" even though the coder's
 * own output was correct. Only runs when node_modules is actually absent,
 * so repeat calls in the same working copy stay cheap.
 */
function ensureDependenciesInstalled(repoRoot: string): void {
  if (!fs.existsSync(path.join(repoRoot, "package.json"))) return;
  if (fs.existsSync(path.join(repoRoot, "node_modules"))) return;
  try {
    execSync("bun install", {
      cwd: repoRoot,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch {
    // Let the actual typecheck/test command surface the real error —
    // an install failure here will just reappear as a clearer failure below.
  }
}

/**
 * Run `bun run typecheck` (tsc --noEmit) against the repo. Falls back to
 * `bunx tsc --noEmit` if no typecheck script is defined in package.json.
 */
export function runTypecheck(repoRoot: string): BuildResult {
  const startTime = Date.now();
  ensureDependenciesInstalled(repoRoot);
  const pkgPath = path.join(repoRoot, "package.json");
  let command = "bunx tsc --noEmit";

  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
      if (pkg.scripts?.typecheck) {
        command = "bun run typecheck";
      } else if (pkg.scripts?.build) {
        command = "bun run build";
      }
    } catch {
      // Malformed package.json — fall through to the bunx default.
    }
  }

  try {
    const output = execSync(command, {
      cwd: repoRoot,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return {
      success: true,
      errors: [],
      warnings: [],
      output,
      durationMs: Date.now() - startTime,
    };
  } catch (error: any) {
    const output = `${error.stdout ?? ""}${error.stderr ?? ""}` || String(error.message ?? error);
    const errors = output
      .split("\n")
      .filter((line: string) => /error/i.test(line))
      .slice(0, 50); // cap so a runaway error dump doesn't blow up prompts/logs
    return {
      success: false,
      errors: errors.length > 0 ? errors : [output.slice(0, 2000)],
      warnings: [],
      output,
      durationMs: Date.now() - startTime,
    };
  }
}

/**
 * Run the repo's test suite, if one exists. Bun's own "0 test files"
 * condition is not a failure — it means the requirement being implemented
 * didn't add tests (or the repo has none yet), which is worth reporting
 * honestly rather than papering over with fabricated pass counts.
 */
export function runTests(repoRoot: string): TestResult {
  const startTime = Date.now();
  ensureDependenciesInstalled(repoRoot);
  const hasTestFiles = walkForTestFiles(repoRoot);

  if (!hasTestFiles) {
    return {
      configured: false,
      passed: 0,
      failed: 0,
      output: "No *.test.ts files found in repository — nothing to run.",
      durationMs: Date.now() - startTime,
    };
  }

  try {
    const output = execSync("bun test", {
      cwd: repoRoot,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return parseTestOutput(output, startTime);
  } catch (error: any) {
    const output = `${error.stdout ?? ""}${error.stderr ?? ""}` || String(error.message ?? error);
    return parseTestOutput(output, startTime);
  }
}

function parseTestOutput(output: string, startTime: number): TestResult {
  const passMatch = output.match(/(\d+)\s+pass/);
  const failMatch = output.match(/(\d+)\s+fail/);
  return {
    configured: true,
    passed: passMatch ? parseInt(passMatch[1], 10) : 0,
    failed: failMatch ? parseInt(failMatch[1], 10) : 0,
    output,
    durationMs: Date.now() - startTime,
  };
}

const IGNORED_DIRS = new Set(["node_modules", ".git", "dist", "build"]);

function walkForTestFiles(root: string, dir: string = root, depth = 0): boolean {
  if (depth > 6) return false;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return false;
  }

  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name)) continue;
      if (walkForTestFiles(root, path.join(dir, entry.name), depth + 1)) return true;
    } else if (/\.test\.(ts|tsx|js|jsx)$/.test(entry.name)) {
      return true;
    }
  }
  return false;
}
