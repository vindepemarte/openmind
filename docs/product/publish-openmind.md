# Publish OpenMind

OpenMind publishes in two layers:

1. npm package: `@vindepemarte/openmind`
2. MCP Registry metadata: `server.json`

## npm

Use environment-backed npm authentication. Do not write npm tokens into files, docs, shell history helpers, or committed config.

```bash
npm test
npm publish --access public
```

The package includes the built CLI/server, public app assets, Docker/local bootstrap files, README, usage guide, and `server.json`.

## MCP Registry

`server.json` uses the domain namespace:

```text
pro.theopenmind/openmind
```

It advertises:

- remote Streamable HTTP MCP: `https://theopenmind.pro/mcp`
- local stdio npm install: `@vindepemarte/openmind`

The hosted service also serves the manifest for well-known discovery:

```text
https://theopenmind.pro/.well-known/mcp/server.json
```

Publish after the npm package version in `server.json` is live:

```bash
mcp-publisher login http --domain theopenmind.pro --private-key "$MCP_REGISTRY_PRIVATE_KEY"
mcp-publisher publish
```

If using DNS verification instead of HTTP verification, authenticate with the matching `mcp-publisher login dns` command and keep the private key outside this repository.

For HTTP verification, set the hosted `MCP_REGISTRY_AUTH` environment variable to the public record:

```text
v=MCPv1; k=ed25519; p=PUBLIC_KEY
```

OpenMind serves that value at:

```text
https://theopenmind.pro/.well-known/mcp-registry-auth
```

## Provider Discovery Surfaces

- Official MCP Registry: publish `server.json` after npm version availability and HTTP/DNS verification.
- Cursor: use the CLI dry run to generate an Add-to-Cursor deeplink, then validate it against the published hosted endpoint.
- Windsurf: use the registry/deeplink form printed by `npx @vindepemarte/openmind connect https://theopenmind.pro --client windsurf --dry-run` after registry publication.
- Cline Marketplace: submit the hosted endpoint, npm package, and `server.json` metadata manually. Marketplace review is provider-controlled.
- Browser providers such as ChatGPT and Claude custom connectors require workspace/admin setup and OAuth callback registration. Registry publication improves discovery but does not force one-click availability.
