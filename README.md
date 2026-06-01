<div align="center">
  <img src="public/assets/openmind-logo.svg" alt="OpenMind" width="104" height="104">

  # OpenMind

  A persistent semantic memory that can connect to anything, anywhere.

  [![Node.js 22+](https://img.shields.io/badge/Node.js-22%2B-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org/)
  [![MCP Compatible](https://img.shields.io/badge/MCP-Compatible-6366F1)](https://modelcontextprotocol.io)
  [![npm](https://img.shields.io/npm/v/@vindepemarte/openmind)](https://www.npmjs.com/package/@vindepemarte/openmind)
  [![License: ISC](https://img.shields.io/badge/License-ISC-blue.svg)](https://opensource.org/licenses/ISC)
</div>

OpenMind stores useful context, decisions, notes, and action items in PostgreSQL with pgvector, then exposes that memory through a dashboard, REST API, and MCP tools. Use it as one durable mind for AI clients, browser-based MCP providers, code agents, and local tools.

Hosted OpenMind runs at:

```text
https://theopenmind.pro
```

The hosted MCP endpoint is:

```text
https://theopenmind.pro/mcp
```

## What It Includes

| Capability | Status |
| --- | --- |
| Hosted Streamable HTTP MCP endpoint | Included |
| Local stdio MCP server through npm | Included |
| Semantic search with pgvector | Included |
| Thought capture, editing, deletion, tags, and filters | Included |
| Web dashboard and public landing page | Included |
| API keys, OAuth metadata, dynamic OAuth client registration | Included |
| Docker Compose local self-hosting | Included |
| Hosted billing and Stripe source | Not included in this public repo |

## Hosted Quick Start

Install from npm and connect supported MCP-capable clients to hosted OpenMind:

```bash
npx @vindepemarte/openmind connect https://theopenmind.pro --all-clients
```

The installer can write MCP config for:

- ChatGPT custom connector instructions
- Claude.ai custom connector instructions
- Claude Desktop
- Claude Code
- Cursor
- Windsurf
- Gemini CLI
- Codex CLI
- OpenCode
- VS Code / GitHub Copilot project config
- JetBrains, Cline, Roo Code, Zed, Continue, and generic MCP snippets

It can also write project instruction files so CLI agents know to use OpenMind as memory:

- `AGENTS.md` for Codex/OpenCode-style agents
- `CLAUDE.md` for Claude Code
- `GEMINI.md` for Gemini CLI
- `.cursor/rules/openmind-memory.mdc`
- `.windsurf/rules/openmind-memory.md`
- `.github/copilot-instructions.md`

Common hosted commands:

```bash
npx @vindepemarte/openmind connect https://theopenmind.pro
npx @vindepemarte/openmind connect https://theopenmind.pro --all-clients
npx @vindepemarte/openmind connect https://theopenmind.pro --client chatgpt,claude-code,cursor
npx @vindepemarte/openmind connect https://theopenmind.pro --all-clients --dry-run
npx @vindepemarte/openmind connect https://theopenmind.pro --client all --no-instructions
```

The CLI accepts an existing `om_...` API key, or you can log in with your OpenMind username and password so it can create a revokable API key. Hosted mode does not ask for an embedding model because embeddings run on the hosted server.

## Browser And Remote MCP Providers

Use this remote MCP URL in providers that accept custom Streamable HTTP MCP servers:

```text
https://theopenmind.pro/mcp
```

OpenMind exposes OAuth discovery metadata for clients that can perform browser login:

```text
https://theopenmind.pro/.well-known/oauth-protected-resource
https://theopenmind.pro/.well-known/oauth-authorization-server
```

OpenMind accepts `read write offline_access` during OAuth setup. Internally, `offline_access` maps to the existing refresh-token flow.

ChatGPT custom connectors and deep research-compatible MCP integrations require two tool names: `search` and `fetch`. OpenMind exposes both alongside its native tools (`capture_thought`, `semantic_search`, `list_recent`, and `get_stats`). Developer Mode clients can use the full tool set.

Static-token clients can use:

```text
Authorization: Bearer om_REDACTED
```

For provider-specific setup, see:

```text
docs/product/mcp-provider-connection-guide.md
```

## Local Self-Hosting

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

Open the local app:

```text
http://localhost:3333/app
```

Default login:

```text
admin / openmind
```

Change `WEBUI_USER`, `WEBUI_PASSWORD`, and `JWT_SECRET` in `.env` for any real use.

Local MCP setup:

```bash
npx @vindepemarte/openmind init --local --client all
npx @vindepemarte/openmind init --local --all-clients --dry-run
npx @vindepemarte/openmind init --local --client all --no-instructions
npx @vindepemarte/openmind init --local --embedding local
npx @vindepemarte/openmind init --local --embedding openrouter
```

You can also run the stdio MCP server directly:

```bash
npx @vindepemarte/openmind mcp
```

## Configuration

Copy `.env.example` to `.env`.

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
| `MCP_REGISTRY_AUTH` | For registry HTTP verification | none | Public `v=MCPv1; ...` record served at `/.well-known/mcp-registry-auth` |
| `OPENMIND_PUBLIC_URL` | No | `https://theopenmind.pro` | Base URL used for MCP `search`/`fetch` citation links |

## Publishing

The npm package is public. Publish with an environment-backed npm login or `NPM_TOKEN`; never commit tokens to this repository.

```bash
npm test
npm publish --access public
```

OpenMind also includes `server.json` for MCP Registry publication. The manifest advertises both:

- hosted remote MCP at `https://theopenmind.pro/mcp`
- local stdio install through `@vindepemarte/openmind`

The hosted app serves the same manifest at:

```text
https://theopenmind.pro/.well-known/mcp/server.json
```

Publish registry metadata after npm is live:

```bash
mcp-publisher login http --domain theopenmind.pro --private-key "$MCP_REGISTRY_PRIVATE_KEY"
mcp-publisher publish
```

For HTTP namespace verification, set `MCP_REGISTRY_AUTH` in the hosted environment to the public record generated by `mcp-publisher`/OpenSSL. Keep the matching private key outside the repo and deployment logs.

Registry publication improves discovery for clients and galleries, but provider marketplaces and browser connector galleries may still require manual submission, review, or workspace-admin approval.

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
public/         Landing page, app dashboard, login, OAuth approval UI, logo asset
init-db/        PostgreSQL bootstrap SQL
tests/          Node test suite
```

## License

ISC. You can run, modify, and self-host OpenMind freely.
