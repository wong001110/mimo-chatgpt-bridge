import os from "node:os";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { buildDesktopReviewPrompt, buildDesktopStatusPrompt } from "./prompt.js";

const execFileAsync = promisify(execFile);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function runWithInput(command, args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with ${code}: ${stderr}`));
    });
    child.stdin.end(input);
  });
}

export class DesktopDriver {
  constructor({ config, logger } = {}) {
    this.config = config;
    this.logger = logger;
    this.queue = Promise.resolve();
  }

  isSupported() {
    return ["darwin", "win32"].includes(this.config.platform || os.platform());
  }

  async triggerReview(completion, { statusOnly = false } = {}) {
    if (!this.config.desktopEnabled) return { skipped: true, reason: "disabled" };
    if (!this.isSupported()) {
      throw new Error(`ChatGPT desktop triggering is unsupported on ${this.config.platform}.`);
    }

    const prompt = statusOnly
      ? buildDesktopStatusPrompt(completion, this.config.reviewBaseUrl)
      : buildDesktopReviewPrompt(completion, this.config.reviewBaseUrl);

    this.queue = this.queue.catch(() => {}).then(() => this.#trigger(prompt));
    await this.queue;
    return { skipped: false };
  }

  async #trigger(prompt) {
    const platform = this.config.platform || os.platform();
    this.logger?.info("Triggering ChatGPT desktop", { platform, mode: this.config.desktopMode });
    if (platform === "darwin") return this.#triggerMac(prompt);
    if (platform === "win32") return this.#triggerWindows(prompt);
    throw new Error(`Unsupported platform: ${platform}`);
  }

  async #triggerMac(prompt) {
    const oldClipboard = await execFileAsync("pbpaste", [], { encoding: "utf8" })
      .then(({ stdout }) => stdout)
      .catch(() => "");

    try {
      await runWithInput("pbcopy", [], prompt);
      const openCompanion = this.config.desktopMode === "companion"
        ? 'key code 49 using {option down}'
        : "";
      const submit = this.config.chatgptAutoSubmit ? "key code 36" : "";
      const script = `
        tell application "${this.config.chatgptAppName}" to activate
        delay ${this.config.chatgptOpenDelayMs / 1000}
        tell application "System Events"
          ${openCompanion}
          delay ${this.config.chatgptOpenDelayMs / 1000}
          keystroke "v" using {command down}
          delay ${this.config.chatgptPasteDelayMs / 1000}
          ${submit}
        end tell
      `;
      await execFileAsync("osascript", ["-e", script], { timeout: 15_000 });
    } finally {
      await sleep(500);
      await runWithInput("pbcopy", [], oldClipboard).catch(() => {});
    }
  }

  async #triggerWindows(prompt) {
    const encoded = Buffer.from(prompt, "utf8").toString("base64");
    const modeCompanion = this.config.desktopMode === "companion" ? "$wshell.SendKeys('% ')" : "";
    const submit = this.config.chatgptAutoSubmit ? "$wshell.SendKeys('{ENTER}')" : "";
    const script = `
      $ErrorActionPreference = 'Stop'
      $oldClipboard = Get-Clipboard -Raw -ErrorAction SilentlyContinue
      try {
        $text = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}'))
        Set-Clipboard -Value $text
        $process = Get-Process | Where-Object { $_.MainWindowTitle -like '*${this.config.chatgptAppName}*' } | Select-Object -First 1
        if (-not $process) { throw 'ChatGPT desktop window was not found. Start and sign in to ChatGPT first.' }
        $wshell = New-Object -ComObject WScript.Shell
        if (-not $wshell.AppActivate($process.Id)) { throw 'Could not activate ChatGPT desktop.' }
        Start-Sleep -Milliseconds ${this.config.chatgptOpenDelayMs}
        ${modeCompanion}
        Start-Sleep -Milliseconds ${this.config.chatgptOpenDelayMs}
        $wshell.SendKeys('^v')
        Start-Sleep -Milliseconds ${this.config.chatgptPasteDelayMs}
        ${submit}
      } finally {
        Start-Sleep -Milliseconds 500
        if ($null -ne $oldClipboard) { Set-Clipboard -Value $oldClipboard }
      }
    `;
    await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
      { timeout: 20_000, windowsHide: true },
    );
  }
}
