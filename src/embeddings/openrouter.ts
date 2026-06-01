import * as dotenv from 'dotenv';
dotenv.config({ quiet: true } as any);

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
// Using the specific model requested by the user
const EMBED_MODEL = 'openai/text-embedding-3-large';

export async function generateEmbedding(text: string): Promise<number[]> {
    if (!OPENROUTER_API_KEY) {
        throw new Error('OPENROUTER_API_KEY environment variable is not set');
    }

    try {
        const response = await fetch('https://openrouter.ai/api/v1/embeddings', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${OPENROUTER_API_KEY}`
            },
            body: JSON.stringify({
                model: EMBED_MODEL,
                input: text,
                dimensions: 1536
            }),
        });

        if (!response.ok) {
            const errorData = await response.text();
            throw new Error(`OpenRouter API error: ${response.statusText} - ${errorData}`);
        }

        const data = await response.json();

        if (!data.data || !data.data[0] || !data.data[0].embedding) {
            throw new Error('Invalid response format from OpenRouter embeddings API');
        }

        return data.data[0].embedding;
    } catch (error) {
        console.error('Error generating embedding with OpenRouter:', error);
        throw error;
    }
}
