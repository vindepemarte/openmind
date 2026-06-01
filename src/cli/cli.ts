#!/usr/bin/env node
import fs from 'fs';
import os from 'os';
import path from 'path';
import readline from 'readline';
import { spawn, spawnSync } from 'child_process';

const OS = process.platform;
const HOME = process.env.HOME || process.env.USERPROFILE || '';
const PACKAGE_SPEC = '@vindepemarte/openmind';
const SERVER_NAME = 'openmind';
const DEFAULT_DATABASE_URL = 'postgresql://openmind:openmind@localhost:5432/openmind';
const DEFAULT_HOSTED_URL = 'https://theopenmind.pro';

type SetupMode = 'local' | 'hosted';
type EmbeddingProvider = 'ollama' | 'openrouter';
type ClientId =
    | 'claude-desktop'
    | 'claude-code'
    | 'cursor'
    | 'windsurf'
    | 'gemini-cli'
    | 'codex-cli'
    | 'opencode'
    | 'vscode';

interface ClientProfile {
    id: ClientId;
    label: string;
    kind: 'json-mcp-servers' | 'json-servers' | 'gemini' | 'opencode' | 'codex-toml';
    pathLabel: string;
    getPath(): string;
}

interface LocalEmbeddingSetup {
    provider: EmbeddingProvider;
    env: Record<string, string>;
}

interface OpenRouterModel {
    id: string;
    name?: string;
    description?: string;
    pricing?: {
        prompt?: string;
        input?: string;
    };
    architecture?: {
        modality?: string;
        input_modalities?: string[];
        output_modalities?: string[];
    };
}

let rl: readline.Interface | null = null;

function prompt(): readline.Interface {
    if (!rl) {
        rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout
        });
    }

    return rl;
}

function closePrompt() {
    if (rl) {
        rl.close();
        rl = null;
    }
}

function question(query: string): Promise<string> {
    return new Promise(resolve => prompt().question(query, resolve));
}

function questionHidden(query: string): Promise<string> {
    if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== 'function') {
        return question(query);
    }

    closePrompt();

    return new Promise(resolve => {
        const input = process.stdin;
        const output = process.stdout;
        const wasRaw = input.isRaw;
        let value = '';

        function cleanup() {
            input.off('data', onData);
            input.setRawMode(wasRaw);
            input.pause();
        }

        function onData(buffer: Buffer) {
            const char = buffer.toString('utf8');

            if (char === '\u0003') {
                cleanup();
                output.write('\n');
                process.exit(130);
            }

            if (char === '\r' || char === '\n') {
                cleanup();
                output.write('\n');
                resolve(value);
                return;
            }

            if (char === '\u007f' || char === '\b') {
                if (value.length > 0) value = value.slice(0, -1);
                return;
            }

            value += char;
            output.write('*');
        }

        output.write(query);
        input.setRawMode(true);
        input.resume();
        input.on('data', onData);
    });
}

function expandHome(value: string): string {
    if (!value) return value;
    if (value === '~') return HOME;
    if (value.startsWith('~/')) return path.join(HOME, value.slice(2));
    return value;
}

