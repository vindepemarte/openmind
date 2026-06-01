import test from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { app } from '../../src/api/server';
import { db } from '../../src/db/client';
import { hashPassword } from '../../src/auth/passwords';

type QueryResult = { rows: any[] };

function setDbQuery(handler: (sql: string, params: any[]) => Promise<QueryResult>) {
    (db as any).query = async (sql: string, params?: any[]) => handler(String(sql), params ?? []);
}

function normalizeSql(sql: string): string {
    return sql.replace(/\s+/g, ' ').trim();
}

function createMissingMetadataError(): Error & { code: string; table: string } {
    const error = new Error('relation "thought_metadata" does not exist') as Error & { code: string; table: string };
    error.code = '42P01';
    error.table = 'thought_metadata';
    return error;
}

async function startTestServer(): Promise<Server> {
    return await new Promise<Server>((resolve) => {
        const server = app.listen(0, () => resolve(server));
    });
}

async function stopTestServer(server: Server): Promise<void> {
    await new Promise<void>((resolve, reject) => {
        server.close((error) => {
            if (error) reject(error);
            else resolve();
        });
    });
}

test('serves authenticated dashboard routes when thought_metadata is missing', async () => {
    const originalQuery = (db as any).query;
    const observedQueries: string[] = [];
    const passwordHash = await hashPassword('openmind');

    try {
        setDbQuery(async (sql) => {
            const normalizedSql = normalizeSql(sql);
            observedQueries.push(normalizedSql);

            if (normalizedSql.includes('SELECT id, is_admin, password_hash FROM users WHERE username = $1')) {
                return { rows: [{ id: 'admin-id', is_admin: true, password_hash: passwordHash }] };
            }

            if (normalizedSql.includes('SELECT id, username, is_admin, created_at FROM users WHERE id = $1')) {
                return { rows: [{ id: 'admin-id', username: 'admin', is_admin: true, created_at: '2026-01-01T00:00:00.000Z' }] };
            }

            if (normalizedSql.includes('SELECT COUNT(*)::int AS total FROM capture_events ce')) {
                return { rows: [{ total: 2 }] };
            }

            if (normalizedSql.includes('COUNT(*) FILTER (WHERE tt.is_completed)::int AS completed')) {
                return { rows: [{ total: 4, completed: 3 }] };
            }

            if (normalizedSql.includes('LEFT JOIN thought_metadata m ON tt.thought_id = m.thought_id')) {
                throw createMissingMetadataError();
            }

            if (
                normalizedSql.includes('FROM thought_tasks tt')
                && normalizedSql.includes("t.thought_type IN ('decision', 'action')")
                && !normalizedSql.includes('LEFT JOIN thought_metadata')
            ) {
                return { rows: [{ total: 1 }] };
            }

            if (normalizedSql.includes('LEFT JOIN thought_metadata m ON t.id = m.thought_id')) {
                throw createMissingMetadataError();
            }

            if (normalizedSql.includes('NULL::TEXT[] AS people, NULL::TEXT[] AS topics')) {
                return {
                    rows: [{
                        id: 'thought-1',
                        content: 'Release checklist',
                        thought_type: 'insight',
                        created_at: '2026-01-01T00:00:00.000Z',
                        people: null,
                        topics: null,
                        summary: 'Release checklist'
                    }]
                };
            }

            if (normalizedSql.includes('SELECT tt.id, tt.content, tt.is_completed, tt.created_at, tt.completed_at, t.thought_type, t.summary')) {
                return {
                    rows: [{
                        id: 'task-1',
                        content: 'Smoke check release',
                        is_completed: false,
                        created_at: '2026-01-01T00:00:00.000Z',
                        completed_at: null,
                        thought_type: 'action',
                        summary: 'Smoke check release'
                    }]
                };
            }

            throw new Error(`Unexpected query: ${normalizedSql}`);
        });

        const server = await startTestServer();

        try {
            const address = server.address() as AddressInfo;
            const baseUrl = `http://127.0.0.1:${address.port}`;
            const authorization = `Basic ${Buffer.from('admin:openmind').toString('base64')}`;
            const authHeaders = { Authorization: authorization };

            const meResponse = await fetch(`${baseUrl}/auth/me`, { headers: authHeaders });
            assert.equal(meResponse.status, 200);
            const mePayload = await meResponse.json();
            assert.equal(mePayload.id, 'admin-id');

            const recentResponse = await fetch(`${baseUrl}/recent?limit=3`, { headers: authHeaders });
            assert.equal(recentResponse.status, 200);
            const recentPayload = await recentResponse.json();
            assert.equal(Array.isArray(recentPayload), true);
            assert.equal(recentPayload.length, 1);

            const kpiResponse = await fetch(`${baseUrl}/api/kpis`, { headers: authHeaders });
            assert.equal(kpiResponse.status, 200);
            const kpiPayload = await kpiResponse.json();
            assert.equal(kpiPayload.unresolvedRiskCount, 1);
            assert.equal(Array.isArray(kpiPayload.suggestions), true);

            const tasksResponse = await fetch(`${baseUrl}/api/tasks?status=open&limit=3`, { headers: authHeaders });
            assert.equal(tasksResponse.status, 200);
            const tasksPayload = await tasksResponse.json();
            assert.equal(Array.isArray(tasksPayload), true);
            assert.equal(tasksPayload.length, 1);
        } finally {
            await stopTestServer(server);
        }

        assert.equal(
            observedQueries.some((query) => query.includes('LEFT JOIN thought_metadata m ON tt.thought_id = m.thought_id')),
            true
        );
        assert.equal(
            observedQueries.some((query) => query.includes('LEFT JOIN thought_metadata m ON t.id = m.thought_id')),
            true
        );
        assert.equal(
            observedQueries.some((query) => query.includes('NULL::TEXT[] AS people, NULL::TEXT[] AS topics')),
            true
        );
        assert.equal(
            observedQueries.some(
                (query) => query.includes("t.thought_type IN ('decision', 'action')") && !query.includes('LEFT JOIN thought_metadata')
            ),
            true
        );
    } finally {
        (db as any).query = originalQuery;
    }
});

