/**
 * Logger — log-level system with production stripping
 *
 * In development: all log levels are printed.
 * In production:  only `warn` and `error` are printed (debug/info stripped).
 *
 * Usage:
 *   import { log } from '@/utils/logger';
 *   log.debug('[Module]', 'detail');   // stripped in production
 *   log.info('[Module]', 'message');   // stripped in production
 *   log.warn('[Module]', 'warning');   // kept in production
 *   log.error('[Module]', 'failure');  // kept in production
 */

type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
  silent: 4,
};

// __LOG_LEVEL__ is replaced by Vite define at build time.
// In production it becomes 'warn', in dev it becomes 'debug'.
const currentLevel: LogLevel =
  (typeof __LOG_LEVEL__ !== 'undefined' ? __LOG_LEVEL__ : 'debug') as LogLevel;

const minPriority = LEVEL_PRIORITY[currentLevel] ?? 0;

function noop(..._args: unknown[]) { /* stripped */ }

function createLogger(level: LogLevel, fn: (...args: unknown[]) => void) {
  return LEVEL_PRIORITY[level] >= minPriority ? fn : noop;
}

export const log = {
  debug: createLogger('debug', console.log.bind(console)),
  info:  createLogger('info', console.info.bind(console)),
  warn:  createLogger('warn', console.warn.bind(console)),
  error: createLogger('error', console.error.bind(console)),
};

// Type declaration for the Vite define replacement
declare const __LOG_LEVEL__: string;
