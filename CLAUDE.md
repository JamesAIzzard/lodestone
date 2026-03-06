# Lodestone — Claude Code Instructions

## MCP Server Identity Map

Claude Code shows connectors by UUID instead of name. Use this mapping:

| MCP prefix | Component |
|---|---|
| `mcp__lodestone-files__` | Stable — local file search/edit (installed MCP) |
| `mcp__e81c08be-8a1e-44e9-8197-983783613eb5__` | Stable — cloud memories (production Worker) |
| `mcp__lodestone-files-dev__` | Dev — local file search/edit (from `.mcp.json`) |
| `mcp__61402c1d-20ba-47f1-a812-4d2f15990837__` | Dev — cloud memories (dev Worker) |

**When developing Lodestone**, use the `-dev` / `61402c1d` tools. The stable tools point at the installed app and production database.

## Lodestone

Call `lodestone_guide` on each server at the start of every conversation — it describes the available tools.
