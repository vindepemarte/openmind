import express from 'express';
import multer from 'multer';
import cors from 'cors';
import fs from 'fs';
import { exec } from 'child_process';
import { randomUUID, randomBytes, createHash } from 'crypto';
import path from 'path';

import cookieParser from 'cookie-parser';
import { captureThought } from '../processing/pipeline';
import { db } from '../db/client';
import { generateEmbedding } from '../embeddings/openrouter';
import { createMcpServer, MCP_INSTRUCTIONS } from '../mcp/server';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { unifiedAuthMiddleware } from '../auth/middleware';
import { sessionRouter } from '../auth/session';
import { oauthRouter } from '../auth/oauth';
import { apiKeysRouter } from '../auth/apikeys';
import { settingsRouter } from '../auth/settings';
import { buildImportPlan, CsvImportMapping } from '../import/memories';
import { generateContentHash, getBulkDuplicateLookup } from '../processing/dedup';
import { buildKpiSuggestions, estimateTimeSavedMinutes } from '../analytics/kpis';
import { hashPassword } from '../auth/passwords';
import {
    normalizeUsername,
    passwordPolicySummary,
    validatePasswordPolicy,
    validateUsername
} from '../auth/credentials';

declare global {
    namespace Express {
        interface Request {
            userId?: string;
            isAdmin?: boolean;
            authMethod?: 'basic' | 'api_key' | 'oauth' | 'session';
        }
    }
}

export const app = express();
app.disable('x-powered-by');
app.use(cors());

// Parse JSON and cookies before auth
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(cookieParser());

const publicPath = path.resolve(process.cwd(), 'public');
app.get('/login', (_req, res) => {
    res.sendFile(path.join(publicPath, 'login.html'));
});

app.get('/login.html', (_req, res) => {
    res.sendFile(path.join(publicPath, 'login.html'));
});

// Unified auth middleware handles Basic, Bearer (API key + OAuth), and JWT cookies.
// Public routes (/login, /auth/login, /oauth/*, /health) are bypassed internally
app.use(unifiedAuthMiddleware);

// Mount routers (session/oauth have their own public routes whitelisted in middleware)
app.use(sessionRouter);
app.use(oauthRouter);
app.use(apiKeysRouter);
app.use(settingsRouter);

// Serve authenticated static assets without exposing the dashboard shell publicly.
app.use(express.static(publicPath, { index: false }));

const WEBUI_USER = process.env.WEBUI_USER || 'admin';
const WEBUI_PASSWORD = process.env.WEBUI_PASSWORD || 'openmind';

function isMissingThoughtMetadataError(error: unknown): boolean {
    if (!error || typeof error !== 'object') return false;

    const pgError = error as { code?: string; table?: string; message?: string };
    if (pgError.code !== '42P01') return false;
    if (pgError.table === 'thought_metadata') return true;

    return typeof pgError.message === 'string'
        && pgError.message.includes('thought_metadata')
        && pgError.message.includes('does not exist');
}

