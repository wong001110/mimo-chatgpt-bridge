export function reviewUrlFor(completion, reviewBaseUrl) {
  if (!completion?.reviewToken) throw new Error("Completion review token is missing.");
  return `${String(reviewBaseUrl).replace(/\/$/, "")}/review/${encodeURIComponent(completion.reviewToken)}`;
}

export function buildDesktopReviewPrompt(completion, reviewBaseUrl) {
  const reviewUrl = reviewUrlFor(completion, reviewBaseUrl);
  return `MiMoCode has completed a coding turn.

completionID: ${completion.id}
sessionID: ${completion.sessionId}
iteration: ${completion.iteration}/${completion.maxIterations}
project: ${completion.projectDir}

Use the ChatGPT desktop built-in browser to open this local, capability-scoped review page:
${reviewUrl}

Inspect the assistant report, Git status, diff, latest commit, and test evidence shown on the page. Then submit exactly one action on that page:
1. Approve with a concise verified summary.
2. Request changes with one precise implementation instruction for MiMoCode.
3. Mark it as needing the user when a credential or product decision is required.
4. Stop the loop when the task is unsafe, destructive, or blocked.

Do not invent test results. Do not claim a commit or push unless the evidence shows it. If the built-in browser cannot access the page, report that limitation and leave the completion unchanged.`;
}

export function buildDesktopStatusPrompt(completion, reviewBaseUrl) {
  return `MiMoCode bridge status update.

completionID: ${completion.id}
status: ${completion.status}
iteration: ${completion.iteration}/${completion.maxIterations}

Open the local review page for evidence and any available next action:
${reviewUrlFor(completion, reviewBaseUrl)}`;
}
