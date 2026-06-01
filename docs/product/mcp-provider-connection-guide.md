# OpenMind MCP Provider Connection Guide

This guide is the publish-ready reference for connecting hosted OpenMind at `https://theopenmind.pro` to MCP-capable clients and browser-based MCP providers.

## Scope

- Covers OpenMind remote MCP access using `/mcp` (Streamable HTTP, preferred).
- Covers `/mcp/sse` + `/mcp/messages` only for legacy clients that still require SSE.
- Documents provider-specific setup for ChatGPT custom connectors, Claude, Claude Code/Desktop, Cursor, Windsurf, VS Code/GitHub Copilot, Gemini CLI, Codex CLI, OpenCode, JetBrains IDEs, Cline, Roo Code, Zed, Continue, and generic MCP clients.

## Prerequisites

1. OpenMind is running and reachable at `https://theopenmind.pro`, or at your own stable self-hosted base URL.
2. You can sign in to OpenMind with a valid account.
3. You choose one auth mode per client:
- `api_key`: revokable static token (`Authorization: Bearer om_...`), best for headless integrations.
- `oauth`: browser login + refresh flow, recommended for interactive clients.
- `basic`: username/password via HTTP Basic, only when needed for compatibility.

## Transport And Auth Matrix

| Provider / Client | Recommended auth | Also supports | Notes / limits |
| --- | --- | --- | --- |
| Generic MCP JSON client | API key | Basic, OAuth | Use when the client accepts raw MCP server JSON. |
| ChatGPT Browser (custom MCP app) | OAuth | None | Requires OAuth fields and callback flow in app settings. |
| Claude.ai / Claude custom connector | OAuth | None | Use the remote MCP URL and exact callback URI shown by Claude. |
| Claude Desktop local bridge | API key | Basic | Uses `mcp-remote` when direct remote OAuth is unavailable. |
| Cursor | OAuth | API key | Supports Streamable HTTP, config files, and Add-to-Cursor links where enabled. |
| Windsurf | OAuth | API key | Supports Streamable HTTP, registries, config files, and deeplinks. |
| VS Code / GitHub Copilot | OAuth | API key | Use `.vscode/mcp.json` or the MCP add-server UI. |
| Codex CLI | OAuth | API key | OAuth is preferred; API key mode works with bearer token env var. |
| Claude Code CLI | OAuth | API key, Basic | Can send static headers or do browser OAuth login. |
| OpenCode CLI | OAuth | API key | Supports remote MCP config and OAuth metadata discovery. |
| Gemini CLI | OAuth | API key | Supports HTTP MCP URL and OAuth discovery metadata. |
| JetBrains AI Assistant / Rider | API key | Basic | Remote URL is documented; OAuth behavior for arbitrary custom MCP servers varies by IDE build. |
| Cline / Roo Code | API key | Basic | Use marketplace/registry metadata where available, otherwise paste JSON manually. |
| Zed / Continue | API key | Local stdio | Remote HTTP support depends on build/version; local npm stdio is the fallback. |
| Gemini Web | Not supported | None | No official public flow for arbitrary custom MCP servers. |
| DeepSeek | Not supported | None | No official public flow for arbitrary custom MCP servers. |

## Canonical OpenMind Endpoints

- Preferred MCP transport: `https://theopenmind.pro/mcp`
- Legacy SSE transport: `https://theopenmind.pro/mcp/sse`
- Legacy SSE message endpoint: `https://theopenmind.pro/mcp/messages?sessionId=...`
- OAuth protected-resource metadata: `https://theopenmind.pro/.well-known/oauth-protected-resource`
- OAuth authorization-server metadata: `https://theopenmind.pro/.well-known/oauth-authorization-server`
- OAuth auth endpoint: `https://theopenmind.pro/oauth/authorize`
- OAuth token endpoint: `https://theopenmind.pro/oauth/token`
- OAuth dynamic client registration: `https://theopenmind.pro/oauth/register`
- OAuth revoke endpoint: `https://theopenmind.pro/oauth/revoke`
- MCP Registry manifest: `https://theopenmind.pro/.well-known/mcp/server.json`
- MCP Registry HTTP verification: `https://theopenmind.pro/.well-known/mcp-registry-auth`

