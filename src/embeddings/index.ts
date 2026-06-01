import * as dotenv from 'dotenv';
dotenv.config({ quiet: true } as any);

export type EmbeddingProvider = 'openrouter' | 'ollama';

export function getEmbeddingProvider(): EmbeddingProvider {
    const provider = (process.env.EMBEDDING_PROVIDER || '').trim().toLowerCase();
    if (provider === 'local' || provider === 'ollama') {
        return 'ollama';
    }

    if (provider === 'openrouter') {
        return 'openrouter';
    }

    return process.env.OPENROUTER_API_KEY ? 'openrouter' : 'ollama';
}

export async function generateEmbedding(text: string): Promise<number[]> {
    const provider = getEmbeddingProvider();
    if (provider === 'ollama') {
        const ollama = await import('./ollama');
        return ollama.generateEmbedding(text);
    }

    const openrouter = await import('./openrouter');
    return openrouter.generateEmbedding(text);
}
