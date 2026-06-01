/**
 * Very basic chunker for handling long inputs.
 * Nomic-embed-text has an 8192 token context limit, but chunking by paragraph
 * still yields better search isolation for distinct ideas inside a long text.
 */
export function chunkText(text: string, maxParagraphs: number = 3): string[] {
    // Split by double newline (paragraphs)
    const paragraphs = text.split(/\n\s*\n/).map(p => p.trim()).filter(p => p.length > 0);

    // If not too many paragraphs, just return as one chunk to preserve full context
    if (paragraphs.length <= maxParagraphs) {
        return [text.trim()];
    }

    // Otherwise, chunk
    const chunks: string[] = [];
    let currentChunk = '';

    for (const paragraph of paragraphs) {
        if ((currentChunk + '\n\n' + paragraph).length > 2000) { // Rough char limit per chunk
            if (currentChunk) chunks.push(currentChunk.trim());
            currentChunk = paragraph;
        } else {
            currentChunk = currentChunk ? currentChunk + '\n\n' + paragraph : paragraph;
        }
    }

    if (currentChunk) {
        chunks.push(currentChunk.trim());
    }

    return chunks;
}
