import { createHash } from 'crypto';
import bcrypt from 'bcryptjs';

export function sha256Hash(password: string): string {
    return createHash('sha256').update(password).digest('hex');
}

export async function hashPassword(password: string): Promise<string> {
    return bcrypt.hash(password, 12);
}

export async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
    if (storedHash.startsWith('$2')) {
        return bcrypt.compare(password, storedHash);
    }

    return sha256Hash(password) === storedHash;
}
