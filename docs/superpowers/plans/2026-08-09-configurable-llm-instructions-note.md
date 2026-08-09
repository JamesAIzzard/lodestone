# Configurable LLM Instructions Note Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users select an indexed LLM instructions note in Settings, make Lodestone's MCP guide point to it dynamically, and remove hard-coded user-writing conventions.

**Architecture:** Persist one optional absolute note path in Lodestone's TOML configuration. Expose it separately through the renderer IPC and MCP bridge, generate guide text at request time, and use the existing cross-silo filepath search for the Settings picker and availability check.

**Tech Stack:** TypeScript, Electron IPC and preload bridge, React 19, MCP SDK, smol-toml, Vitest, npm.

## Global Constraints

- Keep the `startup` and `notes` guide topics and both existing `lodestone://guide/...` resource URIs.
- Built-in guide content may describe Lodestone tool use only; writing, communication, Markdown, mathematical, and naming conventions belong in the selected note or its linked notes.
- The selected note is optional and stored as an exact absolute path.
- When no note is set, advise searching for a likely LLM user instructions note.
- Do not add a renderer filesystem-read capability or any new dependency.
- Guide calls must see changed settings without restarting Lodestone.
- Existing configuration files must continue to load.
- Bump the application version from `1.6.0` to `1.7.0` and synchronise the lockfile's root package version.

---

## File Structure

- `src/backend/config.ts`: parse, default, and save the optional TOML setting.
- `src/backend/config.test.ts`: protect missing, loaded, and round-tripped setting behaviour.
- `src/shared/types.ts`: define the renderer-facing `LlmInstructionsSettings` contract.
- `src/shared/electron-api.d.ts`: type the new renderer IPC methods.
- `src/preload.ts`: expose the new renderer IPC methods.
- `src/main/ipc-handlers.ts`: read, update, clear, and persist the setting.
- `src/backend/mcp/resources.ts`: contain tool-only guide copy and dynamically add the note bootstrap.
- `src/backend/mcp/resources.test.ts`: protect configured and unset guide output.
- `src/backend/mcp/types.ts`: add the MCP dependency used to retrieve current guidance configuration.
- `src/backend/mcp/index.ts`: pass dependencies into guide and resource registration.
- `src/main/internal-api.ts`: expose the current note path to the MCP bridge.
- `src/main/mcp-bridge.ts`: proxy guidance configuration into the MCP server.
- `src/renderer/lib/llm-instructions-note.ts`: hold path comparison and UI-state rules.
- `src/renderer/lib/llm-instructions-note.test.ts`: test configured, unset, checking, and unavailable states without a browser test dependency.
- `src/renderer/components/LlmInstructionsNoteSetting.tsx`: implement note search, selection, clearing, availability, and warnings.
- `src/renderer/views/SettingsView.tsx`: place the new setting above LLM Client Integration.
- `package.json`, `package-lock.json`: set application version `1.7.0`.

---

### Task 1: Persist and expose the selected note path

**Files:**
- Modify: `src/backend/config.test.ts`
- Modify: `src/backend/config.ts`
- Modify: `src/shared/types.ts`
- Modify: `src/shared/electron-api.d.ts`
- Modify: `src/preload.ts`
- Modify: `src/main/ipc-handlers.ts`

**Interfaces:**
- Produces: `LodestoneConfig.llm_instructions_note_path?: string`
- Produces: `LlmInstructionsSettings { notePath?: string }`
- Produces: `ElectronAPI.getLlmInstructionsSettings(): Promise<LlmInstructionsSettings>`
- Produces: `ElectronAPI.updateLlmInstructionsSettings(notePath?: string): Promise<{ success: boolean }>`

- [ ] **Step 1: Write failing configuration tests**

Extend `src/backend/config.test.ts` imports with `saveLodestoneConfig`, then add:

```ts
it('loads an optional LLM instructions note path', () => {
  const p = writeConfig(`
server_name = "test"
llm_instructions_note_path = "C:\\\\Notes\\\\LLM User Instructions.md"
`);

  expect(loadLodestoneConfig(p).llm_instructions_note_path).toBe(
    'C:\\Notes\\LLM User Instructions.md',
  );
});

it('leaves the LLM instructions note unset by default', () => {
  expect(createDefaultLodestoneConfig().llm_instructions_note_path).toBeUndefined();
});

it('round-trips the selected LLM instructions note path', () => {
  const p = writeConfig('server_name = "test"');
  const config = loadLodestoneConfig(p);
  config.llm_instructions_note_path = 'C:\\Notes\\LLM User Instructions.md';

  saveLodestoneConfig(p, config);

  expect(loadLodestoneConfig(p).llm_instructions_note_path).toBe(
    'C:\\Notes\\LLM User Instructions.md',
  );
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npx vitest run src/backend/config.test.ts`

