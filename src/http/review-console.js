import { publicCompletion } from "../security.js";

const ACTIONABLE_STATUSES = new Set(["pending", "reviewing", "waiting_user"]);
const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function hostWithoutPort(value = "") {
  if (value.startsWith("[")) return value.slice(1, value.indexOf("]")).toLowerCase();
  return value.split(":")[0].toLowerCase();
}

function isLocalRequest(req) {
  return LOCAL_HOSTS.has(hostWithoutPort(req.headers.host || ""));
}

function hasLocalOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return LOCAL_HOSTS.has(new URL(origin).hostname.toLowerCase());
  } catch {
    return false;
  }
}

async function readForm(req, maxBytes = 65_536) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) {
      const error = new Error("Review action is too large.");
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
}

function renderPage(completion, { message = "" } = {}) {
  const publicValue = publicCompletion(completion, { includeDiff: true });
  const evidence = JSON.stringify(publicValue, null, 2);
  const actionable = ACTIONABLE_STATUSES.has(completion.status);
  const notice = message
    ? `<div class="notice">${escapeHtml(message)}</div>`
    : "";
  const disabled = actionable ? "" : "disabled";
  const terminalNote = actionable
    ? "Choose exactly one action after reviewing the evidence."
    : `This completion is no longer actionable (status: ${escapeHtml(completion.status)}).`;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>MiMoCode Review ${escapeHtml(completion.id)}</title>
  <style>
    :root { color-scheme: light dark; font-family: ui-sans-serif, system-ui, sans-serif; }
    body { max-width: 1100px; margin: 0 auto; padding: 28px 20px 60px; line-height: 1.5; }
    h1, h2 { line-height: 1.2; }
    .meta { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 8px; margin: 16px 0; }
    .card { border: 1px solid #8886; border-radius: 12px; padding: 16px; margin: 16px 0; }
    .notice { border-left: 4px solid currentColor; padding: 10px 14px; margin: 16px 0; font-weight: 600; }
    pre { white-space: pre-wrap; overflow-wrap: anywhere; max-height: 55vh; overflow: auto; padding: 14px; border-radius: 8px; background: #8881; }
    textarea { width: 100%; min-height: 110px; box-sizing: border-box; padding: 10px; }
    button { margin-top: 10px; padding: 9px 14px; font-weight: 600; cursor: pointer; }
    button[disabled], textarea[disabled] { opacity: .55; cursor: not-allowed; }
    .actions { display: grid; grid-template-columns: repeat(auto-fit, minmax(290px, 1fr)); gap: 16px; }
    code { overflow-wrap: anywhere; }
  </style>
</head>
<body>
  <h1>MiMoCode completion review</h1>
  ${notice}
  <p>${terminalNote}</p>
  <div class="meta">
    <div><strong>Completion</strong><br><code>${escapeHtml(completion.id)}</code></div>
    <div><strong>Status</strong><br>${escapeHtml(completion.status)}</div>
    <div><strong>Iteration</strong><br>${completion.iteration}/${completion.maxIterations}</div>
    <div><strong>Project</strong><br><code>${escapeHtml(completion.projectDir)}</code></div>
  </div>

  <section class="card">
    <h2>Evidence</h2>
    <pre>${escapeHtml(evidence)}</pre>
  </section>

  <section class="actions">
    <form class="card" method="post" action="/review/${escapeHtml(completion.reviewToken)}/action">
      <h2>Approve</h2>
      <input type="hidden" name="action" value="approve">
      <label>Concise verified summary</label>
      <textarea name="summary" required maxlength="10000" ${disabled}></textarea>
      <button type="submit" ${disabled}>Approve completion</button>
    </form>

    <form class="card" method="post" action="/review/${escapeHtml(completion.reviewToken)}/action">
      <h2>Request changes</h2>
      <input type="hidden" name="action" value="instruction">
      <label>One precise implementation instruction for MiMoCode</label>
      <textarea name="instruction" required maxlength="30000" ${disabled}></textarea>
      <button type="submit" ${disabled}>Send to MiMoCode</button>
    </form>

    <form class="card" method="post" action="/review/${escapeHtml(completion.reviewToken)}/action">
      <h2>Needs user</h2>
      <input type="hidden" name="action" value="needs_user">
      <label>What decision or credential is required?</label>
      <textarea name="summary" required maxlength="10000" ${disabled}></textarea>
      <button type="submit" ${disabled}>Mark as needs user</button>
    </form>

    <form class="card" method="post" action="/review/${escapeHtml(completion.reviewToken)}/action">
      <h2>Stop loop</h2>
      <input type="hidden" name="action" value="stop">
      <label>Reason the loop must stop</label>
      <textarea name="reason" required maxlength="10000" ${disabled}></textarea>
      <button type="submit" ${disabled}>Stop</button>
    </form>
  </section>
</body>
</html>`;
}

function sendHtml(res, status, html) {
  res.statusCode = status;
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.setHeader(
    "content-security-policy",
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  );
  res.setHeader("referrer-policy", "no-referrer");
  res.end(html);
}

export async function handleReviewConsole(req, res, url, { store, actions }) {
  const match = url.pathname.match(/^\/review\/([A-Za-z0-9_-]{20,})(?:\/action)?$/);
  if (!match) return false;

  if (!isLocalRequest(req) || !hasLocalOrigin(req)) {
    sendHtml(res, 403, "<!doctype html><title>Forbidden</title><h1>Local access only</h1>");
    return true;
  }

  const completion = store.getByReviewToken(match[1]);
  if (!completion) {
    sendHtml(res, 404, "<!doctype html><title>Not found</title><h1>Review not found</h1>");
    return true;
  }

  if (req.method === "GET" && !url.pathname.endsWith("/action")) {
    sendHtml(res, 200, renderPage(completion));
    return true;
  }

  if (req.method !== "POST" || !url.pathname.endsWith("/action")) {
    sendHtml(res, 405, "<!doctype html><title>Method not allowed</title><h1>Method not allowed</h1>");
    return true;
  }

  if (!ACTIONABLE_STATUSES.has(completion.status)) {
    sendHtml(res, 409, renderPage(completion, { message: "This completion is no longer actionable." }));
    return true;
  }

  const form = await readForm(req);
  const action = form.get("action");
  let updated;
  let message;

  if (action === "approve") {
    const summary = String(form.get("summary") || "").trim();
    if (!summary) throw Object.assign(new Error("Approval summary is required."), { statusCode: 400 });
    updated = actions.markReviewed(completion.id, "approved", summary, {
      source: "chatgpt_desktop_review_page",
    });
    message = "Completion approved.";
  } else if (action === "needs_user") {
    const summary = String(form.get("summary") || "").trim();
    if (!summary) throw Object.assign(new Error("Needs-user summary is required."), { statusCode: 400 });
    updated = actions.markReviewed(completion.id, "needs_user", summary, {
      source: "chatgpt_desktop_review_page",
    });
    message = "Completion marked as needing user input.";
  } else if (action === "instruction") {
    const instruction = String(form.get("instruction") || "").trim();
    if (!instruction) throw Object.assign(new Error("Instruction is required."), { statusCode: 400 });
    if (instruction.length > 30_000) {
      throw Object.assign(new Error("Instruction is too long."), { statusCode: 413 });
    }
    updated = await actions.sendInstruction(completion.id, instruction, {
      source: "chatgpt_desktop_review_page",
    });
    message = "Instruction sent to MiMoCode.";
  } else if (action === "stop") {
    const reason = String(form.get("reason") || "").trim();
    if (!reason) throw Object.assign(new Error("Stop reason is required."), { statusCode: 400 });
    updated = actions.stop(completion.id, reason, { source: "chatgpt_desktop_review_page" });
    message = "Automatic loop stopped.";
  } else {
    throw Object.assign(new Error("Unknown review action."), { statusCode: 400 });
  }

  sendHtml(res, 200, renderPage(updated, { message }));
  return true;
}
