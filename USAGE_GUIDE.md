# OpenMind Memory Migration Guide

Welcome to your personal AI memory system! This guide explains how to migrate your past conversations from various AI tools (Gemini, Claude Code, Antigravity) into OpenMind so your agents can remember them.

## 1. Migrating Claude Code / OpenClaw

Your Claude Code sessions are stored in `.jsonl` files (often deep in your system folders).
We have provided a script that reads a directory full of these files, extracts the actual chat content, intelligently chunks it, and imports it directly into your OpenMind database.

**To Import:**
```bash
npx tsx scripts/migrate-claude.ts <path-to-your-jsonl-folder>
```
*Example:* `npx tsx scripts/migrate-claude.ts claude-chats`

---

## 2. Migrating Antigravity Sessions (Mac)

Antigravity stores your conversation logs in `~/.gemini/antigravity/brain/`.
Our script automatically scans this live directory, filters out the binary noise (`.pb` files), extracts the human-readable text logs, and imports your conversations properly.

**To Import:**
*(Run this from the root of your OpenMind project)*
```bash
npx tsx scripts/migrate-antigravity.ts
```

---

## 3. Migrating Gemini / ChatGPT Text Exports

If you have raw text exports or `.txt` files containing conversations (like `gemini-chats.txt`), you can upload them using the standard memory migration script. This script automatically splits large text files into manageable pieces.

**To Import:**
```bash
npx tsx scripts/migrate-memories.ts --text <path-to-your-txt-file>
```
*Example:* `npx tsx scripts/migrate-memories.ts --text gemini-chats.txt`

---

## What Happens When You Import?

When any of these scripts run, they connect to your OpenMind pipeline, which does the following:
1. **Deduplication:** Checks if the exact chunk has been imported before.
2. **Analysis:** Asks OpenRouter to define the topic, extract people mentioned, and determine action items.
3. **Embedding:** Generates a vector through your configured provider: local Ollama or OpenRouter.
4. **Storage:** Saves everything atomically in your local Postgres database.

## How To Use The MCP Server

OpenMind supports two MCP connection patterns:

1. Local stdio server (`src/mcp/server.ts`)
2. Remote HTTP MCP server (`/mcp`) exposed by the API service

### Local stdio setup (desktop/local workflows)

For local clients that run a command-based MCP server process, the simplest path is the installer:

```bash
npx @vindepemarte/openmind init --local --client all
```

For manual setup, point the client at the npm stdio server.

```json
{
  "mcpServers": {
    "openmind": {
      "command": "npx",
      "args": ["-y", "@vindepemarte/openmind", "mcp"],
      "env": {
        "EMBEDDING_PROVIDER": "ollama",
        "OLLAMA_BASE_URL": "http://127.0.0.1:11434",
        "OLLAMA_EMBEDDING_MODEL": "nomic-embed-text",
        "DATABASE_URL": "postgresql://openmind:openmind@localhost:5432/openmind"
      },
    }
  }
}
```

### Remote MCP setup (hosted OpenMind)

If OpenMind is hosted remotely (for example on Coolify or any VPS), use:

- Preferred transport: `https://YOUR_DOMAIN.com/mcp`
- Legacy transport: `https://YOUR_DOMAIN.com/mcp/sse` with messages to `https://YOUR_DOMAIN.com/mcp/messages?sessionId=...`

Remote auth supports:

- API keys (`Authorization: Bearer om_...`)
- OAuth 2.0 (recommended for interactive clients)
- Basic auth (`Authorization: Basic ...`) for compatibility

Use `/mcp` for modern clients. Use `/mcp/sse` only for older SSE-only clients.

One-command hosted setup:

```bash
npx @vindepemarte/openmind connect https://YOUR_DOMAIN.com --client all
```

The installer can also write project instruction files that tell CLI agents to search OpenMind before relying on stale context and to capture durable decisions after useful work. Use `--no-instructions` if you only want MCP config files.

## Provider-By-Provider MCP Docs

For full provider-specific setup steps, snippets, auth differences, limits, and troubleshooting, see:

- `docs/product/mcp-provider-connection-guide.md`

### Example Claude Desktop Remote Bridge

```json
{
  "mcpServers": {
    "openmind-remote": {
      "command": "npx",
      "args": [
        "-y",
        "mcp-remote",
        "https://YOUR_DOMAIN.com/mcp",
        "--header",
        "Authorization: Bearer om_REDACTED"
      ]
    }
  }
}
```

Replace `YOUR_DOMAIN.com` with your deployment domain and `om_REDACTED` with a valid OpenMind API key.
