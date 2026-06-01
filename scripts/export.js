"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const client_1 = require("../src/db/client");
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
async function exportThoughts() {
    console.log('Fetching all thoughts and metadata...');
    try {
        const result = await client_1.db.query(`
            SELECT 
                t.id, t.content, t.source, t.thought_type, t.summary, t.created_at, t.updated_at,
                m.people, m.topics, m.action_items, m.sentiment
            FROM thoughts t
            LEFT JOIN thought_metadata m ON t.id = m.thought_id
            ORDER BY t.created_at ASC
        `);
        // Get tags
        const tagsResult = await client_1.db.query(`SELECT thought_id, tag FROM thought_tags`);
        const tagsByThought = tagsResult.rows.reduce((acc, row) => {
            if (!acc[row.thought_id])
                acc[row.thought_id] = [];
            acc[row.thought_id].push(row.tag);
            return acc;
        }, {});
        const exportData = result.rows.map(row => ({
            ...row,
            tags: tagsByThought[row.id] || []
        }));
        const dateStr = new Date().toISOString().split('T')[0];
        const filename = `openmind-backup-${dateStr}.json`;
        const filepath = path_1.default.join(__dirname, '..', filename);
        fs_1.default.writeFileSync(filepath, JSON.stringify(exportData, null, 2));
        console.log(`\n✅ Exported ${exportData.length} thoughts to ${filename}`);
    }
    catch (error) {
        console.error('Export failed:', error);
    }
    finally {
        process.exit(0);
    }
}
exportThoughts();
