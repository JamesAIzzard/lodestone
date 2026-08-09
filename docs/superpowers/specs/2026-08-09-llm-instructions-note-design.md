# Configurable LLM Instructions Note

## Purpose

Lodestone should explain how to use its own tools without hard-coding a user's communication, writing, or working preferences. Those preferences should live in a user-maintained, indexed note that an LLM can read through Lodestone.

## Scope

This change will:

- retain built-in guidance about using Lodestone's search, browse, read, edit, status, and date-time tools;
- remove hard-coded note-writing conventions from the MCP guide resources;
- let the user select an indexed LLM instructions note in Settings;
- make `lodestone_guide` point to the exact selected note when configured;
- provide generic discovery advice and a visible Settings warning when no note is configured; and
- warn when a previously selected note is no longer available.

It will not read, interpret, cache, or copy the selected note's contents into Lodestone configuration. The LLM remains responsible for opening the note and following only the guidance relevant to its task.

## Configuration

Add one optional application setting, `llm_instructions_note_path`, containing the selected note's absolute path. An absent or empty value means that no note has been configured.

The exact path is preferable to a filename-only setting because it identifies one file even when multiple silos contain notes with the same name. The setting is local to the Lodestone installation. If the file moves, the user reselects it through Settings.

## Settings Experience

Add an **LLM Instructions Note** section near the existing LLM Client Integration settings.

The section contains a searchable note picker. As the user enters a query, it uses the existing cross-silo file search and displays matching indexed files with their filename, parent path, and silo. Selecting a result saves its absolute path.

The section has three states:

1. **Configured and available:** show the selected filename and path, with controls to change or clear it.
2. **Not configured:** show an amber warning explaining that LLM clients will receive generic advice to search for user instructions.
3. **Configured but unavailable:** show a stronger warning that the selected file cannot currently be found and should be reselected.

The availability check should use current indexed search results rather than reading arbitrary filesystem paths from the renderer. A stopped or still-indexing silo may therefore make availability temporarily uncertain; the message should not claim that the file has been deleted.

## MCP Guide Behaviour

Keep the existing `startup` and `notes` guide topics for compatibility.

- `startup` describes the available Lodestone tools and the normal search, read, and edit workflow.
- `notes` describes only Lodestone-specific mechanics for finding, reading, and safely editing notes, including staleness handling. It contains no prose, Markdown, mathematical, naming, or communication conventions.

Both guide resources remain available through their existing `lodestone://guide/...` URIs.

The `startup` guide appends one short LLM-instructions bootstrap:

- When configured, it names the exact path and tells the LLM to open that note with `lodestone_read` before substantive work, following linked guidance only as far as the task requires.
- When unset, it advises the LLM to use `lodestone_search` to look for a likely note containing LLM user instructions.

The selected path is retrieved whenever `lodestone_guide` or the startup resource is requested. A settings change therefore affects subsequent calls without restarting Lodestone or the connected LLM client.

## Data Flow

```mermaid
flowchart LR
    Settings[Settings note picker] --> Config[Local Lodestone config]
    Config --> GUI[GUI internal API]
    GUI --> Bridge[MCP bridge dependency]
    Bridge --> Guide[lodestone_guide]
    Guide --> LLM[LLM opens selected note]
```

The MCP server remains a protocol adapter. It receives the optional configured path through a dedicated dependency such as `getLlmInstructionsConfig`, rather than reading the GUI configuration file directly.

## Error Handling

- An unset path is a supported state, not an error.
- A stale or unavailable configured path does not make `lodestone_guide` fail. The guide still returns tool usage and advises searching for user instructions.
- Search failures in the Settings picker leave the saved selection unchanged and show a local error state.
- Clearing the selection removes the configured path and immediately restores the generic guide wording.

## Testing

Focused tests should protect the meaningful behaviour:

- configuration parsing and round-tripping preserve an optional selected note path;
- guide construction includes the exact configured path and excludes hard-coded writing conventions;
- guide construction produces generic search advice when the setting is absent;
- the MCP bridge obtains the current setting for each guide request; and
- the Settings picker represents configured, unset, and unavailable states correctly at the component boundary.

Type checking and the full existing test suite remain the final regression checks.

## Compatibility

Existing configurations remain valid because the new setting is optional. Existing guide topic names and resource URIs remain unchanged. The content becomes narrower, but the public MCP surface does not otherwise change.
