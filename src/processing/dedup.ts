import crypto from 'crypto';

/**
 * Normalizes text (trims, removes excess whitespace) and generates a SHA-256 hash
 * to serve as a unique fingerprint for a thought content.
 */
export function generateContentHash(content: string): string {
    // Normalize content: lowercase, trim, remove multiple spaces
    const normalized = content
        .trim()
        .toLowerCase()
        .replace(/\s+/g, ' ');

    return crypto.createHash('sha256').update(normalized).digest('hex');
}

export function getDuplicateLookup(contentHash: string, userId?: string): { query: string; params: string[] } {
    if (userId) {
        return {
            query: 'SELECT id FROM thoughts WHERE content_hash = $1 AND user_id = $2',
            params: [contentHash, userId]
        };
    }

    return {
        query: 'SELECT id FROM thoughts WHERE content_hash = $1 AND user_id IS NULL',
        params: [contentHash]
    };
}

export function getBulkDuplicateLookup(contentHashes: string[], userId?: string): { query: string; params: any[] } {
    if (userId) {
        return {
            query: 'SELECT content_hash FROM thoughts WHERE content_hash = ANY($1::text[]) AND user_id = $2',
            params: [contentHashes, userId]
        };
    }

    return {
        query: 'SELECT content_hash FROM thoughts WHERE content_hash = ANY($1::text[]) AND user_id IS NULL',
        params: [contentHashes]
    };
}

interface ThoughtInsertOptions {
    content: string;
    contentHash: string;
    source: string;
    thoughtType: string;
    summary?: string | null;
    userId?: string;
}

export function getThoughtInsertQuery(options: ThoughtInsertOptions): { query: string; params: any[] } {
    const sharedColumns = 'content, content_hash, source, thought_type, summary, user_id';
    const sharedValues = '$1, $2, $3, $4, $5, $6';
    const sharedParams = [
        options.content,
        options.contentHash,
        options.source,
        options.thoughtType,
        options.summary || null,
        options.userId || null
    ];

    if (options.userId) {
        return {
            query: `INSERT INTO thoughts (${sharedColumns})
                    VALUES (${sharedValues})
                    ON CONFLICT (user_id, content_hash) WHERE user_id IS NOT NULL DO NOTHING
                    RETURNING id`,
            params: sharedParams
        };
    }

    return {
        query: `INSERT INTO thoughts (${sharedColumns})
                VALUES (${sharedValues})
                ON CONFLICT (content_hash) WHERE user_id IS NULL DO NOTHING
                RETURNING id`,
        params: sharedParams
    };
}
