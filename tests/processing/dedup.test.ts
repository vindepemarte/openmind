import test from 'node:test';
import assert from 'node:assert/strict';

import { generateContentHash, getBulkDuplicateLookup, getDuplicateLookup, getThoughtInsertQuery } from '../../src/processing/dedup';

test('generateContentHash normalizes whitespace and case', () => {
    const a = generateContentHash('  Important Decision   ');
    const b = generateContentHash('important decision');
    const c = generateContentHash('important    decision');

    assert.equal(a, b);
    assert.equal(b, c);
});

test('getDuplicateLookup scopes duplicates to the current user', () => {
    assert.deepEqual(getDuplicateLookup('hash-a', 'user-123'), {
        query: 'SELECT id FROM thoughts WHERE content_hash = $1 AND user_id = $2',
        params: ['hash-a', 'user-123']
    });

    assert.deepEqual(getDuplicateLookup('hash-a'), {
        query: 'SELECT id FROM thoughts WHERE content_hash = $1 AND user_id IS NULL',
        params: ['hash-a']
    });
});

test('getBulkDuplicateLookup scopes preview duplicate checks to the current user', () => {
    assert.deepEqual(getBulkDuplicateLookup(['hash-a', 'hash-b'], 'user-123'), {
        query: 'SELECT content_hash FROM thoughts WHERE content_hash = ANY($1::text[]) AND user_id = $2',
        params: [['hash-a', 'hash-b'], 'user-123']
    });

    assert.deepEqual(getBulkDuplicateLookup(['hash-a']), {
        query: 'SELECT content_hash FROM thoughts WHERE content_hash = ANY($1::text[]) AND user_id IS NULL',
        params: [['hash-a']]
    });
});

test('getThoughtInsertQuery targets the user-scoped unique index when userId is provided', () => {
    const result = getThoughtInsertQuery({
        content: 'Ship pricing page',
        contentHash: 'hash-a',
        source: 'csv-upload',
        thoughtType: 'action',
        summary: 'Ship it',
        userId: 'user-123'
    });

    assert.match(result.query, /ON CONFLICT \(user_id, content_hash\) WHERE user_id IS NOT NULL DO NOTHING/);
    assert.deepEqual(result.params, [
        'Ship pricing page',
        'hash-a',
        'csv-upload',
        'action',
        'Ship it',
        'user-123'
    ]);
});

test('getThoughtInsertQuery targets anonymous uniqueness when userId is omitted', () => {
    const result = getThoughtInsertQuery({
        content: 'Company-wide note',
        contentHash: 'hash-b',
        source: 'system',
        thoughtType: 'other',
        summary: null
    });

    assert.match(result.query, /ON CONFLICT \(content_hash\) WHERE user_id IS NULL DO NOTHING/);
    assert.deepEqual(result.params, [
        'Company-wide note',
        'hash-b',
        'system',
        'other',
        null,
        null
    ]);
});
