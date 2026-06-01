export type ImportSourceType = 'csv' | 'chatgpt' | 'claude' | 'text';

export interface CsvImportMapping {
    contentColumn: string;
    sourceColumn?: string;
    typeColumn?: string;
    tagsColumn?: string;
}

export interface ImportItem {
    content: string;
    source: string;
    thoughtType?: string;
    tags: string[];
}

export interface ImportPlan {
    detectedType: ImportSourceType;
    headers: string[];
    mapping: CsvImportMapping | null;
    items: ImportItem[];
}

const CONTENT_COLUMN_HINTS = ['content', 'text', 'message', 'note', 'body', 'thought', 'memory'];
const SOURCE_COLUMN_HINTS = ['source', 'origin', 'app', 'channel', 'system'];
const TYPE_COLUMN_HINTS = ['type', 'thought_type', 'category', 'kind'];
const TAGS_COLUMN_HINTS = ['tags', 'labels', 'keywords'];

function trimCell(value: string | undefined): string {
    return (value || '').trim();
}

function findHeader(headers: string[], hints: string[]): string | undefined {
    const normalized = headers.map(header => ({
        original: header,
        normalized: header.trim().toLowerCase()
    }));

    for (const hint of hints) {
        const match = normalized.find(header => header.normalized === hint);
        if (match) return match.original;
    }

    for (const hint of hints) {
        const match = normalized.find(header => header.normalized.includes(hint));
        if (match) return match.original;
    }

    return undefined;
}

export function chunkLargeText(text: string, maxCharLength: number = 2000): string[] {
    if (maxCharLength <= 0) return [];

    const paragraphs = text.split(/\n\s*\n/).map(p => p.trim()).filter(p => p.length > 0);
    const chunks: string[] = [];
    let currentChunk = '';

    function splitByWords(segment: string): string[] {
        const normalized = segment.trim();
        if (!normalized) return [];
        if (normalized.length <= maxCharLength) return [normalized];

        const words = normalized.split(/\s+/).filter(Boolean);
        if (words.length <= 1) {
            const hardSlices: string[] = [];
            for (let index = 0; index < normalized.length; index += maxCharLength) {
                hardSlices.push(normalized.slice(index, index + maxCharLength));
            }
            return hardSlices;
        }

        const wordChunks: string[] = [];
        let currentWordChunk = '';
        for (const word of words) {
            if (word.length > maxCharLength) {
                if (currentWordChunk) {
                    wordChunks.push(currentWordChunk);
                    currentWordChunk = '';
                }
                for (let index = 0; index < word.length; index += maxCharLength) {
                    wordChunks.push(word.slice(index, index + maxCharLength));
                }
                continue;
            }

            const candidate = currentWordChunk ? `${currentWordChunk} ${word}` : word;
            if (candidate.length > maxCharLength) {
                wordChunks.push(currentWordChunk);
                currentWordChunk = word;
            } else {
                currentWordChunk = candidate;
            }
        }

        if (currentWordChunk) {
            wordChunks.push(currentWordChunk);
        }

        return wordChunks;
    }

    function splitLongParagraph(paragraph: string): string[] {
        const normalized = paragraph.trim();
        if (!normalized) return [];
        if (normalized.length <= maxCharLength) return [normalized];

        const sentences = normalized
            .split(/(?<=[.!?])\s+/)
            .map(sentence => sentence.trim())
            .filter(Boolean);

        if (sentences.length <= 1) {
            return splitByWords(normalized);
        }

        const sentenceChunks: string[] = [];
        let currentSentenceChunk = '';
        for (const sentence of sentences) {
            if (sentence.length > maxCharLength) {
                if (currentSentenceChunk) {
                    sentenceChunks.push(currentSentenceChunk);
                    currentSentenceChunk = '';
                }
                sentenceChunks.push(...splitByWords(sentence));
                continue;
            }

            const candidate = currentSentenceChunk ? `${currentSentenceChunk} ${sentence}` : sentence;
            if (candidate.length > maxCharLength) {
                sentenceChunks.push(currentSentenceChunk);
                currentSentenceChunk = sentence;
            } else {
                currentSentenceChunk = candidate;
            }
        }

        if (currentSentenceChunk) {
            sentenceChunks.push(currentSentenceChunk);
        }

        return sentenceChunks;
    }

    for (const paragraph of paragraphs) {
        for (const section of splitLongParagraph(paragraph)) {
            if ((currentChunk.length + section.length) > maxCharLength && currentChunk.length > 0) {
                chunks.push(currentChunk.trim());
                currentChunk = section;
            } else {
                currentChunk = currentChunk ? currentChunk + '\n\n' + section : section;
            }
        }
    }

    if (currentChunk.trim().length > 0) {
        chunks.push(currentChunk.trim());
    }

    return chunks;
}

