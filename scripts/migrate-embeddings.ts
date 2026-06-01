import { db } from '../src/db/client';
import { generateEmbedding } from '../src/embeddings/openrouter';

async function migrateEmbeddings() {
    console.log('🚀 Starting OpenRouter Embeddings Migration');
    console.log('============================================');

    try {
        // Find how many thoughts we have
        const countResult = await db.query('SELECT COUNT(*) FROM thoughts');
        const total = parseInt(countResult.rows[0].count);
        console.log(`Found ${total} thoughts to re-embed.\n`);

        if (total === 0) {
            console.log('No thoughts to migrate. Exiting.');
            process.exit(0);
        }

        // Drop the old 768-dimension table
        console.log('Dropping old thought_embeddings table (768 dimensions)...');
        await db.query('DROP TABLE IF EXISTS thought_embeddings CASCADE');

        // Recreate the new 1536-dimension table
        console.log('Recreating thought_embeddings table (1536 dimensions)...');
        await db.query(`
            CREATE TABLE thought_embeddings (
                thought_id UUID PRIMARY KEY REFERENCES thoughts(id) ON DELETE CASCADE,
                embedding vector(1536) NOT NULL
            )
        `);
        await db.query('CREATE INDEX ON thought_embeddings USING hnsw (embedding vector_cosine_ops)');
        console.log('New table and hnsw index created successfully.\n');

        // Fetch all thoughts (content + id)
        const thoughtsResult = await db.query('SELECT id, content FROM thoughts');
        const thoughts = thoughtsResult.rows;

        console.log(`Beginning batch re-embedding for ${thoughts.length} items via OpenRouter...`);
        let processed = 0;
        let errors = 0;

        for (const thought of thoughts) {
            try {
                process.stdout.write(`Embedding [${processed + 1}/${total}]... `);

                // Call OpenRouter API for the new 1536 vector
                const newEmbedding = await generateEmbedding(thought.content);
                const formattedEmbedding = `[${newEmbedding.join(',')}]`;

                // Insert into the new DB table
                await db.query(
                    'INSERT INTO thought_embeddings (thought_id, embedding) VALUES ($1, $2::vector)',
                    [thought.id, formattedEmbedding]
                );

                process.stdout.write('✅ Done\n');
                processed++;

                // A small delay to respect rate limits (e.g., 200ms)
                await new Promise(resolve => setTimeout(resolve, 200));

            } catch (err: any) {
                process.stdout.write(`❌ Error: ${err.message}\n`);
                errors++;
            }
        }

        console.log('\n============================================');
        console.log(`Migration Complete! ✅`);
        console.log(`Successfully embedded: ${processed}`);
        console.log(`Errors: ${errors}`);
        console.log('Your database is now fully running on openai/text-embedding-3-large (1536d)');
        process.exit(0);

    } catch (error: any) {
        console.error('\n❌ Fatal Migration Error:', error.message);
        process.exit(1);
    }
}

migrateEmbeddings();