Expected: FAIL because `LodestoneConfig` has no `llm_instructions_note_path` property and the loader drops the TOML field.

- [ ] **Step 3: Add the configuration field and parser**

In `src/backend/config.ts`, add the optional field to `LodestoneConfig` and parse it at the top level:

```ts
export interface LodestoneConfig {
  server_name: string;
  llm_instructions_note_path?: string;
  defaults: DefaultsConfig;
  silos: Record<string, SiloTomlConfig>;
}

export function loadLodestoneConfig(configPath: string): LodestoneConfig {
  const parsed = readTomlObject(configPath);

  return {
    server_name: stringField(parsed.server_name, DEFAULT_CONFIG.server_name),
    llm_instructions_note_path: optionalStringField(parsed.llm_instructions_note_path),
    defaults: parseDefaultsConfig(parsed.defaults),
    silos: parseSilosConfig(parsed.silos),
  };
}
```

Do not add the field to `DEFAULT_CONFIG`; absence is the supported unset state.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run: `npx vitest run src/backend/config.test.ts`

Expected: all configuration tests PASS.

- [ ] **Step 5: Add the renderer settings contract**

In `src/shared/types.ts`, add:

```ts
export interface LlmInstructionsSettings {
  notePath?: string;
}
```

Import it into `src/shared/electron-api.d.ts` and add:

```ts
getLlmInstructionsSettings: () => Promise<LlmInstructionsSettings>;
updateLlmInstructionsSettings: (
  notePath?: string,
) => Promise<{ success: boolean }>;
```

Expose matching methods in `src/preload.ts`:

```ts
getLlmInstructionsSettings: (): Promise<unknown> =>
  ipcRenderer.invoke('llm-instructions:get'),
updateLlmInstructionsSettings: (notePath?: string): Promise<unknown> =>
  ipcRenderer.invoke('llm-instructions:update', notePath),
```

- [ ] **Step 6: Persist set and clear operations in the main process**

Import `LlmInstructionsSettings` in `src/main/ipc-handlers.ts` and register these handlers alongside the other Settings handlers:

```ts
ipcMain.handle('llm-instructions:get', async (): Promise<LlmInstructionsSettings> => ({
  notePath: ctx.config?.llm_instructions_note_path,
}));

ipcMain.handle(
  'llm-instructions:update',
  async (_event, notePath?: string): Promise<{ success: boolean }> => {
    if (!ctx.config) return { success: false };

    const trimmedPath = notePath?.trim();
    if (trimmedPath) {
      ctx.config.llm_instructions_note_path = trimmedPath;
    } else {
      delete ctx.config.llm_instructions_note_path;
    }

    saveLodestoneConfig(ctx.configPath(), ctx.config);
    return { success: true };
  },
);
```

- [ ] **Step 7: Type-check the cross-process contract**

Run: `npm run typecheck`

Expected: PASS.

- [ ] **Step 8: Commit the persisted setting**

```powershell
git add src/backend/config.test.ts src/backend/config.ts src/shared/types.ts src/shared/electron-api.d.ts src/preload.ts src/main/ipc-handlers.ts
git commit -m "feat: persist LLM instructions note setting"
```

---

### Task 2: Generate tool-only MCP guidance dynamically

**Files:**
- Create: `src/backend/mcp/resources.test.ts`
- Modify: `src/backend/mcp/resources.ts`
- Modify: `src/backend/mcp/types.ts`
- Modify: `src/backend/mcp/index.ts`
- Modify: `src/main/internal-api.ts`
- Modify: `src/main/mcp-bridge.ts`

**Interfaces:**
- Consumes: `LodestoneConfig.llm_instructions_note_path?: string`
- Produces: `LlmInstructionsConfig { notePath?: string }`
- Produces: `McpServerDeps.getLlmInstructionsConfig(): Promise<LlmInstructionsConfig>`
- Produces: `getGuideText(topic, getConfig): Promise<string>`

- [ ] **Step 1: Write failing guide tests**

