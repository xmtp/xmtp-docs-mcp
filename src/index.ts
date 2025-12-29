import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import * as fs from "node:fs/promises";

type Chunk = {
  id: string;
  title: string;
  text: string;
};

const DEFAULT_DOC_URL =
  "https://raw.githubusercontent.com/xmtp/docs-xmtp-org/main/llms/llms-full.txt";

function chunkMarkdownish(text: string): Chunk[] {
  // Simple chunking:
  // - start a new chunk on headings like "#", "##", "###"
  // - otherwise accumulate lines
  const lines = text.split(/\r?\n/);
  const chunks: Chunk[] = [];

  let currentTitle = "Intro";
  let currentLines: string[] = [];
  let idx = 0;

  const flush = () => {
    const body = currentLines.join("\n").trim();
    if (!body) return;
    const id = String(idx++).padStart(5, "0");
    chunks.push({ id, title: currentTitle.trim() || "Untitled", text: body });
    currentLines = [];
  };

  for (const line of lines) {
    const headingMatch = line.match(/^(#{1,6})\s+(.+)\s*$/);
    if (headingMatch) {
      flush();
      currentTitle = headingMatch[2];
      continue;
    }
    currentLines.push(line);
  }
  flush();
  return chunks;
}

function scoreChunk(q: string, chunk: Chunk): number {
  const query = q.toLowerCase();
  const hay = (chunk.title + "\n" + chunk.text).toLowerCase();

  // Very dumb scoring:
  // - count occurrences of the whole query
  // - plus a small bump for each query token found
  let score = 0;
  if (query.length > 1) {
    score += hay.split(query).length - 1;
  }
  for (const token of query.split(/\s+/).filter(Boolean)) {
    if (token.length < 2) continue;
    if (hay.includes(token)) score += 0.25;
  }
  return score;
}

async function loadDocsText(): Promise<string> {
  // Prefer local file if set
  const localPath = process.env.XMTP_DOC_PATH?.trim();
  if (localPath) {
    return await fs.readFile(localPath, "utf8");
  }

  // Otherwise fetch from URL
  const url = (process.env.XMTP_DOC_URL?.trim() || DEFAULT_DOC_URL).trim();
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to fetch docs from ${url} (${res.status})`);
  }
  return await res.text();
}

// Define schemas once, so we can infer handler arg types
const SearchSchema = {
  query: z.string().min(1),
  limit: z.number().int().min(1).max(20).default(5),
};

type SearchArgs = z.infer<z.ZodObject<typeof SearchSchema>>;

const GetChunkSchema = {
  id: z.string().min(1),
  maxChars: z.number().int().min(200).max(20000).default(6000),
};

type GetChunkArgs = z.infer<z.ZodObject<typeof GetChunkSchema>>;

async function main() {
  const docsText = await loadDocsText();
  const chunks = chunkMarkdownish(docsText);
  const byId = new Map(chunks.map((c) => [c.id, c]));

  const server = new McpServer({
    name: "xmtp-docs-mcp",
    version: "0.1.0",
  });

  server.tool("search_xmtp_docs", SearchSchema, async (args: SearchArgs) => {
    const { query, limit } = args;

    const scored = chunks
      .map((c) => ({ c, s: scoreChunk(query, c) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, limit);

    const results = scored.map(({ c, s }) => ({
      id: c.id,
      title: c.title,
      score: s,
      // return a short preview so the model can decide whether to fetch the chunk
      preview: c.text.length > 400 ? c.text.slice(0, 400) + "…" : c.text,
    }));

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              source: process.env.XMTP_DOC_PATH
                ? `file:${process.env.XMTP_DOC_PATH}`
                : process.env.XMTP_DOC_URL || DEFAULT_DOC_URL,
              totalChunks: chunks.length,
              results,
            },
            null,
            2
          ),
        },
      ],
    };
  });

  server.tool("get_xmtp_doc_chunk", GetChunkSchema, async (args: GetChunkArgs) => {
    const { id, maxChars } = args;

    const chunk = byId.get(id);
    if (!chunk) {
      return {
        content: [{ type: "text", text: `No chunk found for id=${id}` }],
      };
    }

    const full = `# ${chunk.title}\n\n${chunk.text}`;
    const clipped = full.length > maxChars ? full.slice(0, maxChars) + "…" : full;

    return {
      content: [{ type: "text", text: clipped }],
    };
  });

  // stdio transport: client spawns this process and talks JSON-RPC over stdin/stdout
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  // Important: write errors to stderr so stdout stays clean for MCP
  console.error(err);
  process.exit(1);
});