<div align="center">
  <img src="public/assets/openmind-logo.svg" alt="OpenMind" width="104" height="104">

  # OpenMind

  Persistent semantic memory for the AI tools you use every day.

  [![Node.js 22+](https://img.shields.io/badge/Node.js-22%2B-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org/)
  [![MCP Compatible](https://img.shields.io/badge/MCP-Compatible-6366F1)](https://modelcontextprotocol.io)
  [![License: ISC](https://img.shields.io/badge/License-ISC-blue.svg)](https://opensource.org/licenses/ISC)
</div>

OpenMind is a local-first memory server for MCP clients. It stores useful context, decisions, notes, and action items in PostgreSQL with pgvector, then lets AI assistants retrieve that memory by meaning.

This public repo is the open-source local runtime. It does not include hosted billing, Stripe, pricing pages, or the private marketing website.

## What It Includes

| Capability | Status |
| --- | --- |
| Local MCP stdio server | Included |
| HTTP/SSE MCP server | Included |
| Semantic search with pgvector | Included |
| Thought capture and deduplication | Included |
| Web dashboard | Included |
| Local auth, API keys, OAuth metadata | Included |
| Docker Compose setup | Included |
| Hosted billing and Stripe | Not included |
| Marketing website and SEO pages | Not included |

## Quick Start

Prerequisites:

- Node.js 22+
- Docker and Docker Compose
- Either [Ollama](https://ollama.com/) for local embeddings or an OpenRouter API key for hosted embeddings

Run OpenMind locally:

```bash
git clone https://github.com/vindepemarte/openmind.git
cd openmind
cp .env.example .env
# Edit .env. Use EMBEDDING_PROVIDER=ollama for local embeddings,
# or set OPENROUTER_API_KEY for OpenRouter embeddings.
docker compose up -d
```

Open the dashboard:

```text
http://localhost:3333
```

Default login:

```text
admin / openmind
```

Change `WEBUI_USER`, `WEBUI_PASSWORD`, and `JWT_SECRET` in `.env` for any real use.

## Connect Your AI Clients

Install from npm and choose interactive setup:

```bash
npx @vindepemarte/openmind init
```

The installer detects macOS, Linux, and Windows paths and can write MCP config for:

- Claude Desktop
- Claude Code
- Cursor
- Windsurf
- Gemini CLI
- Codex CLI
- OpenCode
- VS Code / GitHub Copilot project config

It can also write project instruction files so CLI agents know to use OpenMind as memory:

- `AGENTS.md` for Codex/OpenCode-style agents
- `CLAUDE.md` for Claude Code
- `GEMINI.md` for Gemini CLI
- `.cursor/rules/openmind-memory.mdc`
- `.windsurf/rules/openmind-memory.md`
- `.github/copilot-instructions.md`

Local setup asks whether embeddings should run through local Ollama or OpenRouter:

```bash
npx @vindepemarte/openmind init --local --client all
npx @vindepemarte/openmind init --local --client all --no-instructions
npx @vindepemarte/openmind init --local --embedding local
npx @vindepemarte/openmind init --local --embedding openrouter
```

Local Ollama mode starts Ollama, pulls the selected embedding model, tests it, then writes the correct MCP environment.

You can also run the stdio MCP server directly:

```bash
npx @vindepemarte/openmind mcp
```

## Hosted Account Setup

If you have a hosted OpenMind account, the same CLI can connect Claude Desktop to your subscription-backed instance:

```bash
npx @vindepemarte/openmind connect https://YOUR_OPENMIND_DOMAIN
npx @vindepemarte/openmind connect https://YOUR_OPENMIND_DOMAIN --client all
npx @vindepemarte/openmind connect https://YOUR_OPENMIND_DOMAIN --client all --no-instructions
```

The CLI accepts an existing `om_...` API key, or you can log in with your OpenMind username and password so it can create an API key. Hosted mode does not ask for an embedding model because embeddings run on the hosted server.

## Configuration

Copy `.env.example` to `.env`:

Use the same embedding provider and model for both capture and search. If you change providers later, rebuild or reimport existing memories so similarity scores stay meaningful.

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `EMBEDDING_PROVIDER` | No | `openrouter` | `openrouter` or `ollama` |
| `EMBEDDING_DIMENSIONS` | No | `1536` | Vector size stored in pgvector |
| `OPENROUTER_API_KEY` | For OpenRouter | none | Embeddings and metadata extraction |
| `OPENROUTER_EMBEDDING_MODEL` | No | `openai/text-embedding-3-large` | OpenRouter embedding model |
| `OPENROUTER_MODEL` | No | `openai/gpt-4o-mini` | Metadata extraction model |
| `OLLAMA_BASE_URL` | For Ollama | Docker: `http://host.docker.internal:11434`; native: `http://127.0.0.1:11434` | Local Ollama API URL |
| `OLLAMA_EMBEDDING_MODEL` | For Ollama | `nomic-embed-text` | Local embedding model |
| `DATABASE_URL` | No | local Docker Postgres | PostgreSQL/pgvector connection |
| `API_PORT` | No | `3333` | Dashboard and HTTP MCP port |
| `WEBUI_USER` | No | `admin` | Initial admin username |
| `WEBUI_PASSWORD` | No | `openmind` | Initial admin password |
| `JWT_SECRET` | Recommended | generated at boot | Stable dashboard sessions |

## Useful Commands

```bash
npm install
npm run build
npm test
npm run mcp
npm start
```

## Project Structure

```text
src/
  api/          Express API, dashboard routes, HTTP MCP transport
  auth/         Sessions, API keys, OAuth, password handling
  cli/          Local and hosted MCP installer
  db/           PostgreSQL client
  embeddings/   OpenRouter and Ollama embedding generation
  import/       Memory import parsing
  mcp/          MCP tool server
  processing/   Metadata, chunking, deduplication, capture pipeline
public/         Dashboard, login, OAuth approval UI, logo asset
init-db/        PostgreSQL bootstrap SQL
tests/          Node test suite
```

## License

ISC. You can run, modify, and self-host OpenMind freely.
