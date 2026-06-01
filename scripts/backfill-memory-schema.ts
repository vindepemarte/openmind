import { db } from '../src/db/client';

interface MigrationStep {
    label: string;
    sql: string;
}

const steps: MigrationStep[] = [
    {
        label: 'enable uuid extension',
        sql: `CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`
    },
    {
        label: 'enable vector extension',
        sql: `CREATE EXTENSION IF NOT EXISTS vector`
    },
    {
        label: 'create thought_embeddings table',
        sql: `
            CREATE TABLE IF NOT EXISTS thought_embeddings (
                thought_id UUID PRIMARY KEY REFERENCES thoughts(id) ON DELETE CASCADE,
                embedding vector(1536) NOT NULL
            )
        `
    },
    {
        label: 'create HNSW index for thought_embeddings',
        sql: `
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
        `
    },
    {
        label: 'create thought_metadata table',
        sql: `
            CREATE TABLE IF NOT EXISTS thought_metadata (
                thought_id UUID PRIMARY KEY REFERENCES thoughts(id) ON DELETE CASCADE,
                people TEXT[],
                topics TEXT[],
                action_items TEXT[],
                sentiment VARCHAR(20)
            )
        `
    },
    {
        label: 'create thought_tags table',
        sql: `
            CREATE TABLE IF NOT EXISTS thought_tags (
                thought_id UUID REFERENCES thoughts(id) ON DELETE CASCADE,
                tag VARCHAR(50) NOT NULL,
                PRIMARY KEY (thought_id, tag)
            )
        `
    },
    {
        label: 'create thought_links table',
        sql: `
            CREATE TABLE IF NOT EXISTS thought_links (
                source_id UUID REFERENCES thoughts(id) ON DELETE CASCADE,
                target_id UUID REFERENCES thoughts(id) ON DELETE CASCADE,
                relationship VARCHAR(50) NOT NULL,
                PRIMARY KEY (source_id, target_id, relationship)
            )
        `
    }
];

async function main() {
    try {
        for (const step of steps) {
            await db.query(step.sql);
            console.log(`ok - ${step.label}`);
        }
    } finally {
        await db.end();
    }
}

main().catch((error) => {
    const message =
        error instanceof Error
            ? (error.stack || error.message || 'Memory schema backfill failed with an unknown error')
            : (typeof error === 'string' && error.trim().length > 0)
                ? error
                : `Memory schema backfill failed with an unknown error payload: ${JSON.stringify(error)}`;
    console.error(message);
    process.exit(1);
});
