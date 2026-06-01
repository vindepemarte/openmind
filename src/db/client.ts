import { Pool } from 'pg';
import * as dotenv from 'dotenv';

dotenv.config({ quiet: true } as any);

// Create a connection pool to the database
export const db = new Pool({
    connectionString: process.env.DATABASE_URL || 'postgresql://openmind:openmind@localhost:5432/openmind',
});

// Helper for atomic transactions
export async function withTransaction<T>(
    callback: (client: any) => Promise<T>
): Promise<T> {
    const client = await db.connect();
    try {
        await client.query('BEGIN');
        const result = await callback(client);
        await client.query('COMMIT');
        return result;
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
}
