import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function runCli(args: string[], input = ''): Promise<{ stdout: string; stderr: string; code: number | null }> {
    const cliPath = path.join(process.cwd(), 'dist', 'src', 'cli', 'cli.js');
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'openmind-cli-test-'));

    return new Promise((resolve) => {
        const child = execFile(
            process.execPath,
            [cliPath, ...args],
            {
                cwd: process.cwd(),
                env: {
                    ...process.env,
                    HOME: home,
                    USERPROFILE: home,
                },
            },
            (error, stdout, stderr) => {
                resolve({
                    stdout,
                    stderr,
                    code: typeof (error as any)?.code === 'number' ? (error as any).code : 0,
                });
            },
        );

        if (input) child.stdin?.end(input);
    });
}

test('CLI --all-clients dry-run prints all provider profiles without writing', async () => {
    const result = await runCli([
        'connect',
        'https://theopenmind.pro',
        '--all-clients',
        '--dry-run',
        '--no-instructions',
        '--api-key',
        'om_test',
    ]);

    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /Dry run only\. No files were written/);
    assert.match(result.stdout, /\[ChatGPT custom connector\]/);
    assert.match(result.stdout, /\[Claude Code \(current project\)\]/);
    assert.match(result.stdout, /\[Generic MCP client\]/);
    assert.match(result.stdout, /OAuth dynamic registration: https:\/\/theopenmind\.pro\/oauth\/register/);
});

test('CLI --client all remains backward compatible', async () => {
    const result = await runCli([
        'connect',
        'https://theopenmind.pro',
        '--client',
        'all',
        '--dry-run',
        '--no-instructions',
        '--api-key',
        'om_test',
    ]);

    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /\[ChatGPT custom connector\]/);
    assert.match(result.stdout, /\[Windsurf\]/);
    assert.match(result.stdout, /\[VS Code \/ GitHub Copilot \(current project\)\]/);
});

test('CLI resolves comma-separated provider aliases', async () => {
    const result = await runCli([
        'connect',
        'https://theopenmind.pro',
        '--client',
        'chatgpt,claude-code,cursor',
        '--dry-run',
        '--no-instructions',
        '--api-key',
        'om_test',
    ]);

    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /\[ChatGPT custom connector\]/);
    assert.match(result.stdout, /\[Claude Code \(current project\)\]/);
    assert.match(result.stdout, /\[Cursor\]/);
    assert.doesNotMatch(result.stdout, /\[Windsurf\]/);
});

test('CLI non-TTY fallback accepts comma-separated client names', async () => {
    const result = await runCli([
        'connect',
        'https://theopenmind.pro',
        '--dry-run',
        '--no-instructions',
        '--api-key',
        'om_test',
    ], 'chatgpt,cursor\n');

    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /Clients \(comma-separated ids or all\) \[all\]/);
    assert.match(result.stdout, /\[ChatGPT custom connector\]/);
    assert.match(result.stdout, /\[Cursor\]/);
    assert.doesNotMatch(result.stdout, /\[Windsurf\]/);
});

test('CLI local dry-run does not require starting Ollama or writing config files', async () => {
    const result = await runCli([
        'init',
        '--local',
        '--all-clients',
        '--dry-run',
        '--no-instructions',
        '--embedding',
        'local',
    ]);

    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /Dry run only\. No files were written/);
    assert.match(result.stdout, /OLLAMA_EMBEDDING_MODEL/);
    assert.match(result.stdout, /npx/);
    assert.doesNotMatch(result.stdout, /Starting Ollama server/);
});
