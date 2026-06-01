import { db } from '../src/db/client';

interface SafetyCheck {
    label: string;
    query: string;
    params?: any[];
}

async function runCheck(check: SafetyCheck) {
    const result = await db.query(check.query, check.params ?? []);
    const exists = Boolean(result.rows[0]?.exists);

    if (!exists) {
        throw new Error(`Migration safety check failed: ${check.label}`);
    }

    console.log(`ok - ${check.label}`);
}

async function main() {
    const checks: SafetyCheck[] = [
        {
            label: 'users table exists',
            query: `SELECT EXISTS (
                SELECT 1 FROM information_schema.tables
                WHERE table_schema = 'public' AND table_name = 'users'
            ) AS exists`
        },
        {
            label: 'api_keys table exists',
            query: `SELECT EXISTS (
                SELECT 1 FROM information_schema.tables
                WHERE table_schema = 'public' AND table_name = 'api_keys'
            ) AS exists`
        },
        {
            label: 'thoughts table exists',
            query: `SELECT EXISTS (
                SELECT 1 FROM information_schema.tables
                WHERE table_schema = 'public' AND table_name = 'thoughts'
            ) AS exists`
        },
        {
            label: 'thoughts.user_id column exists',
            query: `SELECT EXISTS (
                SELECT 1 FROM information_schema.columns
                WHERE table_schema = 'public' AND table_name = 'thoughts' AND column_name = 'user_id'
            ) AS exists`
        },
        {
            label: 'oauth_codes PKCE columns exist',
            query: `SELECT EXISTS (
                SELECT 1 FROM information_schema.columns
                WHERE table_schema = 'public' AND table_name = 'oauth_codes' AND column_name = 'code_challenge'
            ) AND EXISTS (
                SELECT 1 FROM information_schema.columns
                WHERE table_schema = 'public' AND table_name = 'oauth_codes' AND column_name = 'code_challenge_method'
            ) AS exists`
        },
        {
            label: 'thought_embeddings table exists',
            query: `SELECT EXISTS (
                SELECT 1 FROM information_schema.tables
                WHERE table_schema = 'public' AND table_name = 'thought_embeddings'
            ) AS exists`
        },
        {
            label: 'thought_embeddings HNSW index exists',
            query: `SELECT EXISTS (
                SELECT 1 FROM pg_indexes
                WHERE schemaname = 'public'
                    AND tablename = 'thought_embeddings'
                    AND indexdef ILIKE '%USING hnsw%'
            ) AS exists`
        },
        {
            label: 'thought_metadata table exists',
            query: `SELECT EXISTS (
                SELECT 1 FROM information_schema.tables
                WHERE table_schema = 'public' AND table_name = 'thought_metadata'
            ) AS exists`
        },
        {
            label: 'thought_tags table exists',
            query: `SELECT EXISTS (
                SELECT 1 FROM information_schema.tables
                WHERE table_schema = 'public' AND table_name = 'thought_tags'
            ) AS exists`
        },
        {
            label: 'thought_links table exists',
            query: `SELECT EXISTS (
                SELECT 1 FROM information_schema.tables
                WHERE table_schema = 'public' AND table_name = 'thought_links'
            ) AS exists`
        },
        {
            label: 'capture_events table exists',
            query: `SELECT EXISTS (
                SELECT 1 FROM information_schema.tables
                WHERE table_schema = 'public' AND table_name = 'capture_events'
            ) AS exists`
        },
        {
            label: 'idx_capture_events_status index exists',
            query: `SELECT EXISTS (
                SELECT 1 FROM pg_indexes
                WHERE schemaname = 'public' AND indexname = 'idx_capture_events_status'
            ) AS exists`
        },
        {
            label: 'thought_tasks table exists',
            query: `SELECT EXISTS (
                SELECT 1 FROM information_schema.tables
                WHERE table_schema = 'public' AND table_name = 'thought_tasks'
            ) AS exists`
        },
        {
            label: 'thought_tasks completion columns exist',
            query: `SELECT EXISTS (
                SELECT 1 FROM information_schema.columns
                WHERE table_schema = 'public' AND table_name = 'thought_tasks' AND column_name = 'is_completed'
            ) AND EXISTS (
                SELECT 1 FROM information_schema.columns
                WHERE table_schema = 'public' AND table_name = 'thought_tasks' AND column_name = 'completed_at'
            ) AS exists`
        },
        {
            label: 'idx_thoughts_user_id index exists',
            query: `SELECT EXISTS (
                SELECT 1 FROM pg_indexes
                WHERE schemaname = 'public' AND indexname = 'idx_thoughts_user_id'
            ) AS exists`
        },
        {
            label: 'idx_thoughts_user_content_hash_unique index exists',
            query: `SELECT EXISTS (
                SELECT 1 FROM pg_indexes
                WHERE schemaname = 'public' AND indexname = 'idx_thoughts_user_content_hash_unique'
            ) AS exists`
        },
        {
            label: 'idx_thoughts_anonymous_content_hash_unique index exists',
            query: `SELECT EXISTS (
                SELECT 1 FROM pg_indexes
                WHERE schemaname = 'public' AND indexname = 'idx_thoughts_anonymous_content_hash_unique'
            ) AS exists`
        },
        {
            label: 'legacy thoughts_content_hash_key constraint removed',
            query: `SELECT NOT EXISTS (
                SELECT 1 FROM pg_constraint
                WHERE conname = 'thoughts_content_hash_key'
                  AND conrelid = 'thoughts'::regclass
            ) AS exists`
        },
        {
            label: 'idx_capture_events_user_created_at index exists',
            query: `SELECT EXISTS (
                SELECT 1 FROM pg_indexes
                WHERE schemaname = 'public' AND indexname = 'idx_capture_events_user_created_at'
            ) AS exists`
        },
        {
            label: 'idx_thought_tasks_user_completed index exists',
            query: `SELECT EXISTS (
                SELECT 1 FROM pg_indexes
                WHERE schemaname = 'public' AND indexname = 'idx_thought_tasks_user_completed'
            ) AS exists`
        }
    ];

    try {
        for (const check of checks) {
            await runCheck(check);
        }

        console.log('Migration safety checks passed.');
    } finally {
        await db.end();
    }
}

main().catch((error) => {
    const message =
        error instanceof Error
            ? (error.stack || error.message || 'Migration safety checks failed with an unknown error')
            : (typeof error === 'string' && error.trim().length > 0)
                ? error
                : `Migration safety checks failed with an unknown error payload: ${JSON.stringify(error)}`;
    console.error(message);
    process.exit(1);
});
