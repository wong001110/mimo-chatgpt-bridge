import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { collectGitSnapshot } from "../src/git.js";

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

test("collectGitSnapshot captures branch, commit, status, and diff", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "mimo-git-"));
  git(cwd, "init", "-b", "main");
  git(cwd, "config", "user.email", "test@example.com");
  git(cwd, "config", "user.name", "Test User");
  fs.writeFileSync(path.join(cwd, "file.txt"), "one\n");
  git(cwd, "add", "file.txt");
  git(cwd, "commit", "-m", "Initial");
  fs.writeFileSync(path.join(cwd, "file.txt"), "one\ntwo\n");
  fs.writeFileSync(path.join(cwd, "new.txt"), "new file\n");

  const snapshot = await collectGitSnapshot(cwd, { maxDiffBytes: 50_000 });
  assert.equal(snapshot.isGitRepository, true);
  assert.equal(snapshot.branch, "main");
  assert.match(snapshot.head, /^[0-9a-f]{40}$/);
  assert.match(snapshot.status, /file\.txt/);
  assert.match(snapshot.diff, /\+two/);
  assert.deepEqual(snapshot.untrackedFiles, ["new.txt"]);
  assert.match(snapshot.untrackedDiff, /new file/);
  assert.match(snapshot.lastCommit, /Initial/);
  assert.match(snapshot.headCommitDiff, /Initial/);
  assert.match(snapshot.headCommitDiff, /\+one/);
});

test("collectGitSnapshot handles non-repositories", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "mimo-not-git-"));
  const snapshot = await collectGitSnapshot(cwd);
  assert.equal(snapshot.isGitRepository, false);
});
