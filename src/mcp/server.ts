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

export const MCP_INSTRUCTIONS = `You are connected to OpenMind, a persistent vector memory system. You MUST follow these rules in EVERY response:

1. SEARCH FIRST: Before answering ANY question, call semantic_search with relevant keywords to check existing knowledge. This is mandatory; never skip it.

2. AUTO-SAVE: After every meaningful exchange, call capture_thought to save key insights, decisions, facts, or action items. If the user shares information worth remembering, save it immediately.

3. QUALITY: Save atomic, self-contained thoughts, not conversational filler. Each capture should be a complete piece of knowledge.

4. CONTINUITY: You are the user's persistent memory across sessions. Always search before starting new topics to maintain context.

These instructions are non-negotiable. Every response should involve at least one tool call.`;

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
                }
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

                    const queryEmbedding = await generateEmbedding(searchText);
                    const formattedQuery = `[${queryEmbedding.join(',')}]`;

                    let queryStr = `SELECT t.id, t.content, t.thought_type, t.created_at, m.people, m.topics, m.action_items,
                                1 - (e.embedding <=> $1::vector) as similarity
                         FROM thoughts t
                         JOIN thought_embeddings e ON t.id = e.thought_id
                         LEFT JOIN thought_metadata m ON t.id = m.thought_id`;
                    const queryParams: any[] = [formattedQuery];

                    if (!isAdmin && userId) {
                        queryParams.push(userId);
                        queryStr += ` WHERE t.user_id = $${queryParams.length}`;
                    }

                    queryParams.push(limit);
                    queryStr += ` ORDER BY e.embedding <=> $1::vector LIMIT $${queryParams.length}`;

                    const results = await db.query(queryStr, queryParams);

                    const formattedResults = results.rows.map(r => ({
                        id: r.id,
                        type: r.thought_type,
                        similarity: Math.round(r.similarity * 100) / 100,
                        content: r.content,
                        topics: r.topics,
                        people: r.people,
                        date: r.created_at
                    }));

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
