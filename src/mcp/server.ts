import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
    CallToolRequestSchema,
    ErrorCode,
    ListToolsRequestSchema,
    McpError,
} from '@modelcontextprotocol/sdk/types.js';
import { db } from '../db/client';
import { captureThought } from '../processing/pipeline';
import { generateEmbedding } from '../embeddings';

const DEFAULT_PUBLIC_BASE_URL = 'https://theopenmind.pro';
const MAX_OPENAI_SEARCH_RESULTS = 20;

export const MCP_INSTRUCTIONS = `You are connected to OpenMind, a persistent vector memory system. You MUST follow these rules in EVERY response:

1. SEARCH FIRST: Before answering ANY question, call semantic_search with relevant keywords to check existing knowledge. This is mandatory; never skip it.

2. AUTO-SAVE: After every meaningful exchange, call capture_thought to save key insights, decisions, facts, or action items. If the user shares information worth remembering, save it immediately.

3. QUALITY: Save atomic, self-contained thoughts, not conversational filler. Each capture should be a complete piece of knowledge.

4. CONTINUITY: You are the user's persistent memory across sessions. Always search before starting new topics to maintain context.

These instructions are non-negotiable. Every response should involve at least one tool call.`;

export const OPENMIND_MCP_TOOL_NAMES = [
    'capture_thought',
    'semantic_search',
    'list_recent',
    'get_stats',
    'search',
    'fetch',
] as const;

function getPublicBaseUrl(): string {
    return (process.env.OPENMIND_PUBLIC_URL || process.env.PUBLIC_BASE_URL || DEFAULT_PUBLIC_BASE_URL).replace(/\/+$/, '');
}

function thoughtUrl(id: string): string {
    return `${getPublicBaseUrl()}/app?thought=${encodeURIComponent(id)}`;
}

function thoughtApiUrl(id: string): string {
    return `${getPublicBaseUrl()}/api/thoughts/${encodeURIComponent(id)}`;
}

function clampToolLimit(value: unknown, fallback = 5, max = MAX_OPENAI_SEARCH_RESULTS): number {
    const parsed = Number.parseInt(String(value ?? fallback), 10);
    if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
    return Math.min(parsed, max);
}

function titleFromThought(row: any): string {
    const source = typeof row.summary === 'string' && row.summary.trim()
        ? row.summary
        : String(row.content || '').split(/\r?\n/)[0];
    const compact = source.trim().replace(/\s+/g, ' ');
    if (!compact) return `OpenMind thought ${row.id}`;
    return compact.length > 96 ? `${compact.slice(0, 93)}...` : compact;
}

function normalizeFetchId(value: unknown): string {
    const raw = String(value || '').trim();
    if (!raw) return '';

    try {
        const parsed = new URL(raw);
        const thoughtParam = parsed.searchParams.get('thought');
        if (thoughtParam) return thoughtParam;

        const apiMatch = parsed.pathname.match(/\/api\/thoughts\/([^/]+)$/);
        if (apiMatch?.[1]) return decodeURIComponent(apiMatch[1]);
    } catch {
        // Treat non-URL values as raw thought IDs.
    }

    return raw;
}

function buildThoughtAccessCondition(
    params: any[],
    userId: string | undefined,
    isAdmin: boolean | undefined,
    alias = 't',
): string {
    if (isAdmin || !userId) return '';
    params.push(userId);
    return `${alias}.user_id = $${params.length}`;
}

async function searchThoughtRows(searchText: string, limit: number, userId?: string, isAdmin?: boolean) {
    const queryEmbedding = await generateEmbedding(searchText);
    const formattedQuery = `[${queryEmbedding.join(',')}]`;
    const queryParams: any[] = [formattedQuery];
    const conditions: string[] = [];
    const accessCondition = buildThoughtAccessCondition(queryParams, userId, isAdmin);
    if (accessCondition) conditions.push(accessCondition);

    queryParams.push(limit);
    const limitParam = queryParams.length;

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const result = await db.query(
        `SELECT t.id,
                t.content,
                t.thought_type,
                t.source,
                t.summary,
                t.created_at,
                t.updated_at,
                m.people,
                m.topics,
                m.action_items,
                COALESCE(tags.tags, '{}') AS tags,
                1 - (e.embedding <=> $1::vector) AS similarity
         FROM thoughts t
         JOIN thought_embeddings e ON t.id = e.thought_id
         LEFT JOIN thought_metadata m ON t.id = m.thought_id
         LEFT JOIN LATERAL (
             SELECT array_agg(tt.tag ORDER BY tt.tag) AS tags
             FROM thought_tags tt
             WHERE tt.thought_id = t.id
         ) tags ON true
         ${whereClause}
         ORDER BY e.embedding <=> $1::vector
         LIMIT $${limitParam}`,
        queryParams,
    );

    return result.rows;
}

