# OpenMind MCP Provider Connection Guide

This guide is the publish-ready reference for connecting OpenMind to major MCP-capable clients.

## Scope

- Covers OpenMind remote MCP access using `/mcp` (Streamable HTTP, preferred).
- Covers `/mcp/sse` + `/mcp/messages` only for legacy clients that still require SSE.
- Documents provider-specific setup for ChatGPT Browser, Codex CLI, Claude Code CLI, OpenCode CLI, Gemini CLI, and JetBrains IDEs.

## Prerequisites

1. OpenMind is running and reachable at a stable base URL (for example, `https://openmind.example.com`).
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
| Codex CLI | OAuth | API key | OAuth is preferred; API key mode works with bearer token env var. |
| Claude Code CLI | OAuth | API key, Basic | Can send static headers or do browser OAuth login. |
| OpenCode CLI | OAuth | API key | Supports remote MCP config and OAuth metadata discovery. |
| Gemini CLI | OAuth | API key | Supports HTTP MCP URL and OAuth discovery metadata. |
| JetBrains AI Assistant / Rider | API key | Basic | Remote URL is documented; OAuth behavior for arbitrary custom MCP servers varies by IDE build. |
| Gemini Web | Not supported | None | No official public flow for arbitrary custom MCP servers. |
| DeepSeek | Not supported | None | No official public flow for arbitrary custom MCP servers. |

## Canonical OpenMind Endpoints

- Preferred MCP transport: `https://YOUR_DOMAIN/mcp`
- Legacy SSE transport: `https://YOUR_DOMAIN/mcp/sse`
- Legacy SSE message endpoint: `https://YOUR_DOMAIN/mcp/messages?sessionId=...`
- OAuth metadata: `https://YOUR_DOMAIN/.well-known/oauth-authorization-server`
- OAuth auth endpoint: `https://YOUR_DOMAIN/oauth/authorize`
- OAuth token endpoint: `https://YOUR_DOMAIN/oauth/token`
- OAuth dynamic client registration: `https://YOUR_DOMAIN/oauth/register`
- OAuth revoke endpoint: `https://YOUR_DOMAIN/oauth/revoke`

## Provider Setup Playbooks

### Generic MCP JSON

Use this when the client accepts a raw remote MCP object.

API key / basic static-header pattern:

```json
{
  "mcpServers": {
    "openmind": {
      "type": "http",
      "url": "https://YOUR_DOMAIN/mcp",
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
      "url": "https://YOUR_DOMAIN/mcp"
    }
  }
}
```

Operational notes:
- For OAuth clients, also provide metadata (`/.well-known/oauth-authorization-server`) if the client asks.
- For API keys, rotate/revoke keys from the OpenMind API Keys tab.

### ChatGPT Browser (OAuth Only)

1. In ChatGPT, open app settings and create a custom MCP app.
2. Set MCP URL to `https://YOUR_DOMAIN/mcp`.
3. Set auth type to OAuth.
4. Use OpenMind OAuth endpoints:
- Auth URL: `https://YOUR_DOMAIN/oauth/authorize`
- Token URL: `https://YOUR_DOMAIN/oauth/token`
- Registration URL: `https://YOUR_DOMAIN/oauth/register`
5. Complete browser approval with your OpenMind username/password.

If ChatGPT requires manual OAuth client credentials:
- copy the callback URI shown by ChatGPT,
- create a manual client in OpenMind OAuth Clients tab with that redirect URI,
- paste client ID + secret into ChatGPT.

### Codex CLI

OAuth (recommended):

```bash
codex mcp add openmind --url https://YOUR_DOMAIN/mcp
codex mcp login openmind --scopes read,write
```

API key:

```bash
export OPENMIND_MCP_TOKEN='om_REDACTED'
codex mcp add openmind --url https://YOUR_DOMAIN/mcp --bearer-token-env-var OPENMIND_MCP_TOKEN
```

Troubleshooting:
- `401` with API key usually means key revoked/rotated.
- OAuth failures usually indicate callback mismatch or login denial.

### Claude Code CLI

OAuth:

```bash
claude mcp add --transport http openmind https://YOUR_DOMAIN/mcp
# then use /mcp inside Claude Code and follow browser login
```

API key / basic static header:

```bash
claude mcp add --transport http openmind https://YOUR_DOMAIN/mcp --header 'Authorization: Bearer om_REDACTED'
```

When to use each:
- OAuth for interactive local development.
- API key for automation or non-interactive shells.
- Basic only for compatibility scenarios where key-based auth is unavailable.

### OpenCode CLI

OAuth config:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "openmind": {
      "type": "remote",
      "url": "https://YOUR_DOMAIN/mcp",
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
      "url": "https://YOUR_DOMAIN/mcp",
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
      "httpUrl": "https://YOUR_DOMAIN/mcp",
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
      "httpUrl": "https://YOUR_DOMAIN/mcp",
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

1. Add a remote MCP server URL: `https://YOUR_DOMAIN/mcp`.
2. Prefer Bearer API key headers where your IDE build supports custom headers.
3. If your build does not expose header controls, use a client with explicit remote auth support (Codex CLI, Claude Code, OpenCode, Gemini CLI, ChatGPT Browser).

Known limit:
- OAuth support for arbitrary remote MCP servers is not consistent across JetBrains builds.

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