Create `src/backend/mcp/resources.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { getGuideText } from './resources';

describe('getGuideText', () => {
  it('points startup guidance to the exact configured note', async () => {
    const getConfig = vi.fn().mockResolvedValue({
      notePath: 'C:\\Notes\\LLM User Instructions.md',
    });

    const guide = await getGuideText('startup', getConfig);

    expect(guide).toContain('C:\\Notes\\LLM User Instructions.md');
    expect(guide).toContain('lodestone_read');
    expect(guide).not.toContain('MathJax');
    expect(guide).not.toContain('Paragraphs are preferred');
  });

  it('suggests searching for user instructions when no note is configured', async () => {
    const guide = await getGuideText('startup', async () => ({}));

    expect(guide).toContain('lodestone_search');
    expect(guide).toContain('LLM user instructions');
  });

  it('retrieves current configuration for each startup guide request', async () => {
    let notePath: string | undefined;
    const getConfig = vi.fn(async () => ({ notePath }));

    const first = await getGuideText('startup', getConfig);
    notePath = 'C:\\Notes\\Current Instructions.md';
    const second = await getGuideText('startup', getConfig);

    expect(first).toContain('LLM user instructions');
    expect(second).toContain('C:\\Notes\\Current Instructions.md');
    expect(getConfig).toHaveBeenCalledTimes(2);
  });

  it('keeps the notes guide limited to Lodestone mechanics', async () => {
    const guide = await getGuideText('notes', async () => ({}));

    expect(guide).toContain('Staleness detection');
    expect(guide).not.toContain('Note-Writing Conventions');
    expect(guide).not.toContain('MathJax');
  });
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npx vitest run src/backend/mcp/resources.test.ts`

Expected: FAIL because `getGuideText` is not exported and guide content is static.

- [ ] **Step 3: Replace static personal guidance with dynamic guide construction**

In `src/backend/mcp/resources.ts`, define these contracts and builders:

```ts
export type GuideTopic = 'startup' | 'notes';

export interface LlmInstructionsConfig {
  notePath?: string;
}

export type GetLlmInstructionsConfig = () => Promise<LlmInstructionsConfig>;

const STARTUP_TOOL_GUIDE = `# lodestone-files - Startup Guide

Lodestone searches, browses, reads, and edits files in configured silos.

## Key Tools

- \`lodestone_search\` finds files by semantic meaning, keywords, filename, path, or regular expression.
- \`lodestone_explore\` browses indexed directory structures.
- \`lodestone_read\` reads a search result reference or absolute path.
- \`lodestone_edit\` creates, changes, moves, renames, or trashes indexed files.
- \`lodestone_status\` reports silo availability and indexing state.
- \`lodestone_get_datetime\` returns the current local date and time.

Use \`lodestone_search\` or \`lodestone_explore\` to locate material, then \`lodestone_read\` before editing.`;

const NOTES_TOOL_GUIDE = `# Lodestone Notes Guide

Use \`lodestone_search\` for topic or keyword queries, \`lodestone_explore\` for directory navigation, and \`lodestone_read\` to retrieve the selected note.

Use \`lodestone_edit\` for note changes. Always read a note before editing it. If staleness detection reports an external change, read the note again and retry a narrow edit against the refreshed content.`;

function buildInstructionsBootstrap(notePath?: string): string {
  if (notePath) {
    return `## LLM User Instructions

Before substantive work, open the configured instructions note with \`lodestone_read\`:

\`${notePath}\`

Follow its links only as far as the current task requires. More specific project instructions and current source material take precedence.`;
  }

  return `## LLM User Instructions

No instructions note is configured. Use \`lodestone_search\` to look for a likely note containing LLM user instructions before substantive work.`;
}

export async function getGuideText(
  topic: GuideTopic,
  getConfig: GetLlmInstructionsConfig,
): Promise<string> {
  if (topic === 'notes') return NOTES_TOOL_GUIDE;
  const config = await getConfig();
  return `${STARTUP_TOOL_GUIDE}\n\n${buildInstructionsBootstrap(config.notePath)}`;
}
```

Change `registerGuideTool` and `registerResources` to accept `getConfig: GetLlmInstructionsConfig`. Their handlers must call `getGuideText` inside each request handler. Keep the existing topic enum and resource URIs. Update descriptions so they say “tool usage” rather than “note-writing conventions”.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run: `npx vitest run src/backend/mcp/resources.test.ts`

Expected: all guide tests PASS.

- [ ] **Step 5: Wire current configuration through the MCP boundary**

In `src/backend/mcp/types.ts`, add a top-level dependency:

```ts
getLlmInstructionsConfig: () => Promise<{ notePath?: string }>;
```

In `src/backend/mcp/index.ts`, register both guide surfaces using that dependency:

```ts
registerGuideTool(server, deps.getLlmInstructionsConfig);
registerResources(server, deps.getLlmInstructionsConfig);
```

In `src/main/internal-api.ts`, add a `getLlmInstructionsConfig` request case and handler:

```ts
case 'getLlmInstructionsConfig':
  result = this.handleGetLlmInstructionsConfig();
  break;
