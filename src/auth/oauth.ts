import { Router, RequestHandler } from 'express';
import { randomBytes, createHash } from 'crypto';
import path from 'path';
import { db } from '../db/client';
import { verifyPassword, hashPassword } from './passwords';
import { getUserSetting } from './settings';
import { normalizeUsername } from './credentials';
import {
    buildLoginAttemptKey,
    clearLoginAttempts,
    getLoginThrottleStatus,
    recordFailedLoginAttempt
} from './login-attempts';

export const oauthRouter = Router();
const DEFAULT_OAUTH_SCOPES = ['read', 'write'];
const OAUTH_SCOPES_SUPPORTED = [...DEFAULT_OAUTH_SCOPES, 'offline_access'];

function sha256(input: string): string {
    return createHash('sha256').update(input).digest('hex');
}

function sha256Base64Url(input: string): string {
    return createHash('sha256').update(input).digest('base64url');
}

function generateToken(): string {
    return randomBytes(32).toString('hex');
}

function wantsJson(req: Parameters<RequestHandler>[0]): boolean {
    return req.is('application/json') === 'application/json' || req.headers.accept?.includes('application/json') === true;
}

function getBaseUrl(req: Parameters<RequestHandler>[0]): string {
    const protocol = req.get('x-forwarded-proto') || req.protocol;
    const host = req.get('x-forwarded-host') || req.get('host');
    return `${protocol}://${host}`;
}

function parseScopes(input: unknown): string[] {
    if (Array.isArray(input)) {
        return [...new Set(input.map(value => String(value).trim()).filter(Boolean))];
    }

    if (typeof input === 'string') {
        return [...new Set(input.split(/[,\s]+/).map(value => value.trim()).filter(Boolean))];
    }

    return [];
}

function toInternalScopes(scopes: string[]): string[] {
    const normalized = scopes
        .filter(scope => scope !== 'offline_access')
        .filter(scope => DEFAULT_OAUTH_SCOPES.includes(scope));

    return [...new Set(normalized)];
}

function resolveScopes(requested: unknown, allowedScopes: string[] = DEFAULT_OAUTH_SCOPES): string[] | null {
    const parsed = parseScopes(requested);
    const internalAllowedScopes = toInternalScopes(allowedScopes);
    const effectiveAllowedScopes = internalAllowedScopes.length > 0 ? internalAllowedScopes : DEFAULT_OAUTH_SCOPES;

    if (parsed.length === 0) {
        return effectiveAllowedScopes;
    }

    const invalidScope = parsed.find(scope => scope !== 'offline_access' && !effectiveAllowedScopes.includes(scope));
    if (invalidScope) return null;

    const internalRequestedScopes = toInternalScopes(parsed);
    return internalRequestedScopes.length > 0 ? internalRequestedScopes : effectiveAllowedScopes;
}

function isLoopbackHost(hostname: string): boolean {
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]';
}

function normalizeRedirectUris(input: unknown): string[] | null {
    if (!Array.isArray(input) || input.length === 0) {
        return null;
    }

    const redirectUris: string[] = [];

    for (const rawValue of input) {
        if (typeof rawValue !== 'string') {
            return null;
        }

        const trimmed = rawValue.trim();
        if (!trimmed) {
            return null;
        }

        let parsed: URL;
        try {
            parsed = new URL(trimmed);
        } catch {
            return null;
        }

        const isHttps = parsed.protocol === 'https:';
        const isLoopbackHttp = parsed.protocol === 'http:' && isLoopbackHost(parsed.hostname);
        if (!isHttps && !isLoopbackHttp) {
            return null;
        }

        redirectUris.push(parsed.toString());
    }

    return [...new Set(redirectUris)];
}

function getOAuthServerMetadata(req: Parameters<RequestHandler>[0]) {
    const issuer = getBaseUrl(req);
    return {
        issuer,
        authorization_endpoint: `${issuer}/oauth/authorize`,
        token_endpoint: `${issuer}/oauth/token`,
        registration_endpoint: `${issuer}/oauth/register`,
        revocation_endpoint: `${issuer}/oauth/revoke`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic'],
        code_challenge_methods_supported: ['plain', 'S256'],
        scopes_supported: OAUTH_SCOPES_SUPPORTED,
    };
}