// Bootstrap admin user and run migrations at startup
async function bootstrap() {
    await db.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`);
    await db.query(`CREATE EXTENSION IF NOT EXISTS vector`);

    // Run migration: ensure users table exists
    await db.query(`
        CREATE TABLE IF NOT EXISTS users (
            id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
            username VARCHAR(100) UNIQUE NOT NULL,
            password_hash VARCHAR(128) NOT NULL,
            is_admin BOOLEAN DEFAULT false,
            created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
        )
    `);

    // Ensure user_id column exists on thoughts
    await db.query(`
        DO $$
        BEGIN
            IF NOT EXISTS (
                SELECT 1 FROM information_schema.columns
                WHERE table_name = 'thoughts' AND column_name = 'user_id'
            ) THEN
                ALTER TABLE thoughts ADD COLUMN user_id UUID REFERENCES users(id);
            END IF;
        END $$
    `);

    await db.query(`CREATE INDEX IF NOT EXISTS idx_thoughts_user_id ON thoughts(user_id)`);

    // Legacy schema used a global unique constraint on content_hash, which breaks
    // user-scoped dedup in multi-user environments.
    await db.query(`
        DO $$
        BEGIN
            IF EXISTS (
                SELECT 1
                FROM pg_constraint
                WHERE conname = 'thoughts_content_hash_key'
                  AND conrelid = 'thoughts'::regclass
            ) THEN
                ALTER TABLE thoughts DROP CONSTRAINT thoughts_content_hash_key;
            END IF;
        END $$
    `);

    await db.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_thoughts_user_content_hash_unique
        ON thoughts(user_id, content_hash)
        WHERE user_id IS NOT NULL
    `);
    await db.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_thoughts_anonymous_content_hash_unique
        ON thoughts(content_hash)
        WHERE user_id IS NULL
    `);

    // Ensure core memory schema exists for upgraded databases, not only fresh init-db installs.
    await db.query(`
        CREATE TABLE IF NOT EXISTS thought_embeddings (
            thought_id UUID PRIMARY KEY REFERENCES thoughts(id) ON DELETE CASCADE,
            embedding vector(1536) NOT NULL
        )
    `);
    await db.query(`
        DO $$
        BEGIN
            IF NOT EXISTS (
                SELECT 1 FROM pg_indexes
                WHERE schemaname = 'public'
                    AND tablename = 'thought_embeddings'
                    AND indexdef ILIKE '%USING hnsw%'
            ) THEN
                CREATE INDEX idx_thought_embeddings_embedding_hnsw
                ON thought_embeddings USING hnsw (embedding vector_cosine_ops);
            END IF;
        END $$
    `);
    await db.query(`
        CREATE TABLE IF NOT EXISTS thought_metadata (
            thought_id UUID PRIMARY KEY REFERENCES thoughts(id) ON DELETE CASCADE,
            people TEXT[],
            topics TEXT[],
            action_items TEXT[],
            sentiment VARCHAR(20)
        )
    `);
    await db.query(`
        CREATE TABLE IF NOT EXISTS thought_tags (
            thought_id UUID REFERENCES thoughts(id) ON DELETE CASCADE,
            tag VARCHAR(50) NOT NULL,
            PRIMARY KEY (thought_id, tag)
        )
    `);
    await db.query(`
        CREATE TABLE IF NOT EXISTS thought_links (
            source_id UUID REFERENCES thoughts(id) ON DELETE CASCADE,
            target_id UUID REFERENCES thoughts(id) ON DELETE CASCADE,
            relationship VARCHAR(50) NOT NULL,
            PRIMARY KEY (source_id, target_id, relationship)
        )
    `);

    // API keys table
    await db.query(`
        CREATE TABLE IF NOT EXISTS api_keys (
            id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
            user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            key_hash VARCHAR(128) NOT NULL UNIQUE,
            name VARCHAR(100) NOT NULL,
            created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
            last_used_at TIMESTAMP WITH TIME ZONE
        )
    `);

    // OAuth clients table
    await db.query(`
        CREATE TABLE IF NOT EXISTS oauth_clients (
            id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
            client_id VARCHAR(64) NOT NULL UNIQUE,
            client_secret_hash VARCHAR(128) NOT NULL,
            name VARCHAR(200) NOT NULL,
            redirect_uris TEXT[] NOT NULL,
            scopes TEXT[] DEFAULT '{read,write}',
            created_by UUID REFERENCES users(id) ON DELETE SET NULL,
            created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
        )
    `);

    // OAuth authorization codes table
    await db.query(`
        CREATE TABLE IF NOT EXISTS oauth_codes (
            id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
            code VARCHAR(128) NOT NULL UNIQUE,
            client_id VARCHAR(64) NOT NULL,
            user_id UUID NOT NULL REFERENCES users(id),
            redirect_uri TEXT NOT NULL,
            scope TEXT,
            state TEXT,
            code_challenge TEXT,
            code_challenge_method TEXT,
            expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
            used BOOLEAN DEFAULT false
        )
    `);

    await db.query(`
        DO $$
        BEGIN
            IF NOT EXISTS (
                SELECT 1 FROM information_schema.columns
                WHERE table_name = 'oauth_codes' AND column_name = 'code_challenge'
            ) THEN
                ALTER TABLE oauth_codes ADD COLUMN code_challenge TEXT;
            END IF;

            IF NOT EXISTS (
                SELECT 1 FROM information_schema.columns
                WHERE table_name = 'oauth_codes' AND column_name = 'code_challenge_method'
            ) THEN
                ALTER TABLE oauth_codes ADD COLUMN code_challenge_method TEXT;
            END IF;
        END $$
    `);

    // OAuth tokens table
    await db.query(`
        CREATE TABLE IF NOT EXISTS oauth_tokens (
            id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
            access_token_hash VARCHAR(128) NOT NULL UNIQUE,
            refresh_token_hash VARCHAR(128) NOT NULL UNIQUE,
            client_id VARCHAR(64) NOT NULL,
            user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            scope TEXT,
            expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
            refresh_expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
            created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
        )
    `);

    // User settings table
    await db.query(`
        CREATE TABLE IF NOT EXISTS user_settings (
            user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            setting_key VARCHAR(100) NOT NULL,
            setting_value TEXT NOT NULL,
            PRIMARY KEY (user_id, setting_key)
        )
    `);

    await db.query(`
        CREATE TABLE IF NOT EXISTS capture_events (
            id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
            user_id UUID REFERENCES users(id) ON DELETE CASCADE,
            source VARCHAR(200) NOT NULL,
            content_hash VARCHAR(128) NOT NULL,
            status VARCHAR(20) NOT NULL,
            thought_id UUID,
            created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
        )
    `);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_capture_events_user_created_at ON capture_events(user_id, created_at DESC)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_capture_events_status ON capture_events(status)`);

    await db.query(`
        CREATE TABLE IF NOT EXISTS thought_tasks (
            id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
            thought_id UUID NOT NULL REFERENCES thoughts(id) ON DELETE CASCADE,
            user_id UUID REFERENCES users(id) ON DELETE CASCADE,
            content TEXT NOT NULL,
            is_completed BOOLEAN DEFAULT false,
            completed_at TIMESTAMP WITH TIME ZONE,
            created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(thought_id, content)
        )
    `);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_thought_tasks_user_completed ON thought_tasks(user_id, is_completed, created_at DESC)`);

    // Config table (for JWT secret etc)
    await db.query(`
        CREATE TABLE IF NOT EXISTS config (
            key VARCHAR(100) PRIMARY KEY,
            value TEXT NOT NULL
        )
    `);

    // Upsert admin user
    const adminHash = await hashPassword(WEBUI_PASSWORD);
    await db.query(
        `INSERT INTO users (username, password_hash, is_admin)
         VALUES ($1, $2, true)
         ON CONFLICT (username) DO UPDATE SET password_hash = $2, is_admin = true`,
        [WEBUI_USER, adminHash]
    );

    // Assign orphaned thoughts to admin user
    const adminResult = await db.query(`SELECT id FROM users WHERE is_admin = true LIMIT 1`);
    if (adminResult.rows.length > 0) {
        await db.query(
            `UPDATE thoughts SET user_id = $1 WHERE user_id IS NULL`,
            [adminResult.rows[0].id]
        );
    }

    console.log(`Admin user "${WEBUI_USER}" bootstrapped.`);
}


// --- MCP transport session state ---
type SseSession = {
    server: ReturnType<typeof createMcpServer>;
    transport: SSEServerTransport;
};

type StreamableSession = {
    transport: StreamableHTTPServerTransport;
};

const sseSessions = new Map<string, SseSession>();
const streamableSessions = new Map<string, StreamableSession>();

function getSingleHeaderValue(value: string | string[] | undefined): string | undefined {
    return Array.isArray(value) ? value[0] : value;
}

function getSingleQueryValue(value: unknown): string | undefined {
    return Array.isArray(value) ? value[0] : typeof value === 'string' ? value : undefined;
}

function sendMcpError(res: express.Response, status: number, message: string) {
    res.status(status).json({
        jsonrpc: '2.0',
        error: {
            code: -32000,
            message
        },
        id: null
    });
}

async function closeMcpServer(server: ReturnType<typeof createMcpServer>) {
    try {
        await server.close();
    } catch (error) {
        console.error('Error closing MCP server:', error);
    }
}

// --- MCP Streamable HTTP transport (preferred for modern MCP clients) ---
app.all('/mcp', async (req, res) => {
    try {
        const sessionId = getSingleHeaderValue(req.headers['mcp-session-id']);

        if (sessionId && sseSessions.has(sessionId)) {
            sendMcpError(res, 400, 'Bad Request: Session exists but uses the legacy SSE transport');
            return;
        }

        let session = sessionId ? streamableSessions.get(sessionId) : undefined;

        if (!session) {
            if (sessionId) {
                sendMcpError(res, 404, 'Session not found');
                return;
            }

            if (req.method !== 'POST' || !isInitializeRequest(req.body)) {
                sendMcpError(res, 400, 'Bad Request: No valid MCP session ID provided');
                return;
            }

            const server = createMcpServer(req.userId, req.isAdmin);
            const transport = new StreamableHTTPServerTransport({
                sessionIdGenerator: () => randomUUID(),
                onsessioninitialized: initializedSessionId => {
                    streamableSessions.set(initializedSessionId, { transport });
                }
            });

            transport.onclose = () => {
                const activeSessionId = transport.sessionId;
                if (activeSessionId) {
                    streamableSessions.delete(activeSessionId);
                }
            };

            await server.connect(transport);
            session = { transport };
        }

        await session.transport.handleRequest(req as any, res as any, req.body);
    } catch (error) {
        console.error('MCP /mcp error:', error);
        if (!res.headersSent) {
            sendMcpError(res, 500, 'Internal server error');
        }
    }
});

// --- MCP legacy SSE transport (kept for older clients) ---

app.get('/mcp/sse', async (req, res) => {
    const mcpServer = createMcpServer(req.userId, req.isAdmin);
    const transport = new SSEServerTransport('/mcp/messages', res as any);
    sseSessions.set(transport.sessionId, { server: mcpServer, transport });

    res.on('close', () => {
        void closeMcpServer(mcpServer);
        sseSessions.delete(transport.sessionId);
    });

    await mcpServer.connect(transport);
});

app.post('/mcp/messages', async (req, res) => {
    const sessionId = getSingleQueryValue(req.query.sessionId);

    if (!sessionId) {
        sendMcpError(res, 400, 'Bad Request: sessionId is required');
        return;
    }

    if (streamableSessions.has(sessionId)) {
        sendMcpError(res, 400, 'Bad Request: Session exists but uses the Streamable HTTP transport');
        return;
    }

    const session = sseSessions.get(sessionId);
    if (!session) {
        sendMcpError(res, 400, 'SSE transport not connected');
        return;
    }

    await session.transport.handlePostMessage(req as any, res as any, req.body);
});

// --- Existing Capture and Rest API ---
app.post('/capture', async (req, res) => {
    try {
        const { content, source = 'api', type, tags } = req.body;
        if (!content) return res.status(400).json({ error: 'content is required' });

        const result = await captureThought(content, { source, overrideType: type, tags, userId: req.userId });
        res.json(result);
    } catch (error: any) {
        console.error('API /capture error:', error);
        res.status(500).json({ error: error.message });
    }
});

app.get('/stats', async (req, res) => {
    try {
        const params: any[] = [];
        let whereClause = '';

        if (!req.isAdmin && req.userId) {
            params.push(req.userId);
            whereClause = ` WHERE user_id = $1`;
        }

        const [totalResult, typeResult] = await Promise.all([
            db.query(`SELECT COUNT(*)::int AS total FROM thoughts${whereClause}`, params),
            db.query(
                `SELECT thought_type, COUNT(*)::int AS count
                 FROM thoughts${whereClause}
                 GROUP BY thought_type
                 ORDER BY count DESC, thought_type ASC`,
                params
            )
        ]);

        res.json({
            totalThoughts: totalResult.rows[0]?.total ?? 0,
            byType: typeResult.rows
        });
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/kpis', async (req, res) => {
    try {
        const duplicateParams: any[] = [];
        const reminderParams: any[] = [];
        const riskParams: any[] = [];
        let duplicateWhere = `WHERE ce.status = 'duplicate'`;
        let reminderWhere = '';
        let riskWhereWithMetadata = `WHERE tt.is_completed = false
                                     AND (COALESCE(m.sentiment, 'neutral') = 'negative' OR t.thought_type IN ('decision', 'action'))`;
        let riskWhereWithoutMetadata = `WHERE tt.is_completed = false
                                        AND t.thought_type IN ('decision', 'action')`;

        if (!req.isAdmin && req.userId) {
            duplicateParams.push(req.userId);
            reminderParams.push(req.userId);
            riskParams.push(req.userId);
            duplicateWhere += ` AND ce.user_id = $${duplicateParams.length}`;
            reminderWhere = `WHERE tt.user_id = $${reminderParams.length}`;
            riskWhereWithMetadata += ` AND tt.user_id = $${riskParams.length}`;
            riskWhereWithoutMetadata += ` AND tt.user_id = $${riskParams.length}`;
        }

        const riskWithMetadataQuery = `SELECT COUNT(*)::int AS total
                                       FROM thought_tasks tt
                                       JOIN thoughts t ON tt.thought_id = t.id
                                       LEFT JOIN thought_metadata m ON tt.thought_id = m.thought_id
                                       ${riskWhereWithMetadata}`;

        const riskWithoutMetadataQuery = `SELECT COUNT(*)::int AS total
                                          FROM thought_tasks tt
                                          JOIN thoughts t ON tt.thought_id = t.id
                                          ${riskWhereWithoutMetadata}`;

        const [duplicateResult, reminderResult, riskResult] = await Promise.all([
            db.query(`SELECT COUNT(*)::int AS total FROM capture_events ce ${duplicateWhere}`, duplicateParams),
            db.query(
                `SELECT COUNT(*)::int AS total,
                        COUNT(*) FILTER (WHERE tt.is_completed)::int AS completed
                 FROM thought_tasks tt
                 ${reminderWhere}`,
                reminderParams
            ),
            db.query(riskWithMetadataQuery, riskParams).catch((error: unknown) => {
                if (!isMissingThoughtMetadataError(error)) {
                    throw error;
                }
                return db.query(riskWithoutMetadataQuery, riskParams);
            })
        ]);

        const duplicatesPrevented = duplicateResult.rows[0]?.total ?? 0;
        const totalReminders = reminderResult.rows[0]?.total ?? 0;
        const completedReminders = reminderResult.rows[0]?.completed ?? 0;
        const reminderCompletionRate = totalReminders > 0
            ? Math.round((completedReminders / totalReminders) * 100)
            : 0;
        const unresolvedRiskCount = riskResult.rows[0]?.total ?? 0;
        const snapshot = {
            duplicatesPrevented,
            totalReminders,
            completedReminders,
            reminderCompletionRate,
            unresolvedRiskCount
        };

        res.json({
            ...snapshot,
            estimatedTimeSavedMinutes: estimateTimeSavedMinutes(snapshot),
            suggestions: buildKpiSuggestions(snapshot)
        });
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/tasks', async (req, res) => {
    try {
        const limit = parseInt((req.query.limit as string) || '8');
        const status = (req.query.status as string) || 'open';
        const params: any[] = [];
        const conditions: string[] = [];

        if (status === 'open') {
            conditions.push(`tt.is_completed = false`);
        } else if (status === 'completed') {
            conditions.push(`tt.is_completed = true`);
        }

        if (!req.isAdmin && req.userId) {
            params.push(req.userId);
            conditions.push(`tt.user_id = $${params.length}`);
        }

        let query = `SELECT tt.id, tt.content, tt.is_completed, tt.created_at, tt.completed_at, t.thought_type, t.summary
                     FROM thought_tasks tt
                     JOIN thoughts t ON tt.thought_id = t.id`;

        if (conditions.length > 0) {
            query += ` WHERE ${conditions.join(' AND ')}`;
        }

        params.push(limit);
        query += ` ORDER BY tt.created_at DESC LIMIT $${params.length}`;

        const result = await db.query(query, params);
        res.json(result.rows);
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
});

app.put('/api/tasks/:id', async (req, res) => {
    try {
        const isCompleted = req.body?.isCompleted !== false;
        const params: any[] = [isCompleted, req.params.id];
        let query = `UPDATE thought_tasks
                     SET is_completed = $1,
                         completed_at = CASE WHEN $1 THEN NOW() ELSE NULL END
                     WHERE id = $2`;

        if (!req.isAdmin && req.userId) {
            params.push(req.userId);
            query += ` AND user_id = $${params.length}`;
        }

        query += ` RETURNING id, is_completed, completed_at`;
        const result = await db.query(query, params);

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Task not found' });
        }

        res.json(result.rows[0]);
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/onboarding', async (req, res) => {
    if (!req.userId) {
        return res.status(401).json({ error: 'Authentication required' });
    }

    try {
        const baseQueries = await Promise.all([
            db.query(`SELECT COUNT(*)::int AS total FROM thoughts WHERE user_id = $1`, [req.userId]),
            db.query(`SELECT COUNT(*)::int AS total FROM api_keys WHERE user_id = $1`, [req.userId]),
            db.query(
                `SELECT COUNT(*)::int AS total
                 FROM user_settings
                 WHERE user_id = $1 AND setting_key = 'session_lifetime'`,
                [req.userId]
            ),
            db.query(
                `SELECT COUNT(*)::int AS total
                 FROM oauth_clients
                 WHERE created_by = $1`,
                [req.userId]
            ),
        ]);

        const steps = [
            {
                id: 'capture-first-memory',
                label: 'Capture your first memory',
                description: 'Import at least one thought so search and analytics have real data.',
                tab: 'import',
                completed: (baseQueries[0].rows[0]?.total ?? 0) > 0
            },
            {
                id: 'create-api-key',
                label: 'Create an API key',
                description: 'Generate a revokable key for your first MCP or API integration.',
                tab: 'apikeys',
                completed: (baseQueries[1].rows[0]?.total ?? 0) > 0
            },
            {
                id: 'review-session-policy',
                label: 'Review session lifetime',
                description: 'Set a session duration that matches your security requirements.',
                tab: 'settings',
                completed: (baseQueries[2].rows[0]?.total ?? 0) > 0
            },
            {
                id: 'register-oauth-client',
                label: 'Register an OAuth client',
                description: 'Create one OAuth client now so browser-based MCP login is ready when needed.',
                tab: 'oauth',
                completed: (baseQueries[3].rows[0]?.total ?? 0) > 0
            }
        ];

        if (req.isAdmin) {
            const nonAdminUsers = await db.query(`SELECT COUNT(*)::int AS total FROM users WHERE is_admin = false`);
            steps.push({
                id: 'create-team-member',
                label: 'Create a teammate account',
                description: 'Provision at least one non-admin user to validate admin workflows.',
                tab: 'users',
                completed: (nonAdminUsers.rows[0]?.total ?? 0) > 0
            });
        }

        const completed = steps.filter(step => step.completed).length;
        const total = steps.length;
        const remaining = total - completed;
        const nextStep = steps.find(step => !step.completed) ?? null;
        const progressPercent = total > 0 ? Math.round((completed / total) * 100) : 0;

        res.json({
            completed,
            total,
            remaining,
            progressPercent,
            nextStep,
            completionMessage: nextStep
                ? null
                : 'Onboarding complete. Keep the workspace healthy by importing regularly and reviewing action queue items.',
            steps
        });
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/recent', async (req, res) => {
    try {
        const limit = parseInt((req.query.limit as string) || '10');
        const queryParams: any[] = [];
        const conditions: string[] = [];

        if (!req.isAdmin && req.userId) {
            queryParams.push(req.userId);
            conditions.push(`t.user_id = $${queryParams.length}`);
        }

        const whereClause = conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : '';
        queryParams.push(limit);
        const limitClause = ` ORDER BY t.created_at DESC LIMIT $${queryParams.length}`;

        const queryWithMetadata = `SELECT t.id, t.content, t.thought_type, t.created_at, m.people, m.topics, t.summary
                                   FROM thoughts t
                                   LEFT JOIN thought_metadata m ON t.id = m.thought_id${whereClause}${limitClause}`;

        const queryWithoutMetadata = `SELECT t.id, t.content, t.thought_type, t.created_at,
                                             NULL::TEXT[] AS people, NULL::TEXT[] AS topics, t.summary
                                      FROM thoughts t${whereClause}${limitClause}`;

        let results;
        try {
            results = await db.query(queryWithMetadata, queryParams);
        } catch (error: unknown) {
            if (!isMissingThoughtMetadataError(error)) {
                throw error;
            }
            results = await db.query(queryWithoutMetadata, queryParams);
        }

        res.json(results.rows);
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
});

// Semantic search endpoint for dashboard
app.get('/search', async (req, res) => {
    try {
        const query = req.query.q as string;
        const limit = parseInt((req.query.limit as string) || '10');
        if (!query) return res.status(400).json({ error: 'q parameter is required' });

        const embedding = await generateEmbedding(query);
        const embeddingStr = `[${embedding.join(',')}]`;

        let queryStr = `SELECT t.id, t.content, t.thought_type, t.created_at, t.summary,
                         1 - (e.embedding <=> $1::vector) AS similarity
                  FROM thoughts t
                  JOIN thought_embeddings e ON t.id = e.thought_id`;
        const params: any[] = [embeddingStr];

        if (!req.isAdmin && req.userId) {
            params.push(req.userId);
            queryStr += ` WHERE t.user_id = $${params.length}`;
        }

        params.push(limit);
        queryStr += ` ORDER BY e.embedding <=> $1::vector LIMIT $${params.length}`;

        const results = await db.query(queryStr, params);
        res.json(results.rows);
    } catch (error: any) {
        console.error('Search error:', error);
        res.status(500).json({ error: error.message });
    }
});

app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.get('/', (_req, res) => {
    res.redirect('/app');
});

app.get('/app', (req, res) => {
    res.sendFile(path.join(publicPath, 'index.html'));
});

// --- User Management API (admin only) ---

const adminOnly: express.RequestHandler = (req, res, next) => {
    if (!req.isAdmin) {
        res.status(403).json({ error: 'Admin access required' });
        return;
    }
    next();
};

app.get('/api/users', adminOnly, async (req, res) => {
    try {
        const result = await db.query(
            `SELECT id, username, is_admin, created_at FROM users ORDER BY created_at ASC`
        );
        res.json(result.rows);
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/users', adminOnly, async (req, res) => {
    try {
        const username = normalizeUsername(req.body?.username);
        const password = typeof req.body?.password === 'string' ? req.body.password : '';
        if (!username || !password) {
            return res.status(400).json({ error: 'username and password are required' });
        }

        const usernameError = validateUsername(username);
        if (usernameError) {
            return res.status(400).json({ error: usernameError });
        }

        const passwordError = validatePasswordPolicy(password);
        if (passwordError) {
            return res.status(400).json({
                error: passwordError,
                passwordPolicy: passwordPolicySummary(),
            });
        }

        const passwordHash = await hashPassword(password);
        const result = await db.query(
            `INSERT INTO users (username, password_hash, is_admin)
             VALUES ($1, $2, false) RETURNING id, username, is_admin, created_at`,
            [username, passwordHash]
        );

        res.json(result.rows[0]);
    } catch (error: any) {
        if (error.code === '23505') {
            res.status(409).json({ error: 'Username already exists' });
        } else {
            res.status(500).json({ error: error.message });
        }
    }
});

app.delete('/api/users/:id', adminOnly, async (req, res) => {
    try {
        const targetId = req.params.id;

        if (targetId === req.userId) {
            return res.status(400).json({ error: 'Cannot delete your own account' });
        }

        const result = await db.query(
            `DELETE FROM users WHERE id = $1 RETURNING id`,
            [targetId]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'User not found' });
        }

        res.json({ deleted: true });
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
});

app.put('/api/users/:id/password', adminOnly, async (req, res) => {
    try {
        const targetId = req.params.id;
        const password = typeof req.body?.password === 'string' ? req.body.password : '';

        if (!password) {
            return res.status(400).json({ error: 'password is required' });
        }

        const passwordError = validatePasswordPolicy(password);
        if (passwordError) {
            return res.status(400).json({
                error: passwordError,
                passwordPolicy: passwordPolicySummary(),
            });
        }

        const passwordHash = await hashPassword(password);
        const result = await db.query(
            `UPDATE users SET password_hash = $1 WHERE id = $2 RETURNING id, username`,
            [passwordHash, targetId]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'User not found' });
        }

        res.json({ updated: true, ...result.rows[0] });
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
});

async function handleMcpConfigRequest(req: express.Request, res: express.Response) {
    try {
        const targetId = req.params.id;
        const source = req.method === 'GET' ? req.query : (req.body ?? {});
        const password = typeof source.password === 'string' ? source.password : '';
        const authType = typeof source.authType === 'string' ? source.authType.toLowerCase() : 'basic';
        const keyName = typeof source.keyName === 'string' ? source.keyName.trim() : '';
        const oauthScopes = ['read', 'write'];

        if (!req.userId) {
            return res.status(401).json({ error: 'Authentication required' });
        }

        if (!req.isAdmin && req.userId !== targetId) {
            return res.status(403).json({ error: 'Access denied' });
        }

        const result = await db.query(
            `SELECT username FROM users WHERE id = $1`,
            [targetId]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'User not found' });
        }

        const username = result.rows[0].username;

        // Determine the base URL from the request
        const protocol = req.get('x-forwarded-proto') || req.protocol;
        const host = req.get('x-forwarded-host') || req.get('host');
        const baseUrl = `${protocol}://${host}`;

        if (authType === 'basic') {
            if (!password) {
                return res.status(400).json({ error: 'password is required for Basic auth config' });
            }

            const basicAuth = Buffer.from(`${username}:${password}`).toString('base64');

            return res.json({
                authType,
                mcpServers: {
                    openmind: {
                        type: 'http',
                        url: `${baseUrl}/mcp`,
                        headers: {
                            Authorization: `Basic ${basicAuth}`
                        }
                    }
                },
                instructions: MCP_INSTRUCTIONS,
                summary: 'Uses your account username and password via HTTP Basic auth.'
            });
        }

        if (authType === 'api_key') {
            const rawKey = 'om_' + randomBytes(16).toString('hex');
            const keyHash = createHash('sha256').update(rawKey).digest('hex');
            const resolvedKeyName = keyName || `MCP access (${username})`;

            await db.query(
                `INSERT INTO api_keys (user_id, key_hash, name)
                 VALUES ($1, $2, $3)`,
                [targetId, keyHash, resolvedKeyName]
            );

            return res.json({
                authType,
                mcpServers: {
                    openmind: {
                        type: 'http',
                        url: `${baseUrl}/mcp`,
                        headers: {
                            Authorization: `Bearer ${rawKey}`
                        }
                    }
                },
                instructions: MCP_INSTRUCTIONS,
                generatedApiKey: rawKey,
                keyName: resolvedKeyName,
                summary: `Uses a newly generated API key named "${resolvedKeyName}". You can revoke it later from the API Keys tab.`
            });
        }

        if (authType === 'oauth') {
            return res.json({
                authType,
                mcpServers: {
                    openmind: {
                        type: 'http',
                        url: `${baseUrl}/mcp`
                    }
                },
                oauth: {
                    issuer: baseUrl,
                    authorizationUrl: `${baseUrl}/oauth/authorize`,
                    tokenUrl: `${baseUrl}/oauth/token`,
                    registrationUrl: `${baseUrl}/oauth/register`,
                    revocationUrl: `${baseUrl}/oauth/revoke`,
                    metadataUrl: `${baseUrl}/.well-known/oauth-authorization-server`,
                    scopes: oauthScopes,
                },
                instructions: MCP_INSTRUCTIONS,
                summary: 'Uses OAuth 2.0. Modern MCP clients can log in through a browser flow, and clients without automatic registration can use a manually created OAuth client from the OAuth Clients tab.'
            });
        }

        return res.status(400).json({ error: 'Unsupported authType. Use "basic", "api_key", or "oauth".' });
    } catch (error: any) {
        return res.status(500).json({ error: error.message });
    }
}

