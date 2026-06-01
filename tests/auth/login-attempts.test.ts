import test from 'node:test';
import assert from 'node:assert/strict';

import {
    buildLoginAttemptKey,
    clearLoginAttempts,
    getLoginThrottleStatus,
    recordFailedLoginAttempt,
    resetLoginAttemptStore
} from '../../src/auth/login-attempts';

function createRequest(ip: string, forwardedFor?: string): any {
    return {
        ip,
        get(name: string) {
            if (name.toLowerCase() === 'x-forwarded-for') {
                return forwardedFor;
            }
            return undefined;
        }
    };
}

test('buildLoginAttemptKey prefers x-forwarded-for when available', () => {
    resetLoginAttemptStore();
    const key = buildLoginAttemptKey('Alice', createRequest('127.0.0.1', '203.0.113.8, 10.0.0.1'));
    assert.equal(key, 'alice|203.0.113.8');
});

test('recordFailedLoginAttempt blocks after repeated failures and can be cleared', () => {
    resetLoginAttemptStore();
    const key = buildLoginAttemptKey('alice', createRequest('127.0.0.1'));

    for (let i = 0; i < 4; i += 1) {
        const status = recordFailedLoginAttempt(key);
        assert.equal(status.blocked, false);
        assert.equal(status.remainingAttempts, 4 - i);
    }

    const blockedStatus = recordFailedLoginAttempt(key);
    assert.equal(blockedStatus.blocked, true);
    assert.equal(blockedStatus.remainingAttempts, 0);
    assert.ok(blockedStatus.retryAfterSeconds > 0);

    clearLoginAttempts(key);
    const resetStatus = getLoginThrottleStatus(key);
    assert.equal(resetStatus.blocked, false);
    assert.equal(resetStatus.remainingAttempts, 5);
});
