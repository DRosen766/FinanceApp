import "server-only";

/**
 * Naive in-memory login throttle. This is a single-user, single-process app, so a global
 * counter is enough: after MAX_FAILURES failed attempts, lock out for LOCKOUT_MS.
 */
const MAX_FAILURES = 5;
const LOCKOUT_MS = 15 * 60 * 1000;

let failures = 0;
let lockedUntil = 0;

export function loginLockedFor(now = Date.now()): number {
  return Math.max(0, lockedUntil - now);
}

export function recordLoginFailure(now = Date.now()): void {
  failures += 1;
  if (failures >= MAX_FAILURES) {
    lockedUntil = now + LOCKOUT_MS;
    failures = 0;
  }
}

export function recordLoginSuccess(): void {
  failures = 0;
  lockedUntil = 0;
}
