import { db, withTransaction } from '../db/client';
import { generateContentHash, getDuplicateLookup, getThoughtInsertQuery } from './dedup';
import { generateEmbedding } from '../embeddings/openrouter';
import { extractMetadata } from './metadata';

export interface CaptureOptions {
    source: string;
    overrideType?: string;
    tags?: string[];
    userId?: string;
}

export interface CaptureResult {
    id: string;
    status: 'created' | 'duplicate' | 'error';
    metadata?: any;
    chunks_processed?: number;
}

const MAX_THOUGHT_SOURCE_LENGTH = 50;
const MAX_THOUGHT_TYPE_LENGTH = 50;
const MAX_TAG_LENGTH = 50;
const MAX_SUMMARY_LENGTH = 500;

function normalizeSource(source: string): string {
    const normalized = source.trim();
    if (!normalized) return 'unknown';
    return normalized.slice(0, MAX_THOUGHT_SOURCE_LENGTH);
}

function normalizeThoughtType(value: unknown, fallback: string = 'other'): string {
    if (typeof value !== 'string') return fallback;

    const normalized = value.trim().toLowerCase();
    if (!normalized) return fallback;
    return normalized.slice(0, MAX_THOUGHT_TYPE_LENGTH);
}

function normalizeSentiment(value: unknown): 'positive' | 'neutral' | 'negative' {
    if (typeof value !== 'string') return 'neutral';

    const normalized = value.trim().toLowerCase();
    if (normalized === 'positive' || normalized === 'neutral' || normalized === 'negative') {
        return normalized;
    }

    return 'neutral';
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
        if (normalized) {
            return normalized.slice(0, MAX_SUMMARY_LENGTH);
        }
    }

    return content.trim().slice(0, Math.min(content.length, MAX_SUMMARY_LENGTH));
}

function normalizeTags(tags: string[] | undefined): string[] {
    if (!tags || tags.length === 0) return [];

    const seen = new Set<string>();
    const normalizedTags: string[] = [];

    for (const tag of tags) {
        if (typeof tag !== 'string') continue;

        const normalized = tag.toLowerCase().trim().slice(0, MAX_TAG_LENGTH);
        if (!normalized || seen.has(normalized)) continue;

        seen.add(normalized);
        normalizedTags.push(normalized);
    }

    return normalizedTags;
}

export async function captureThought(content: string, options: CaptureOptions): Promise<CaptureResult> {
    try {
        const source = normalizeSource(options.source);
        const contentHash = generateContentHash(content);
        const duplicateLookup = getDuplicateLookup(contentHash, options.userId);

        // 1. Deduplication check
        const existing = await db.query(duplicateLookup.query, duplicateLookup.params);

        if (existing.rows.length > 0) {
            await db.query(
                `INSERT INTO capture_events (user_id, source, content_hash, status, thought_id)
                 VALUES ($1, $2, $3, $4, $5)`,
                [options.userId || null, source, contentHash, 'duplicate', existing.rows[0].id]
            ).catch(() => {});

            // console.log(`Thought already exists. Skipping duplicate. [Hash: ${contentHash}]`);
            return { id: existing.rows[0].id, status: 'duplicate' };
        }

        // console.log('Processing new thought...');

        // 2. Metadata Extraction
        const extractedMetadata = await extractMetadata(content);
        const metadata = {
            type: normalizeThoughtType(extractedMetadata?.type),
            people: normalizeStringList(extractedMetadata?.people, 120),
            topics: normalizeStringList(extractedMetadata?.topics, 120),
            action_items: normalizeStringList(extractedMetadata?.action_items, 300),
            sentiment: normalizeSentiment(extractedMetadata?.sentiment),
            summary: normalizeSummary(extractedMetadata?.summary, content),
        };
        const finalType = normalizeThoughtType(options.overrideType, metadata.type);
        const normalizedTags = normalizeTags(options.tags);

        // 3. Chunking & Embedding
        // We embed the whole text for overall semantic search, but we could also embed chunks.
        // For simplicity in V1, we embed the whole content. Nomic supports 8192 tokens.
        const embedding = await generateEmbedding(content);

        // 4. Database Transaction
        const persistence = await withTransaction(async (client) => {
            const insertThought = getThoughtInsertQuery({
                content,
                contentHash,
                source,
                thoughtType: finalType,
                summary: metadata.summary,
                userId: options.userId
            });

            const thoughtRes = await client.query(insertThought.query, insertThought.params);

            if (thoughtRes.rows.length === 0) {
                const concurrentDuplicate = await client.query(duplicateLookup.query, duplicateLookup.params);
                if (concurrentDuplicate.rows.length === 0) {
                    throw new Error('Thought insert conflict detected but duplicate lookup returned no row');
                }

                await client.query(
                    `INSERT INTO capture_events (user_id, source, content_hash, status, thought_id)
                     VALUES ($1, $2, $3, $4, $5)`,
                    [options.userId || null, source, contentHash, 'duplicate', concurrentDuplicate.rows[0].id]
                );

                return { id: concurrentDuplicate.rows[0].id, status: 'duplicate' as const };
            }

            const id = thoughtRes.rows[0].id;

            // Insert embedding (note: requires pgvector format '[0.1, 0.2, ...]')
            const formattedEmbedding = `[${embedding.join(',')}]`;
            await client.query(
                `INSERT INTO thought_embeddings (thought_id, embedding) VALUES ($1, $2)`,
                [id, formattedEmbedding]
            );

            // Insert metadata
            await client.query(
                `INSERT INTO thought_metadata (thought_id, people, topics, action_items, sentiment) 
                 VALUES ($1, $2, $3, $4, $5)`,
                [id, metadata.people, metadata.topics, metadata.action_items, metadata.sentiment]
            );

            const uniqueActionItems = Array.from(new Set((metadata.action_items || []).map(item => item.trim()).filter(Boolean)));
            for (const actionItem of uniqueActionItems) {
                await client.query(
                    `INSERT INTO thought_tasks (thought_id, user_id, content)
                     VALUES ($1, $2, $3)
                     ON CONFLICT (thought_id, content) DO NOTHING`,
                    [id, options.userId || null, actionItem]
                );
            }

            // Insert tags if any exist
            if (normalizedTags.length > 0) {
                for (const tag of normalizedTags) {
                    await client.query(
                        `INSERT INTO thought_tags (thought_id, tag) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
                        [id, tag]
                    );
                }
            }

            await client.query(
                `INSERT INTO capture_events (user_id, source, content_hash, status, thought_id)
                 VALUES ($1, $2, $3, $4, $5)`,
                [options.userId || null, source, contentHash, 'created', id]
            );

            // Create links between inferred topics (simplistic knowledge graph implementation)
            // Just a placeholder loop for topic correlation logic if needed.

            return { id, status: 'created' as const };
        });

        if (persistence.status === 'duplicate') {
            return {
                id: persistence.id,
                status: 'duplicate'
            };
        }

        return {
            id: persistence.id,
            status: 'created',
            metadata: metadata
        };
    } catch (error) {
        console.error('Failed to capture thought:', error);
        await db.query(
            `INSERT INTO capture_events (user_id, source, content_hash, status)
             VALUES ($1, $2, $3, $4)`,
            [options.userId || null, normalizeSource(options.source), generateContentHash(content), 'error']
        ).catch(() => {});
        throw error;
    }
}
