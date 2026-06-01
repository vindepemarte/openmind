"use strict";
/**
 * Instructions for migrating memories from ChatGPT or Claude:
 *
 * OpenAI / ChatGPT:
 * 1. Go to Settings -> Data controls -> Export
 * 2. Download the zip file and extract it
 * 3. Find the `conversations.json` file. Note that memory might also be visible in ChatGPT settings directly.
 * 4. To migrate automatically, you can write a short script that parses `conversations.json`
 *    and POSTs each user message to the OpenMind API (`http://localhost:3333/capture`).
 *
 * Claude:
 * 1. Claude's memory is less directly exportable without using their API or custom scraping.
 * 2. If you have unstructured notes or text files mapping your context,
 *    simply run: `npx tsx scripts/migrate-memories.ts path/to/notes.txt`
 *
 * This script will read a text file (one thought per line/paragraph) and import it.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const fs_1 = __importDefault(require("fs"));
const pipeline_1 = require("../src/processing/pipeline");
async function migrate() {
    const filePath = process.argv[2];
    if (!filePath) {
        console.error('Usage: npx tsx scripts/migrate-memories.ts <path-to-text-file>');
        process.exit(1);
    }
    try {
        const content = fs_1.default.readFileSync(filePath, 'utf-8');
        // Split by double newline (paragraphs) for simplest import format
        const thoughts = content.split(/\n\s*\n/).map(t => t.trim()).filter(t => t.length > 5);
        console.log(`Found ${thoughts.length} thoughts to import. Starting migration...`);
        let success = 0;
        let skipped = 0;
        for (let i = 0; i < thoughts.length; i++) {
            console.log(`Importing [${i + 1}/${thoughts.length}]...`);
            try {
                const res = await (0, pipeline_1.captureThought)(thoughts[i], { source: 'migration' });
                if (res.status === 'duplicate')
                    skipped++;
                else
                    success++;
            }
            catch (err) {
                console.error(`Failed on thought ${i + 1}: ${err.message}`);
            }
        }
        console.log(`\n✅ Migration complete!`);
        console.log(`- Imported: ${success}`);
        console.log(`- Skipped (Duplicates): ${skipped}`);
    }
    catch (error) {
        console.error('Migration failed:', error);
    }
    finally {
        process.exit(0);
    }
}
migrate();