app.get('/api/users/:id/mcp-config', handleMcpConfigRequest);
app.post('/api/users/:id/mcp-config', handleMcpConfigRequest);

// --- Web UI Uploads ---
const upload = multer({ dest: '/tmp/' });

function parseImportMapping(rawMapping: unknown): Partial<CsvImportMapping> | undefined {
    if (typeof rawMapping !== 'string' || rawMapping.trim() === '') {
        return undefined;
    }

    try {
        const parsed = JSON.parse(rawMapping);
        const mapping: Partial<CsvImportMapping> = {};

        if (typeof parsed.contentColumn === 'string') mapping.contentColumn = parsed.contentColumn;
        if (typeof parsed.sourceColumn === 'string') mapping.sourceColumn = parsed.sourceColumn;
        if (typeof parsed.typeColumn === 'string') mapping.typeColumn = parsed.typeColumn;
        if (typeof parsed.tagsColumn === 'string') mapping.tagsColumn = parsed.tagsColumn;

        return mapping;
    } catch {
        throw new Error('Invalid import mapping payload');
    }
}

async function buildMemoryImportPreview(
    fileName: string,
    content: string,
    targetUserId?: string,
    rawMapping?: unknown,
) {
    const mapping = parseImportMapping(rawMapping);
    const plan = buildImportPlan(fileName, content, mapping);

    if (plan.items.length === 0) {
        throw new Error('No content found in file');
    }

    const contentHashes = [...new Set(plan.items.map(item => generateContentHash(item.content)))];
    const existingHashes = new Set<string>();

    if (contentHashes.length > 0) {
        const duplicateLookup = getBulkDuplicateLookup(contentHashes, targetUserId);
        const duplicateRows = await db.query(duplicateLookup.query, duplicateLookup.params);
        for (const row of duplicateRows.rows) {
            existingHashes.add(row.content_hash);
        }
    }

    const previewItems = plan.items.map((item, index) => {
        const duplicate = existingHashes.has(generateContentHash(item.content));
        return {
            index: index + 1,
            duplicate,
            preview: item.content.length > 180 ? item.content.slice(0, 180) + '...' : item.content,
            content: item.content,
            source: item.source,
            thoughtType: item.thoughtType || null,
            tags: item.tags,
        };
    });

    return {
        detectedType: plan.detectedType,
        headers: plan.headers,
        mapping: plan.mapping,
        totalItems: previewItems.length,
        duplicateItems: previewItems.filter(item => item.duplicate).length,
        newItems: previewItems.filter(item => !item.duplicate).length,
        previewItems,
    };
}

