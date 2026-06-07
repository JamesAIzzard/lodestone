/**
 * Tree-sitter grammar loader — async one-time runtime init plus on-demand
 * loading and caching of language WASM grammars.
 *
 * Lives separately from the code chunker because grammar loading is
 * infrastructure (filesystem layout, Emscripten init, caching) that's
 * orthogonal to the chunking algorithm. The chunker only needs the verb
 * `loadGrammar(name) → Language | null`.
 *
 * Uses web-tree-sitter's WASM build to avoid native addon packaging issues
 * with Electron. Grammar WASM files are loaded from node_modules.
 */

import path from 'node:path';
import { Parser, Language } from 'web-tree-sitter';
import { walkUpForFile } from '../fs-utils';

const languageCache = new Map<string, Language>();
let initPromise: Promise<void> | null = null;

/**
 * Load a Tree-sitter grammar by its short name (e.g. "typescript", "python").
 * Returns null if the WASM file can't be located or fails to load — callers
 * should fall back to a non-AST chunking strategy in that case.
 */
export async function loadGrammar(grammarName: string): Promise<Language | null> {
  const cached = languageCache.get(grammarName);
  if (cached) return cached;

  await ensureInit();

  try {
    const wasmPath = resolveGrammarWasm(grammarName);
    if (!wasmPath) {
      console.warn(`[tree-sitter-loader] WASM file not found for grammar "${grammarName}"`);
      return null;
    }

    const language = await Language.load(wasmPath);
    languageCache.set(grammarName, language);
    return language;
  } catch (err) {
    console.warn(`[tree-sitter-loader] Grammar not available for "${grammarName}":`, err);
    return null;
  }
}

// web-tree-sitter needs an async one-time init to load its runtime WASM into
// Emscripten's linear memory before any parser can be constructed.
async function ensureInit(): Promise<void> {
  if (initPromise) return initPromise;

  initPromise = (async () => {
    // When Vite bundles consumers into .vite/build/, Emscripten's default
    // resolution can't find web-tree-sitter.wasm. locateFile bridges the gap.
    const wasmDir = resolveRuntimeWasmDir();
    await Parser.init(
      wasmDir
        ? { locateFile: (scriptName: string) => path.join(wasmDir, scriptName) }
        : undefined,
    );
  })();
  return initPromise;
}

// Resolves relative to this loader's own location so the search works from
// both vitest and Electron's bundled output, where the loader's location
// relative to node_modules varies.
function resolveRuntimeWasmDir(): string | null {
  const file = walkUpForFile(
    __dirname,
    path.join('node_modules', 'web-tree-sitter', 'web-tree-sitter.wasm'),
  );
  return file ? path.dirname(file) : null;
}

function resolveGrammarWasm(grammarName: string): string | null {
  return walkUpForFile(
    __dirname,
    path.join(
      'node_modules',
      '@repomix/tree-sitter-wasms',
      'out',
      `tree-sitter-${grammarName}.wasm`,
    ),
  );
}
