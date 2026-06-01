import type { Request } from 'express';

type AttemptEntry = {
    count: number;
    firstFailureAt: number;
    lockedUntil: number;
};

export type LoginThrottleStatus = {
    blocked: boolean;
    remainingAttempts: number;
    retryAfterSeconds: number;
};

const MAX_ATTEMPTS = 5;
const WINDOW_MS = 15 * 60 * 1000;
const LOCKOUT_MS = 10 * 60 * 1000;
const MAX_TRACKED_KEYS = 5000;

const attempts = new Map<string, AttemptEntry>();

function now(): number {
    return Date.now();
}

function trimAttempts(nowMs: number): void {
    if (attempts.size <= MAX_TRACKED_KEYS) {
        return;
    }

    for (const [key, entry] of attempts) {
        if (entry.lockedUntil <= nowMs && nowMs - entry.firstFailureAt > WINDOW_MS) {
            attempts.delete(key);
        }
    }
}

function resolveEntry(attemptKey: string, nowMs: number): AttemptEntry {
    const existing = attempts.get(attemptKey);
    if (!existing) {
        return { count: 0, firstFailureAt: nowMs, lockedUntil: 0 };
    }

    if (existing.lockedUntil > 0 && existing.lockedUntil <= nowMs) {
        return { count: 0, firstFailureAt: nowMs, lockedUntil: 0 };
    }

    if (nowMs - existing.firstFailureAt > WINDOW_MS) {
        return { count: 0, firstFailureAt: nowMs, lockedUntil: 0 };
    }

    return existing;
}

function statusFromEntry(entry: AttemptEntry, nowMs: number): LoginThrottleStatus {
    if (entry.lockedUntil > nowMs) {
        return {
            blocked: true,
            remainingAttempts: 0,
            retryAfterSeconds: Math.max(1, Math.ceil((entry.lockedUntil - nowMs) / 1000)),
        };
    }

    return {
        blocked: false,
        remainingAttempts: Math.max(0, MAX_ATTEMPTS - entry.count),
        retryAfterSeconds: 0,
    };
}

export function getRequestIp(req: Request): string {
    const forwarded = req.get('x-forwarded-for');
    if (forwarded) {
        return forwarded.split(',')[0].trim();
    }
    return req.ip || 'unknown';
}

export function buildLoginAttemptKey(username: string, req: Request): string {
    return `${username.toLowerCase()}|${getRequestIp(req)}`;
}

export function getLoginThrottleStatus(attemptKey: string): LoginThrottleStatus {
    const nowMs = now();
    const entry = resolveEntry(attemptKey, nowMs);
    attempts.set(attemptKey, entry);
    trimAttempts(nowMs);
    return statusFromEntry(entry, nowMs);
}

export function recordFailedLoginAttempt(attemptKey: string): LoginThrottleStatus {
    const nowMs = now();
    const entry = resolveEntry(attemptKey, nowMs);
    entry.count += 1;

    if (entry.count >= MAX_ATTEMPTS) {
        entry.lockedUntil = nowMs + LOCKOUT_MS;
    }

    attempts.set(attemptKey, entry);
    trimAttempts(nowMs);
    return statusFromEntry(entry, nowMs);
}

export function clearLoginAttempts(attemptKey: string): void {
    attempts.delete(attemptKey);
}

// Test helper.
export function resetLoginAttemptStore(): void {
    attempts.clear();
}
