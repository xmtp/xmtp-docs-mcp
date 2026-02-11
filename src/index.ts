// =============================================================================
// XMTP Docs MCP Server
// =============================================================================
// This file is the brain of the MCP server. It does three main things:
// 1. Loads XMTP documentation from a URL or local file
// 2. Splits the docs into searchable chunks (sections)
// 3. Exposes two tools that AI assistants can use to search and read the docs
// =============================================================================

// -----------------------------------------------------------------------------
// IMPORTS - External libraries we depend on
// -----------------------------------------------------------------------------
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"; // The MCP protocol framework
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"; // Handles communication via stdin/stdout
import { z } from "zod"; // Validates that tool inputs are correct

// -----------------------------------------------------------------------------
// TYPES - Defines the shape of our data
// -----------------------------------------------------------------------------

/**
 * A Chunk represents one section of the documentation.
 * The docs get split into many chunks, each with a unique ID.
 */
type Chunk = {
  id: string; // Unique identifier like "00001", "00042", etc.
  title: string; // The heading text (e.g., "Getting Started")
  text: string; // The actual content under that heading
};

// -----------------------------------------------------------------------------
// CONFIGURATION
// -----------------------------------------------------------------------------

/** URL to fetch XMTP docs from */
const DEFAULT_DOC_URL =
  "https://docs.xmtp.org/llms/llms-full.txt";

// -----------------------------------------------------------------------------
// DOCUMENT CHUNKING
// -----------------------------------------------------------------------------

/**
 * Splits a big markdown document into smaller searchable chunks.
 *
 * How it works:
 * - Scans through the document line by line
 * - When it sees a heading (lines starting with #, ##, ###, etc.), it starts a new chunk
 * - All the lines until the next heading become that chunk's content
 *
 * Example: A doc with "# Intro" followed by text, then "## Setup" followed by text
 * becomes two chunks: one titled "Intro" and one titled "Setup"
 */
