import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export function secureEqual(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) return false;
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

export function readBearerToken(header) {
  if (typeof header !== "string") return "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || "";
}

export function verifyBearer(header, expectedToken) {
  if (!expectedToken) return true;
  return secureEqual(readBearerToken(header), expectedToken);
}

export function limitUtf8(text, maxBytes, suffix = "\n...[truncated]") {
  const value = String(text ?? "");
  const buffer = Buffer.from(value, "utf8");
  if (buffer.byteLength <= maxBytes) return value;
  const suffixBuffer = Buffer.from(suffix, "utf8");
  const budget = Math.max(0, maxBytes - suffixBuffer.byteLength);
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let end = Math.min(buffer.byteLength, budget);
  let prefix = "";
  while (end > 0) {
    try {
      prefix = decoder.decode(buffer.subarray(0, end));
      break;
    } catch {
      end -= 1;
    }
  }
  return `${prefix}${suffix}`;
}

const SECRET_PATTERNS = [
  [/\bsk-[A-Za-z0-9_-]{12,}\b/g, "sk-<redacted>"],
  [/\b(?:ghp|github_pat|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{12,}\b/g, "github_<redacted>"],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}\b/gi, "Bearer <redacted>"],
  [
    /\b(API[_ -]?KEY|TOKEN|SECRET|PASSWORD|PRIVATE[_ -]?KEY)\s*[:=]\s*["']?[^\s"']{8,}["']?/gi,
    "$1=<redacted>",
  ],
];

export function redactSecrets(input) {
  let output = String(input ?? "");
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    output = output.replace(pattern, replacement);
  }
  return output;
}

export function redactValue(value, depth = 0) {
  if (depth > 20) return "<redacted: nesting limit>";
  if (typeof value === "string") return redactSecrets(value);
  if (Array.isArray(value)) return value.map((item) => redactValue(item, depth + 1));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, redactValue(item, depth + 1)]),
    );
  }
  return value;
}

function canonicalPath(value) {
  const resolved = path.resolve(value);
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

export function isPathWithinRoots(targetPath, roots) {
  if (!Array.isArray(roots) || roots.length === 0) return true;
  const target = canonicalPath(targetPath);
  return roots.some((root) => {
    const resolvedRoot = canonicalPath(root);
    const relative = path.relative(resolvedRoot, target);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  });
}

export function publicCompletion(completion, { includeDiff = true } = {}) {
  if (!completion) return null;
  const git = completion.git ? { ...completion.git } : null;
  if (git && !includeDiff) {
    delete git.diff;
    delete git.stagedDiff;
    delete git.untrackedDiff;
    delete git.headCommitDiff;
  }
  return {
    id: completion.id,
    rootId: completion.rootId,
    parentId: completion.parentId,
    sessionId: completion.sessionId,
    assistantMessageId: completion.assistantMessageId,
    projectDir: completion.projectDir,
    worktree: completion.worktree,
    assistantText: redactSecrets(completion.assistantText),
    completedAt: completion.completedAt,
    status: completion.status,
    iteration: completion.iteration,
    maxIterations: completion.maxIterations,
    git: git
      ? Object.fromEntries(
          Object.entries(git).map(([key, value]) => [
            key,
            typeof value === "string" ? redactSecrets(value) : value,
          ]),
        )
      : null,
    tests: redactValue(completion.tests),
    review: redactValue(completion.review),
    lastInstruction: completion.lastInstruction
      ? redactSecrets(completion.lastInstruction)
      : null,
    createdAt: completion.createdAt,
    updatedAt: completion.updatedAt,
    triggeredAt: completion.triggeredAt,
  };
}