function getClaudeDesktopConfigPath(): string {
    if (OS === 'darwin') {
        return path.join(HOME, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
    }

    if (OS === 'win32') {
        return path.join(process.env.APPDATA || '', 'Claude', 'claude_desktop_config.json');
    }

    return path.join(HOME, '.config', 'Claude', 'claude_desktop_config.json');
}

function getCursorConfigPath(): string {
    return path.join(HOME, '.cursor', 'mcp.json');
}

function getWindsurfConfigPath(): string {
    if (OS === 'darwin') {
        return path.join(HOME, '.codeium', 'windsurf', 'mcp_config.json');
    }

    if (OS === 'win32') {
        return path.join(process.env.APPDATA || '', 'Codeium', 'Windsurf', 'mcp_config.json');
    }

    return path.join(HOME, '.codeium', 'windsurf', 'mcp_config.json');
}

function getGeminiConfigPath(): string {
    return path.join(HOME, '.gemini', 'settings.json');
}

function getCodexConfigPath(): string {
    return path.join(HOME, '.codex', 'config.toml');
}

function getOpenCodeConfigPath(): string {
    const xdgConfig = process.env.XDG_CONFIG_HOME || path.join(HOME, '.config');
    if (OS === 'win32') {
        return path.join(process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming'), 'opencode', 'opencode.json');
    }

    return path.join(xdgConfig, 'opencode', 'opencode.json');
}

function getVsCodeProjectConfigPath(): string {
    return path.join(process.cwd(), '.vscode', 'mcp.json');
}

const CLIENTS: ClientProfile[] = [
    {
        id: 'claude-desktop',
        label: 'Claude Desktop',
        kind: 'json-mcp-servers',
        pathLabel: 'Claude Desktop MCP config',
        getPath: getClaudeDesktopConfigPath
    },
    {
        id: 'claude-code',
        label: 'Claude Code (current project)',
        kind: 'json-mcp-servers',
        pathLabel: 'Claude Code project MCP config',
        getPath: () => path.join(process.cwd(), '.mcp.json')
    },
    {
        id: 'cursor',
        label: 'Cursor',
        kind: 'json-mcp-servers',
        pathLabel: 'Cursor MCP config',
        getPath: getCursorConfigPath
    },
    {
        id: 'windsurf',
        label: 'Windsurf',
        kind: 'json-mcp-servers',
        pathLabel: 'Windsurf MCP config',
        getPath: getWindsurfConfigPath
    },
    {
        id: 'gemini-cli',
        label: 'Gemini CLI',
        kind: 'gemini',
        pathLabel: 'Gemini CLI settings',
        getPath: getGeminiConfigPath
    },
    {
        id: 'codex-cli',
        label: 'Codex CLI',
        kind: 'codex-toml',
        pathLabel: 'Codex config',
        getPath: getCodexConfigPath
    },
    {
        id: 'opencode',
        label: 'OpenCode',
        kind: 'opencode',
        pathLabel: 'OpenCode config',
        getPath: getOpenCodeConfigPath
    },
    {
        id: 'vscode',
        label: 'VS Code / GitHub Copilot (current project)',
        kind: 'json-servers',
        pathLabel: 'VS Code project MCP config',
        getPath: getVsCodeProjectConfigPath
    }
];

const LOCAL_OLLAMA_MODELS = [
    {
        id: 'nomic-embed-text',
        dimensions: 768,
        label: 'nomic-embed-text',
        note: 'balanced default for local semantic memory'
    },
    {
        id: 'mxbai-embed-large',
        dimensions: 1024,
        label: 'mxbai-embed-large',
        note: 'larger local model, stronger retrieval, slower on small machines'
    },
    {
        id: 'bge-m3',
        dimensions: 1024,
        label: 'bge-m3',
        note: 'multilingual local embeddings'
    },
    {
        id: 'snowflake-arctic-embed',
        dimensions: 1024,
        label: 'snowflake-arctic-embed',
        note: 'good general-purpose retrieval model'
    }
];

const FALLBACK_OPENROUTER_EMBEDDING_MODELS: OpenRouterModel[] = [
    {
        id: 'openai/text-embedding-3-large',
        name: 'OpenAI text-embedding-3-large',
        pricing: { prompt: '0.00000013' }
    },
    {
        id: 'openai/text-embedding-3-small',
        name: 'OpenAI text-embedding-3-small',
        pricing: { prompt: '0.00000002' }
    }
];

function parseOptionValue(args: string[], name: string): string | undefined {
    const prefix = `${name}=`;
    const inline = args.find(arg => arg.startsWith(prefix));
    if (inline) return inline.slice(prefix.length);

    const index = args.indexOf(name);
    if (index >= 0) return args[index + 1];

    return undefined;
}

function hasFlag(args: string[], name: string): boolean {
    return args.includes(name);
}

function hasAnyFlag(args: string[], names: string[]): boolean {
    return names.some(name => hasFlag(args, name));
}

function normalizeHostedUrl(rawUrl: string): string {
    const value = rawUrl.trim().replace(/\/$/, '');
    if (!value) throw new Error('Hosted URL is required.');
    if (!/^https?:\/\//i.test(value)) return `https://${value}`;
    return value;
}

function getMcpUrl(hostedUrl: string): string {
    return `${normalizeHostedUrl(hostedUrl)}/mcp`;
}

function ensureParentDir(filePath: string) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function readJsonConfig(filePath: string): any {
    if (!fs.existsSync(filePath)) return {};

    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    } catch {
        const backupPath = `${filePath}.invalid-${Date.now()}.bak`;
        fs.copyFileSync(filePath, backupPath);
        console.warn(`Existing JSON config could not be parsed. Backed it up to ${backupPath}`);
        return {};
    }
}

function writeJsonConfig(filePath: string, data: any) {
    ensureParentDir(filePath);
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf-8');
}

function upsertMapEntry(filePath: string, mapKey: 'mcpServers' | 'servers', entry: any) {
    const config = readJsonConfig(filePath);
    if (!config[mapKey] || typeof config[mapKey] !== 'object' || Array.isArray(config[mapKey])) {
        config[mapKey] = {};
    }

    config[mapKey][SERVER_NAME] = entry;
    writeJsonConfig(filePath, config);
}

function upsertGeminiEntry(filePath: string, mode: SetupMode, entry: any) {
    const config = readJsonConfig(filePath);
    if (!config.mcpServers || typeof config.mcpServers !== 'object' || Array.isArray(config.mcpServers)) {
        config.mcpServers = {};
    }

    if (mode === 'hosted' && entry.url) {
        config.mcpServers[SERVER_NAME] = {
            httpUrl: entry.url,
            headers: entry.headers || undefined
        };
    } else {
        config.mcpServers[SERVER_NAME] = entry;
    }

    writeJsonConfig(filePath, config);
}

function upsertOpenCodeEntry(filePath: string, mode: SetupMode, entry: any) {
    const config = readJsonConfig(filePath);
    if (!config.mcp || typeof config.mcp !== 'object' || Array.isArray(config.mcp)) {
        config.mcp = {};
    }

    if (mode === 'hosted' && entry.url) {
        config.mcp[SERVER_NAME] = {
            type: 'remote',
            url: entry.url,
            oauth: false,
            headers: entry.headers || undefined
        };
    } else {
        config.mcp[SERVER_NAME] = {
            type: 'local',
            command: [entry.command, ...entry.args],
            environment: entry.env || {}
        };
    }

    writeJsonConfig(filePath, config);
}

function tomlString(value: string): string {
    return JSON.stringify(value);
}

function tomlArray(values: string[]): string {
    return `[${values.map(tomlString).join(', ')}]`;
}

function removeCodexOpenMindBlock(content: string): string {
    const lines = content.split(/\r?\n/);
    const result: string[] = [];
    let skipping = false;

    for (const line of lines) {
        if (/^\[mcp_servers\.openmind\]/.test(line) || /^\[mcp_servers\.openmind\.env\]/.test(line)) {
            skipping = true;
            continue;
        }

        if (skipping && /^\[/.test(line)) {
            skipping = false;
        }

        if (!skipping) {
            result.push(line);
        }
    }

    return result.join('\n').trimEnd();
}

function upsertCodexEntry(filePath: string, entry: any) {
    ensureParentDir(filePath);
    const existing = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf-8') : '';
    const preserved = removeCodexOpenMindBlock(existing);
    const block: string[] = [
        '[mcp_servers.openmind]',
        `command = ${tomlString(entry.command)}`,
        `args = ${tomlArray(entry.args || [])}`
    ];

    if (entry.env && Object.keys(entry.env).length > 0) {
        block.push('', '[mcp_servers.openmind.env]');
        for (const [key, value] of Object.entries(entry.env)) {
            block.push(`${key} = ${tomlString(String(value))}`);
        }
    }

    const next = `${preserved}${preserved ? '\n\n' : ''}${block.join('\n')}\n`;
    fs.writeFileSync(filePath, next, 'utf-8');
}

function localStdioEntry(env: Record<string, string>) {
    return {
        command: 'npx',
        args: ['-y', PACKAGE_SPEC, 'mcp'],
        env
    };
}

function hostedBridgeEntry(hostedUrl: string, apiKey: string) {
    return {
        command: 'npx',
        args: [
            '-y',
            'mcp-remote',
            getMcpUrl(hostedUrl),
            '--header',
            `Authorization: Bearer ${apiKey}`
        ]
    };
}

function hostedHttpEntry(hostedUrl: string, apiKey: string) {
    return {
        url: getMcpUrl(hostedUrl),
        headers: {
            Authorization: `Bearer ${apiKey}`
        }
    };
}

function vsCodeEntry(mode: SetupMode, hostedUrl: string | undefined, apiKey: string | undefined, localEnv: Record<string, string>) {
    if (mode === 'hosted') {
        return {
            type: 'http',
            url: getMcpUrl(hostedUrl || DEFAULT_HOSTED_URL),
            headers: {
                Authorization: `Bearer ${apiKey}`
            }
        };
    }

    return {
        type: 'stdio',
        command: 'npx',
        args: ['-y', PACKAGE_SPEC, 'mcp'],
        env: localEnv
    };
}

function entryForClient(client: ClientProfile, mode: SetupMode, hostedUrl: string | undefined, apiKey: string | undefined, localEnv: Record<string, string>) {
    if (mode === 'local') {
        if (client.kind === 'json-servers') return vsCodeEntry(mode, hostedUrl, apiKey, localEnv);
        return localStdioEntry(localEnv);
    }

    if (!hostedUrl || !apiKey) {
        throw new Error('Hosted URL and API key are required for hosted MCP configuration.');
    }

    if (client.kind === 'gemini' || client.kind === 'opencode') {
        return hostedHttpEntry(hostedUrl, apiKey);
    }

    if (client.kind === 'json-servers') {
        return vsCodeEntry(mode, hostedUrl, apiKey, localEnv);
    }

    return hostedBridgeEntry(hostedUrl, apiKey);
}

function writeClientConfig(client: ClientProfile, mode: SetupMode, entry: any): string {
    const filePath = client.getPath();

    if (client.kind === 'json-mcp-servers') {
        upsertMapEntry(filePath, 'mcpServers', entry);
    } else if (client.kind === 'json-servers') {
        upsertMapEntry(filePath, 'servers', entry);
    } else if (client.kind === 'gemini') {
        upsertGeminiEntry(filePath, mode, entry);
    } else if (client.kind === 'opencode') {
        upsertOpenCodeEntry(filePath, mode, entry);
    } else if (client.kind === 'codex-toml') {
        upsertCodexEntry(filePath, entry);
    }

    return filePath;
}

const OPENMIND_INSTRUCTION_START = '<!-- OPENMIND_MEMORY_START -->';
const OPENMIND_INSTRUCTION_END = '<!-- OPENMIND_MEMORY_END -->';

interface InstructionTarget {
    id: string;
    label: string;
    filePath: string;
    preamble?: string;
}

const OPENMIND_MEMORY_INSTRUCTIONS = `## OpenMind Memory

OpenMind MCP is configured for this project. Use it as long-term memory when it is available.

When to search:
- At the start of a task that may depend on prior context, decisions, preferences, bugs, deployments, or architecture.
- Before answering "what did we decide", "what changed", "how was this set up", or similar continuity questions.
- Before assuming there is no prior context.

When to capture:
- Save durable user preferences, project decisions, architecture choices, deployment details, working commands, resolved bugs, and important follow-up tasks.
- After finishing a meaningful change, save a short memory with what changed, where, and how it was verified.
- Keep memories concise and self-contained. Include useful tags such as project name, repo, feature, deployment, bugfix, decision, or preference.

Do not capture:
- Secrets, API keys, passwords, auth tokens, recovery codes, private keys, or credentials.
- Large raw logs, generated build output, temporary errors, or conversational filler.
- Information the user explicitly says not to save.

Tool names may appear as direct OpenMind tools (semantic_search, capture_thought, list_recent, get_stats) or namespaced MCP tools such as mcp__openmind__semantic_search and mcp__openmind__capture_thought.`;

function buildInstructionBlock(): string {
    return `${OPENMIND_INSTRUCTION_START}\n${OPENMIND_MEMORY_INSTRUCTIONS}\n${OPENMIND_INSTRUCTION_END}`;
}

function upsertInstructionFile(target: InstructionTarget): string {
    const block = buildInstructionBlock();
    ensureParentDir(target.filePath);

    if (!fs.existsSync(target.filePath)) {
        const content = `${target.preamble || ''}${target.preamble ? '\n\n' : ''}${block}\n`;
        fs.writeFileSync(target.filePath, content, 'utf-8');
        return target.filePath;
    }

    const current = fs.readFileSync(target.filePath, 'utf-8');
    const pattern = new RegExp(`${OPENMIND_INSTRUCTION_START}[\\s\\S]*?${OPENMIND_INSTRUCTION_END}`);
    const next = pattern.test(current)
        ? current.replace(pattern, block)
        : `${current.trimEnd()}\n\n${block}\n`;

    fs.writeFileSync(target.filePath, next, 'utf-8');
    return target.filePath;
}

function getInstructionTargets(clients: ClientProfile[]): InstructionTarget[] {
    const ids = new Set(clients.map(client => client.id));
    const targets = new Map<string, InstructionTarget>();

    function add(target: InstructionTarget) {
        targets.set(target.filePath, target);
    }

    if (ids.has('codex-cli') || ids.has('opencode')) {
        add({
            id: 'agents',
            label: 'Codex/OpenCode project instructions',
            filePath: path.join(process.cwd(), 'AGENTS.md')
        });
    }

    if (ids.has('claude-code')) {
        add({
            id: 'claude',
            label: 'Claude Code project instructions',
            filePath: path.join(process.cwd(), 'CLAUDE.md')
        });
    }

    if (ids.has('gemini-cli')) {
        add({
            id: 'gemini',
            label: 'Gemini CLI project instructions',
            filePath: path.join(process.cwd(), 'GEMINI.md')
        });
    }

    if (ids.has('cursor')) {
        add({
            id: 'cursor',
            label: 'Cursor project rule',
            filePath: path.join(process.cwd(), '.cursor', 'rules', 'openmind-memory.mdc'),
            preamble: '---\ndescription: Use OpenMind as persistent project memory\nalwaysApply: true\n---'
        });
    }

    if (ids.has('windsurf')) {
        add({
            id: 'windsurf',
            label: 'Windsurf project rule',
            filePath: path.join(process.cwd(), '.windsurf', 'rules', 'openmind-memory.md')
        });
    }

    if (ids.has('vscode')) {
        add({
            id: 'vscode',
            label: 'VS Code / GitHub Copilot instructions',
            filePath: path.join(process.cwd(), '.github', 'copilot-instructions.md')
        });
    }

    return Array.from(targets.values());
}

async function shouldWriteInstructions(args: string[], targets: InstructionTarget[]): Promise<boolean> {
    if (targets.length === 0) return false;
    if (hasAnyFlag(args, ['--no-instructions', '--no-agent-instructions'])) return false;
    if (hasAnyFlag(args, ['--instructions', '--agent-instructions', '--yes', '-y'])) return true;

    const answer = (await question('\nWrite OpenMind memory instructions into this project? [Y/n]: ')).trim().toLowerCase();
    return answer === '' || answer === 'y' || answer === 'yes';
}

async function maybeWriteInstructionFiles(args: string[], clients: ClientProfile[]) {
    const targets = getInstructionTargets(clients);
    if (!await shouldWriteInstructions(args, targets)) return;

    const written = targets.map(target => ({
        label: target.label,
        path: upsertInstructionFile(target)
    }));

    console.log('\nUpdated agent instruction files:');
    for (const item of written) {
        console.log(`  - ${item.label}: ${item.path}`);
    }
}

function parseClients(value: string): ClientProfile[] {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'all') return CLIENTS;

    const aliases: Record<string, ClientId> = {
        claude: 'claude-desktop',
        'claude-desktop': 'claude-desktop',
        claude_desktop: 'claude-desktop',
        'claude-code': 'claude-code',
        claude_code: 'claude-code',
        cursor: 'cursor',
        windsurf: 'windsurf',
        gemini: 'gemini-cli',
        'gemini-cli': 'gemini-cli',
        gemini_cli: 'gemini-cli',
        codex: 'codex-cli',
        'codex-cli': 'codex-cli',
        codex_cli: 'codex-cli',
        opencode: 'opencode',
        vscode: 'vscode',
        'vs-code': 'vscode'
    };

    const selected = normalized
        .split(',')
        .map(value => value.trim())
        .filter(Boolean)
        .map(value => aliases[value] || value as ClientId);

    const clients = CLIENTS.filter(client => selected.includes(client.id));
    if (clients.length === 0) {
        throw new Error(`No supported MCP clients matched "${value}". Use --client all or one of: ${CLIENTS.map(c => c.id).join(', ')}`);
    }

    return clients;
}

async function chooseClients(args: string[]): Promise<ClientProfile[]> {
    const clientArg = parseOptionValue(args, '--client') || parseOptionValue(args, '--clients');
    if (clientArg) return parseClients(clientArg);

    console.log('\nChoose MCP client config to write:');
    console.log('  0) All supported clients');
    CLIENTS.forEach((client, index) => {
        console.log(`  ${index + 1}) ${client.label}`);
    });

    const answer = (await question('Client [1]: ')).trim();
    if (!answer) return [CLIENTS[0]];
    if (answer === '0' || answer.toLowerCase() === 'all') return CLIENTS;

    const index = Number.parseInt(answer, 10);
    if (Number.isInteger(index) && index >= 1 && index <= CLIENTS.length) {
        return [CLIENTS[index - 1]];
    }

    return parseClients(answer);
}

function commandExists(command: string): boolean {
    const result = spawnSync(command, ['--version'], { stdio: 'ignore' });
    return result.status === 0;
}

function runInteractive(command: string, args: string[]) {
    const result = spawnSync(command, args, { stdio: 'inherit' });
    if (result.error) throw result.error;
    if (result.status !== 0) {
        throw new Error(`${command} ${args.join(' ')} failed with exit code ${result.status}`);
    }
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function canReach(url: string, timeoutMs = 1500): Promise<boolean> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetch(url, { signal: controller.signal });
        return response.ok;
    } catch {
        return false;
    } finally {
        clearTimeout(timer);
    }
}

async function ensureOllamaRunning(baseUrl: string) {
    const versionUrl = `${baseUrl.replace(/\/$/, '')}/api/version`;
    if (await canReach(versionUrl)) return;

    console.log('Starting Ollama server...');
    const child = spawn('ollama', ['serve'], {
        detached: true,
        stdio: 'ignore'
    });
    child.unref();

    for (let attempt = 0; attempt < 20; attempt += 1) {
        await sleep(500);
        if (await canReach(versionUrl)) return;
    }

    throw new Error('Ollama did not become reachable at http://127.0.0.1:11434. Start Ollama and rerun this command.');
}

async function testOllamaEmbedding(baseUrl: string, model: string) {
    const response = await fetch(`${baseUrl.replace(/\/$/, '')}/api/embed`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model, input: 'OpenMind setup test' })
    });

    if (!response.ok) {
        const body = await response.text();
        throw new Error(`Ollama test embedding failed (${response.status}): ${body}`);
    }
}

