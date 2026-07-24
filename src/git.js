import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { isPathWithinRoots, limitUtf8, redactSecrets } from "./security.js";

const execFileAsync = promisify(execFile);

async function git(cwd, args, { timeout = 15_000, maxBytes = 1_000_000 } = {}) {
  try {
    const { stdout, stderr } = await execFileAsync("git", args, {
      cwd,
      timeout,
      maxBuffer: Math.max(maxBytes * 2, 1024 * 1024),
      windowsHide: true,
      encoding: "utf8",
      env: { ...process.env, GIT_PAGER: "cat", GIT_OPTIONAL_LOCKS: "0" },
    });
    return {
      ok: true,
      stdout: limitUtf8(redactSecrets(stdout.trimEnd()), maxBytes),
      stderr: limitUtf8(redactSecrets(stderr.trimEnd()), Math.min(maxBytes, 50_000)),
    };
  } catch (error) {
    return {
      ok: false,
      stdout: limitUtf8(redactSecrets(error.stdout || ""), maxBytes),
      stderr: limitUtf8(redactSecrets(error.stderr || error.message || "git failed"), 50_000),
      code: error.code,
    };
  }
}

function looksBinary(buffer) {
  const sample = buffer.subarray(0, Math.min(buffer.length, 8192));
  return sample.includes(0);
}

async function collectUntrackedSnapshot(cwd, files, maxBytes) {
  const sections = [];
  let remaining = maxBytes;

  for (const relativePath of files.slice(0, 200)) {
    if (remaining <= 0) break;
    const absolutePath = path.resolve(cwd, relativePath);
    if (!isPathWithinRoots(absolutePath, [cwd])) continue;

    try {
      const stat = await fs.lstat(absolutePath);
      const normalized = relativePath.split(path.sep).join("/");
      if (stat.isSymbolicLink()) {
        const target = await fs.readlink(absolutePath);
        const section = `--- /dev/null\n+++ b/${normalized}\n@@ symlink @@\n+${target}\n`;
        const limited = limitUtf8(redactSecrets(section), remaining);
        sections.push(limited);
        remaining -= Buffer.byteLength(limited, "utf8");
        continue;
      }
      if (!stat.isFile()) continue;

      const perFileLimit = Math.min(remaining, 100_000);
      const handle = await fs.open(absolutePath, "r");
      try {
        const buffer = Buffer.alloc(Math.min(Number(stat.size), perFileLimit + 1));
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        const content = buffer.subarray(0, bytesRead);
        let section;
        if (looksBinary(content)) {
          section = `--- /dev/null\n+++ b/${normalized}\nBinary file (${stat.size} bytes)\n`;
        } else {
          const text = redactSecrets(content.toString("utf8"));
          section = `--- /dev/null\n+++ b/${normalized}\n@@ new file @@\n${text
            .split("\n")
            .map((line) => `+${line}`)
            .join("\n")}\n`;
          if (stat.size > perFileLimit) section += "+...[file truncated]\n";
        }
        const limited = limitUtf8(section, remaining);
        sections.push(limited);
        remaining -= Buffer.byteLength(limited, "utf8");
      } finally {
        await handle.close();
      }
    } catch {
      // The file may disappear between git listing and reading. Its path remains in the list.
    }
  }

  if (files.length > 200 && remaining > 0) {
    sections.push(`...[${files.length - 200} additional untracked files omitted]`);
  }
  return limitUtf8(sections.join("\n"), maxBytes);
}

export async function collectGitSnapshot(cwd, { maxDiffBytes = 200_000 } = {}) {
  const inside = await git(cwd, ["rev-parse", "--is-inside-work-tree"], { maxBytes: 1000 });
  if (!inside.ok || inside.stdout !== "true") {
    return { isGitRepository: false, error: inside.stderr || "Not a Git worktree." };
  }

  const [
    branch,
    head,
    status,
    diffStat,
    diff,
    stagedDiff,
    lastCommit,
    headCommitDiff,
    remote,
    untracked,
  ] = await Promise.all([
    git(cwd, ["branch", "--show-current"], { maxBytes: 10_000 }),
    git(cwd, ["rev-parse", "HEAD"], { maxBytes: 10_000 }),
    git(cwd, ["status", "--short", "--branch"], { maxBytes: 100_000 }),
    git(cwd, ["diff", "--stat", "--no-ext-diff"], { maxBytes: 100_000 }),
    git(cwd, ["diff", "--no-ext-diff", "--unified=3"], { maxBytes: maxDiffBytes }),
    git(cwd, ["diff", "--cached", "--no-ext-diff", "--unified=3"], {
      maxBytes: maxDiffBytes,
    }),
    git(cwd, ["log", "-1", "--pretty=format:%H%n%an%n%aI%n%s"], { maxBytes: 50_000 }),
    git(cwd, ["show", "--format=fuller", "--stat", "--patch", "--no-ext-diff", "HEAD"], {
      maxBytes: maxDiffBytes,
    }),
    git(cwd, ["remote", "get-url", "origin"], { maxBytes: 20_000 }),
    git(cwd, ["ls-files", "--others", "--exclude-standard", "-z"], {
      maxBytes: 500_000,
    }),
  ]);

  const untrackedFiles = untracked.ok
    ? untracked.stdout.split("\0").map((item) => item.trim()).filter(Boolean)
    : [];
  const untrackedDiff = await collectUntrackedSnapshot(cwd, untrackedFiles, maxDiffBytes);

  return {
    isGitRepository: true,
    branch: branch.stdout,
    head: head.stdout,
    status: status.stdout,
    diffStat: diffStat.stdout,
    diff: diff.stdout,
    stagedDiff: stagedDiff.stdout,
    untrackedFiles,
    untrackedDiff,
    lastCommit: lastCommit.stdout,
    headCommitDiff: headCommitDiff.stdout,
    remote: remote.ok ? remote.stdout : "",
  };
}
