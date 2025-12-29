# XMTP Docs MCP (internal beta)

A lightweight, **docs-only MCP server** that exposes XMTP documentation as searchable tools for MCP-compatible clients like **Claude Code**.

This project is intended as an **internal beta**. It provides structured, queryable access to XMTP docs for LLM-assisted development workflows.

## Quickstart for Claude Code

1. Add the MCP server to Claude Code using `npx`:

   ```bash
   claude mcp add --transport stdio xmtp-docs -- npx -y github:xmtp/xmtp-docs-mcp
   ```

2. Start Claude Code:

   ```bash
   claude
   ```

3. Inside Claude Code, run:

   ```bash
   /mcp
   ```

You should see the `xmtp-docs` server and [its tools](#mcp-tools) listed.

## Quickstart for Cursor (per-project)

1. In the root of your repo, create a file at:

   ```bash
   mkdir -p .cursor
   touch .cursor/mcp.json
   ```

2.	Add this configuration to .cursor/mcp.json:

   ```json
   {
     "mcpServers": {
       "xmtp-docs": {
         "command": "npx",
         "args": ["-y", "github:xmtp/xmtp-docs-mcp"]
       }
     }
   }
   ```

   > [!TIP]
   > If Cursor doesn’t recognize `mcpServers` in your version, try `mcp_servers` as the top-level key instead.

3.	Restart Cursor.

## MCP tools

After you add the MCP to your AI tool, it will use these xmtp-docs tools as needed to answer questions about XMTP.

- `search_xmtp_docs(query, limit)`: Search XMTP docs and return the most relevant chunks.
- `get_xmtp_doc_chunk(id, maxChars)`: Fetch a specific documentation chunk by id.

## Docs source

By default, the server loads the full XMTP LLM docs bundle: https://raw.githubusercontent.com/xmtp/docs-xmtp-org/main/llms/llms-full.txt

You can override this with environment variables:

- `XMTP_DOC_URL`: Load docs from a custom URL
- `XMTP_DOC_PATH`: Load docs from a local file

These values are set as environment variables in the MCP configuration (for example, in `.mcp.json` when using Claude Code).

For other doc bundles, see [Build with LLMs](https://docs.xmtp.org/chat-apps/intro/build-with-llms).

## Local development

This is only needed if you’re working on the MCP server itself. End users should use the [Quickstart](#quickstart-for-claude-code) setup instead.

```bash
npm install
npm run build
npm run dev
```

The server will start and wait for stdio input (this is expected).
