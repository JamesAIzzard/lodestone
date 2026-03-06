# Lodestone — Claude Code Instructions

## MCP Server Identity Map

Claude Code shows connectors by UUID instead of name. Use this mapping:

| MCP prefix | Component |
|---|---|
| `mcp__lodestone__` | Stable — local silo ops (installed MCP) |
| `mcp__e81c08be-8a1e-44e9-8197-983783613eb5__` | Stable — cloud memories (production Worker) |
| `mcp__lodestone-dev__` | Dev — local silo ops (from `.mcp.json`) |
| `mcp__61402c1d-20ba-47f1-a812-4d2f15990837__` | Dev — cloud memories (dev Worker) |

**When developing Lodestone**, use the `-dev` / `61402c1d` tools. The stable tools point at the installed app and production database.

## Memory: Use Lodestone Memory Tools

- **Start of every conversation**: call `lodestone_orient` before anything else.
- **Before asking James a question**: check `lodestone_recall` first — it may already be answered.
- **As you work**: save learnings with `lodestone_remember`, update with `lodestone_revise`, remove stale entries with `lodestone_forget`.
- **Do NOT** use MEMORY.md for new memories — use the lodestone tools instead.

For detailed guidance: call `lodestone_guide` with topic `"memory"` (storage, cross-referencing, reminders) or `"tasks"` (agenda, recurring, overdue handling).

## Code Search: Use Lodestone

**Prefer lodestone tools over Grep/Glob** when the codebase is indexed — especially for exploratory, semantic, or fuzzy searches. Grep/Glob are still fine for quick exact lookups. Lodestone covers every search need:

- **`lodestone_search`** (default hybrid mode) — Blends semantic, BM25 keyword, and filepath matching. Best for exploratory searches by concept or intent (e.g., "where does the app handle file deletion").
- **`lodestone_search`** (bm25 mode) — Keyword/exact term matching. Use for specific symbol lookups, function names, imports.
- **`lodestone_search`** (regex mode) — Full regex pattern scanning across all indexed files. Replaces Grep.
- **`lodestone_search`** (filepath mode) — Fuzzy filename/path matching. Replaces Glob.
- **`lodestone_search`** (semantic mode) — Pure vector similarity. Best when searching by meaning with no specific terms in mind.
- **`lodestone_read`** — Retrieve full file contents from search results (by reference ID or absolute path).
- **`lodestone_explore`** — Browse directory structure and list files.

## File Editing: Use Lodestone Edit

**Prefer `lodestone_edit`** over the built-in Edit and Write tools for modifying notes within indexed silos. Benefits:
- Immediate reindexing — changes are searchable right away (no waiting for chokidar)
- Staleness detection — rejects edits if the file changed since last read
- Silo boundary checking — prevents edits outside indexed directories
- Puid tracking — reference files by short IDs (r1, r2) from search results

Operations: `str_replace`, `insert_at_line`, `overwrite`, `append`, `create`, `mkdir`, `rename`, `move`, `delete`

**When the built-in Edit/Write is still appropriate:**
- Files outside indexed silos (e.g., config files, CLAUDE.md itself)
- Quick one-off edits where puid tracking isn't needed

