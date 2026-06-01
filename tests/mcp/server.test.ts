import test from 'node:test';
import assert from 'node:assert/strict';

import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import { createMcpServer, OPENMIND_MCP_TOOL_NAMES } from '../../src/mcp/server';
import { db } from '../../src/db/client';

function okJsonResponse(payload: any) {
    return {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => payload,
        text: async () => JSON.stringify(payload),
    } as any;
}

async function callPrivateHandler(server: any, method: string, params: any = {}) {
    const handler = server._requestHandlers.get(method);
    assert.equal(typeof handler, 'function', `missing MCP handler for ${method}`);
    return handler({ method, params }, {});
}

test('MCP tool list includes ChatGPT-compatible search and fetch tools', async () => {
    const server = createMcpServer('user-1', false) as any;

    try {
        const result = await callPrivateHandler(server, ListToolsRequestSchema.shape.method.value);
        const toolNames = result.tools.map((tool: any) => tool.name);

        for (const expected of OPENMIND_MCP_TOOL_NAMES) {
            assert.equal(toolNames.includes(expected), true, `${expected} should be exposed`);
        }
    } finally {
        await server.close();
    }
});

test('MCP search returns OpenAI-compatible result objects', async () => {
    const originalQuery = (db as any).query;
    const originalFetch = (global as any).fetch;
    const previousPublicUrl = process.env.OPENMIND_PUBLIC_URL;
    const previousDimensions = process.env.EMBEDDING_DIMENSIONS;
    process.env.OPENMIND_PUBLIC_URL = 'https://theopenmind.pro';
    process.env.EMBEDDING_DIMENSIONS = '3';

    try {
        (global as any).fetch = async (url: string) => {
            assert.equal(url, 'https://openrouter.ai/api/v1/embeddings');
            return okJsonResponse({ data: [{ embedding: [0.1, 0.2, 0.3] }] });
        };

        (db as any).query = async (sql: string, params: any[] = []) => {
            assert.match(String(sql), /JOIN thought_embeddings/);
            assert.match(String(sql), /t\.user_id = \$2/);
            assert.deepEqual(params, ['[0.1,0.2,0.3]', 'user-1', 5]);
            return {
                rows: [{
                    id: 'thought-1',
                    content: 'OpenMind install plan for ChatGPT search and fetch.',
                    thought_type: 'decision',
                    source: 'mcp',
                    summary: 'OpenMind install plan',
                    created_at: '2026-06-01T00:00:00.000Z',
                    updated_at: '2026-06-01T00:00:00.000Z',
                    topics: ['mcp'],
                    people: [],
                    action_items: [],
                    tags: ['release'],
                    similarity: 0.87,
                }]
            };
        };

        const server = createMcpServer('user-1', false) as any;
        try {
            const result = await callPrivateHandler(server, CallToolRequestSchema.shape.method.value, {
                name: 'search',
                arguments: { query: 'install plan' }
            });

            assert.equal(result.content.length, 1);
            assert.equal(result.content[0].type, 'text');
            const payload = JSON.parse(result.content[0].text);
            assert.deepEqual(payload, {
                results: [{
                    id: 'thought-1',
                    title: 'OpenMind install plan',
                    url: 'https://theopenmind.pro/app?thought=thought-1'
                }]
            });
        } finally {
            await server.close();
        }
    } finally {
        (db as any).query = originalQuery;
        (global as any).fetch = originalFetch;
        if (previousPublicUrl === undefined) delete process.env.OPENMIND_PUBLIC_URL;
        else process.env.OPENMIND_PUBLIC_URL = previousPublicUrl;
        if (previousDimensions === undefined) delete process.env.EMBEDDING_DIMENSIONS;
        else process.env.EMBEDDING_DIMENSIONS = previousDimensions;
    }
});

test('MCP fetch returns full thought content and metadata by id', async () => {
    const originalQuery = (db as any).query;
    const previousPublicUrl = process.env.OPENMIND_PUBLIC_URL;
    process.env.OPENMIND_PUBLIC_URL = 'https://theopenmind.pro';

    try {
        (db as any).query = async (sql: string, params: any[] = []) => {
            assert.match(String(sql), /WHERE t\.id = \$1 AND t\.user_id = \$2/);
            assert.deepEqual(params, ['thought-1', 'user-1']);
            return {
                rows: [{
                    id: 'thought-1',
                    content: 'Full saved thought content.',
                    content_hash: 'hash-1',
                    thought_type: 'insight',
                    source: 'mcp',
                    summary: 'Saved thought',
                    created_at: '2026-06-01T00:00:00.000Z',
                    updated_at: '2026-06-01T00:00:00.000Z',
                    people: ['Ada'],
                    topics: ['memory'],
                    action_items: ['Verify connector'],
                    sentiment: 'positive',
                    tags: ['mcp'],
                }]
            };
        };

        const server = createMcpServer('user-1', false) as any;
        try {
            const result = await callPrivateHandler(server, CallToolRequestSchema.shape.method.value, {
                name: 'fetch',
                arguments: { id: 'thought-1' }
            });

            assert.equal(result.content.length, 1);
            assert.equal(result.content[0].type, 'text');
            const payload = JSON.parse(result.content[0].text);
            assert.equal(payload.id, 'thought-1');
            assert.equal(payload.title, 'Saved thought');
            assert.equal(payload.text, 'Full saved thought content.');
            assert.equal(payload.url, 'https://theopenmind.pro/app?thought=thought-1');
            assert.equal(payload.metadata.api_url, 'https://theopenmind.pro/api/thoughts/thought-1');
            assert.deepEqual(payload.metadata.tags, ['mcp']);
            assert.deepEqual(payload.metadata.action_items, ['Verify connector']);
        } finally {
            await server.close();
        }
    } finally {
        (db as any).query = originalQuery;
        if (previousPublicUrl === undefined) delete process.env.OPENMIND_PUBLIC_URL;
        else process.env.OPENMIND_PUBLIC_URL = previousPublicUrl;
    }
});
