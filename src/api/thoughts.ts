import { Router } from 'express';

import { db, withTransaction } from '../db/client';
import { generateEmbedding } from '../embeddings';
import { extractMetadata } from '../processing/metadata';
import { generateContentHash } from '../processing/dedup';

export const thoughtsRouter = Router();

const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 25;
const MAX_THOUGHT_SOURCE_LENGTH = 50;
const MAX_THOUGHT_TYPE_LENGTH = 50;
const MAX_TAG_LENGTH = 50;
const MAX_SUMMARY_LENGTH = 500;

function clampLimit(value: unknown): number {
    const parsed = Number.parseInt(String(value || DEFAULT_LIMIT), 10);
    if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_LIMIT;
    return Math.min(parsed, MAX_LIMIT);
}

function parseOffset(value: unknown): number {
    const parsed = Number.parseInt(String(value || 0), 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function normalizeSource(source: unknown, fallback = 'dashboard'): string {
    if (typeof source !== 'string') return fallback;
    const normalized = source.trim();
    return (normalized || fallback).slice(0, MAX_THOUGHT_SOURCE_LENGTH);
}

function normalizeThoughtType(value: unknown, fallback = 'other'): string {
    if (typeof value !== 'string') return fallback;
    const normalized = value.trim().toLowerCase();
    return (normalized || fallback).slice(0, MAX_THOUGHT_TYPE_LENGTH);
}

function normalizeSentiment(value: unknown): 'positive' | 'neutral' | 'negative' {
    if (typeof value !== 'string') return 'neutral';
    const normalized = value.trim().toLowerCase();
    return normalized === 'positive' || normalized === 'negative' ? normalized : 'neutral';
}

function normalizeStringList(value: unknown, maxItemLength: number): string[] {
    if (!Array.isArray(value)) return [];

    const seen = new Set<string>();
    const normalizedValues: string[] = [];

    for (const item of value) {
        if (typeof item !== 'string') continue;
        const normalized = item.trim();
        if (!normalized) continue;

        const trimmed = normalized.slice(0, maxItemLength);
        const dedupKey = trimmed.toLowerCase();
        if (seen.has(dedupKey)) continue;

        seen.add(dedupKey);
        normalizedValues.push(trimmed);
    }

    return normalizedValues;
}

function normalizeSummary(summary: unknown, content: string): string {
    if (typeof summary === 'string') {
        const normalized = summary.trim();
        if (normalized) return normalized.slice(0, MAX_SUMMARY_LENGTH);
    }

    return content.trim().slice(0, Math.min(content.length, MAX_SUMMARY_LENGTH));
}

function normalizeTags(input: unknown): string[] | undefined {
    if (input === undefined) return undefined;

    const values = Array.isArray(input)
        ? input
        : typeof input === 'string'
            ? input.split(',')
            : [];

    const seen = new Set<string>();
    const tags: string[] = [];

    for (const value of values) {
        if (typeof value !== 'string') continue;
        const normalized = value.toLowerCase().trim().slice(0, MAX_TAG_LENGTH);
        if (!normalized || seen.has(normalized)) continue;
        seen.add(normalized);
        tags.push(normalized);
    }

    return tags;
}

function buildAccessCondition(req: any, alias = 't'): { sql: string; params: any[] } {
    if (req.isAdmin || !req.userId) {
        return { sql: '', params: [] };
    }

    return {
        sql: `${alias}.user_id = $1`,
        params: [req.userId],
    };
}

function appendCondition(
    conditions: string[],
    params: any[],
    condition: string,
    value: any,
) {
    params.push(value);
    conditions.push(condition.replace('?', `$${params.length}`));
}

function selectThoughtSql(whereClause: string) {
    return `SELECT t.id,
                   t.content,
                   t.content_hash,
                   t.source,
                   t.thought_type,
                   t.summary,
                   t.user_id,
                   t.created_at,
                   t.updated_at,
                   COALESCE(tags.tags, '{}') AS tags,
                   m.people,
                   m.topics,
                   m.action_items,
                   m.sentiment
            FROM thoughts t
            LEFT JOIN thought_metadata m ON t.id = m.thought_id
            LEFT JOIN LATERAL (
                SELECT array_agg(tt.tag ORDER BY tt.tag) AS tags
                FROM thought_tags tt
                WHERE tt.thought_id = t.id
            ) tags ON true
            ${whereClause}`;
}

async function fetchThoughtById(id: string, req: any) {
    const params: any[] = [id];
    const conditions = ['t.id = $1'];

    if (!req.isAdmin && req.userId) {
        params.push(req.userId);
        conditions.push(`t.user_id = $${params.length}`);
    }

    const result = await db.query(
        `${selectThoughtSql(`WHERE ${conditions.join(' AND ')}`)}`,
        params,
    );

    return result.rows[0] ?? null;
}

async function assertNoContentConflict(contentHash: string, userId: string | null, thoughtId: string) {
    const params: any[] = [contentHash, thoughtId];
    let query = `SELECT id FROM thoughts WHERE content_hash = $1 AND id <> $2`;

    if (userId) {
        params.push(userId);
        query += ` AND user_id = $${params.length}`;
    } else {
        query += ` AND user_id IS NULL`;
    }

    const result = await db.query(query, params);
    if (result.rows.length > 0) {
        const error = new Error('A thought with the same content already exists');
        (error as any).statusCode = 409;
        throw error;
    }
}

thoughtsRouter.get('/api/thoughts', async (req, res) => {
    try {
        const limit = clampLimit(req.query.limit);
        const offset = parseOffset(req.query.offset);
        const params: any[] = [];
        const conditions: string[] = [];
        const access = buildAccessCondition(req, 't');

        params.push(...access.params);
        if (access.sql) conditions.push(access.sql);

        const textQuery = typeof req.query.q === 'string' ? req.query.q.trim() : '';
        if (textQuery) {
            const pattern = `%${textQuery}%`;
            params.push(pattern);
            const contentParam = params.length;
            params.push(pattern);
            const summaryParam = params.length;
            conditions.push(`(t.content ILIKE $${contentParam} OR t.summary ILIKE $${summaryParam})`);
        }

        const type = typeof req.query.type === 'string' ? req.query.type.trim().toLowerCase() : '';
        if (type) appendCondition(conditions, params, 't.thought_type = ?', type);

        const source = typeof req.query.source === 'string' ? req.query.source.trim() : '';
        if (source) appendCondition(conditions, params, 't.source = ?', source);

        const tag = typeof req.query.tag === 'string' ? req.query.tag.trim().toLowerCase() : '';
        if (tag) {
            appendCondition(
                conditions,
                params,
                `EXISTS (SELECT 1 FROM thought_tags filter_tags WHERE filter_tags.thought_id = t.id AND filter_tags.tag = ?)`,
                tag,
            );
        }

        const from = typeof req.query.from === 'string' ? req.query.from.trim() : '';
        if (from) appendCondition(conditions, params, 't.created_at >= ?', from);

        const to = typeof req.query.to === 'string' ? req.query.to.trim() : '';
        if (to) appendCondition(conditions, params, 't.created_at <= ?', to);

        const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
        const countResult = await db.query(
            `SELECT COUNT(*)::int AS total FROM thoughts t ${whereClause}`,
            params,
        );

        const listParams = [...params, limit, offset];
        const listResult = await db.query(
            `${selectThoughtSql(whereClause)}
             ORDER BY t.created_at DESC
             LIMIT $${listParams.length - 1}
             OFFSET $${listParams.length}`,
            listParams,
        );

        res.json({
            items: listResult.rows,
            total: countResult.rows[0]?.total ?? 0,
            limit,
            offset,
        });
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
});

thoughtsRouter.get('/api/thoughts/:id', async (req, res) => {
    try {
        const thought = await fetchThoughtById(req.params.id, req);
        if (!thought) return res.status(404).json({ error: 'Thought not found' });
        res.json(thought);
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
});

thoughtsRouter.patch('/api/thoughts/:id', async (req, res) => {
    try {
        const existing = await fetchThoughtById(req.params.id, req);
        if (!existing) return res.status(404).json({ error: 'Thought not found' });

        const body = req.body ?? {};
        const hasContentUpdate = Object.prototype.hasOwnProperty.call(body, 'content');
        const nextContent = hasContentUpdate ? String(body.content || '').trim() : existing.content;
        if (!nextContent) return res.status(400).json({ error: 'content cannot be empty' });

        const metadata = hasContentUpdate ? await extractMetadata(nextContent) : null;
        const contentHash = hasContentUpdate ? generateContentHash(nextContent) : existing.content_hash;
        const userId = existing.user_id || null;

        if (hasContentUpdate && contentHash !== existing.content_hash) {
            await assertNoContentConflict(contentHash, userId, existing.id);
        }

        const hasTypeUpdate = Object.prototype.hasOwnProperty.call(body, 'type')
            || Object.prototype.hasOwnProperty.call(body, 'thought_type');
        const nextType = hasTypeUpdate
            ? normalizeThoughtType(body.type ?? body.thought_type, existing.thought_type)
            : hasContentUpdate
                ? normalizeThoughtType(metadata?.type, existing.thought_type)
                : existing.thought_type;

        const hasSourceUpdate = Object.prototype.hasOwnProperty.call(body, 'source');
        const nextSource = hasSourceUpdate
            ? normalizeSource(body.source, existing.source)
            : existing.source;

        const hasSummaryUpdate = Object.prototype.hasOwnProperty.call(body, 'summary');
        const nextSummary = hasSummaryUpdate
            ? normalizeSummary(body.summary, nextContent)
            : hasContentUpdate
                ? normalizeSummary(metadata?.summary, nextContent)
                : existing.summary;

        const nextTags = normalizeTags(body.tags);
        const actionItems = hasContentUpdate
            ? normalizeStringList(metadata?.action_items, 300)
            : undefined;
        const nextEmbedding = hasContentUpdate ? await generateEmbedding(nextContent) : null;

        await withTransaction(async (client) => {
            await client.query(
                `UPDATE thoughts
                 SET content = $1,
                     content_hash = $2,
                     source = $3,
                     thought_type = $4,
                     summary = $5,
                     updated_at = NOW()
                 WHERE id = $6`,
                [nextContent, contentHash, nextSource, nextType, nextSummary, existing.id],
            );

            if (hasContentUpdate) {
                await client.query(
                    `INSERT INTO thought_embeddings (thought_id, embedding)
                     VALUES ($1, $2)
                     ON CONFLICT (thought_id) DO UPDATE SET embedding = EXCLUDED.embedding`,
                    [existing.id, `[${nextEmbedding!.join(',')}]`],
                );

                await client.query(
                    `INSERT INTO thought_metadata (thought_id, people, topics, action_items, sentiment)
                     VALUES ($1, $2, $3, $4, $5)
                     ON CONFLICT (thought_id) DO UPDATE
                     SET people = EXCLUDED.people,
                         topics = EXCLUDED.topics,
                         action_items = EXCLUDED.action_items,
                         sentiment = EXCLUDED.sentiment`,
                    [
                        existing.id,
                        normalizeStringList(metadata?.people, 120),
                        normalizeStringList(metadata?.topics, 120),
                        actionItems,
                        normalizeSentiment(metadata?.sentiment),
                    ],
                );

                await client.query(`DELETE FROM thought_tasks WHERE thought_id = $1`, [existing.id]);
                for (const actionItem of actionItems || []) {
                    await client.query(
                        `INSERT INTO thought_tasks (thought_id, user_id, content)
                         VALUES ($1, $2, $3)
                         ON CONFLICT (thought_id, content) DO NOTHING`,
                        [existing.id, userId, actionItem],
                    );
                }
            }

            if (nextTags !== undefined) {
                await client.query(`DELETE FROM thought_tags WHERE thought_id = $1`, [existing.id]);
                for (const tag of nextTags) {
                    await client.query(
                        `INSERT INTO thought_tags (thought_id, tag)
                         VALUES ($1, $2)
                         ON CONFLICT DO NOTHING`,
                        [existing.id, tag],
                    );
                }
            }
        });

        const updated = await fetchThoughtById(req.params.id, req);
        res.json(updated);
    } catch (error: any) {
        res.status(error.statusCode || 500).json({ error: error.message });
    }
});

thoughtsRouter.delete('/api/thoughts/:id', async (req, res) => {
    try {
        const params: any[] = [req.params.id];
        let query = `DELETE FROM thoughts WHERE id = $1`;

        if (!req.isAdmin && req.userId) {
            params.push(req.userId);
            query += ` AND user_id = $${params.length}`;
        }

        query += ` RETURNING id`;
        const result = await db.query(query, params);
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Thought not found' });
        }

        res.json({ deleted: true, id: result.rows[0].id });
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
});
