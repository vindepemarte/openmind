import fs from 'fs';
import path from 'path';
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

async function migrateClaudeCode(sessionsDir: string) {
    console.log(`Scanning Claude Code / OpenClaw directory: ${sessionsDir}...`);

    if (!fs.existsSync(sessionsDir)) {
        console.error('Directory not found.');
        process.exit(1);
    }

    const files = fs.readdirSync(sessionsDir).filter(f => f.endsWith('.jsonl'));
    let allChunks: string[] = [];

    for (const file of files) {
        const filePath = path.join(sessionsDir, file);
        const lines = fs.readFileSync(filePath, 'utf-8').split('\n').filter(l => l.trim() !== '');

        let conversationText = `Conversation Log: ${file}\n\n`;

        for (const line of lines) {
            try {
                const event = JSON.parse(line);

                // Extract USER and ASSISTANT messages
                if ((event.type === 'user' || event.type === 'assistant') && event.message && event.message.content) {
                    const role = event.message.role;
                    let textContent = '';

                    if (Array.isArray(event.message.content)) {
                        for (const block of event.message.content) {
                            if (block.type === 'text') textContent += block.text + '\n';
                            if (block.type === 'tool_use') textContent += `[Tool Use: ${block.name}]\n`;
                        }
                    } else if (typeof event.message.content === 'string') {
                        textContent = event.message.content;
                    }

                    // Filter out massive XML/HTML/Base64 blocks for sanity
                    if (textContent.trim() && textContent.length < 10000 && !textContent.includes('base64')) {
                        conversationText += `${role.toUpperCase()}: ${textContent.trim()}\n\n`;
                    }
                }
            } catch (e) {
                // Ignore parse errors on individual lines
            }
        }

        if (conversationText.length > 100) {
            const chunks = chunkLargeText(conversationText, 3000);
            allChunks.push(...chunks);
        }
    }

    console.log(`Prepared ${allChunks.length} conversation chunks from Claude Code.`);
    if (allChunks.length === 0) return;

    let success = 0, skipped = 0, errors = 0;
    for (let i = 0; i < allChunks.length; i++) {
        process.stdout.write(`\rImporting chunk [${i + 1}/${allChunks.length}]... `);
        try {
            const res = await captureThought(allChunks[i], { source: 'migration-claude' });
            if (res.status === 'duplicate') skipped++;
            else success++;
        } catch (err: any) {
            console.error(`\n❌ Failed on chunk ${i + 1}: ${err.message}`);
            errors++;
        }
    }

    console.log(`\n\n✅ Claude Code Migration complete!`);
    console.log(`- Imported: ${success}`);
    console.log(`- Skipped (Duplicates): ${skipped}`);
    console.log(`- Errors: ${errors}`);
}


const targetDir = process.argv[2];
if (!targetDir) {
    console.log("Usage: npx tsx scripts/migrate-claude.ts <path/to/claude/sessions/or/tasks>");
    process.exit(1);
}

// Make sure cwd is right relative to the script
migrateClaudeCode(path.resolve(process.cwd(), targetDir)).catch(console.error);