async function configureOllamaEmbedding(args: string[]): Promise<LocalEmbeddingSetup> {
    if (!commandExists('ollama')) {
        throw new Error('Ollama is required for local embeddings. Install it from https://ollama.com/download, then rerun this command.');
    }

    const modelArg = parseOptionValue(args, '--ollama-model');
    let selectedModel = LOCAL_OLLAMA_MODELS[0];

    if (modelArg) {
        selectedModel = LOCAL_OLLAMA_MODELS.find(model => model.id === modelArg) || {
            id: modelArg,
            label: modelArg,
            dimensions: 1536,
            note: 'custom Ollama embedding model'
        };
    } else {
        console.log('\nChoose local embedding model:');
        LOCAL_OLLAMA_MODELS.forEach((model, index) => {
            console.log(`  ${index + 1}) ${model.label} (${model.dimensions} dims) - ${model.note}`);
        });
        const answer = (await question('Local model [1]: ')).trim();
        const index = answer ? Number.parseInt(answer, 10) : 1;
        if (Number.isInteger(index) && index >= 1 && index <= LOCAL_OLLAMA_MODELS.length) {
            selectedModel = LOCAL_OLLAMA_MODELS[index - 1];
        } else if (answer) {
            selectedModel = {
                id: answer,
                label: answer,
                dimensions: 1536,
                note: 'custom Ollama embedding model'
            };
        }
    }

    const baseUrl = (parseOptionValue(args, '--ollama-url') || process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434').replace(/\/$/, '');

    await ensureOllamaRunning(baseUrl);
    console.log(`Downloading local embedding model with Ollama: ${selectedModel.id}`);
    runInteractive('ollama', ['pull', selectedModel.id]);
    await testOllamaEmbedding(baseUrl, selectedModel.id);

    return {
        provider: 'ollama',
        env: {
            EMBEDDING_PROVIDER: 'ollama',
            OLLAMA_BASE_URL: baseUrl,
            OLLAMA_EMBEDDING_MODEL: selectedModel.id,
            EMBEDDING_DIMENSIONS: '1536'
        }
    };
}

function embeddingModelMatches(model: OpenRouterModel): boolean {
    const joined = [
        model.id,
        model.name || '',
        model.description || '',
        model.architecture?.modality || '',
        ...(model.architecture?.input_modalities || []),
        ...(model.architecture?.output_modalities || [])
    ].join(' ').toLowerCase();

    return joined.includes('embedding') || joined.includes('embed');
}

async function fetchOpenRouterEmbeddingModels(apiKey: string): Promise<OpenRouterModel[]> {
    try {
        const response = await fetch('https://openrouter.ai/api/v1/models', {
            headers: {
                authorization: `Bearer ${apiKey}`
            }
        });

        if (!response.ok) {
            throw new Error(`OpenRouter models request failed (${response.status})`);
        }

        const payload = await response.json() as { data?: OpenRouterModel[] };
        const models = (payload.data || []).filter(embeddingModelMatches);
        return models.length > 0 ? models : FALLBACK_OPENROUTER_EMBEDDING_MODELS;
    } catch (error) {
        console.warn(`Could not fetch OpenRouter model catalog: ${error instanceof Error ? error.message : String(error)}`);
        return FALLBACK_OPENROUTER_EMBEDDING_MODELS;
    }
}

function pricePerMillion(model: OpenRouterModel): string {
    const raw = model.pricing?.prompt || model.pricing?.input;
    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0) return 'pricing unavailable';
    return `$${(value * 1_000_000).toFixed(4).replace(/\.?0+$/, '')}/1M input tokens`;
}

