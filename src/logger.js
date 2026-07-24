import { redactSecrets } from "./security.js";

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

export function createLogger({ level = "info", sink = console } = {}) {
  const threshold = LEVELS[level] ?? LEVELS.info;

  function write(logLevel, message, extra = undefined) {
    if ((LEVELS[logLevel] ?? 100) < threshold) return;
    const entry = {
      time: new Date().toISOString(),
      level: logLevel,
      message: redactSecrets(message),
    };
    if (extra !== undefined) {
      entry.extra = JSON.parse(redactSecrets(JSON.stringify(extra)));
    }
    const line = JSON.stringify(entry);
    if (logLevel === "error") sink.error(line);
    else if (logLevel === "warn") sink.warn(line);
    else sink.log(line);
  }

  return {
    debug: (message, extra) => write("debug", message, extra),
    info: (message, extra) => write("info", message, extra),
    warn: (message, extra) => write("warn", message, extra),
    error: (message, extra) => write("error", message, extra),
  };
}
