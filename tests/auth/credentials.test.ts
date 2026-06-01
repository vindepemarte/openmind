import test from 'node:test';
import assert from 'node:assert/strict';

import {
    normalizeUsername,
    passwordPolicySummary,
    validatePasswordPolicy,
    validateUsername
} from '../../src/auth/credentials';

test('normalizeUsername trims string inputs', () => {
    assert.equal(normalizeUsername('  alice  '), 'alice');
    assert.equal(normalizeUsername(42), '');
});

test('validateUsername enforces allowed characters and length', () => {
    assert.equal(validateUsername('valid.user-name_1'), null);
    assert.equal(validateUsername('ab'), 'username must be between 3 and 64 characters');
    assert.equal(
        validateUsername('bad user'),
        'username may only contain letters, numbers, dots, underscores, and hyphens'
    );
});

test('validatePasswordPolicy requires mixed-case alphanumeric passwords', () => {
    assert.equal(validatePasswordPolicy('StrongPass1'), null);
    assert.equal(validatePasswordPolicy('short1A'), 'password must be at least 10 characters');
    assert.equal(validatePasswordPolicy('alllowercase1'), 'password must include at least one uppercase letter');
    assert.equal(validatePasswordPolicy('ALLUPPERCASE1'), 'password must include at least one lowercase letter');
    assert.equal(validatePasswordPolicy('NoDigitsHere'), 'password must include at least one number');
    assert.match(passwordPolicySummary(), /at least 10 characters/i);
});
