# Lodestone — Claude Code Instructions

## Memory: Use Lodestone Memory Tools

You have access to persistent memory via the lodestone MCP tools. **Use them proactively:**

- **`lodestone_orient`** — Call at the start of every conversation to ground yourself in recent working context before doing anything else.
- **`lodestone_recall`** — Search memories when you need context about past decisions, architecture, patterns, or user preferences. Do this before asking the user questions you might already have answers to. **Recall uses semantic search** — query with natural language concepts, short sentences, or brief descriptions of what you're looking for (e.g., "how does the search pipeline compose scores" not "decaying-sum"). Think about meaning, not keywords.
- **`lodestone_remember`** — Save new learnings, decisions, and patterns as you work. Don't batch these up — save as you go.
- **`lodestone_revise`** — Update existing memories when information changes (e.g., a phase is completed, a decision is revised).
- **`lodestone_forget`** — Remove memories that are wrong or no longer relevant.

**When to use memory:**
- Start of conversation: `lodestone_orient` to see recent context
- Before exploring unfamiliar code: `lodestone_recall` to check if you've seen it before
- After completing significant work: `lodestone_remember` or `lodestone_revise` to record what changed
- When the user shares a preference or decision: `lodestone_remember` immediately

**Do NOT** use the auto-memory markdown files (MEMORY.md) for new memories. Use the lodestone tools instead — they're searchable, revisable, and more efficient.

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

**Prefer `lodestone_edit`** over the built-in Edit and Write tools for modifying files within indexed silos. Benefits:
- Immediate reindexing — changes are searchable right away (no waiting for chokidar)
- Staleness detection — rejects edits if the file changed since last read
- Silo boundary checking — prevents edits outside indexed directories
- Puid tracking — reference files by short IDs (r1, r2) from search results

Operations: `str_replace`, `insert_at_line`, `overwrite`, `append`, `create`, `mkdir`, `rename`, `move`, `delete`

**When the built-in Edit/Write is still appropriate:**
- Files outside indexed silos (e.g., config files, CLAUDE.md itself)
- Quick one-off edits where puid tracking isn't needed