export function parseChatGPTExport(content: string): ImportItem[] {
    const data = JSON.parse(content);
    if (!Array.isArray(data)) {
        throw new Error('Invalid ChatGPT format. Expected an array.');
    }

    const items: ImportItem[] = [];
    for (const conversation of data) {
        if (!conversation.mapping) continue;
        const title = conversation.title || 'Untitled Conversation';
        let text = `Conversation: ${title}\n\n`;

        for (const key in conversation.mapping) {
            const node = conversation.mapping[key];
            if (node.message?.content?.parts && node.message.author) {
                const role = node.message.author.role;
                if ((role === 'user' || role === 'assistant') && Array.isArray(node.message.content.parts)) {
                    const partText = node.message.content.parts.join('\n').trim();
                    if (partText.length > 0) {
                        text += `${role.toUpperCase()}: ${partText}\n\n`;
                    }
                }
            }
        }

        for (const chunk of chunkLargeText(text, 3000)) {
            items.push({
                content: chunk,
                source: 'chatgpt-export',
                tags: ['chatgpt']
            });
        }
    }

    return items;
}

export function parseClaudeExport(content: string): ImportItem[] {
    const lines = content.split('\n').filter(line => line.trim() !== '');
    let conversationText = 'Claude Code Session\n\n';

    for (const line of lines) {
        try {
            const event = JSON.parse(line);
            if ((event.type === 'user' || event.type === 'assistant') && event.message?.content) {
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

                if (textContent.trim() && textContent.length < 10000 && !textContent.includes('base64')) {
                    conversationText += `${role.toUpperCase()}: ${textContent.trim()}\n\n`;
                }
            }
        } catch {
            // Skip malformed lines.
        }
    }

    if (conversationText.length <= 100) {
        return [];
    }

    return chunkLargeText(conversationText, 3000).map(chunk => ({
        content: chunk,
        source: 'claude-export',
        tags: ['claude']
    }));
}

export function parseCsvRows(content: string): string[][] {
    const rows: string[][] = [];
    let row: string[] = [];
    let cell = '';
    let inQuotes = false;
    const input = content.replace(/^\uFEFF/, '');

    for (let index = 0; index < input.length; index += 1) {
        const character = input[index];

        if (inQuotes) {
            if (character === '"') {
                if (input[index + 1] === '"') {
                    cell += '"';
                    index += 1;
                } else {
                    inQuotes = false;
                }
            } else {
                cell += character;
            }
            continue;
        }

        if (character === '"') {
            inQuotes = true;
        } else if (character === ',') {
            row.push(cell);
            cell = '';
        } else if (character === '\n') {
            row.push(cell);
            const normalizedRow = row.map(value => value.replace(/\r$/, ''));
            if (normalizedRow.some(value => value.trim() !== '')) {
                rows.push(normalizedRow);
            }
            row = [];
            cell = '';
        } else if (character !== '\r') {
            cell += character;
        }
    }

    if (cell.length > 0 || row.length > 0) {
        row.push(cell);
        if (row.some(value => value.trim() !== '')) {
            rows.push(row);
        }
    }

    return rows;
}