OAuth clients may request `read write offline_access`. OpenMind accepts `offline_access` and maps it internally to the existing refresh-token behavior.

## Provider Setup Playbooks

### Generic MCP JSON

Use this when the client accepts a raw remote MCP object.

API key / basic static-header pattern:

```json
{
  "mcpServers": {
    "openmind": {
      "type": "http",
      "url": "https://theopenmind.pro/mcp",
      "headers": {
        "Authorization": "Bearer om_REDACTED"
      }
    }
  }
}
```

OAuth pattern:

```json
{
  "mcpServers": {
    "openmind": {
      "type": "http",
      "url": "https://theopenmind.pro/mcp"
    }
  }
}
```

Operational notes:
- For OAuth clients, also provide metadata (`/.well-known/oauth-authorization-server`) if the client asks.
- For API keys, rotate/revoke keys from the OpenMind API Keys tab.

### ChatGPT Browser (OAuth Only)

1. In ChatGPT, open app settings and create a custom MCP app.
2. Set MCP URL to `https://theopenmind.pro/mcp`.
3. Set auth type to OAuth.
4. Use OpenMind OAuth endpoints:
- Auth URL: `https://theopenmind.pro/oauth/authorize`
- Token URL: `https://theopenmind.pro/oauth/token`
- Registration URL: `https://theopenmind.pro/oauth/register`
5. Complete browser approval with your OpenMind username/password.

If ChatGPT requires manual OAuth client credentials:
- copy the callback URI shown by ChatGPT,
- create a manual client in OpenMind OAuth Clients tab with that redirect URI,
- paste client ID + secret into ChatGPT.

ChatGPT and deep research-compatible custom connectors expect MCP tools named `search` and `fetch`. OpenMind exposes:
- `search(query)`: returns `{"results":[{"id","title","url"}]}`
- `fetch(id)`: returns full thought text, URL, and metadata

Developer Mode-compatible clients can also use OpenMind's native tools: `capture_thought`, `semantic_search`, `list_recent`, and `get_stats`.

### Codex CLI

OAuth (recommended):

```bash
codex mcp add openmind --url https://theopenmind.pro/mcp
codex mcp login openmind --scopes read,write
```

API key:

```bash
export OPENMIND_MCP_TOKEN='om_REDACTED'
codex mcp add openmind --url https://theopenmind.pro/mcp --bearer-token-env-var OPENMIND_MCP_TOKEN
```

Troubleshooting:
- `401` with API key usually means key revoked/rotated.
- OAuth failures usually indicate callback mismatch or login denial.

### Claude Code CLI

OAuth:

```bash
claude mcp add --transport http openmind https://theopenmind.pro/mcp
# then use /mcp inside Claude Code and follow browser login
```

API key / basic static header:

```bash
claude mcp add --transport http openmind https://theopenmind.pro/mcp --header 'Authorization: Bearer om_REDACTED'
```

When to use each:
- OAuth for interactive local development.
- API key for automation or non-interactive shells.
- Basic only for compatibility scenarios where key-based auth is unavailable.

### Claude Desktop Local Bridge

When Claude Desktop cannot connect directly to remote Streamable HTTP with OAuth, use the local bridge pattern:

```json
{
  "mcpServers": {
    "openmind": {
      "command": "npx",
      "args": [
        "-y",
        "mcp-remote",
        "https://theopenmind.pro/mcp",
        "--header",
        "Authorization: Bearer om_REDACTED"
      ]
    }
  }
}
```

The OpenMind CLI writes this form for Claude Desktop hosted setup.

### Cursor

The CLI writes Cursor MCP config and prints an Add-to-Cursor deeplink when possible:

```bash
npx @vindepemarte/openmind connect https://theopenmind.pro --client cursor
```

If the link is unavailable in your Cursor build, use the generated `~/.cursor/mcp.json`.

### Windsurf

The CLI writes Windsurf MCP config and prints a registry/deeplink form:

