import type { CookieOptions, Request, Response } from 'express';
import { Router } from 'express';
import { db } from '../db/client';
import { signJwt, verifyJwt } from './jwt';
import { verifyPassword, hashPassword } from './passwords';
import { getUserSetting } from './settings';
import { normalizeUsername, validateUsername, validatePasswordPolicy, passwordPolicySummary } from './credentials';
import {
    buildLoginAttemptKey,
    clearLoginAttempts,
    getLoginThrottleStatus,
    recordFailedLoginAttempt
} from './login-attempts';

export const sessionRouter = Router();

function isSecureRequest(req: Request): boolean {
    const forwardedProto = req.get('x-forwarded-proto');
    if (typeof forwardedProto === 'string' && forwardedProto.length > 0) {
        return forwardedProto.split(',')[0].trim() === 'https';
    }
    return req.secure || req.protocol === 'https';
}

function sessionCookieOptions(req: Request, maxAgeMs: number): CookieOptions {
    return {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production' || isSecureRequest(req),
        sameSite: 'lax',
        maxAge: maxAgeMs,
        path: '/',
    };
}

function setNoStoreHeaders(res: Response) {
    res.set('Cache-Control', 'no-store');
    res.set('Pragma', 'no-cache');
}

// Register
sessionRouter.post('/auth/register', async (req, res) => {
    try {
        setNoStoreHeaders(res);

        const username = normalizeUsername(req.body?.username);
        const password = typeof req.body?.password === 'string' ? req.body.password : '';
        if (!username || !password) {
            return res.status(400).json({ error: 'username and password are required' });
        }

        const usernameError = validateUsername(username);
        if (usernameError) {
            return res.status(400).json({ error: usernameError });
        }

        const passwordError = validatePasswordPolicy(password);
        if (passwordError) {
            return res.status(400).json({
                error: passwordError,
                passwordPolicy: passwordPolicySummary(),
            });
        }

        const passwordHash = await hashPassword(password);
        const result = await db.query(
            `INSERT INTO users (username, password_hash, is_admin)
             VALUES ($1, $2, false) RETURNING id, username, is_admin, created_at`,
            [username, passwordHash]
        );

        const sessionLifetime = 86400 * 7; // 7 days default
        const token = await signJwt(
            { userId: result.rows[0].id, username: result.rows[0].username, isAdmin: result.rows[0].is_admin },
            sessionLifetime
        );

        res.cookie('session', token, sessionCookieOptions(req, sessionLifetime * 1000));
        res.json({ ok: true, username: result.rows[0].username, isAdmin: result.rows[0].is_admin });
    } catch (error: any) {
        if (error.code === '23505') {
            res.status(409).json({ error: 'Username already exists' });
        } else {
            console.error('Registration error:', error);
            res.status(500).json({ error: 'Internal server error' });
        }
    }
});

// Login
sessionRouter.post('/auth/login', async (req, res) => {
    try {
        setNoStoreHeaders(res);

        const username = normalizeUsername(req.body?.username);
        const password = typeof req.body?.password === 'string' ? req.body.password : '';
        if (!username || !password) {
            return res.status(400).json({ error: 'username and password are required' });
        }

        const attemptKey = buildLoginAttemptKey(username, req);
        const throttle = getLoginThrottleStatus(attemptKey);
        if (throttle.blocked) {
            res.set('Retry-After', String(throttle.retryAfterSeconds));
            return res.status(429).json({
                error: `Too many failed login attempts. Try again in ${throttle.retryAfterSeconds} seconds.`,
            });
        }

        const result = await db.query(
            `SELECT id, username, is_admin, password_hash FROM users WHERE username = $1`,
            [username]
        );

        if (result.rows.length === 0) {
            const failed = recordFailedLoginAttempt(attemptKey);
            if (failed.blocked) {
                res.set('Retry-After', String(failed.retryAfterSeconds));
            }
            return res.status(401).json({ error: 'Invalid credentials' });
        }

        const user = result.rows[0];
        const valid = await verifyPassword(password, user.password_hash);
        if (!valid) {
            const failed = recordFailedLoginAttempt(attemptKey);
            if (failed.blocked) {
                res.set('Retry-After', String(failed.retryAfterSeconds));
            }
            return res.status(401).json({ error: 'Invalid credentials' });
        }

        // Migrate SHA-256 hash to bcrypt if needed
        if (!user.password_hash.startsWith('$2')) {
            const bcryptHash = await hashPassword(password);
            await db.query(`UPDATE users SET password_hash = $1 WHERE id = $2`, [bcryptHash, user.id]);
        }

        const sessionLifetime = await getUserSetting(user.id, 'session_lifetime');

        const token = await signJwt(
            { userId: user.id, username: user.username, isAdmin: user.is_admin },
            sessionLifetime
        );

        clearLoginAttempts(attemptKey);
        res.cookie('session', token, sessionCookieOptions(req, sessionLifetime * 1000));

        res.json({ ok: true, username: user.username, isAdmin: user.is_admin });
    } catch (error: any) {
        console.error('Login error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Logout
sessionRouter.post('/auth/logout', (req, res) => {
    setNoStoreHeaders(res);
    res.clearCookie('session', sessionCookieOptions(req, 0));
    res.json({ ok: true });
});

// Current user info
sessionRouter.get('/auth/me', async (req, res) => {
    if (!req.userId) {
        return res.status(401).json({ error: 'Not authenticated' });
    }

    try {
        const result = await db.query(
            `SELECT id, username, is_admin, created_at FROM users WHERE id = $1`,
            [req.userId]
        );

        if (result.rows.length === 0) {
            return res.status(401).json({ error: 'User not found' });
        }

        res.json(result.rows[0]);
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
});

sessionRouter.get('/auth/session', async (req, res) => {
    if (!req.userId) {
        return res.status(401).json({ error: 'Not authenticated' });
    }

    const authMethod = req.authMethod ?? null;
    if (authMethod !== 'session') {
        return res.json({
            authMethod,
            sessionExpiresAt: null,
            sessionExpiresInSeconds: null,
        });
    }

    const token = typeof req.cookies?.session === 'string' ? req.cookies.session : '';
    if (!token) {
        return res.json({
            authMethod: 'session',
            sessionExpiresAt: null,
            sessionExpiresInSeconds: null,
        });
    }

    try {
        const payload = await verifyJwt(token);
        const expiresInSeconds = Math.max(0, payload.exp - Math.floor(Date.now() / 1000));

        return res.json({
            authMethod: 'session',
            sessionExpiresAt: new Date(payload.exp * 1000).toISOString(),
            sessionExpiresInSeconds: expiresInSeconds,
        });
    } catch {
        res.clearCookie('session', sessionCookieOptions(req, 0));
        return res.status(401).json({ error: 'Session expired' });
    }
});