export function guessCsvMapping(headers: string[]): CsvImportMapping {
    return {
        contentColumn: findHeader(headers, CONTENT_COLUMN_HINTS) || headers[0] || '',
        sourceColumn: findHeader(headers, SOURCE_COLUMN_HINTS),
        typeColumn: findHeader(headers, TYPE_COLUMN_HINTS),
        tagsColumn: findHeader(headers, TAGS_COLUMN_HINTS),
    };
}

function tagsFromCell(value: string | undefined): string[] {
    return trimCell(value)
        .split(/[,\n;|]/)
        .map(tag => tag.trim())
        .filter(Boolean);
}

function detectImportSource(fileName: string, content: string): ImportSourceType {
    const normalizedName = fileName.toLowerCase();
    const trimmedContent = content.trim();

    if (normalizedName.endsWith('.csv')) return 'csv';
    if (normalizedName.endsWith('.jsonl')) return 'claude';
    if (normalizedName.endsWith('.json') && trimmedContent.startsWith('[')) return 'chatgpt';
    return 'text';
}

function parseCsvImport(fileName: string, content: string, providedMapping?: Partial<CsvImportMapping>): ImportPlan {
    const rows = parseCsvRows(content);
    if (rows.length === 0) {
        throw new Error('No rows found in CSV file');
    }

    const headers = rows[0].map(value => trimCell(value));
    const guessedMapping = guessCsvMapping(headers);
    const mapping: CsvImportMapping = {
        contentColumn: providedMapping?.contentColumn || guessedMapping.contentColumn,
        sourceColumn: providedMapping?.sourceColumn || guessedMapping.sourceColumn,
        typeColumn: providedMapping?.typeColumn || guessedMapping.typeColumn,
        tagsColumn: providedMapping?.tagsColumn || guessedMapping.tagsColumn,
    };

    const contentIndex = headers.indexOf(mapping.contentColumn);
    if (contentIndex === -1) {
        throw new Error('The selected content column does not exist in this CSV file');
    }

    const sourceIndex = mapping.sourceColumn ? headers.indexOf(mapping.sourceColumn) : -1;
    const typeIndex = mapping.typeColumn ? headers.indexOf(mapping.typeColumn) : -1;
    const tagsIndex = mapping.tagsColumn ? headers.indexOf(mapping.tagsColumn) : -1;

    const items: ImportItem[] = [];
    for (const row of rows.slice(1)) {
        const contentValue = trimCell(row[contentIndex]);
        if (!contentValue) continue;

        const source = trimCell(row[sourceIndex]) || `csv-${fileName}`;
        const thoughtType = trimCell(row[typeIndex]) || undefined;
        const tags = tagsFromCell(row[tagsIndex]);

        for (const chunk of chunkLargeText(contentValue, 2000)) {
            items.push({
                content: chunk,
                source,
                thoughtType,
                tags: [...tags],
            });
        }
    }

    return {
        detectedType: 'csv',
        headers,
        mapping,
        items,
    };
}

export function buildImportPlan(fileName: string, content: string, providedMapping?: Partial<CsvImportMapping>): ImportPlan {
    const detectedType = detectImportSource(fileName, content);

    if (detectedType === 'csv') {
        return parseCsvImport(fileName, content, providedMapping);
    }

    if (detectedType === 'chatgpt') {
        return {
            detectedType,
            headers: [],
            mapping: null,
            items: parseChatGPTExport(content).map(item => ({
                ...item,
                source: `upload-${fileName}`
            })),
        };
    }

    if (detectedType === 'claude') {
        return {
            detectedType,
            headers: [],
            mapping: null,
            items: parseClaudeExport(content).map(item => ({
                ...item,
                source: `upload-${fileName}`
            })),
        };
    }

    return {
        detectedType,
        headers: [],
        mapping: null,
        items: chunkLargeText(content, 2000).map(chunk => ({
            content: chunk,
            source: `upload-${fileName}`,
            tags: []
        })),
    };
}
