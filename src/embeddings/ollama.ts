import * as dotenv from 'dotenv';
import { fitEmbeddingDimensions } from './vector';
dotenv.config({ quiet: true } as any);

const DEFAULT_OLLAMA_BASE_URL = 'http://127.0.0.1:11434';
const DEFAULT_OLLAMA_MODEL = 'nomic-embed-text';

function getOllamaBaseUrl(): string {
    return (process.env.OLLAMA_BASE_URL || DEFAULT_OLLAMA_BASE_URL).replace(/\/$/, '');
}

export function getOllamaEmbeddingModel(): string {
    return process.env.OLLAMA_EMBEDDING_MODEL || DEFAULT_OLLAMA_MODEL;
}

export async function generateEmbedding(text: string): Promise<number[]> {
    const baseUrl = getOllamaBaseUrl();
    const model = getOllamaEmbeddingModel();

    const response = await fetch(`${baseUrl}/api/embed`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
            model,
            input: text
        })
    });

    if (!response.ok) {
        const body = await response.text();
        throw new Error(`Ollama embedding error (${response.status}): ${body}`);
    }

    const data = await response.json() as { embeddings?: number[][]; embedding?: number[] };
    const embedding = Array.isArray(data.embeddings?.[0]) ? data.embeddings[0] : data.embedding;
    if (!embedding) {
        throw new Error('Invalid response format from Ollama embeddings API');
    }

    return fitEmbeddingDimensions(embedding);
}
