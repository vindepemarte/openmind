import * as dotenv from 'dotenv';
import { fitEmbeddingDimensions } from './vector';
dotenv.config({ quiet: true } as any);

const OPENROUTER_EMBEDDING_MODEL = process.env.OPENROUTER_EMBEDDING_MODEL || 'openai/text-embedding-3-large';

export async function generateEmbedding(text: string): Promise<number[]> {
    const openrouterApiKey = process.env.OPENROUTER_API_KEY;

    if (!openrouterApiKey) {
        throw new Error('OPENROUTER_API_KEY environment variable is not set');
    }

    try {
        const body: Record<string, unknown> = {
            model: OPENROUTER_EMBEDDING_MODEL,
            input: text
        };

        if (OPENROUTER_EMBEDDING_MODEL.startsWith('openai/text-embedding-3-')) {
            body.dimensions = 1536;
        }

        const response = await fetch('https://openrouter.ai/api/v1/embeddings', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${openrouterApiKey}`
            },
            body: JSON.stringify(body),
        });

        if (!response.ok) {
            const errorData = await response.text();
            throw new Error(`OpenRouter API error: ${response.statusText} - ${errorData}`);
        }

        const data = await response.json();

        if (!data.data || !data.data[0] || !data.data[0].embedding) {
            throw new Error('Invalid response format from OpenRouter embeddings API');
        }

        return fitEmbeddingDimensions(data.data[0].embedding);
    } catch (error) {
        console.error('Error generating embedding with OpenRouter:', error);
        throw error;
    }
}
