# Lodestone - Codex Instructions

## MCP Server Identity Map

Codex shows connectors by UUID instead of name. Use this mapping:

| MCP prefix | Component |
|---|---|
| `mcp__lodestone-files__` | Stable - local file search/edit (installed MCP) |
| `mcp__lodestone-files-dev__` | Dev - local file search/edit (from `.mcp.json`) |

**When developing Lodestone**, use the `-dev` tools. The stable tools point at the installed app.

## Lodestone

Call `lodestone_guide` at the start of every conversation - it describes the available tools.

## Communication

When explaining architecture, data flow, or refactor proposals, use Mermaid diagrams where they
make the idea easier to follow. Prefer small focused diagrams alongside concise prose rather than
large all-in-one diagrams.
