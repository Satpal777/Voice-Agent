type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

function currentLevel(): LogLevel {
  const level = (process.env.LOG_LEVEL ?? "info").toLowerCase();
  if (level in LEVEL_PRIORITY) {
    return level as LogLevel;
  }
  return "info";
}

function shouldLog(level: LogLevel): boolean {
  return LEVEL_PRIORITY[level] >= LEVEL_PRIORITY[currentLevel()];
}

function format(component: string, message: string, meta?: Record<string, unknown>): string {
  const time = new Date().toISOString().slice(11, 23);
  if (meta && Object.keys(meta).length > 0) {
    const details = Object.entries(meta)
      .map(([key, value]) => `${key}=${typeof value === "string" ? value : JSON.stringify(value)}`)
      .join(" ");
    return `[${time}] [${component}] ${message} | ${details}`;
  }
  return `[${time}] [${component}] ${message}`;
}

export const log = {
  debug(component: string, message: string, meta?: Record<string, unknown>): void {
    if (shouldLog("debug")) {
      console.log(format(component, message, meta));
    }
  },

  info(component: string, message: string, meta?: Record<string, unknown>): void {
    if (shouldLog("info")) {
      console.log(format(component, message, meta));
    }
  },

  warn(component: string, message: string, meta?: Record<string, unknown>): void {
    if (shouldLog("warn")) {
      console.warn(format(component, message, meta));
    }
  },

  error(component: string, message: string, meta?: Record<string, unknown>): void {
    if (shouldLog("error")) {
      console.error(format(component, message, meta));
    }
  },
};
