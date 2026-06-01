import * as dotenv from 'dotenv';
dotenv.config({ quiet: true } as any);

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || 'openai/gpt-4o-mini';

export interface ThoughtMetadata {
    type: string;
    people: string[];
    topics: string[];
    action_items: string[];
    sentiment: string;
    summary: string;
}

const SYSTEM_PROMPT = `
You are classifying and extracting metadata from a "thought" captured by a user in their personal memory system.
Analyze the provided text and extract the following information. Be concise and precise.

Return ONLY a strictly valid JSON object with the following structure:
{
  "type": "insight" | "decision" | "person" | "meeting" | "action" | "reflection" | "other",
  "people": ["Name 1", "Name 2"] (List of people explicitly mentioned. Empty array if none),
  "topics": ["topic1", "topic2"] (1-5 key concepts or topics discussed),
  "action_items": ["Action item 1"] (List of explicit or strongly implied tasks. Empty array if none),
  "sentiment": "positive" | "neutral" | "negative",
  "summary": "A 1-2 sentence concise summary of the core idea"
}
`;

export async function extractMetadata(text: string): Promise<ThoughtMetadata> {
    if (!OPENROUTER_API_KEY) {
        console.warn('OPENROUTER_API_KEY not set. Returning empty metadata.');
        return {
            type: 'other',
            people: [],
            topics: [],
            action_items: [],
            sentiment: 'neutral',
            summary: text.substring(0, 100),
        };
    }

    try {
        const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
                'Content-Type': 'application/json',
                'HTTP-Referer': 'https://github.com/openmind', // Required by OpenRouter
                'X-Title': 'OpenMind Memory System', // Optional, recommended by OpenRouter
            },
            body: JSON.stringify({
                model: OPENROUTER_MODEL,
                messages: [
                    { role: 'system', content: SYSTEM_PROMPT },
                    { role: 'user', content: text }
                ],
                response_format: { type: 'json_object' }
            }),
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`OpenRouter API error: ${response.status} ${errorText}`);
        }

        const data = await response.json();
        const content = data.choices[0].message.content;
        return JSON.parse(content) as ThoughtMetadata;
    } catch (error) {
        console.error('Error extracting metadata:', error);
        // Fallback
        return {
            type: 'other',
            people: [],
            topics: [],
            action_items: [],
            sentiment: 'neutral',
            summary: text.substring(0, 100),
        };
    }
}
