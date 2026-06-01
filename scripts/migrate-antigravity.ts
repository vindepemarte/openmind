import fs from 'fs';
import path from 'path';
import os from 'os';
import { captureThought } from '../src/processing/pipeline';

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
    if (currentChunk.trim().length > 0) chunks.push(currentChunk.trim());
    return chunks;
}

async function migrateAntigravitySessions() {
    console.log('Scanning Antigravity brain for active session logs...');
    const brainDir = path.join(os.homedir(), '.gemini', 'antigravity', 'brain');

    if (!fs.existsSync(brainDir)) {
        console.error('Antigravity brain directory not found.');
        process.exit(1);
    }

    const sessions = fs.readdirSync(brainDir);
    let allChunks: string[] = [];

    // We only want to export actual text logs, not the .pb binary files
    for (const sessionId of sessions) {
        const logFile = path.join(brainDir, sessionId, '.system_generated', 'logs', 'overview.txt');
        if (fs.existsSync(logFile)) {
            const content = fs.readFileSync(logFile, 'utf-8');
            // Extract only the USER and ASSISTANT messages to prevent importing pure system code context
            const relevantText = content.split('\n')
                .filter(line => line.startsWith('USER:') || line.startsWith('ASSISTANT:'))
                .join('\n');

            if (relevantText.length > 100) {
                const chunks = chunkLargeText(relevantText, 3000);
                allChunks.push(...chunks);
            }
        }
    }

    console.log(`Prepared ${allChunks.length} conversation chunks from Antigravity logs.`);

    let success = 0, skipped = 0, errors = 0;
    for (let i = 0; i < allChunks.length; i++) {
        process.stdout.write(`\rImporting chunk [${i + 1}/${allChunks.length}]... `);
        try {
            const res = await captureThought(allChunks[i], { source: 'migration-antigravity' });
            if (res.status === 'duplicate') skipped++;
            else success++;
        } catch (err: any) {
            console.error(`\n❌ Failed on chunk ${i + 1}: ${err.message}`);
            errors++;
        }
    }

    console.log(`\n\n✅ Antigravity Migration complete!`);
    console.log(`- Imported: ${success}`);
    console.log(`- Skipped (Duplicates): ${skipped}`);
    console.log(`- Errors: ${errors}`);
}

migrateAntigravitySessions().catch(console.error);
