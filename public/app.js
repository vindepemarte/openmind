(function () {
    const state = {
        user: null,
        thoughts: [],
        selectedThought: null,
        limit: 25,
        offset: 0,
    };

    const $ = (id) => document.getElementById(id);

    function escapeHtml(value) {
        return String(value ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function formatDate(value) {
        if (!value) return '';
        const date = new Date(value);
        if (Number.isNaN(date.getTime())) return '';
        return date.toLocaleString(undefined, {
            year: 'numeric',
            month: 'short',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
        });
    }

    function compactContent(value, max = 520) {
        const text = String(value || '').trim();
        if (text.length <= max) return text;
        return text.slice(0, max).trimEnd() + '...';
    }

    async function api(path, options) {
        const response = await fetch(path, {
            credentials: 'same-origin',
            ...options,
            headers: {
                ...(options && options.body instanceof FormData ? {} : { 'content-type': 'application/json' }),
                ...(options?.headers || {}),
            },
        });

        if (response.status === 401) {
            window.location.href = '/login';
            throw new Error('Authentication required');
        }

        const text = await response.text();
        const data = text ? JSON.parse(text) : null;

        if (!response.ok) {
            throw new Error(data?.error || `Request failed with ${response.status}`);
        }

        return data;
    }

    function showStatus(id, message, type) {
        const node = $(id);
        if (!node) return;
        node.textContent = message || '';
        node.className = message ? `status visible ${type || 'success'}` : 'status';
    }

    function tagsToText(tags) {
        return Array.isArray(tags) ? tags.join(', ') : '';
    }

    function parseTags(value) {
        return String(value || '')
            .split(',')
            .map((tag) => tag.trim())
            .filter(Boolean);
    }

    function pills(thought, extra) {
        const tags = Array.isArray(thought.tags) ? thought.tags : [];
        const parts = [
            `<span class="pill type">${escapeHtml(thought.thought_type || thought.type || 'thought')}</span>`,
        ];

        if (thought.source) {
            parts.push(`<span class="pill source">${escapeHtml(thought.source)}</span>`);
        }

        if (typeof thought.similarity === 'number') {
            parts.push(`<span class="pill similarity">${Math.round(thought.similarity * 100)}% match</span>`);
        }

        for (const tag of tags.slice(0, 5)) {
            parts.push(`<span class="pill">${escapeHtml(tag)}</span>`);
        }

        if (extra) parts.push(extra);
        return `<div class="pill-row">${parts.join('')}</div>`;
    }

    function switchView(view) {
        document.querySelectorAll('.nav-tab').forEach((tab) => {
            tab.classList.toggle('active', tab.dataset.view === view);
        });
        document.querySelectorAll('.view').forEach((panel) => {
            panel.classList.toggle('active', panel.id === `view-${view}`);
        });

        if (view === 'connect') loadApiKeys();
        if (view === 'admin' && state.user?.is_admin) loadUsers();
    }

    async function loadMe() {
        state.user = await api('/auth/me');
        $('currentUser').textContent = `${state.user.username}${state.user.is_admin ? ' / admin' : ''}`;
        document.querySelectorAll('.admin-only').forEach((node) => {
            node.classList.toggle('hidden', !state.user.is_admin);
        });
    }

    async function loadStats() {
        try {
            const stats = await api('/stats');
            $('metricTotal').textContent = String(stats.totalThoughts || 0);
        } catch {
            $('metricTotal').textContent = '0';
        }
    }

    function buildThoughtQuery() {
        const params = new URLSearchParams();
        params.set('limit', String(state.limit));
        params.set('offset', String(state.offset));

        const values = {
            q: $('filterText').value.trim(),
            type: $('filterType').value.trim(),
            tag: $('filterTag').value.trim(),
            source: $('filterSource').value.trim(),
        };

        for (const [key, value] of Object.entries(values)) {
            if (value) params.set(key, value);
        }

        return params.toString();
    }

    async function loadThoughts() {
        const container = $('thoughtList');
        container.innerHTML = '<div class="empty">Loading thoughts...</div>';

        try {
            const payload = await api(`/api/thoughts?${buildThoughtQuery()}`);
            state.thoughts = payload.items || [];
            $('metricTotal').textContent = String(payload.total || 0);
            $('metricShown').textContent = String(state.thoughts.length);
            renderThoughts();
        } catch (error) {
            container.innerHTML = `<div class="empty">${escapeHtml(error.message)}</div>`;
        }
    }

    function renderThoughts() {
        const container = $('thoughtList');
        if (!state.thoughts.length) {
            container.innerHTML = '<div class="empty">No thoughts found.</div>';
            return;
        }

        container.innerHTML = state.thoughts.map((thought) => {
            const active = state.selectedThought?.id === thought.id ? ' active' : '';
            return `<article class="thought-item${active}" data-id="${escapeHtml(thought.id)}">
                <div class="thought-topline">
                    ${pills(thought)}
                    <span class="muted">${escapeHtml(formatDate(thought.created_at))}</span>
                </div>
                <p class="thought-content">${escapeHtml(compactContent(thought.content))}</p>
                ${thought.summary ? `<p class="muted">${escapeHtml(compactContent(thought.summary, 180))}</p>` : ''}
            </article>`;
        }).join('');
    }

    async function selectThought(id) {
        try {
            const thought = await api(`/api/thoughts/${encodeURIComponent(id)}`);
            state.selectedThought = thought;
            renderThoughts();
            $('editorHint').classList.add('hidden');
            $('thoughtEditor').classList.remove('hidden');
            $('editContent').value = thought.content || '';
            $('editType').value = thought.thought_type || '';
            $('editSource').value = thought.source || '';
            $('editSummary').value = thought.summary || '';
            $('editTags').value = tagsToText(thought.tags);
            showStatus('thoughtStatus', '', 'success');
        } catch (error) {
            showStatus('thoughtStatus', error.message, 'error');
        }
    }

    async function saveSelectedThought(event) {
        event.preventDefault();
        if (!state.selectedThought) return;

        try {
            const payload = {
                content: $('editContent').value,
                type: $('editType').value,
                source: $('editSource').value,
                summary: $('editSummary').value,
                tags: parseTags($('editTags').value),
            };

            const updated = await api(`/api/thoughts/${encodeURIComponent(state.selectedThought.id)}`, {
                method: 'PATCH',
                body: JSON.stringify(payload),
            });

            state.selectedThought = updated;
            showStatus('thoughtStatus', 'Thought saved.', 'success');
            await loadThoughts();
        } catch (error) {
            showStatus('thoughtStatus', error.message, 'error');
        }
    }

    async function deleteSelectedThought() {
        if (!state.selectedThought) return;
        if (!window.confirm('Delete this thought?')) return;

        try {
            await api(`/api/thoughts/${encodeURIComponent(state.selectedThought.id)}`, { method: 'DELETE' });
            state.selectedThought = null;
            $('thoughtEditor').classList.add('hidden');
            $('editorHint').classList.remove('hidden');
            showStatus('thoughtStatus', 'Thought deleted.', 'success');
            await loadThoughts();
        } catch (error) {
            showStatus('thoughtStatus', error.message, 'error');
        }
    }

    async function runSemanticSearch(event) {
        event.preventDefault();
        const query = $('searchInput').value.trim();
        const container = $('searchResults');
        if (!query) {
            container.innerHTML = '<div class="empty">Enter a search query.</div>';
            return;
        }

        container.innerHTML = '<div class="empty">Searching...</div>';
        try {
            const results = await api(`/search?q=${encodeURIComponent(query)}&limit=12`);
            if (!results.length) {
                container.innerHTML = '<div class="empty">No semantic matches.</div>';
                return;
            }

            container.innerHTML = results.map((thought) => `<article class="result-item">
                ${pills(thought)}
                <p class="thought-content">${escapeHtml(compactContent(thought.content, 700))}</p>
                <p class="muted">${escapeHtml(formatDate(thought.created_at))}</p>
            </article>`).join('');
        } catch (error) {
            container.innerHTML = `<div class="empty">${escapeHtml(error.message)}</div>`;
        }
    }

    async function captureThought(event) {
        event.preventDefault();
        showStatus('captureStatus', 'Capturing...', 'success');
        try {
            const content = $('captureContent').value.trim();
            if (!content) throw new Error('Content is required.');

            const payload = {
                content,
                source: 'dashboard',
                type: $('captureType').value.trim() || undefined,
                tags: parseTags($('captureTags').value),
            };

            const result = await api('/capture', {
                method: 'POST',
                body: JSON.stringify(payload),
            });

            $('captureContent').value = '';
            $('captureType').value = '';
            $('captureTags').value = '';
            showStatus('captureStatus', `Captured with status: ${result.status}.`, 'success');
            await loadStats();
            await loadThoughts();
        } catch (error) {
            showStatus('captureStatus', error.message, 'error');
        }
    }

    async function loadApiKeys() {
        const container = $('apiKeyList');
        try {
            const keys = await api('/api/keys');
            if (!keys.length) {
                container.innerHTML = '<div class="empty">No API keys yet.</div>';
                return;
            }

            container.innerHTML = `<table>
                <thead><tr><th>Name</th><th>Created</th><th>Last used</th><th></th></tr></thead>
                <tbody>
                    ${keys.map((key) => `<tr>
                        <td>${escapeHtml(key.name)}</td>
                        <td>${escapeHtml(formatDate(key.created_at))}</td>
                        <td>${escapeHtml(key.last_used_at ? formatDate(key.last_used_at) : 'Never')}</td>
                        <td><button class="button danger revoke-key" data-id="${escapeHtml(key.id)}" type="button">Revoke</button></td>
                    </tr>`).join('')}
                </tbody>
            </table>`;
        } catch (error) {
            container.innerHTML = `<div class="empty">${escapeHtml(error.message)}</div>`;
        }
    }

    async function createApiKey(event) {
        event.preventDefault();
        try {
            const name = $('keyName').value.trim() || `OpenMind key ${new Date().toISOString().slice(0, 10)}`;
            const result = await api('/api/keys', {
                method: 'POST',
                body: JSON.stringify({ name }),
            });

            $('keyName').value = '';
            showStatus('newKey', `New key: ${result.key}`, 'success');
            try {
                await navigator.clipboard.writeText(result.key);
            } catch {
                // Some browsers block clipboard writes outside secure contexts.
            }
            await loadApiKeys();
        } catch (error) {
            showStatus('newKey', error.message, 'error');
        }
    }

    async function revokeApiKey(id) {
        try {
            await api(`/api/keys/${encodeURIComponent(id)}`, { method: 'DELETE' });
            showStatus('newKey', 'API key revoked.', 'success');
            await loadApiKeys();
        } catch (error) {
            showStatus('newKey', error.message, 'error');
        }
    }

    async function importMemories(event) {
        event.preventDefault();
        const file = $('importFile').files[0];
        if (!file) {
            showStatus('importStatus', 'Choose a file first.', 'error');
            return;
        }

        try {
            const formData = new FormData();
            formData.append('file', file);
            const result = await api('/upload/memories', {
                method: 'POST',
                body: formData,
            });
            showStatus('importStatus', result.status || 'Import started.', 'success');
            $('importFile').value = '';
            setTimeout(() => {
                loadStats();
                loadThoughts();
            }, 1500);
        } catch (error) {
            showStatus('importStatus', error.message, 'error');
        }
    }

    async function loadUsers() {
        const container = $('userList');
        try {
            const users = await api('/api/users');
            container.innerHTML = `<table>
                <thead><tr><th>Username</th><th>Role</th><th>Created</th></tr></thead>
                <tbody>
                    ${users.map((user) => `<tr>
                        <td>${escapeHtml(user.username)}</td>
                        <td>${escapeHtml(user.is_admin ? 'Admin' : 'User')}</td>
                        <td>${escapeHtml(formatDate(user.created_at))}</td>
                    </tr>`).join('')}
                </tbody>
            </table>`;
        } catch (error) {
            container.innerHTML = `<div class="empty">${escapeHtml(error.message)}</div>`;
        }
    }

    async function logout() {
        await fetch('/auth/logout', { method: 'POST', credentials: 'same-origin' });
        window.location.href = '/login';
    }

    function configureConnectDefaults() {
        const origin = window.location.origin;
        $('mcpUrl').textContent = `${origin}/mcp`;
        $('cliInstall').textContent = `npx @vindepemarte/openmind connect ${origin} --all-clients`;
        $('chatgptConnector').textContent = `MCP URL: ${origin}/mcp\nOAuth metadata: ${origin}/.well-known/oauth-authorization-server\nScopes: read write offline_access`;
        $('claudeCodeCommand').textContent = `claude mcp add --transport http openmind ${origin}/mcp`;
        $('cursorCommand').textContent = `npx @vindepemarte/openmind connect ${origin} --client cursor`;
        $('windsurfCommand').textContent = `npx @vindepemarte/openmind connect ${origin} --client windsurf --dry-run`;
        $('vscodeCommand').textContent = `npx @vindepemarte/openmind connect ${origin} --client vscode`;
        $('genericCommand').textContent = `npx @vindepemarte/openmind connect ${origin} --client generic --dry-run`;
    }

    function bindEvents() {
        document.querySelectorAll('.nav-tab').forEach((tab) => {
            tab.addEventListener('click', () => switchView(tab.dataset.view));
        });

        $('thoughtFilters').addEventListener('submit', (event) => {
            event.preventDefault();
            state.offset = 0;
            loadThoughts();
        });

        $('clearFilters').addEventListener('click', () => {
            $('filterText').value = '';
            $('filterType').value = '';
            $('filterTag').value = '';
            $('filterSource').value = '';
            state.offset = 0;
            loadThoughts();
        });

        $('thoughtList').addEventListener('click', (event) => {
            const item = event.target.closest('.thought-item');
            if (item?.dataset.id) selectThought(item.dataset.id);
        });

        $('thoughtEditor').addEventListener('submit', saveSelectedThought);
        $('deleteThought').addEventListener('click', deleteSelectedThought);
        $('searchForm').addEventListener('submit', runSemanticSearch);
        $('captureForm').addEventListener('submit', captureThought);
        $('keyForm').addEventListener('submit', createApiKey);
        $('importForm').addEventListener('submit', importMemories);
        $('logoutButton').addEventListener('click', logout);

        $('apiKeyList').addEventListener('click', (event) => {
            const button = event.target.closest('.revoke-key');
            if (button?.dataset.id) revokeApiKey(button.dataset.id);
        });

        document.querySelectorAll('.copy-button').forEach((button) => {
            button.addEventListener('click', async () => {
                const source = $(button.dataset.copyFrom);
                if (!source) return;
                try {
                    await navigator.clipboard.writeText(source.textContent.trim());
                } catch {
                    return;
                }
                const previous = button.textContent;
                button.textContent = 'Copied';
                setTimeout(() => { button.textContent = previous; }, 1200);
            });
        });
    }

    async function init() {
        configureConnectDefaults();
        bindEvents();
        await loadMe();
        await Promise.all([loadStats(), loadThoughts()]);
        const initialView = new URLSearchParams(window.location.search).get('view');
        if (initialView && document.getElementById(`view-${initialView}`)) {
            switchView(initialView);
        }
    }

    init().catch((error) => {
        document.body.innerHTML = `<main class="app-shell"><div class="empty">${escapeHtml(error.message)}</div></main>`;
    });
})();