```bash
npx @vindepemarte/openmind connect https://theopenmind.pro --client windsurf
```

The deeplink is most useful after `server.json` has been published and indexed by the relevant registry.

### VS Code / GitHub Copilot

The CLI writes project-local `.vscode/mcp.json`:

```bash
npx @vindepemarte/openmind connect https://theopenmind.pro --client vscode
```

Use the VS Code MCP add-server UI if you prefer not to write project config.

### OpenCode CLI

OAuth config:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "openmind": {
      "type": "remote",
      "url": "https://theopenmind.pro/mcp",
      "oauth": {
        "scope": "read write"
      }
    }
  }
}
```

API key config:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "openmind": {
      "type": "remote",
      "url": "https://theopenmind.pro/mcp",
      "oauth": false,
      "headers": {
        "Authorization": "Bearer {env:OPENMIND_MCP_TOKEN}"
      }
    }
  }
}
```

### Gemini CLI

OAuth config:

```json
{
  "mcpServers": {
    "openmind": {
      "httpUrl": "https://theopenmind.pro/mcp",
      "oauth": {
        "scopes": ["read", "write"]
      }
    }
  }
}
```

API key config:

```json
{
  "mcpServers": {
    "openmind": {
      "httpUrl": "https://theopenmind.pro/mcp",
      "headers": {
        "Authorization": "Bearer om_REDACTED"
      }
    }
  }
}
```

Operational notes:
- Gemini CLI can discover endpoints from OpenMind metadata.
- In OAuth mode, credentials are stored locally after successful browser login.

### JetBrains AI Assistant / Rider

1. Add a remote MCP server URL: `https://theopenmind.pro/mcp`.
2. Prefer Bearer API key headers where your IDE build supports custom headers.
3. If your build does not expose header controls, use a client with explicit remote auth support (Codex CLI, Claude Code, OpenCode, Gemini CLI, ChatGPT Browser).

Known limit:
- OAuth support for arbitrary remote MCP servers is not consistent across JetBrains builds.

### Cline, Roo Code, Zed, Continue

Use the CLI dry run to generate copy-ready snippets without writing files:

```bash
npx @vindepemarte/openmind connect https://theopenmind.pro --client cline,roo,zed,continue --dry-run
```

For Cline Marketplace or provider-specific galleries, use `server.json` plus the hosted endpoints above. Marketplace submission and approval are provider-controlled and cannot be completed by this repository alone.

### Unsupported Custom MCP Flows Today

- Gemini Web: no official public custom MCP server flow.
- DeepSeek: no official public custom MCP server flow.

## Troubleshooting

### 401 Unauthorized On `/mcp`

Common causes:
- wrong `Authorization` header format,
- revoked API key,
- expired OAuth access token,
- username/password mismatch (Basic mode).

Fix path:
1. Regenerate MCP config from OpenMind dashboard.
2. Re-copy headers exactly.
3. If using OAuth, repeat browser login flow.

### OAuth Callback Or Client Errors

Common causes:
- redirect URI mismatch,
- missing client credentials in manual-client mode.

Fix path:
1. Recreate OAuth client with exact callback URI.
2. Retry `authorize -> token` flow.
3. Use dynamic registration endpoint when client supports it.

### Client Connects But No MCP Responses

Common causes:
- client pointed at `/mcp/sse` while expecting Streamable HTTP,
- legacy SSE client missing `/mcp/messages` session follow-up,
- wrong base URL/proxy headers.

Fix path:
1. Default to `/mcp`.
2. Only use `/mcp/sse` + `/mcp/messages` for legacy clients.
3. Validate external URL, TLS, and reverse-proxy forwarding.

## Security And Operational Guidance

- Prefer API keys over Basic for static credentials because API keys are revokable independently of account passwords.
- Prefer OAuth for user-driven desktop/CLI clients.
- Keep tokens in environment variables or secure secret stores.
- Rotate credentials on agent offboarding or machine compromise.

Default token/session behavior:
- OAuth access token lifetime: `3600` seconds (default).
- OAuth refresh token lifetime: `2592000` seconds (default).
- Lifetimes are configurable per user in OpenMind settings.