```

```ts
private handleGetLlmInstructionsConfig(): { notePath?: string } {
  return { notePath: this.ctx.config?.llm_instructions_note_path };
}
```

In `src/main/mcp-bridge.ts`, pass the live proxy beside `silo`:

```ts
getLlmInstructionsConfig: () =>
  gui.call<{ notePath?: string }>('getLlmInstructionsConfig'),
```

- [ ] **Step 6: Verify dynamic guidance and types**

Run: `npx vitest run src/backend/mcp/resources.test.ts src/backend/config.test.ts`

Expected: PASS.

Run: `npm run typecheck`

Expected: PASS.

- [ ] **Step 7: Commit the MCP guide change**

```powershell
git add src/backend/mcp/resources.test.ts src/backend/mcp/resources.ts src/backend/mcp/types.ts src/backend/mcp/index.ts src/main/internal-api.ts src/main/mcp-bridge.ts
git commit -m "feat: load LLM guidance note dynamically"
```

---

### Task 3: Add the searchable Settings picker and warnings

**Files:**
- Create: `src/renderer/lib/llm-instructions-note.ts`
- Create: `src/renderer/lib/llm-instructions-note.test.ts`
- Create: `src/renderer/components/LlmInstructionsNoteSetting.tsx`
- Modify: `src/renderer/views/SettingsView.tsx`

**Interfaces:**
- Consumes: `ElectronAPI.search`, `ElectronAPI.getLlmInstructionsSettings`, and `ElectronAPI.updateLlmInstructionsSettings`
- Produces: `InstructionsNoteStatus = 'unset' | 'checking' | 'available' | 'unavailable'`
- Produces: `getInstructionsNoteStatus(notePath, availabilityChecked, results)`
- Produces: `LlmInstructionsNoteSetting` React component

- [ ] **Step 1: Write failing UI-state tests**

Create `src/renderer/lib/llm-instructions-note.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { getInstructionsNoteStatus } from './llm-instructions-note';
import type { SearchResult } from '../../shared/types';

function result(filePath: string): SearchResult {
  return {
    filePath,
    siloName: 'workspace',
    score: 1,
    scoreLabel: 'filepath',
    signals: { filepath: 1 },
  };
}

