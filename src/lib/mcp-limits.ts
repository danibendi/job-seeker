import type { McpServerOptions } from "@modelcontextprotocol/server";

// Limits for both MCP endpoints. mcp-handler hands the SDK an already-parsed body, and the SDK
// leaves the tool-argument element limit off unless a server sets it, so both are applied here.

/** Owner MCP request bodies, matching the SDK's own default (GHSA-f897-62hf-6gxq). */
export const MAX_OWNER_MCP_BODY_BYTES = 4 * 1024 * 1024;

/**
 * Array elements plus object members in one tools/call `arguments` payload (GHSA-46jr-4wx8-v453).
 * The largest legitimate input is a LinkedIn batch of up to 300 items with free-form evidence,
 * so this leaves roughly 330 elements per item while bounding validation work.
 */
export const MAX_TOOL_INPUT_ELEMENTS = 100_000;

/**
 * Spread into createMcpHandler options. mcp-handler forwards every extra option to
 * `new McpServer()`, but its option type lists only the SDK's base ServerOptions.
 */
export const toolInputLimit: Pick<McpServerOptions, "maxToolInputElements"> = { maxToolInputElements: MAX_TOOL_INPUT_ELEMENTS };
