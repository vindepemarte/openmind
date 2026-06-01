import fs from 'fs';
import path from 'path';
import { captureThought } from '../src/processing/pipeline';

// A simple utility to chunk large strings into roughly 2000-character blocks, split by paragraphs
function chunkLargeText(text: string, maxCharLength: number = 2000): string[] {
    const paragraphs = text.split(/\n\s*\n/).map(p => p.trim()).filter(p => p.length > 0);
    const chunks: string[] = [];
    let currentChunk = '';

    for (const paragraph of paragraphs) {
        if ((currentChunk.length + paragraph.length) > maxCharLength && currentChunk.length > 0) {
            chunks.push(currentChunk.trim());
            currentChunk = paragraph;
        } else {
            currentChunk = currentChunk ? currentChunk + '\n\n' + paragraph : paragraph;
        }
    }

    if (currentChunk.trim().length > 0) {
        chunks.push(currentChunk.trim());
    }

    return chunks;
}

async function processChatGPTExport(filePath: string) {
    console.log(`Loading ChatGPT export from ${filePath}...`);
    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));

    if (!Array.isArray(data)) {
        throw new Error('Invalid ChatGPT conversations.json format. Expected an array.');
    }

    const compiledThoughts: string[] = [];

    for (const conversation of data) {
        if (!conversation.mapping) continue;

        const title = conversation.title || 'Untitled Conversation';
        let currentConversationText = `Conversation: ${title}\n\n`;

        // Iterate over nodes in chronological order if possible (mapping keys are IDs, but usually parent pointers exist)
        // Simplest way: just grab all text parts from user and assistant
        for (const key in conversation.mapping) {
            const node = conversation.mapping[key];
            if (node.message && node.message.content && node.message.author) {
                const role = node.message.author.role;
                const parts = node.message.content.parts;

                if ((role === 'user' || role === 'assistant') && Array.isArray(parts)) {
                    const text = parts.join('\n').trim();
                    if (text.length > 0) {
                        currentConversationText += `${role.toUpperCase()}: ${text}\n\n`;
                    }
                }
            }
        }

        // If the conversation is huge, chunk it to ensure high-quality semantic search
        const chunks = chunkLargeText(currentConversationText, 3000);
        compiledThoughts.push(...chunks);
    }

    return compiledThoughts;
}

async function processRawText(filePath: string) {
    console.log(`Loading raw text from ${filePath}...`);
    const content = fs.readFileSync(filePath, 'utf-8');

    // Chunk large files to preserve semantic search quality
    return chunkLargeText(content, 2000);
}

async function migrate() {
    const type = process.argv[2]; // '--chatgpt' or '--text'
    const filePath = process.argv[3];

    if (!type || !filePath || (type !== '--chatgpt' && type !== '--text')) {
        console.error('Usage: npx tsx scripts/migrate-memories.ts < --chatgpt | --text > <path-to-file>');
        process.exit(1);
    }

    try {
        let thoughts: string[] = [];

        if (type === '--chatgpt') {
            thoughts = await processChatGPTExport(filePath);
        } else if (type === '--text') {
            thoughts = await processRawText(filePath);
        }

        console.log(`\nPrepared ${thoughts.length} individual thought chunks for import.`);
        console.log(`Initializing migration. This may take some time depending on your LLM API limits...\n`);

        let success = 0;
        let errors = 0;
        let skipped = 0;

        for (let i = 0; i < thoughts.length; i++) {
            process.stdout.write(`\rImporting chunk [${i + 1}/${thoughts.length}]... `);
            try {
                // Ensure we don't hit rate limits too hard for OpenRouter
                const res = await captureThought(thoughts[i], { source: `migration-${type.replace('--', '')}` });
                if (res.status === 'duplicate') skipped++;
                else success++;
            } catch (err: any) {
                console.error(`\n❌ Failed on chunk ${i + 1}: ${err.message}`);
                errors++;
            }
        }

        console.log(`\n\n✅ Migration complete!`);
        console.log(`- Imported: ${success}`);
        console.log(`- Skipped (Duplicates): ${skipped}`);
        console.log(`- Errors: ${errors}`);

    } catch (error: any) {
        console.error('Migration failed:', error);
    } finally {
        process.exit(0);
    }
}

migrate();
