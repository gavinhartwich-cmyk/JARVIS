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

import { execSync } from "child_process";
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
   * Execute git command
   */
  private exec(command: string): string {
    try {
      return execSync(`cd "${this.repoPath}" && git ${command}`, {
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      }).trim();
    } catch (error) {
      throw new Error(
        `Git command failed: ${command}\n${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Get current repository status
   */
  async getStatus(): Promise<GitStatus> {
    try {
      const branch = this.exec("branch --show-current");
      const statusOutput = this.exec(
        'status --porcelain=v2 --branch --untracked-files=all'
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
   */
  async createBranch(branchName: string, baseBranch = "main"): Promise<void> {
    try {
      this.exec(`checkout ${baseBranch}`);
      this.exec(`pull origin ${baseBranch}`);
      this.exec(`checkout -b ${branchName}`);
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
      this.exec("add -A");
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
      this.exec(`commit -m "${message}"`);

      // Get commit info
      const hash = this.exec("rev-parse HEAD").substring(0, 7);
      const author = this.exec("config user.name");
      const date = new Date(this.exec("log -1 --format=%ai"));
      const fullMessage = this.exec("log -1 --format=%B");

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
      const forceFlag = force ? "--force-with-lease" : "";
      this.exec(`push origin ${branchName} ${forceFlag}`.trim());
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
        `log ${baseBranch}..HEAD --format="%H|%an|%ai|%B"`
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
      this.exec(`rev-parse --verify ${branchName}`);
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
      this.exec(`branch ${forceFlag} ${branchName}`);
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
      const output = this.exec(`log -${count} --format="%H|%an|%ai|%B"`);

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
      return this.exec(`diff ${fromRef} ${toRef}`);
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
      this.exec("diff --quiet");
      return false;
    } catch {
      return true;
    }
  }
}
