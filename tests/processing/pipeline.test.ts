import test from 'node:test';
import assert from 'node:assert/strict';

import { captureThought } from '../../src/processing/pipeline';
import * as dbClient from '../../src/db/client';

function okJsonResponse(payload: any) {
    return {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => payload,
        text: async () => JSON.stringify(payload),
    } as any;
}

test('captureThought is idempotent per user and still allows the same content for another user', async () => {
    const originalQuery = (dbClient.db as any).query;
    const originalConnect = (dbClient.db as any).connect;
    const originalFetch = (global as any).fetch;

    try {
        const createdUsers = new Set<string>();
        const duplicateCaptureEvents: Array<{ sql: string; params: any[] }> = [];
        const transactionStatements: Array<{ sql: string; params: any[] }> = [];

        (dbClient.db as any).query = async (sql: string, params: any[] = []) => {
            const query = String(sql);

            if (query.includes('SELECT id FROM thoughts WHERE content_hash = $1')) {
                const userId = params[1] || 'anonymous';
                return createdUsers.has(userId)
                    ? { rows: [{ id: `thought-${userId}` }] }
                    : { rows: [] };
            }

            if (query.includes('INSERT INTO capture_events')) {
                duplicateCaptureEvents.push({ sql: query, params });
                return { rows: [] };
            }

            throw new Error(`Unexpected db.query call: ${query}`);
        };

        (dbClient.db as any).connect = async () => {
            const client = {
                query: async (sql: string, params: any[] = []) => {
                    const query = String(sql);

                    if (query === 'BEGIN' || query === 'COMMIT' || query === 'ROLLBACK') {
                        return { rows: [] };
                    }

                    transactionStatements.push({ sql: query, params });

                    if (query.includes('INSERT INTO thoughts')) {
                        const userId = params[5] || 'anonymous';
                        createdUsers.add(userId);
                        return { rows: [{ id: `thought-${userId}` }] };
                    }

                    return { rows: [] };
                },
                release: () => {}
            };

            return client;
        };

        (global as any).fetch = async (url: string) => {
            if (url.includes('/chat/completions')) {
                return okJsonResponse({
                    choices: [{
                        message: {
                            content: JSON.stringify({
                                type: 'action',
                                people: [],
                                topics: ['launch'],
                                action_items: ['Follow up with team', 'Follow up with team'],
                                sentiment: 'negative',
                                summary: 'Follow up task'
                            })
                        }
                    }]
                });
            }

            if (url.includes('/embeddings')) {
                return okJsonResponse({
                    data: [{ embedding: [0.1, 0.2, 0.3] }]
                });
            }

            throw new Error(`Unexpected fetch URL: ${url}`);
        };

        const first = await captureThought('Follow up with team', { source: 'test-import', userId: 'user-1' });
        const second = await captureThought('Follow up with team', { source: 'test-import', userId: 'user-1' });
        const third = await captureThought('Follow up with team', { source: 'test-import', userId: 'user-2' });

        assert.equal(first.status, 'created');
        assert.equal(second.status, 'duplicate');
        assert.equal(third.status, 'created');

        const executedSql = transactionStatements.map(statement => statement.sql).join('\n');
        assert.match(executedSql, /INSERT INTO thoughts/);
        assert.match(executedSql, /INSERT INTO thought_embeddings/);
        assert.match(executedSql, /INSERT INTO thought_metadata/);
        assert.match(executedSql, /INSERT INTO thought_tasks/);
        assert.match(executedSql, /INSERT INTO capture_events/);

        assert.equal(
            duplicateCaptureEvents.filter(event => event.params[3] === 'duplicate').length,
            1
        );
    } finally {
        (dbClient.db as any).query = originalQuery;
        (dbClient.db as any).connect = originalConnect;
        (global as any).fetch = originalFetch;
    }
});

