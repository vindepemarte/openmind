import jwt from 'jsonwebtoken';
import { randomBytes } from 'crypto';
import { db } from '../db/client';

let cachedSecret: string | null = null;

export interface JwtPayload {
    userId: string;
    username: string;
    isAdmin: boolean;
}

export async function getJwtSecret(): Promise<string> {
    if (cachedSecret) return cachedSecret;

    await db.query(`
        CREATE TABLE IF NOT EXISTS config (
            key VARCHAR(100) PRIMARY KEY,
            value TEXT NOT NULL
        )
    `);

    const result = await db.query(`SELECT value FROM config WHERE key = 'jwt_secret'`);
    if (result.rows.length > 0) {
        cachedSecret = result.rows[0].value;
        return cachedSecret!;
    }

    const secret = process.env.JWT_SECRET || randomBytes(32).toString('hex');
    await db.query(
        `INSERT INTO config (key, value) VALUES ('jwt_secret', $1) ON CONFLICT (key) DO NOTHING`,
        [secret]
    );
    cachedSecret = secret;
    return secret;
}

export async function signJwt(payload: JwtPayload, expiresInSeconds: number): Promise<string> {
    const secret = await getJwtSecret();
    return jwt.sign(payload, secret, { expiresIn: expiresInSeconds });
}

export async function verifyJwt(token: string): Promise<JwtPayload & { iat: number; exp: number }> {
    const secret = await getJwtSecret();
    return jwt.verify(token, secret) as JwtPayload & { iat: number; exp: number };
}