function chunkMarkdownish(text: string): Chunk[] {
  const lines = text.split(/\r?\n/); // Split document into individual lines
  const chunks: Chunk[] = [];

  let currentTitle = "Intro"; // Default title for content before first heading
  let currentLines: string[] = []; // Accumulates lines for current chunk
  let idx = 0; // Counter for generating unique IDs

  // Helper function: saves the current accumulated lines as a chunk
  const flush = () => {
    const body = currentLines.join("\n").trim();
    if (!body) return; // Skip empty chunks
    const id = String(idx++).padStart(5, "0"); // "0" -> "00000", "42" -> "00042"
    chunks.push({ id, title: currentTitle.trim() || "Untitled", text: body });
    currentLines = []; // Reset for next chunk
  };

  // Process each line of the document
  for (const line of lines) {
    // Check if this line is a markdown heading (e.g., "## My Section")
    const headingMatch = line.match(/^(#{1,6})\s+(.+)\s*$/);
    if (headingMatch) {
      flush(); // Save previous chunk before starting new one
      currentTitle = headingMatch[2]; // Extract the heading text
      continue;
    }
    currentLines.push(line); // Not a heading, add to current chunk
  }
  flush(); // Don't forget the last chunk!
  return chunks;
}

// -----------------------------------------------------------------------------
// SEARCH SCORING
// -----------------------------------------------------------------------------

/**
 * Calculates how relevant a chunk is to a search query.
 * Higher score = more relevant.
 *
 * The scoring is simple:
 * - +1 point for each time the full query appears in the chunk
 * - +0.25 points for each unique word from the query that appears at least once
 *
 * Example: Query "send message" on a chunk containing "send message" twice:
 * - Full phrase "send message" appears 2x → +2 points
 * - Word "send" is present → +0.25 points
 * - Word "message" is present → +0.25 points
 * - Total: 2.5 points
 */
function scoreChunk(q: string, chunk: Chunk): number {
  const query = q.toLowerCase();
  const hay = (chunk.title + "\n" + chunk.text).toLowerCase(); // Search both title and content

  let score = 0;

  // Count full query matches
  if (query.length > 1) {
    score += hay.split(query).length - 1; // Clever trick: splitting by query gives N+1 parts for N matches
  }

  // Bonus points for individual word matches
  for (const token of query.split(/\s+/).filter(Boolean)) {
    if (token.length < 2) continue; // Skip single characters
    if (hay.includes(token)) score += 0.25;
  }

  return score;
}

// -----------------------------------------------------------------------------
// DOCUMENT LOADING
// -----------------------------------------------------------------------------

/**
 * Fetches the documentation text from the default XMTP docs URL.
 */
async function loadDocsText(): Promise<string> {
  const res = await fetch(DEFAULT_DOC_URL);
  if (!res.ok) {
    throw new Error(`Failed to fetch docs from ${DEFAULT_DOC_URL} (${res.status})`);
  }
  return await res.text();
}

// -----------------------------------------------------------------------------
// TOOL INPUT SCHEMAS
// -----------------------------------------------------------------------------
// These schemas define what inputs each tool accepts, with validation rules.
// The MCP SDK uses these to validate requests and generate documentation.

/** Schema for the search_xmtp_docs tool */
const SearchSchema = {
  query: z.string().min(1), // The search query (required, at least 1 character)
  limit: z.number().int().min(1).max(20).default(5), // Max results to return (1-20, defaults to 5)
};
type SearchArgs = z.infer<z.ZodObject<typeof SearchSchema>>;

/** Schema for the get_xmtp_doc_chunk tool */
const GetChunkSchema = {
  id: z.string().min(1), // The chunk ID to retrieve (required)
  maxChars: z.number().int().min(200).max(20000).default(6000), // Max characters to return
};
type GetChunkArgs = z.infer<z.ZodObject<typeof GetChunkSchema>>;

// -----------------------------------------------------------------------------
// SERVER STARTUP
// -----------------------------------------------------------------------------

/**
 * Initializes and starts the MCP server.
 *
 * This function:
 * 1. Loads the documentation
 * 2. Chunks it into searchable sections
 * 3. Registers two tools that AI assistants can call
 * 4. Starts listening for requests via stdin/stdout
 */
export async function startServer() {
  // Load and prepare the documentation
  const docsText = await loadDocsText();
  const chunks = chunkMarkdownish(docsText);
  const byId = new Map(chunks.map((c) => [c.id, c])); // Quick lookup by ID

  // Create the MCP server instance
  const server = new McpServer({
    name: "xmtp-docs-mcp",
    version: "1.0.0",
  });

  // ---------------------------------------------------------------------------
  // TOOL 1: search_xmtp_docs
  // ---------------------------------------------------------------------------
  // Searches the documentation and returns matching chunks with previews.
  // AI assistants use this to find relevant documentation sections.
  server.tool("search_xmtp_docs", SearchSchema, async (args: SearchArgs) => {
    const { query, limit } = args;

    // Score all chunks, keep only matches, sort by relevance, take top N
    const scored = chunks
      .map((c) => ({ c, s: scoreChunk(query, c) }))
      .filter((x) => x.s > 0) // Only keep chunks that matched something
      .sort((a, b) => b.s - a.s) // Highest scores first
      .slice(0, limit); // Take only requested number

    // Format results with previews (truncate long chunks to 400 chars)
    const results = scored.map(({ c, s }) => ({
      id: c.id,
      title: c.title,
      score: s,
      preview: c.text.length > 400 ? c.text.slice(0, 400) + "…" : c.text,
    }));

    // Return as JSON (MCP tools return content arrays)
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              source: DEFAULT_DOC_URL,
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

  // ---------------------------------------------------------------------------
  // TOOL 2: get_xmtp_doc_chunk
  // ---------------------------------------------------------------------------
  // Retrieves the full content of a specific chunk by ID.
  // AI assistants use this after searching to read the full section.
  server.tool("get_xmtp_doc_chunk", GetChunkSchema, async (args: GetChunkArgs) => {
    const { id, maxChars } = args;

    // Look up the chunk
    const chunk = byId.get(id);
    if (!chunk) {
      return {
        content: [{ type: "text", text: `No chunk found for id=${id}` }],
      };
    }

    // Format with title and content, truncate if needed
    const full = `# ${chunk.title}\n\n${chunk.text}`;
    const clipped = full.length > maxChars ? full.slice(0, maxChars) + "…" : full;

    return {
      content: [{ type: "text", text: clipped }],
    };
  });

  // ---------------------------------------------------------------------------
  // START LISTENING
  // ---------------------------------------------------------------------------
  // Connect to stdin/stdout so MCP clients can communicate with this server.
  // The server will now wait for incoming tool calls.
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