app.post('/api/import/preview', upload.single('file'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const targetUserId = (req.isAdmin && req.body.userId) ? req.body.userId : req.userId;
    const filePath = req.file.path;
    const originalName = req.file.originalname;

    try {
        const content = fs.readFileSync(filePath, 'utf-8');
        fs.unlinkSync(filePath);

        const preview = await buildMemoryImportPreview(originalName, content, targetUserId, req.body.mapping);
        res.json({
            dryRun: true,
            ...preview,
        });
    } catch (error: any) {
        try { fs.unlinkSync(filePath); } catch { }
        res.status(400).json({ error: error.message });
    }
});

app.post('/upload/memories', upload.single('file'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    // Admin can upload for any user; regular users upload for themselves only
    const targetUserId = (req.isAdmin && req.body.userId) ? req.body.userId : req.userId;
    const filePath = req.file.path;
    const originalName = req.file.originalname;

    try {
        const content = fs.readFileSync(filePath, 'utf-8');
        fs.unlinkSync(filePath); // clean up temp file

        const plan = buildImportPlan(originalName, content, parseImportMapping(req.body.mapping));
        if (plan.items.length === 0) {
            return res.status(400).json({ error: 'No content found in file' });
        }

        // Respond immediately, process in background
        res.json({ status: `Processing ${plan.items.length} items for import...` });

        // Background processing
        let success = 0, skipped = 0, errors = 0;
        for (const item of plan.items) {
            try {
                const result = await captureThought(item.content, {
                    source: item.source || `upload-${originalName}`,
                    overrideType: item.thoughtType,
                    tags: item.tags,
                    userId: targetUserId
                });
                if (result.status === 'duplicate') skipped++;
                else success++;
            } catch (err: any) {
                console.error(`Upload chunk error: ${err.message}`);
                errors++;
            }
        }
        console.log(`Upload complete for user ${targetUserId}: ${success} imported, ${skipped} duplicates, ${errors} errors`);
    } catch (err: any) {
        if (!res.headersSent) res.status(500).json({ error: err.message });
    }
});

app.post('/upload/restore', adminOnly, upload.single('database'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No SQL file uploaded' });

    try {
        const dbUrl = process.env.DATABASE_URL || 'postgresql://openmind:openmind@postgres:5432/openmind';
        const filePath = req.file.path;

        const cmd = `psql "${dbUrl}" < "${filePath}"`;

        exec(cmd, { maxBuffer: 100 * 1024 * 1024 }, (err, stdout, stderr) => {
            try { fs.unlinkSync(filePath); } catch { }

            if (err) {
                console.error('Restore stderr:', stderr);
                res.json({ status: `Restore completed with warnings. Check logs for details.`, stderr: stderr?.slice(0, 500) });
            } else {
                console.log('Restore stdout:', stdout?.slice(0, 200));
                res.json({ status: 'Database restored successfully!' });
            }
        });
    } catch (err: any) {
        console.error('Restore error:', err);
        res.status(500).json({ error: err.message });
    }
});

const port = process.env.API_PORT || 3333;

export async function startServer() {
    await bootstrap();
    return app.listen(port, () => {
        console.log(`OpenMind API Server running on port ${port}`);
    });
}

if (require.main === module) {
    startServer().catch((error) => {
        console.error('Failed to bootstrap:', error);
        process.exit(1);
    });
}
