type LogLevel = "debug" | "info" | "warn" | "error";

let silent = false;

/** Suppresses all output; used by CLI tools that emit machine-readable stdout. */
export function setLoggerSilent(value: boolean): void {
  silent = value;
}

function emit(level: LogLevel, message: string, fields?: Record<string, unknown>): void {
  if (silent) return;
  const line = JSON.stringify({
    level,
    message,
    ts: new Date().toISOString(),
    ...fields,
  });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export const logger = {
  debug: (message: string, fields?: Record<string, unknown>) => emit("debug", message, fields),
  info: (message: string, fields?: Record<string, unknown>) => emit("info", message, fields),
  warn: (message: string, fields?: Record<string, unknown>) => emit("warn", message, fields),
  error: (message: string, fields?: Record<string, unknown>) => emit("error", message, fields),
};