function getProtectedResourceMetadata(req: Parameters<RequestHandler>[0]) {
    const issuer = getBaseUrl(req);
    return {
        resource: `${issuer}/mcp`,
        authorization_servers: [issuer],
        scopes_supported: OAUTH_SCOPES_SUPPORTED,
        bearer_methods_supported: ['header'],
    };
}

function verifyPkceChallenge(codeVerifier: string, codeChallenge: string, method: string | null): boolean {
    if (method === 'S256') {
        return sha256Base64Url(codeVerifier) === codeChallenge;
    }

    return codeVerifier === codeChallenge;
}

function getClientCredentials(req: Parameters<RequestHandler>[0], body: any): { clientId?: string; clientSecret?: string } {
    const authHeader = req.headers.authorization;
    if (authHeader?.startsWith('Basic ')) {
        try {
            const decoded = Buffer.from(authHeader.slice(6), 'base64').toString('utf-8');
            const colonIndex = decoded.indexOf(':');
            if (colonIndex !== -1) {
                return {
                    clientId: decoded.slice(0, colonIndex),
                    clientSecret: decoded.slice(colonIndex + 1)
                };
            }
        } catch {
            // Fall back to body parsing below.
        }
    }

    return {
        clientId: body.client_id,
        clientSecret: body.client_secret
    };
}

// --- Public OAuth endpoints ---

oauthRouter.get('/.well-known/oauth-authorization-server', (req, res) => {
    res.json(getOAuthServerMetadata(req));
});

oauthRouter.get('/.well-known/oauth-protected-resource', (req, res) => {
    res.json(getProtectedResourceMetadata(req));
});

oauthRouter.get('/.well-known/oauth-protected-resource/mcp', (req, res) => {
    res.json(getProtectedResourceMetadata(req));
});

oauthRouter.post('/oauth/register', async (req, res) => {
    try {
        const body = req.body ?? {};
        const clientName = typeof body.client_name === 'string'
            ? body.client_name.trim()
            : typeof body.name === 'string'
                ? body.name.trim()
                : '';
        const redirectUris = normalizeRedirectUris(body.redirect_uris);
        const scopes = resolveScopes(body.scope ?? body.scopes);
        const tokenEndpointAuthMethod = body.token_endpoint_auth_method === 'client_secret_basic'
            ? 'client_secret_basic'
            : 'client_secret_post';

        if (!clientName || !redirectUris || !scopes) {
            return res.status(400).json({
                error: 'invalid_client_metadata',
                error_description: 'client_name, valid redirect_uris, and supported scopes are required'
            });
        }

        const clientId = 'om_client_' + randomBytes(12).toString('hex');
        const clientSecret = 'om_secret_' + randomBytes(24).toString('hex');
        const secretHash = sha256(clientSecret);

        await db.query(
            `INSERT INTO oauth_clients (client_id, client_secret_hash, name, redirect_uris, scopes)
             VALUES ($1, $2, $3, $4, $5)`,
            [clientId, secretHash, clientName, redirectUris, scopes]
        );

        const issuedAt = Math.floor(Date.now() / 1000);
        res.status(201).json({
            client_id: clientId,
            client_secret: clientSecret,
            client_id_issued_at: issuedAt,
            client_secret_expires_at: 0,
            client_name: clientName,
            redirect_uris: redirectUris,
            grant_types: ['authorization_code', 'refresh_token'],
            response_types: ['code'],
            token_endpoint_auth_method: tokenEndpointAuthMethod,
            scope: scopes.join(' ')
        });
    } catch (error: any) {
        console.error('OAuth dynamic registration error:', error);
        res.status(500).json({ error: 'server_error', error_description: error.message });
    }
});

// Authorization page (GET, serves the consent form)
oauthRouter.get('/oauth/authorize', (req, res) => {
    const { client_id, redirect_uri, response_type } = req.query;

    if (response_type !== 'code') {
        return res.status(400).json({ error: 'Only response_type=code is supported' });
    }

    if (!client_id || !redirect_uri) {
        return res.status(400).json({ error: 'client_id and redirect_uri are required' });
    }

    res.sendFile(path.join(process.cwd(), 'public', 'oauth-authorize.html'));
});