describe('getInstructionsNoteStatus', () => {
  it('reports unset when no path is configured', () => {
    expect(getInstructionsNoteStatus(undefined, false, [])).toBe('unset');
  });

  it('reports checking before availability results return', () => {
    expect(getInstructionsNoteStatus('C:\\Notes\\Instructions.md', false, [])).toBe('checking');
  });

  it('matches Windows paths without case sensitivity', () => {
    expect(
      getInstructionsNoteStatus(
        'C:\\Notes\\Instructions.md',
        true,
        [result('c:\\notes\\instructions.md')],
      ),
    ).toBe('available');
  });

  it('reports unavailable when indexed search cannot find the exact path', () => {
    expect(
      getInstructionsNoteStatus(
        'C:\\Notes\\Instructions.md',
        true,
        [result('C:\\Notes\\Another Note.md')],
      ),
    ).toBe('unavailable');
  });
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npx vitest run src/renderer/lib/llm-instructions-note.test.ts`

Expected: FAIL because the helper module does not exist.

- [ ] **Step 3: Implement the UI-state helper**

Create `src/renderer/lib/llm-instructions-note.ts`:

```ts
import type { SearchResult } from '../../shared/types';

export type InstructionsNoteStatus = 'unset' | 'checking' | 'available' | 'unavailable';

function normaliseWindowsPath(filePath: string): string {
  return filePath.replaceAll('/', '\\').toLowerCase();
}

export function getInstructionsNoteStatus(
  notePath: string | undefined,
  availabilityChecked: boolean,
  results: SearchResult[],
): InstructionsNoteStatus {
  if (!notePath) return 'unset';
  if (!availabilityChecked) return 'checking';

  const selectedPath = normaliseWindowsPath(notePath);
  return results.some((item) => normaliseWindowsPath(item.filePath) === selectedPath)
    ? 'available'
    : 'unavailable';
}
```

- [ ] **Step 4: Run the focused test and verify GREEN**

Run: `npx vitest run src/renderer/lib/llm-instructions-note.test.ts`

Expected: PASS.

- [ ] **Step 5: Implement the searchable note-setting component**

Create `src/renderer/components/LlmInstructionsNoteSetting.tsx` with these behaviours:

1. On mount, call `getLlmInstructionsSettings()` and store `notePath`.
2. When a configured path is loaded or selected, search by `fileName(notePath)` using `{ mode: 'filepath', limit: 20 }`, then use `getInstructionsNoteStatus` to display its state.
3. Debounce picker queries by 250 ms and call `search({ query, mode: 'filepath', limit: 8 })` across all silos.
4. Display each result as a button containing `fileName(result.filePath)`, `dirPath(result.filePath)`, and `result.siloName`.
5. Selecting a result calls `updateLlmInstructionsSettings(result.filePath)`, preserves the exact result for an immediately available state, clears the query results, and displays the selected path.
6. Clearing calls `updateLlmInstructionsSettings(undefined)` and restores the unset warning.
7. Search or persistence failures show a local red error message without discarding the saved selection.

Use `Search`, `Loader2`, `TriangleAlert`, `CheckCircle2`, and `X` from `lucide-react`, the existing `Button`, and the same input classes as `SettingsView`. The warning copy must be:

```ts
const UNSET_WARNING =
  'No instructions note is configured. LLM clients will receive general advice to search for user instructions.';

const UNAVAILABLE_WARNING =
  'The selected note is not currently available in an indexed silo. It may have moved, or its silo may be stopped or still indexing.';
```

Label the search input `Find an indexed instructions note` and use placeholder `Search filenames...`.

- [ ] **Step 6: Place the component in Settings**

Import `LlmInstructionsNoteSetting` into `src/renderer/views/SettingsView.tsx`. Add this section immediately before LLM Client Integration:

```tsx
<Section
  title="LLM Instructions Note"
  description="Choose the indexed note that contains your standing instructions for LLM clients."
>
  <LlmInstructionsNoteSetting />
</Section>
```

- [ ] **Step 7: Verify the renderer change**

Run: `npx vitest run src/renderer/lib/llm-instructions-note.test.ts`

Expected: PASS.

Run: `npm run typecheck`

Expected: PASS.

Run: `npm run lint -- --quiet`

Expected: PASS with no errors.

- [ ] **Step 8: Commit the Settings picker**

```powershell
git add src/renderer/lib/llm-instructions-note.ts src/renderer/lib/llm-instructions-note.test.ts src/renderer/components/LlmInstructionsNoteSetting.tsx src/renderer/views/SettingsView.tsx
git commit -m "feat: select LLM instructions note in settings"
```

---

### Task 4: Bump to version 1.7.0 and run release verification

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`

**Interfaces:**
- Consumes: completed configuration, MCP, and Settings changes from Tasks 1 to 3
- Produces: application version `1.7.0`

- [ ] **Step 1: Synchronise package metadata at version 1.7.0**

Run: `npm version 1.7.0 --no-git-tag-version`

Expected: `package.json` and both root version entries in `package-lock.json` are `1.7.0`. Dependency versions, including `smol-toml` `1.6.0`, remain unchanged.

- [ ] **Step 2: Verify the version diff**

Run: `git diff -- package.json package-lock.json`

Expected: only the application/root package version changes from the currently inconsistent `1.6.0` and `1.5.0` values to `1.7.0`.

- [ ] **Step 3: Run all automated tests**

Run: `npm test`

Expected: PASS.

- [ ] **Step 4: Run static verification**

Run: `npm run typecheck`

Expected: PASS.

Run: `npm run lint -- --quiet`

Expected: PASS with no errors.

Run: `git diff --check`

Expected: no whitespace errors.

- [ ] **Step 5: Commit the release metadata**

```powershell
git add package.json package-lock.json
git commit -m "chore: bump Lodestone to 1.7.0"
```

- [ ] **Step 6: Confirm the final repository state**

Run: `git status --short`

Expected: no uncommitted files.

Run: `git log -5 --oneline`

Expected: the design, setting, dynamic guide, Settings picker, and version commits appear in recent history.
