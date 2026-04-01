type LogLevel = "debug" | "info" | "warn" | "error"
type LogFn = (level: LogLevel, message: string) => void

let logger: LogFn = (level, message) => {
  // Before client is available, fall back to stderr only as last resort.
  // This path should only be hit if pluginLog is called before setPluginLogger.
  process.stderr.write(`[opencode-copilot-plugin] ${level.toUpperCase()}: ${message}\n`)
}

/** Initializes the plugin-wide logger. Must be called once at plugin startup before any discovery runs. */
export function setPluginLogger(fn: LogFn): void {
  logger = fn
}

/** Emits a structured log message through the configured logger. */
export function pluginLog(level: LogLevel, message: string): void {
  logger(level, message)
}