test('captureThought handles insert conflicts by returning duplicate without partial writes', async () => {
    const originalQuery = (dbClient.db as any).query;
    const originalConnect = (dbClient.db as any).connect;
    const originalFetch = (global as any).fetch;

    try {
        const transactionStatements: Array<{ sql: string; params: any[] }> = [];

        (dbClient.db as any).query = async (sql: string, params: any[] = []) => {
            const query = String(sql);

            if (query.includes('SELECT id FROM thoughts WHERE content_hash = $1')) {
                return { rows: [] };
            }

            if (query.includes('INSERT INTO capture_events')) {
                return { rows: [] };
            }

            throw new Error(`Unexpected db.query call: ${query}`);
        };

        (dbClient.db as any).connect = async () => {
            const client = {
                query: async (sql: string, params: any[] = []) => {
                    const query = String(sql);

                    if (query === 'BEGIN' || query === 'COMMIT' || query === 'ROLLBACK') {
                        return { rows: [] };
                    }

                    transactionStatements.push({ sql: query, params });

                    if (query.includes('INSERT INTO thoughts')) {
                        return { rows: [] };
                    }

                    if (query.includes('SELECT id FROM thoughts WHERE content_hash = $1')) {
                        return { rows: [{ id: 'existing-thought' }] };
                    }

                    if (query.includes('INSERT INTO capture_events')) {
                        return { rows: [] };
                    }

                    throw new Error(`Unexpected transactional query: ${query}`);
                },
                release: () => {}
            };

            return client;
        };

        (global as any).fetch = async (url: string) => {
            if (url.includes('/chat/completions')) {
                return okJsonResponse({
                    choices: [{
                        message: {
                            content: JSON.stringify({
                                type: 'insight',
                                people: [],
                                topics: ['dedup'],
                                action_items: [],
                                sentiment: 'neutral',
                                summary: 'Metadata for duplicate conflict path'
                            })
                        }
                    }]
                });
            }

            if (url.includes('/embeddings')) {
                return okJsonResponse({
                    data: [{ embedding: [0.1, 0.2, 0.3] }]
                });
            }

            throw new Error(`Unexpected fetch URL: ${url}`);
        };

        const result = await captureThought('Concurrent duplicate write', {
            source: 'test-conflict',
            userId: 'user-1'
        });

        assert.equal(result.status, 'duplicate');
        assert.equal(result.id, 'existing-thought');

        const executedSql = transactionStatements.map(statement => statement.sql).join('\n');
        assert.match(executedSql, /INSERT INTO thoughts/);
        assert.match(executedSql, /INSERT INTO capture_events/);
        assert.doesNotMatch(executedSql, /INSERT INTO thought_embeddings/);
        assert.doesNotMatch(executedSql, /INSERT INTO thought_metadata/);
    } finally {
        (dbClient.db as any).query = originalQuery;
        (dbClient.db as any).connect = originalConnect;
        (global as any).fetch = originalFetch;
    }
});

test('captureThought normalizes metadata, source, and tags before persistence', async () => {
    const originalQuery = (dbClient.db as any).query;
    const originalConnect = (dbClient.db as any).connect;
    const originalFetch = (global as any).fetch;

    try {
        const transactionStatements: Array<{ sql: string; params: any[] }> = [];

        (dbClient.db as any).query = async (sql: string) => {
            const query = String(sql);

            if (query.includes('SELECT id FROM thoughts WHERE content_hash = $1')) {
                return { rows: [] };
            }

            if (query.includes('INSERT INTO capture_events')) {
                return { rows: [] };
            }

            throw new Error(`Unexpected db.query call: ${query}`);
        };

        (dbClient.db as any).connect = async () => {
            const client = {
                query: async (sql: string, params: any[] = []) => {
                    const query = String(sql);

                    if (query === 'BEGIN' || query === 'COMMIT' || query === 'ROLLBACK') {
                        return { rows: [] };
                    }

                    transactionStatements.push({ sql: query, params });

                    if (query.includes('INSERT INTO thoughts')) {
                        return { rows: [{ id: 'thought-normalized' }] };
                    }

                    return { rows: [] };
                },
                release: () => {}
            };

            return client;
        };

        (global as any).fetch = async (url: string) => {
            if (url.includes('/chat/completions')) {
                return okJsonResponse({
                    choices: [{
                        message: {
                            content: JSON.stringify({
                                type: '   ',
                                people: [' Alice ', 'alice', 42, null, ''],
                                topics: [' Product ', 'product', 'Roadmap'],
                                action_items: [' Follow up ', 'follow up', {}, ''],
                                sentiment: 'confused',
                                summary: '   '
                            })
                        }
                    }]
                });
            }

            if (url.includes('/embeddings')) {
                return okJsonResponse({
                    data: [{ embedding: [0.1, 0.2, 0.3] }]
                });
            }

            throw new Error(`Unexpected fetch URL: ${url}`);
        };

        const result = await captureThought('Normalize me', {
            source: ' '.repeat(10),
            userId: 'user-1',
            tags: [' Launch ', 'launch', 'x'.repeat(80)]
        });

        assert.equal(result.status, 'created');

        const thoughtInsert = transactionStatements.find(statement => statement.sql.includes('INSERT INTO thoughts'));
        assert.ok(thoughtInsert);
        assert.equal(thoughtInsert.params[2], 'unknown');
        assert.equal(thoughtInsert.params[3], 'other');
        assert.equal(thoughtInsert.params[4], 'Normalize me');

        const metadataInsert = transactionStatements.find(statement => statement.sql.includes('INSERT INTO thought_metadata'));
        assert.ok(metadataInsert);
        assert.deepEqual(metadataInsert.params[1], ['Alice']);
        assert.deepEqual(metadataInsert.params[2], ['Product', 'Roadmap']);
        assert.deepEqual(metadataInsert.params[3], ['Follow up']);
        assert.equal(metadataInsert.params[4], 'neutral');

        const tagStatements = transactionStatements.filter(statement => statement.sql.includes('INSERT INTO thought_tags'));
        assert.equal(tagStatements.length, 2);
        assert.deepEqual(
            tagStatements.map(statement => statement.params[1]).sort(),
            ['launch', 'x'.repeat(50)].sort()
        );
    } finally {
        (dbClient.db as any).query = originalQuery;
        (dbClient.db as any).connect = originalConnect;
        (global as any).fetch = originalFetch;
    }
});