async function configureOpenRouterEmbedding(args: string[]): Promise<LocalEmbeddingSetup> {
    const apiKey = process.env.OPENROUTER_API_KEY || parseOptionValue(args, '--openrouter-key') || await questionHidden('OpenRouter API key: ');
    if (!apiKey.trim()) {
        throw new Error('OPENROUTER_API_KEY is required for OpenRouter embeddings.');
    }

    const configuredModel = parseOptionValue(args, '--openrouter-model') || process.env.OPENROUTER_EMBEDDING_MODEL;
    const models = await fetchOpenRouterEmbeddingModels(apiKey.trim());
    let selectedModel = configuredModel || models[0]?.id || 'openai/text-embedding-3-large';

    if (!configuredModel) {
        console.log('\nChoose OpenRouter embedding model:');
        models.forEach((model, index) => {
            const name = model.name && model.name !== model.id ? ` - ${model.name}` : '';
            console.log(`  ${index + 1}) ${model.id}${name} (${pricePerMillion(model)})`);
        });

        const answer = (await question('OpenRouter embedding model [1]: ')).trim();
        const index = answer ? Number.parseInt(answer, 10) : 1;
        if (Number.isInteger(index) && index >= 1 && index <= models.length) {
            selectedModel = models[index - 1].id;
        } else if (answer) {
            selectedModel = answer;
        }
    }

    return {
        provider: 'openrouter',
        env: {
            EMBEDDING_PROVIDER: 'openrouter',
            OPENROUTER_API_KEY: apiKey.trim(),
            OPENROUTER_EMBEDDING_MODEL: selectedModel,
            EMBEDDING_DIMENSIONS: '1536'
        }
    };
}

