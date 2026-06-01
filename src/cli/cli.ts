#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import readline from 'readline';

const OS = process.platform;
const HOME = process.env.HOME || process.env.USERPROFILE || '';
const PACKAGE_SPEC = '@vindepemarte/openmind';

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

function getClaudeConfigPath(): string {
    if (OS === 'darwin') {
        return path.join(HOME, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
    }

    if (OS === 'win32') {
        return path.join(process.env.APPDATA || '', 'Claude', 'claude_desktop_config.json');
    }

    return path.join(HOME, '.config', 'Claude', 'claude_desktop_config.json');
}

function updateClaudeConfig(mcpEntry: any) {
    const configPath = getClaudeConfigPath();
    const configDir = path.dirname(configPath);

    if (!fs.existsSync(configDir)) {
        fs.mkdirSync(configDir, { recursive: true });
    }

    let config: any = {};
    if (fs.existsSync(configPath)) {
        try {
            config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
        } catch {
            console.warn('Existing Claude configuration could not be parsed. A fresh config will be written.');
        }
    }

    if (!config.mcpServers) {
        config.mcpServers = {};
    }

    config.mcpServers.openmind = mcpEntry;

    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
    console.log(`Updated Claude Desktop MCP config: ${configPath}`);
}

function normalizeHostedUrl(rawUrl: string): string {
    const value = rawUrl.trim().replace(/\/$/, '');
    if (!value) throw new Error('Hosted URL is required.');
    if (!/^https?:\/\//i.test(value)) return `https://${value}`;
    return value;
}

function parseOptionValue(args: string[], name: string): string | undefined {
    const prefix = `${name}=`;
    const inline = args.find(arg => arg.startsWith(prefix));
    if (inline) return inline.slice(prefix.length);

    const index = args.indexOf(name);
    if (index >= 0) return args[index + 1];

    return undefined;
}

async function configureLocal() {
    console.log('--- OpenMind Local Setup ---');
    console.log('Configuring Claude Desktop to run the local stdio MCP server.');

    const openrouterKey = process.env.OPENROUTER_API_KEY || await question('OPENROUTER_API_KEY: ');
    if (!openrouterKey.trim()) {
        throw new Error('OPENROUTER_API_KEY is required for local embeddings.');
    }

    updateClaudeConfig({
        command: 'npx',
        args: ['-y', PACKAGE_SPEC, 'mcp'],
        env: {
            OPENROUTER_API_KEY: openrouterKey.trim(),
            DATABASE_URL: process.env.DATABASE_URL || 'postgresql://openmind:openmind@localhost:5432/openmind'
        }
    });

    console.log('Local setup complete. Keep Postgres running and restart Claude Desktop.');
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

async function configureHosted(rawUrl?: string) {
    console.log('--- OpenMind Hosted Setup ---');
    const hostedUrl = normalizeHostedUrl(rawUrl || await question('Hosted OpenMind URL: '));
    const enteredKey = await question('OpenMind API key (press Enter to log in with username/password): ');
    const apiKey = enteredKey.trim() || await loginAndCreateApiKey(hostedUrl);

    if (!apiKey.startsWith('om_')) {
        throw new Error('OpenMind API keys must start with "om_".');
    }

    updateClaudeConfig({
        command: 'npx',
        args: [
            '-y',
            'mcp-remote',
            `${hostedUrl}/mcp`,
            '--header',
            `Authorization: Bearer ${apiKey}`
        ]
    });

    console.log('Hosted setup complete. Restart Claude Desktop to use your hosted OpenMind account.');
}

async function handleInit(args: string[]) {
    const hostedUrl = parseOptionValue(args, '--hosted');

    if (args.includes('--local')) {
        await configureLocal();
        return;
    }

    if (hostedUrl !== undefined) {
        await configureHosted(hostedUrl);
        return;
    }

    console.log('Choose OpenMind setup:');
    console.log('  1) Local self-hosted memory on this machine');
    console.log('  2) Hosted OpenMind account/subscription');

    const choice = (await question('Setup type [1]: ')).trim().toLowerCase();
    if (choice === '2' || choice === 'hosted') {
        await configureHosted();
        return;
    }

    await configureLocal();
}

async function handleMcp() {
    const { runStdio } = await import('../mcp/server');
    await runStdio();
}

function printHelp() {
    console.log('OpenMind CLI');
    console.log(`  npx ${PACKAGE_SPEC} init                 Interactive local/hosted setup`);
    console.log(`  npx ${PACKAGE_SPEC} init --local         Configure local self-hosted MCP`);
    console.log(`  npx ${PACKAGE_SPEC} init --hosted <url>  Configure hosted account MCP`);
    console.log(`  npx ${PACKAGE_SPEC} login <url>          Log in and configure hosted MCP`);
    console.log(`  npx ${PACKAGE_SPEC} connect <url>        Configure hosted MCP with an API key or login`);
    console.log(`  npx ${PACKAGE_SPEC} mcp                  Run the local stdio MCP server`);
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
            await configureHosted(rest[0]);
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