async function fetchThoughtRow(rawId: unknown, userId?: string, isAdmin?: boolean) {
    const id = normalizeFetchId(rawId);
    if (!id) return null;

    const queryParams: any[] = [id];
    const conditions = ['t.id = $1'];
    const accessCondition = buildThoughtAccessCondition(queryParams, userId, isAdmin);
    if (accessCondition) conditions.push(accessCondition);

    const result = await db.query(
        `SELECT t.id,
                t.content,
                t.thought_type,
                t.source,
                t.summary,
                t.content_hash,
                t.created_at,
                t.updated_at,
                m.people,
                m.topics,
                m.action_items,
                m.sentiment,
                COALESCE(tags.tags, '{}') AS tags
         FROM thoughts t
         LEFT JOIN thought_metadata m ON t.id = m.thought_id
         LEFT JOIN LATERAL (
             SELECT array_agg(tt.tag ORDER BY tt.tag) AS tags
             FROM thought_tags tt
             WHERE tt.thought_id = t.id
         ) tags ON true
         WHERE ${conditions.join(' AND ')}`,
        queryParams,
    );

    return result.rows[0] ?? null;
}

function formatSemanticSearchResult(row: any) {
    return {
        id: row.id,
        type: row.thought_type,
        similarity: Math.round(Number(row.similarity) * 100) / 100,
        content: row.content,
        topics: row.topics,
        people: row.people,
        tags: row.tags,
        date: row.created_at,
    };
}

function formatOpenAiSearchResult(row: any) {
    return {
        id: row.id,
        title: titleFromThought(row),
        url: thoughtUrl(row.id),
    };
}

function formatOpenAiFetchResult(row: any) {
    return {
        id: row.id,
        title: titleFromThought(row),
        text: row.content,
        url: thoughtUrl(row.id),
        metadata: {
            api_url: thoughtApiUrl(row.id),
            type: row.thought_type,
            source: row.source,
            summary: row.summary,
            tags: row.tags,
            topics: row.topics,
            people: row.people,
            action_items: row.action_items,
            sentiment: row.sentiment,
            created_at: row.created_at,
            updated_at: row.updated_at,
            content_hash: row.content_hash,
        },
    };
}