test('marks task done for authenticated non-admin users', async () => {
    const originalQuery = (db as any).query;
    const passwordHash = await hashPassword('openmind');
    let observedUpdateSql = '';
    let observedUpdateParams: any[] = [];

    try {
        setDbQuery(async (sql, params) => {
            const normalizedSql = normalizeSql(sql);

            if (normalizedSql.includes('SELECT id, is_admin, password_hash FROM users WHERE username = $1')) {
                return { rows: [{ id: 'user-1', is_admin: false, password_hash: passwordHash }] };
            }

            if (normalizedSql.includes('UPDATE thought_tasks') && normalizedSql.includes('SET is_completed = $1')) {
                observedUpdateSql = normalizedSql;
                observedUpdateParams = [...params];
                return { rows: [{ id: 'task-1', is_completed: true, completed_at: '2026-04-02T00:00:00.000Z' }] };
            }

            throw new Error(`Unexpected query: ${normalizedSql}`);
        });

        const server = await startTestServer();

        try {
            const address = server.address() as AddressInfo;
            const baseUrl = `http://127.0.0.1:${address.port}`;
            const authorization = `Basic ${Buffer.from('admin:openmind').toString('base64')}`;
            const headers = {
                Authorization: authorization,
                'Content-Type': 'application/json',
            };

            const response = await fetch(`${baseUrl}/api/tasks/task-1`, {
                method: 'PUT',
                headers,
                body: JSON.stringify({ isCompleted: true }),
            });

            assert.equal(response.status, 200);
            const payload = await response.json();
            assert.equal(payload.id, 'task-1');
            assert.equal(payload.is_completed, true);

            assert.match(observedUpdateSql, /AND user_id = \$3/);
            assert.deepEqual(observedUpdateParams, [true, 'task-1', 'user-1']);
        } finally {
            await stopTestServer(server);
        }
    } finally {
        (db as any).query = originalQuery;
    }
});
