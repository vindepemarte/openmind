import test from 'node:test';
import assert from 'node:assert/strict';

import { unifiedAuthMiddleware } from '../../src/auth/middleware';
import { db } from '../../src/db/client';
import * as jwtModule from '../../src/auth/jwt';
import { hashPassword } from '../../src/auth/passwords';

type QueryResponse = { rows: any[] };

interface MockResponse {
    statusCode: number;
    headers: Record<string, string>;
    body: any;
    redirectLocation?: string;
    status: (code: number) => MockResponse;
    json: (payload: any) => MockResponse;
    redirect: (location: string) => MockResponse;
    set: (name: string, value: string) => MockResponse;
    setHeader: (name: string, value: string) => void;
}

function createMockResponse(): MockResponse {
    return {
        statusCode: 200,
        headers: {},
        body: undefined,
        status(code: number) {
            this.statusCode = code;
            return this;
        },
        json(payload: any) {
            this.body = payload;
            return this;
        },
        redirect(location: string) {
            this.statusCode = 302;
            this.redirectLocation = location;
            return this;
        },
        set(name: string, value: string) {
            this.headers[name] = value;
            return this;
        },
        setHeader(name: string, value: string) {
            this.headers[name] = value;
        }
    };
}

function setDbQuery(handler: (sql: string, params: any[]) => Promise<QueryResponse>) {
    (db as any).query = async (sql: string, params?: any[]) => handler(String(sql), params ?? []);
}

async function runMiddleware(reqOverrides: Record<string, any>) {
    const req: any = {
        path: '/private',
        method: 'GET',
        headers: {},
        get(name: string) {
            return this.headers[name.toLowerCase()];
        },
        ...reqOverrides
    };
    const res = createMockResponse();
    let nextCalled = false;

    await unifiedAuthMiddleware(req, res as any, () => {
        nextCalled = true;
    });

    return { req, res, nextCalled };
}

test('allows public health route without auth', async () => {
    const originalQuery = (db as any).query;
    const originalVerifyJwt = (jwtModule as any).verifyJwt;

    try {
        let queryCalls = 0;
        setDbQuery(async () => {
            queryCalls += 1;
            throw new Error('public route should not query auth dependencies');
        });
        (jwtModule as any).verifyJwt = async () => {
            throw new Error('public route should not verify JWTs');
        };

        const { nextCalled, res } = await runMiddleware({ path: '/health' });

        assert.equal(nextCalled, true);
        assert.equal(res.statusCode, 200);
        assert.equal(queryCalls, 0);
    } finally {
        (db as any).query = originalQuery;
        (jwtModule as any).verifyJwt = originalVerifyJwt;
    }
});

test('allows public auth, health, and asset routes without auth', async () => {
    const originalQuery = (db as any).query;
    const originalVerifyJwt = (jwtModule as any).verifyJwt;

    try {
        let queryCalls = 0;
        setDbQuery(async () => {
            queryCalls += 1;
            throw new Error('public route should not query auth dependencies');
        });
        (jwtModule as any).verifyJwt = async () => {
            throw new Error('public route should not verify JWTs');
        };

        const loginRoute = await runMiddleware({ path: '/login' });
        assert.equal(loginRoute.nextCalled, true);
        assert.equal(loginRoute.res.statusCode, 200);

        const registerRoute = await runMiddleware({ path: '/auth/register', method: 'POST' });
        assert.equal(registerRoute.nextCalled, true);
        assert.equal(registerRoute.res.statusCode, 200);

        const assetRoute = await runMiddleware({ path: '/assets/openmind-logo.svg' });
        assert.equal(assetRoute.nextCalled, true);
        assert.equal(assetRoute.res.statusCode, 200);

        assert.equal(queryCalls, 0);
    } finally {
        (db as any).query = originalQuery;
        (jwtModule as any).verifyJwt = originalVerifyJwt;
    }
});

test('Authorization header takes precedence over session cookies', async () => {
    const originalQuery = (db as any).query;
    const originalVerifyJwt = (jwtModule as any).verifyJwt;

    try {
        const passwordHash = await hashPassword('secret123');
        let verifyJwtCalls = 0;

        setDbQuery(async (sql) => {
            if (sql.includes('FROM users WHERE username = $1')) {
                return {
                    rows: [{ id: 'basic-user', is_admin: true, password_hash: passwordHash }]
                };
            }

            if (sql.includes('UPDATE users SET password_hash')) {
                return { rows: [] };
            }

            throw new Error(`Unexpected query: ${sql}`);
        });

        (jwtModule as any).verifyJwt = async () => {
            verifyJwtCalls += 1;
            return { userId: 'cookie-user', username: 'cookie', isAdmin: false };
        };

        const credentials = Buffer.from('admin:secret123').toString('base64');
        const { req, res, nextCalled } = await runMiddleware({
            headers: {
                authorization: `Basic ${credentials}`,
                cookie: 'session=fake-session-token'
            }
        });

        assert.equal(nextCalled, true);
        assert.equal(req.userId, 'basic-user');
        assert.equal(req.isAdmin, true);
        assert.equal(res.statusCode, 200);
        assert.equal(verifyJwtCalls, 0);
    } finally {
        (db as any).query = originalQuery;
        (jwtModule as any).verifyJwt = originalVerifyJwt;
    }
});

test('accepts bearer API keys for authenticated requests', async () => {
    const originalQuery = (db as any).query;

    try {
        setDbQuery(async (sql) => {
            if (sql.includes('FROM api_keys ak')) {
                return { rows: [{ user_id: 'api-user', is_admin: false }] };
            }

            if (sql.includes('UPDATE api_keys SET last_used_at')) {
                return { rows: [] };
            }

            throw new Error(`Unexpected query: ${sql}`);
        });

        const { req, nextCalled } = await runMiddleware({
            headers: {
                authorization: 'Bearer om_test_key'
            }
        });

        assert.equal(nextCalled, true);
        assert.equal(req.userId, 'api-user');
        assert.equal(req.isAdmin, false);
    } finally {
        (db as any).query = originalQuery;
    }
});

test('falls back to the session cookie when no Authorization header is present', async () => {
    const originalQuery = (db as any).query;
    const originalVerifyJwt = (jwtModule as any).verifyJwt;

    try {
        setDbQuery(async (sql) => {
            throw new Error(`Unexpected query: ${sql}`);
        });

        (jwtModule as any).verifyJwt = async () => ({
            userId: 'cookie-user',
            username: 'cookie-user',
            isAdmin: false
        });

        const { req, nextCalled } = await runMiddleware({
            headers: {
                cookie: 'session=fake-session-token'
            }
        });

        assert.equal(nextCalled, true);
        assert.equal(req.userId, 'cookie-user');
        assert.equal(req.isAdmin, false);
    } finally {
        (db as any).query = originalQuery;
        (jwtModule as any).verifyJwt = originalVerifyJwt;
    }
});

test('redirects browser GET requests to /login when unauthenticated', async () => {
    const originalQuery = (db as any).query;
    const originalVerifyJwt = (jwtModule as any).verifyJwt;

    try {
        setDbQuery(async () => ({ rows: [] }));
        (jwtModule as any).verifyJwt = originalVerifyJwt;

        const { nextCalled, res } = await runMiddleware({
            headers: {
                accept: 'text/html'
            }
        });

        assert.equal(nextCalled, false);
        assert.equal(res.statusCode, 302);
        assert.equal(res.redirectLocation, '/login');
    } finally {
        (db as any).query = originalQuery;
        (jwtModule as any).verifyJwt = originalVerifyJwt;
    }
});