// Authorization consent submission (POST)
oauthRouter.post('/oauth/authorize', async (req, res) => {
    try {
        const body = req.body ?? {};
        const username = normalizeUsername(body.username);
        const password = typeof body.password === 'string' ? body.password : '';
        const { client_id, redirect_uri, scope, state, action, code_challenge, code_challenge_method } = body;

        if (!client_id || !redirect_uri || !username || !password) {
            return res.status(400).json({ error: 'Missing required fields' });
        }

        const attemptKey = buildLoginAttemptKey(username, req);
        const throttle = getLoginThrottleStatus(attemptKey);
        if (throttle.blocked) {
            res.set('Retry-After', String(throttle.retryAfterSeconds));
            return res.status(429).json({
                error: `Too many failed login attempts. Try again in ${throttle.retryAfterSeconds} seconds.`
            });
        }

        if (code_challenge_method && code_challenge_method !== 'plain' && code_challenge_method !== 'S256') {
            return res.status(400).json({ error: 'Unsupported code_challenge_method' });
        }

        // Validate client
        const clientResult = await db.query(
            `SELECT client_id, name, redirect_uris, scopes FROM oauth_clients WHERE client_id = $1`,
            [client_id]
        );

        if (clientResult.rows.length === 0) {
            return res.status(400).json({ error: 'Unknown client_id' });
        }

        const client = clientResult.rows[0];

        // Validate redirect_uri (exact match)
        if (!client.redirect_uris.includes(redirect_uri)) {
            return res.status(400).json({ error: 'Invalid redirect_uri' });
        }

        const allowedScopes = Array.isArray(client.scopes) && client.scopes.length > 0 ? client.scopes : DEFAULT_OAUTH_SCOPES;
        const resolvedScopes = resolveScopes(scope, allowedScopes);
        if (!resolvedScopes) {
            return res.status(400).json({ error: 'Invalid scope requested' });
        }

        // Authenticate user
        const userResult = await db.query(
            `SELECT id, is_admin, password_hash FROM users WHERE username = $1`,
            [username]
        );

        if (userResult.rows.length === 0) {
            const failed = recordFailedLoginAttempt(attemptKey);
            if (failed.blocked) {
                res.set('Retry-After', String(failed.retryAfterSeconds));
            }
            return res.status(401).json({ error: 'Invalid credentials' });
        }

        const user = userResult.rows[0];
        const valid = await verifyPassword(password, user.password_hash);
        if (!valid) {
            const failed = recordFailedLoginAttempt(attemptKey);
            if (failed.blocked) {
                res.set('Retry-After', String(failed.retryAfterSeconds));
            }
            return res.status(401).json({ error: 'Invalid credentials' });
        }

        // Migrate hash if needed
        if (!user.password_hash.startsWith('$2')) {
            const bcryptHash = await hashPassword(password);
            await db.query(`UPDATE users SET password_hash = $1 WHERE id = $2`, [bcryptHash, user.id]);
        }

        clearLoginAttempts(attemptKey);

        if (action === 'deny') {
            const redirectUrl = new URL(redirect_uri);
            redirectUrl.searchParams.set('error', 'access_denied');
            if (state) redirectUrl.searchParams.set('state', state);
            if (wantsJson(req)) {
                return res.json({ redirect: redirectUrl.toString() });
            }
            return res.redirect(redirectUrl.toString());
        }

        // Generate auth code
        const code = generateToken();
        const codeHash = sha256(code);
        const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

        await db.query(
            `INSERT INTO oauth_codes (code, client_id, user_id, redirect_uri, scope, state, expires_at, code_challenge, code_challenge_method)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
            [
                codeHash,
                client_id,
                user.id,
                redirect_uri,
                resolvedScopes.join(' '),
                state || null,
                expiresAt,
                typeof code_challenge === 'string' ? code_challenge : null,
                typeof code_challenge_method === 'string' ? code_challenge_method : null
            ]
        );

        const redirectUrl = new URL(redirect_uri);
        redirectUrl.searchParams.set('code', code);
        if (state) redirectUrl.searchParams.set('state', state);

        if (wantsJson(req)) {
            return res.json({ redirect: redirectUrl.toString() });
        }

        res.redirect(redirectUrl.toString());
    } catch (error: any) {
        console.error('OAuth authorize error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Token exchange
oauthRouter.post('/oauth/token', async (req, res) => {
    try {
        const body = req.body ?? {};
        const { grant_type, code, redirect_uri, refresh_token, code_verifier } = body;
        const { clientId: client_id, clientSecret: client_secret } = getClientCredentials(req, body);

        if (grant_type === 'authorization_code') {
            if (!client_id || !client_secret || !code || !redirect_uri) {
                return res.status(400).json({ error: 'invalid_request', error_description: 'Missing required parameters' });
            }

            const clientHash = sha256(client_secret);
            const clientResult = await db.query(
                `SELECT client_id FROM oauth_clients WHERE client_id = $1 AND client_secret_hash = $2`,
                [client_id, clientHash]
            );

            if (clientResult.rows.length === 0) {
                return res.status(401).json({ error: 'invalid_client' });
            }

            // Validate and consume auth code
            const codeHash = sha256(code);
            const codeResult = await db.query(
                `SELECT id, user_id, redirect_uri, scope, code_challenge, code_challenge_method FROM oauth_codes
                 WHERE code = $1 AND client_id = $2 AND used = false AND expires_at > NOW()`,
                [codeHash, client_id]
            );

            if (codeResult.rows.length === 0) {
                return res.status(400).json({ error: 'invalid_grant', error_description: 'Invalid or expired authorization code' });
            }

            const authCode = codeResult.rows[0];

            if (authCode.redirect_uri !== redirect_uri) {
                return res.status(400).json({ error: 'invalid_grant', error_description: 'redirect_uri mismatch' });
            }

            if (authCode.code_challenge) {
                if (typeof code_verifier !== 'string' || !verifyPkceChallenge(code_verifier, authCode.code_challenge, authCode.code_challenge_method)) {
                    return res.status(400).json({ error: 'invalid_grant', error_description: 'Invalid code_verifier' });
                }
            }

            // Mark code as used
            await db.query(`UPDATE oauth_codes SET used = true WHERE id = $1`, [authCode.id]);

            // Generate tokens using resource owner's settings
            const accessTokenLifetime = await getUserSetting(authCode.user_id, 'oauth_access_token_lifetime');
            const refreshTokenLifetime = await getUserSetting(authCode.user_id, 'oauth_refresh_token_lifetime');

            const accessToken = generateToken();
            const refreshTokenValue = generateToken();
            const accessHash = sha256(accessToken);
            const refreshHash = sha256(refreshTokenValue);

            const expiresAt = new Date(Date.now() + accessTokenLifetime * 1000);
            const refreshExpiresAt = new Date(Date.now() + refreshTokenLifetime * 1000);

            await db.query(
                `INSERT INTO oauth_tokens (access_token_hash, refresh_token_hash, client_id, user_id, scope, expires_at, refresh_expires_at)
                 VALUES ($1, $2, $3, $4, $5, $6, $7)`,
                [accessHash, refreshHash, client_id, authCode.user_id, authCode.scope, expiresAt, refreshExpiresAt]
            );

            res.json({
                access_token: accessToken,
                token_type: 'Bearer',
                expires_in: accessTokenLifetime,
                refresh_token: refreshTokenValue,
                scope: authCode.scope,
            });

        } else if (grant_type === 'refresh_token') {
            if (!client_id || !client_secret || !refresh_token) {
                return res.status(400).json({ error: 'invalid_request', error_description: 'client credentials and refresh_token are required' });
            }

            const clientHash = sha256(client_secret);
            const clientResult = await db.query(
                `SELECT client_id FROM oauth_clients WHERE client_id = $1 AND client_secret_hash = $2`,
                [client_id, clientHash]
            );

            if (clientResult.rows.length === 0) {
                return res.status(401).json({ error: 'invalid_client' });
            }

            const refreshHash = sha256(refresh_token);
            const tokenResult = await db.query(
                `SELECT id, user_id, client_id, scope FROM oauth_tokens
                 WHERE refresh_token_hash = $1 AND client_id = $2 AND refresh_expires_at > NOW()`,
                [refreshHash, client_id]
            );

            if (tokenResult.rows.length === 0) {
                return res.status(400).json({ error: 'invalid_grant', error_description: 'Invalid or expired refresh token' });
            }

            const oldToken = tokenResult.rows[0];

            // Delete old token
            await db.query(`DELETE FROM oauth_tokens WHERE id = $1`, [oldToken.id]);

            // Generate new token pair using resource owner's settings
            const accessTokenLifetime = await getUserSetting(oldToken.user_id, 'oauth_access_token_lifetime');
            const refreshTokenLifetime = await getUserSetting(oldToken.user_id, 'oauth_refresh_token_lifetime');

            const newAccessToken = generateToken();
            const newRefreshToken = generateToken();
            const newAccessHash = sha256(newAccessToken);
            const newRefreshHash = sha256(newRefreshToken);

            const expiresAt = new Date(Date.now() + accessTokenLifetime * 1000);
            const refreshExpiresAt = new Date(Date.now() + refreshTokenLifetime * 1000);

            await db.query(
                `INSERT INTO oauth_tokens (access_token_hash, refresh_token_hash, client_id, user_id, scope, expires_at, refresh_expires_at)
                 VALUES ($1, $2, $3, $4, $5, $6, $7)`,
                [newAccessHash, newRefreshHash, oldToken.client_id, oldToken.user_id, oldToken.scope, expiresAt, refreshExpiresAt]
            );

            res.json({
                access_token: newAccessToken,
                token_type: 'Bearer',
                expires_in: accessTokenLifetime,
                refresh_token: newRefreshToken,
                scope: oldToken.scope,
            });

        } else {
            res.status(400).json({ error: 'unsupported_grant_type' });
        }
    } catch (error: any) {
        console.error('OAuth token error:', error);
        res.status(500).json({ error: 'server_error', error_description: error.message });
    }
});

// Revoke token
oauthRouter.post('/oauth/revoke', async (req, res) => {
    try {
        const { token } = req.body ?? {};
        if (!token) return res.status(400).json({ error: 'token is required' });

        const tokenHash = sha256(token);

        // Try access token first, then refresh token. Always return 200 per RFC 7009.
        await db.query(
            `DELETE FROM oauth_tokens WHERE access_token_hash = $1 OR refresh_token_hash = $1`,
            [tokenHash]
        );

        res.json({ ok: true });
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
});

// --- Authenticated endpoints for manual OAuth client management ---

// List OAuth clients
oauthRouter.get('/api/oauth/clients', async (req, res) => {
    try {
        const params: any[] = [];
        let whereClause = 'WHERE c.created_by IS NOT NULL';

        if (!req.isAdmin) {
            params.push(req.userId);
            whereClause += ` AND c.created_by = $${params.length}`;
        }

        const result = await db.query(
            `SELECT c.id, c.client_id, c.name, c.redirect_uris, c.scopes, c.created_at, c.created_by, u.username AS owner_username
             FROM oauth_clients c
             LEFT JOIN users u ON c.created_by = u.id
             ${whereClause}
             ORDER BY c.created_at DESC`,
            params
        );
        res.json(result.rows);
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
});

// Register new OAuth client
oauthRouter.post('/api/oauth/clients', async (req, res) => {
    try {
        const body = req.body ?? {};
        const name = typeof body.name === 'string' ? body.name.trim() : '';
        const redirectUris = normalizeRedirectUris(body.redirect_uris);
        const scopes = resolveScopes(body.scopes);

        if (!name || !redirectUris || !scopes) {
            return res.status(400).json({ error: 'name, valid redirect_uris, and supported scopes are required' });
        }

        const clientId = 'om_client_' + randomBytes(12).toString('hex');
        const clientSecret = 'om_secret_' + randomBytes(24).toString('hex');
        const secretHash = sha256(clientSecret);

        const result = await db.query(
            `INSERT INTO oauth_clients (client_id, client_secret_hash, name, redirect_uris, scopes, created_by)
             VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, client_id, name, redirect_uris, scopes, created_at`,
            [clientId, secretHash, name, redirectUris, scopes, req.userId]
        );

        res.json({
            ...result.rows[0],
            client_secret: clientSecret,
            warning: 'Save the client_secret now. It cannot be shown again.'
        });
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
});

// Delete OAuth client
oauthRouter.delete('/api/oauth/clients/:id', async (req, res) => {
    try {
        const params: any[] = [req.params.id];
        let deleteQuery = `DELETE FROM oauth_clients WHERE id = $1`;

        if (!req.isAdmin) {
            params.push(req.userId);
            deleteQuery += ` AND created_by = $${params.length}`;
        }

        deleteQuery += ` RETURNING client_id`;

        const result = await db.query(
            deleteQuery,
            params
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Client not found' });
        }

        // Also delete all tokens for this client
        await db.query(`DELETE FROM oauth_tokens WHERE client_id = $1`, [result.rows[0].client_id]);

        res.json({ deleted: true });
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
});
