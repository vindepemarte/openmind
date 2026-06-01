const DEFAULT_EMBEDDING_DIMENSIONS = 1536;

export function getEmbeddingDimensions(): number {
    const configured = Number.parseInt(process.env.EMBEDDING_DIMENSIONS || '', 10);
    return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_EMBEDDING_DIMENSIONS;
}

export function fitEmbeddingDimensions(embedding: unknown): number[] {
    if (!Array.isArray(embedding)) {
        throw new Error('Embedding provider returned a non-array embedding');
    }

    const vector = embedding.map(value => Number(value));
    if (vector.some(value => !Number.isFinite(value))) {
        throw new Error('Embedding provider returned non-numeric embedding values');
    }

    const dimensions = getEmbeddingDimensions();
    if (vector.length === dimensions) {
        return vector;
    }

    if (vector.length > dimensions) {
        return vector.slice(0, dimensions);
    }

    return vector.concat(Array(dimensions - vector.length).fill(0));
}
