import { RequestHandler } from 'express';
import { createHash } from 'crypto';
import { db } from '../db/client';
import { verifyJwt } from './jwt';
import { verifyPassword, hashPassword } from './passwords';

const PUBLIC_ROUTES = [
    '/login',
    '/auth/login',
    '/auth/register',
    '/oauth/authorize',
    '/oauth/token',
    '/oauth/revoke',
    '/oauth/register',
    '/.well-known/oauth-authorization-server',
    '/.well-known/oauth-protected-resource',
    '/.well-known/oauth-protected-resource/mcp',
    '/.well-known/mcp/server.json',
    '/health',
];

export function isPublicRoute(path: string): boolean {
    const normalized = path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
    if (normalized.startsWith('/assets/')) return true;
    return PUBLIC_ROUTES.includes(normalized);
}

function sha256(input: string): string {
    return createHash('sha256').update(input).digest('hex');
}

function getBaseUrl(req: Parameters<RequestHandler>[0]): string {
    const protocol = req.get('x-forwarded-proto') || req.protocol;
    const host = req.get('x-forwarded-host') || req.get('host');
    return `${protocol}://${host}`;
}

function setMcpAuthChallenge(req: Parameters<RequestHandler>[0], res: Parameters<RequestHandler>[1]) {
    if (!req.path.startsWith('/mcp')) return;
    const baseUrl = getBaseUrl(req);
    res.set(
        'WWW-Authenticate',
        `Bearer resource_metadata="${baseUrl}/.well-known/oauth-protected-resource", scope="read write offline_access"`,
    );
}

export const unifiedAuthMiddleware: RequestHandler = async (req, res, next) => {
    // Allow public routes
    if (isPublicRoute(req.path)) {
        return next();
    }

    // Allow static login page assets
    if (req.path === '/login.html') {
        return next();
    }

    const authHeader = req.headers.authorization;

    // 1. Try Authorization header first (takes precedence over cookies)
    if (authHeader) {
        // 1a. Basic Auth
        if (authHeader.startsWith('Basic ')) {
            const decoded = Buffer.from(authHeader.slice(6), 'base64').toString('utf-8');
            const colonIndex = decoded.indexOf(':');
            if (colonIndex === -1) {
                res.status(401).json({ error: 'Invalid credentials' });
                return;
            }

            const username = decoded.slice(0, colonIndex);
            const password = decoded.slice(colonIndex + 1);

            try {
                const result = await db.query(
                    `SELECT id, is_admin, password_hash FROM users WHERE username = $1`,
                    [username]
                );

                if (result.rows.length === 0) {
                    res.set('WWW-Authenticate', 'Basic realm="OpenMind"');
                    res.status(401).json({ error: 'Invalid credentials' });
                    return;
                }

                const user = result.rows[0];
                const valid = await verifyPassword(password, user.password_hash);
                if (!valid) {
                    res.set('WWW-Authenticate', 'Basic realm="OpenMind"');
                    res.status(401).json({ error: 'Invalid credentials' });
                    return;
                }

                // Migrate SHA-256 hash to bcrypt if needed
                if (!user.password_hash.startsWith('$2')) {
                    const bcryptHash = await hashPassword(password);
                    await db.query(`UPDATE users SET password_hash = $1 WHERE id = $2`, [bcryptHash, user.id]);
                }

                req.userId = user.id;
                req.isAdmin = user.is_admin;
                req.authMethod = 'basic';
                return next();
            } catch (error) {
                console.error('Basic auth error:', error);
                res.status(500).json({ error: 'Internal server error' });
                return;
            }
        }

        // 1b. Bearer token
        if (authHeader.startsWith('Bearer ')) {
            const token = authHeader.slice(7);

            // API Key (om_ prefix)
            if (token.startsWith('om_')) {
                try {
                    const keyHash = sha256(token);
                    const result = await db.query(
                        `SELECT ak.user_id, u.is_admin FROM api_keys ak
                         JOIN users u ON ak.user_id = u.id
                         WHERE ak.key_hash = $1`,
                        [keyHash]
                    );

                    if (result.rows.length === 0) {
                        setMcpAuthChallenge(req, res);
                        res.status(401).json({ error: 'Invalid API key' });
                        return;
                    }

                    // Update last_used_at (fire and forget)
                    db.query(`UPDATE api_keys SET last_used_at = NOW() WHERE key_hash = $1`, [keyHash]).catch(() => {});

                    req.userId = result.rows[0].user_id;
                    req.isAdmin = result.rows[0].is_admin;
                    req.authMethod = 'api_key';
                    return next();
                } catch (error) {
                    console.error('API key auth error:', error);
                    res.status(500).json({ error: 'Internal server error' });
                    return;
                }
            }

            // OAuth opaque token
            try {
                const tokenHash = sha256(token);
                const result = await db.query(
                    `SELECT ot.user_id, u.is_admin, ot.expires_at FROM oauth_tokens ot
                     JOIN users u ON ot.user_id = u.id
                     WHERE ot.access_token_hash = $1`,
                    [tokenHash]
                );

                if (result.rows.length === 0) {
                    setMcpAuthChallenge(req, res);
                    res.status(401).json({ error: 'Invalid or expired token' });
                    return;
                }

                const row = result.rows[0];
                if (new Date(row.expires_at) < new Date()) {
                    setMcpAuthChallenge(req, res);
                    res.status(401).json({ error: 'Token expired' });
                    return;
                }

                req.userId = row.user_id;
                req.isAdmin = row.is_admin;
                req.authMethod = 'oauth';
                return next();
            } catch (error) {
                console.error('OAuth token auth error:', error);
                res.status(500).json({ error: 'Internal server error' });
                return;
            }
        }

        // Unknown Authorization scheme
        setMcpAuthChallenge(req, res);
        res.status(401).json({ error: 'Unsupported authorization scheme' });
        return;
    }

    // 2. Try JWT session cookie
    const sessionToken = typeof req.cookies?.session === 'string'
        ? req.cookies.session
        : (() => {
              const rawCookies = req.headers.cookie;
              if (!rawCookies) return undefined;
              const sessionMatch = rawCookies.split(';').map(c => c.trim()).find(c => c.startsWith('session='));
              return sessionMatch ? sessionMatch.slice('session='.length) : undefined;
          })();

    if (sessionToken) {
        try {
            const payload = await verifyJwt(sessionToken);
            req.userId = payload.userId;
            req.isAdmin = payload.isAdmin;
            req.authMethod = 'session';
            return next();
        } catch {
            // Invalid/expired JWT, clear it.
            res.setHeader('Set-Cookie', 'session=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; SameSite=Lax');
        }
    }

    // 3. No valid auth. Redirect browsers, 401 for APIs.
    const acceptsHtml = req.headers.accept?.includes('text/html');
    if (acceptsHtml && req.method === 'GET') {
        res.redirect('/login');
        return;
    }

    setMcpAuthChallenge(req, res);
    res.status(401).json({ error: 'Authentication required' });
};