async function configureLocalEmbedding(args: string[]): Promise<LocalEmbeddingSetup> {
    const providerArg = (parseOptionValue(args, '--embedding') || parseOptionValue(args, '--embedding-provider') || '').toLowerCase();
    if (providerArg === 'ollama' || providerArg === 'local') {
        return configureOllamaEmbedding(args);
    }

    if (providerArg === 'openrouter') {
        return configureOpenRouterEmbedding(args);
    }

    console.log('\nChoose local embedding runtime:');
    console.log('  1) Local model through Ollama (private, runs on this machine)');
    console.log('  2) OpenRouter embeddings (hosted API, choose model/pricing)');

    const answer = (await question('Embedding runtime [1]: ')).trim().toLowerCase();
    if (answer === '2' || answer === 'openrouter') {
        return configureOpenRouterEmbedding(args);
    }

    return configureOllamaEmbedding(args);
}

async function loginAndCreateApiKey(hostedUrl: string): Promise<string> {
    const username = await question('OpenMind username: ');
    const password = await questionHidden('OpenMind password: ');

    const loginResponse = await fetch(`${hostedUrl}/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username, password })
    });

    if (!loginResponse.ok) {
        const body = await loginResponse.text();
        throw new Error(`Login failed (${loginResponse.status}): ${body}`);
    }

    const setCookie = loginResponse.headers.get('set-cookie') || '';
    const sessionCookie = setCookie.match(/session=[^;]+/)?.[0];
    if (!sessionCookie) {
        throw new Error('Login succeeded but no session cookie was returned.');
    }

    const keyResponse = await fetch(`${hostedUrl}/api/keys`, {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            cookie: sessionCookie
        },
        body: JSON.stringify({ name: `OpenMind CLI ${new Date().toISOString().slice(0, 10)}` })
    });

    if (!keyResponse.ok) {
        const body = await keyResponse.text();
        throw new Error(`API key creation failed (${keyResponse.status}): ${body}`);
    }

    const payload = await keyResponse.json() as { key?: string };
    if (!payload.key || !payload.key.startsWith('om_')) {
        throw new Error('API key response was missing the generated key.');
    }

    return payload.key;
}

function printWrittenConfigs(written: Array<{ client: ClientProfile; path: string }>) {
    console.log('\nUpdated MCP configs:');
    for (const item of written) {
        console.log(`  - ${item.client.label}: ${item.path}`);
    }
}

async function configureLocal(args: string[]) {
    console.log('--- OpenMind Local Setup ---');
    const embedding = await configureLocalEmbedding(args);
    const databaseUrl = parseOptionValue(args, '--database-url') || process.env.DATABASE_URL || DEFAULT_DATABASE_URL;
    const clients = await chooseClients(args);
    const env = {
        ...embedding.env,
        DATABASE_URL: databaseUrl
    };

    const written = clients.map(client => {
        const entry = entryForClient(client, 'local', undefined, undefined, env);
        const filePath = writeClientConfig(client, 'local', entry);
        return { client, path: filePath };
    });

    printWrittenConfigs(written);
    await maybeWriteInstructionFiles(args, clients);
    console.log('\nLocal setup complete. Keep Postgres running, then restart the configured AI app.');
}

async function configureHosted(rawUrl: string | undefined, args: string[]) {
    console.log('--- OpenMind Hosted Setup ---');
    const hostedUrl = normalizeHostedUrl(rawUrl || parseOptionValue(args, '--hosted') || await question(`Hosted OpenMind URL [${DEFAULT_HOSTED_URL}]: `) || DEFAULT_HOSTED_URL);
    const clients = await chooseClients(args);
    const enteredKey = parseOptionValue(args, '--api-key') || await question('OpenMind API key (press Enter to log in with username/password): ');
    const apiKey = enteredKey.trim() || await loginAndCreateApiKey(hostedUrl);

    if (!apiKey.startsWith('om_')) {
        throw new Error('OpenMind API keys must start with "om_".');
    }

    const written = clients.map(client => {
        const entry = entryForClient(client, 'hosted', hostedUrl, apiKey, {});
        const filePath = writeClientConfig(client, 'hosted', entry);
        return { client, path: filePath };
    });

    printWrittenConfigs(written);
    await maybeWriteInstructionFiles(args, clients);
    console.log('\nHosted setup complete. Restart the configured AI app to use your hosted OpenMind account.');
}

async function handleInit(args: string[]) {
    const hostedUrl = parseOptionValue(args, '--hosted');

    if (hasFlag(args, '--local')) {
        await configureLocal(args);
        return;
    }

    if (hostedUrl !== undefined) {
        await configureHosted(hostedUrl, args);
        return;
    }

    console.log('Choose OpenMind setup:');
    console.log('  1) Local self-hosted memory on this machine');
    console.log('  2) Hosted OpenMind account/subscription');

    const choice = (await question('Setup type [1]: ')).trim().toLowerCase();
    if (choice === '2' || choice === 'hosted') {
        await configureHosted(undefined, args);
        return;
    }

    await configureLocal(args);
}

async function handleMcp() {
    const { runStdio } = await import('../mcp/server');
    await runStdio();
}

function printHelp() {
    console.log('OpenMind CLI');
    console.log(`  npx ${PACKAGE_SPEC} init                            Interactive local/hosted setup`);
    console.log(`  npx ${PACKAGE_SPEC} init --local                    Configure local self-hosted MCP`);
    console.log(`  npx ${PACKAGE_SPEC} init --local --client all       Configure all supported local clients`);
    console.log(`  npx ${PACKAGE_SPEC} init --local --embedding local  Use Ollama local embeddings`);
    console.log(`  npx ${PACKAGE_SPEC} init --local --embedding openrouter`);
    console.log(`  npx ${PACKAGE_SPEC} connect https://theopenmind.pro Configure hosted account MCP`);
    console.log(`  npx ${PACKAGE_SPEC} connect <url> --client cursor   Configure one hosted client`);
    console.log(`  npx ${PACKAGE_SPEC} connect <url> --client all --no-instructions`);
    console.log(`  npx ${PACKAGE_SPEC} login <url>                     Log in and configure hosted MCP`);
    console.log(`  npx ${PACKAGE_SPEC} mcp                             Run the local stdio MCP server`);
    console.log('');
    console.log(`Supported clients: all, ${CLIENTS.map(client => client.id).join(', ')}`);
    console.log(`Detected OS: ${OS} (${os.platform()} ${os.release()})`);
}

async function main() {
    const args = process.argv.slice(2);
    const command = args[0];
    const rest = args.slice(1);

    try {
        if (command === 'mcp' || command === 'stdio') {
            await handleMcp();
        } else if (command === 'init' || command === 'install') {
            await handleInit(rest);
        } else if (command === 'connect' || command === 'login') {
            await configureHosted(rest[0], rest.slice(1));
        } else {
            printHelp();
        }
    } finally {
        closePrompt();
    }
}

if (require.main === module) {
    main().catch(error => {
        console.error(error instanceof Error ? error.message : error);
        process.exit(1);
    });
}