export function createMcpServer(userId?: string, isAdmin?: boolean): Server {
    const server = new Server(
        {
            name: 'openmind',
            version: '1.0.0',
        },
        {
            capabilities: {
                tools: {},
            },
            instructions: MCP_INSTRUCTIONS,
        }
    );

    server.setRequestHandler(ListToolsRequestSchema, async () => {
        return {
            tools: [
                {
                    name: 'capture_thought',
                    description: 'Write a new thought/memory into OpenMind',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            content: { type: 'string', description: 'The text of the thought' },
                            tags: { type: 'array', items: { type: 'string' }, description: 'Optional tags to categorize this thought' }
                        },
                        required: ['content'],
                    },
                },
                {
                    name: 'semantic_search',
                    description: 'Search for thoughts by meaning (vector similarity)',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            query: { type: 'string', description: 'The meaning or concept to search for' },
                            limit: { type: 'number', description: 'Max number of results (default 5)' }
                        },
                        required: ['query'],
                    },
                },
                {
                    name: 'list_recent',
                    description: 'Browse the most recent thoughts in OpenMind',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            limit: { type: 'number', description: 'Number of results to return (default 10)' },
                            type: { type: 'string', description: 'Optional thought type filter (e.g. insight, decision, person, meeting, action)' }
                        },
                    },
                },
                {
                    name: 'get_stats',
                    description: 'Get statistics about the thoughts in OpenMind (counts, types, etc)',
                    inputSchema: {
                        type: 'object',
                        properties: {},
                    },
                },
                {
                    name: 'search',
                    description: 'ChatGPT-compatible search over OpenMind thoughts. Returns result objects with id, title, and citation URL.',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            query: { type: 'string', description: 'Search query' },
                            limit: { type: 'number', description: 'Max number of results (default 5, max 20)' }
                        },
                        required: ['query'],
                    },
                },
                {
                    name: 'fetch',
                    description: 'ChatGPT-compatible fetch for a single OpenMind thought by id or citation URL.',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            id: { type: 'string', description: 'Thought id returned by search, or an OpenMind thought URL' }
                        },
                        required: ['id'],
                    },
                },
            ],
        };
    });

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
        switch (request.params.name) {
            case 'capture_thought': {
                const { content, tags } = request.params.arguments as any;
                try {
                    const result = await captureThought(content as string, {
                        source: 'mcp',
                        tags: tags as string[],
                        userId: userId
                    });
                    return {
                        content: [
                            { type: 'text', text: `Thought captured successfully! ID: ${result.id}. Status: ${result.status}` }
                        ]
                    };
                } catch (error: any) {
                    return {
                        isError: true,
                        content: [{ type: 'text', text: `Failed to capture thought: ${error.message}` }]
                    };
                }
            }
            case 'semantic_search': {
                const { query, input, limit = 5 } = request.params.arguments as any;
                try {
                    const searchText = (typeof query === 'string' && query.trim().length > 0)
                        ? query
                        : (typeof input === 'string' && input.trim().length > 0 ? input : undefined);

                    if (!searchText) {
                        return {
                            isError: true,
                            content: [{
                                type: 'text',
                                text: "Search failed: missing search text. Provide 'query' (preferred) or 'input'."
                            }]
                        };
                    }

                    const rows = await searchThoughtRows(searchText, clampToolLimit(limit), userId, isAdmin);
                    const formattedResults = rows.map(formatSemanticSearchResult);

                    return {
                        content: [{ type: 'text', text: JSON.stringify(formattedResults, null, 2) }]
                    };
                } catch (error: any) {
                    return {
                        isError: true,
                        content: [{ type: 'text', text: `Search failed: ${error.message}` }]
                    };
                }
            }
            case 'list_recent': {
                const { limit = 10, type } = request.params.arguments as any;
                try {
                    let queryStr = `
                         SELECT t.id, t.content, t.thought_type, t.created_at, m.people, m.topics
                         FROM thoughts t
                         LEFT JOIN thought_metadata m ON t.id = m.thought_id
                    `;
                    const queryParams: any[] = [];
                    const conditions: string[] = [];

                    if (type) {
                        queryParams.push(type);
                        conditions.push(`t.thought_type = $${queryParams.length}`);
                    }

                    if (!isAdmin && userId) {
                        queryParams.push(userId);
                        conditions.push(`t.user_id = $${queryParams.length}`);
                    }

                    if (conditions.length > 0) {
                        queryStr += ` WHERE ${conditions.join(' AND ')}`;
                    }

                    queryParams.push(limit);
                    queryStr += ` ORDER BY t.created_at DESC LIMIT $${queryParams.length}`;

                    const results = await db.query(queryStr, queryParams);

                    const formattedResults = results.rows.map(r => ({
                        id: r.id,
                        type: r.thought_type,
                        content: r.content,
                        topics: r.topics,
                        date: r.created_at
                    }));

                    return {
                        content: [{ type: 'text', text: JSON.stringify(formattedResults, null, 2) }]
                    };
                } catch (error: any) {
                    return {
                        isError: true,
                        content: [{ type: 'text', text: `Failed to list recent thoughts: ${error.message}` }]
                    };
                }
            }
            case 'get_stats': {
                try {
                    let whereClause = '';
                    const queryParams: any[] = [];

                    if (!isAdmin && userId) {
                        queryParams.push(userId);
                        whereClause = ` WHERE user_id = $${queryParams.length}`;
                    }

                    const totalThoughts = await db.query(`SELECT COUNT(*) FROM thoughts${whereClause}`, queryParams);
                    const types = await db.query(`SELECT thought_type, COUNT(*) FROM thoughts${whereClause} GROUP BY thought_type`, queryParams);

                    return {
                        content: [{
                            type: 'text', text: JSON.stringify({
                                total: parseInt(totalThoughts.rows[0].count),
                                breakdown: types.rows.map(r => ({ type: r.thought_type, count: parseInt(r.count) }))
                            }, null, 2)
                        }]
                    };
                } catch (error: any) {
                    return {
                        isError: true,
                        content: [{ type: 'text', text: `Failed to get stats: ${error.message}` }]
                    };
                }
            }
            case 'search': {
                const { query, input, limit = 5 } = request.params.arguments as any;
                try {
                    const searchText = (typeof query === 'string' && query.trim().length > 0)
                        ? query
                        : (typeof input === 'string' && input.trim().length > 0 ? input : undefined);

                    if (!searchText) {
                        return {
                            isError: true,
                            content: [{ type: 'text', text: 'Search failed: missing query.' }]
                        };
                    }

                    const rows = await searchThoughtRows(searchText, clampToolLimit(limit), userId, isAdmin);
                    return {
                        content: [{
                            type: 'text',
                            text: JSON.stringify({ results: rows.map(formatOpenAiSearchResult) })
                        }]
                    };
                } catch (error: any) {
                    return {
                        isError: true,
                        content: [{ type: 'text', text: `Search failed: ${error.message}` }]
                    };
                }
            }
            case 'fetch': {
                const { id } = request.params.arguments as any;
                try {
                    const row = await fetchThoughtRow(id, userId, isAdmin);
                    if (!row) {
                        return {
                            isError: true,
                            content: [{ type: 'text', text: `Thought not found: ${String(id || '').trim()}` }]
                        };
                    }

                    return {
                        content: [{
                            type: 'text',
                            text: JSON.stringify(formatOpenAiFetchResult(row))
                        }]
                    };
                } catch (error: any) {
                    return {
                        isError: true,
                        content: [{ type: 'text', text: `Fetch failed: ${error.message}` }]
                    };
                }
            }
            default:
                throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${request.params.name}`);
        }
    });

    return server;
}

export async function runStdio() {
    const server = createMcpServer();
    const transport = new StdioServerTransport();
    await server.connect(transport);
}

// Only start stdio if this file is run directly (e.g. from Claude/Cursor)
if (require.main === module) {
    runStdio().catch(console.error);
}
