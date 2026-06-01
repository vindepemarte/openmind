interface SmokeResult {
    name: string;
    ok: boolean;
    detail: string;
}

const results: SmokeResult[] = [];

function record(name: string, ok: boolean, detail: string) {
    results.push({ name, ok, detail });
    const prefix = ok ? 'ok' : 'fail';
    console.log(`${prefix} - ${name}: ${detail}`);
}

async function expectJson(response: Response, name: string) {
    if (!response.ok) {
        throw new Error(`${name} returned HTTP ${response.status}`);
    }

    return response.json();
}

async function main() {
    const baseUrl = (process.env.OPENMIND_BASE_URL || 'http://127.0.0.1:3333').replace(/\/$/, '');
    const username = process.env.OPENMIND_SMOKE_USER;
    const password = process.env.OPENMIND_SMOKE_PASSWORD;
    const runSearch = process.env.OPENMIND_RUN_SEARCH === '1';
    const skipImportPreview = process.env.OPENMIND_SKIP_IMPORT_PREVIEW === '1';

    try {
        const healthResponse = await fetch(`${baseUrl}/health`);
        const healthJson = await expectJson(healthResponse, '/health');
        if (healthJson.status !== 'ok') {
            throw new Error(`/health returned unexpected payload: ${JSON.stringify(healthJson)}`);
        }
        record('/health', true, 'status ok');

        const loginResponse = await fetch(`${baseUrl}/login`);
        const loginHtml = await loginResponse.text();
        if (!loginResponse.ok || !loginHtml.includes('<form')) {
            throw new Error('/login did not return the login page');
        }
        record('/login', true, 'login page reachable');

        const landingResponse = await fetch(`${baseUrl}/`);
        const landingHtml = await landingResponse.text();
        if (!landingResponse.ok || !landingHtml.includes('Start with OpenMind Core')) {
            throw new Error('/ did not return the public landing page');
        }
        record('/', true, 'public landing page reachable');

        if (!username || !password) {
            record('auth flow', true, 'skipped because OPENMIND_SMOKE_USER and OPENMIND_SMOKE_PASSWORD are not set');
        } else {
            const loginApiResponse = await fetch(`${baseUrl}/auth/login`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username, password })
            });
            const loginPayload = await expectJson(loginApiResponse, '/auth/login');
            const sessionCookie = loginApiResponse.headers.get('set-cookie')?.split(';')[0];

            if (!sessionCookie || !loginPayload.ok) {
                throw new Error('/auth/login did not return a session cookie');
            }
            record('/auth/login', true, 'session cookie issued');

            const authHeaders = { Cookie: sessionCookie };

            const meResponse = await fetch(`${baseUrl}/auth/me`, { headers: authHeaders });
            const mePayload = await expectJson(meResponse, '/auth/me');
            if (!mePayload.id) {
                throw new Error('/auth/me did not return a user payload');
            }
            record('/auth/me', true, `logged in as ${mePayload.username}`);

            const dashboardResponse = await fetch(`${baseUrl}/app`, { headers: authHeaders });
            const dashboardHtml = await dashboardResponse.text();
            if (!dashboardResponse.ok || !dashboardHtml.includes('OpenMind')) {
                throw new Error('dashboard shell did not load');
            }
            record('/app', true, 'dashboard HTML loaded');

            const kpiResponse = await fetch(`${baseUrl}/api/kpis`, { headers: authHeaders });
            const kpiPayload = await expectJson(kpiResponse, '/api/kpis');
            if (!Array.isArray(kpiPayload.suggestions)) {
                throw new Error('/api/kpis did not return suggestions');
            }
            record('/api/kpis', true, 'KPI payload returned');

            const recentResponse = await fetch(`${baseUrl}/recent?limit=3`, { headers: authHeaders });
            const recentPayload = await expectJson(recentResponse, '/recent');
            if (!Array.isArray(recentPayload)) {
                throw new Error('/recent did not return an array');
            }
            record('/recent', true, `${recentPayload.length} rows returned`);

            const tasksResponse = await fetch(`${baseUrl}/api/tasks?status=open&limit=3`, { headers: authHeaders });
            const tasksPayload = await expectJson(tasksResponse, '/api/tasks');
            if (!Array.isArray(tasksPayload)) {
                throw new Error('/api/tasks did not return an array');
            }
            record('/api/tasks', true, `${tasksPayload.length} open tasks returned`);

            if (skipImportPreview) {
                record('/api/import/preview', true, 'skipped because OPENMIND_SKIP_IMPORT_PREVIEW is set');
            } else {
                const sampleCsv = [
                    'content,source,type,tags',
                    `"Release smoke ${new Date().toISOString()}","release-smoke","insight","release,smoke"`
                ].join('\n');
                const formData = new FormData();
                formData.set('file', new Blob([sampleCsv], { type: 'text/csv' }), 'release-smoke.csv');
                formData.set('mapping', JSON.stringify({
                    contentColumn: 'content',
                    sourceColumn: 'source',
                    typeColumn: 'type',
                    tagsColumn: 'tags'
                }));

                const importPreviewResponse = await fetch(`${baseUrl}/api/import/preview`, {
                    method: 'POST',
                    headers: authHeaders,
                    body: formData
                });
                const importPreviewPayload = await expectJson(importPreviewResponse, '/api/import/preview');
                if (!importPreviewPayload.dryRun || !Array.isArray(importPreviewPayload.previewItems)) {
                    throw new Error('/api/import/preview did not return a dry-run payload');
                }
                if (importPreviewPayload.totalItems < 1) {
                    throw new Error('/api/import/preview did not parse any import rows');
                }
                if ((importPreviewPayload.newItems + importPreviewPayload.duplicateItems) !== importPreviewPayload.totalItems) {
                    throw new Error('/api/import/preview totals are inconsistent');
                }
                record('/api/import/preview', true, `${importPreviewPayload.totalItems} rows parsed in dry-run mode`);
            }

            if (runSearch) {
                const searchResponse = await fetch(`${baseUrl}/search?q=health&limit=3`, { headers: authHeaders });
                const searchPayload = await expectJson(searchResponse, '/search');
                if (!Array.isArray(searchPayload)) {
                    throw new Error('/search did not return an array');
                }
                record('/search', true, `${searchPayload.length} results returned`);
            } else {
                record('/search', true, 'skipped because OPENMIND_RUN_SEARCH is not set');
            }
        }
    } catch (error: any) {
        record('smoke test run', false, error.message);
    }

    const failed = results.filter(result => !result.ok);
    if (failed.length > 0) {
        process.exit(1);
    }
}

main().catch((error) => {
    record('smoke test run', false, error.message);
    process.exit(1);
});
