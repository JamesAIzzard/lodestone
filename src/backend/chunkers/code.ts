/**
 * Tree-sitter AST-based code chunker — splits source code by top-level definitions.
 *
 * Produces chunks that map naturally to the units a developer searches for:
 * functions, classes, interfaces, type aliases, etc. Uses Tree-sitter WASM
 * grammars to reliably parse code without fragile regex-based splitting.
 *
 * Fallback: if no grammar is available for a file's extension, or parsing
 * fails, falls back to the plaintext paragraph chunker.
 *
 * Uses web-tree-sitter v0.20.x (WASM build) to avoid native addon packaging
 * issues with Electron. Grammar WASM files are provided by tree-sitter-wasms.
 */

import fs from 'node:fs';
import path from 'node:path';
import type Parser from 'web-tree-sitter';
import type { ExtractionResult, ChunkRecord } from '../pipeline-types';
import { estimateTokens, hashText } from '../chunk-utils';
import { chunkPlaintext } from './plaintext';

// ── Language Registry ────────────────────────────────────────────────────────

/**
 * Maps file extensions to their Tree-sitter grammar name.
 * The grammar name maps to a `tree-sitter-{name}.wasm` file in tree-sitter-wasms.
 */
const EXTENSION_TO_GRAMMAR: Record<string, string> = {
  '.ts':   'typescript',
  '.tsx':  'tsx',
  '.js':   'javascript',
  '.jsx':  'tsx',        // JSX is parsed by the TSX grammar
  '.py':   'python',
  '.rs':   'rust',
  '.go':   'go',
  '.java': 'java',
  '.c':    'c',
  '.h':    'c',
  '.cpp':  'cpp',
  '.hpp':  'cpp',
  '.cs':   'c_sharp',
  '.rb':   'ruby',
  '.swift':'swift',
  '.kt':   'kotlin',
};

/**
 * Top-level AST node types that represent "definitions" — the natural
 * chunk boundaries for each language. Nodes not in this list are treated
 * as inter-definition content (preamble, global vars, etc.).
 */
const DEFINITION_TYPES: Record<string, string[]> = {
  typescript: [
    'function_declaration', 'class_declaration', 'interface_declaration',
    'type_alias_declaration', 'enum_declaration', 'export_statement',
    'lexical_declaration', 'abstract_class_declaration', 'module',
  ],
  tsx: [
    'function_declaration', 'class_declaration', 'interface_declaration',
    'type_alias_declaration', 'enum_declaration', 'export_statement',
    'lexical_declaration', 'abstract_class_declaration', 'module',
  ],
  javascript: [
    'function_declaration', 'class_declaration', 'export_statement',
    'lexical_declaration', 'variable_declaration',
  ],
  python: [
    'function_definition', 'class_definition', 'decorated_definition',
  ],
  rust: [
    'function_item', 'struct_item', 'enum_item', 'impl_item',
    'trait_item', 'mod_item', 'type_item', 'const_item', 'static_item',
    'use_declaration', 'macro_definition',
  ],
  go: [
    'function_declaration', 'method_declaration', 'type_declaration',
  ],
  java: [
    'class_declaration', 'interface_declaration', 'method_declaration',
    'enum_declaration', 'annotation_type_declaration',
  ],
  c: [
    'function_definition', 'struct_specifier', 'enum_specifier',
    'type_definition', 'declaration',
  ],
  cpp: [
    'function_definition', 'class_specifier', 'struct_specifier',
    'enum_specifier', 'namespace_definition', 'template_declaration',
    'type_definition', 'declaration',
  ],
  c_sharp: [
    'class_declaration', 'interface_declaration', 'struct_declaration',
    'enum_declaration', 'method_declaration', 'namespace_declaration',
  ],
  ruby: [
    'method', 'class', 'module', 'singleton_method',
  ],
  swift: [
    'function_declaration', 'class_declaration', 'struct_declaration',
    'enum_declaration', 'protocol_declaration', 'extension_declaration',
  ],
  kotlin: [
    'function_declaration', 'class_declaration', 'object_declaration',
    'interface_declaration',
  ],
};

// ── Grammar Cache ────────────────────────────────────────────────────────────

/**
 * The Parser class constructor, loaded once from the web-tree-sitter module.
 * In v0.20.x, `Parser` is the default export and `Parser.Language` is a nested class.
 */
let ParserClass: typeof Parser | null = null;

/** Cached loaded Language instances (grammar name -> Language) */
const languageCache = new Map<string, Parser.Language>();

/** Whether Tree-sitter WASM runtime has been initialised */
let initPromise: Promise<void> | null = null;

/**
 * Ensure the Tree-sitter WASM runtime is initialised.
 * Safe to call multiple times — only runs once.
 */
async function ensureInit(): Promise<void> {
  if (!initPromise) {
    initPromise = (async () => {
      // web-tree-sitter v0.20.x: default export is the Parser class itself
      const mod = await import('web-tree-sitter');
      // Handle both CJS-style default and direct named export
      ParserClass = (mod as any).default ?? mod;

      // Provide locateFile so Emscripten can find tree-sitter.wasm even when
      // the JS is bundled into a different directory (e.g. .vite/build/).
      // When web-tree-sitter is externalised the default resolution works,
      // but this acts as a safety net.
      const wasmDir = resolveTreeSitterWasmDir();
      await ParserClass!.init(wasmDir ? {
        locateFile(scriptName: string) {
          return path.join(wasmDir, scriptName);
        },
      } : undefined);
    })();
  }
  return initPromise;
}

/**
 * Find the directory containing tree-sitter.wasm by walking upward from
 * __dirname until we hit node_modules/web-tree-sitter/.
 */
function resolveTreeSitterWasmDir(): string | null {
  let dir = __dirname;
  for (let i = 0; i < 10; i++) {
    const candidate = path.join(dir, 'node_modules', 'web-tree-sitter', 'tree-sitter.wasm');
    if (fs.existsSync(candidate)) {
      return path.join(dir, 'node_modules', 'web-tree-sitter');
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * Resolve the path to a WASM grammar file.
 * Searches upward from the current file to find node_modules/tree-sitter-wasms/out/.
 */
function resolveWasmPath(grammarName: string): string | null {
  const filename = `tree-sitter-${grammarName}.wasm`;

  // Walk upward from __dirname to find node_modules (works in vitest + Electron)
  let dir = __dirname;
  for (let i = 0; i < 10; i++) {
    const candidate = path.join(dir, 'node_modules', 'tree-sitter-wasms', 'out', filename);
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  return null;
}

/**
 * Load a Tree-sitter grammar by name.
 * Returns null if the grammar WASM file is not found.
 */
async function loadGrammar(grammarName: string): Promise<Parser.Language | null> {
  const cached = languageCache.get(grammarName);
  if (cached) return cached;

  await ensureInit();
  if (!ParserClass) return null;

  try {
    const wasmPath = resolveWasmPath(grammarName);
    if (!wasmPath) {
      console.warn(`[code-chunker] WASM file not found for grammar "${grammarName}"`);
      return null;
    }

    const language = await ParserClass.Language.load(wasmPath);
    languageCache.set(grammarName, language);
    return language;
  } catch (err) {
    console.warn(`[code-chunker] Grammar not available for "${grammarName}":`, err);
    return null;
  }
}

// ── Chunker ──────────────────────────────────────────────────────────────────

/**
 * Sync chunker fallback — delegates to plaintext chunking.
 * The real implementation is async (chunkCodeAsync). This sync version exists
 * only to satisfy the FileProcessor type; it is never called when asyncChunker
 * is present on the FileProcessor.
 */
export function chunkCode(
  filePath: string,
  extraction: ExtractionResult,
  maxChunkTokens: number,
): ChunkRecord[] {
  return chunkPlaintext(filePath, extraction, maxChunkTokens);
}

/**
 * Async code chunker — the real implementation.
 * Parses source code with Tree-sitter and splits by top-level definitions.
 */
export async function chunkCodeAsync(
  filePath: string,
  extraction: ExtractionResult,
  maxChunkTokens: number,
): Promise<ChunkRecord[]> {
  const { body, metadata, metadataLineCount } = extraction;

  if (body.length === 0) return [];

  const ext = path.extname(filePath).toLowerCase();
  const grammarName = EXTENSION_TO_GRAMMAR[ext];

  if (!grammarName) {
    return chunkPlaintext(filePath, extraction, maxChunkTokens);
  }

  const definitionTypes = DEFINITION_TYPES[grammarName];
  if (!definitionTypes) {
    return chunkPlaintext(filePath, extraction, maxChunkTokens);
  }

  const language = await loadGrammar(grammarName);
  if (!language) {
    return chunkPlaintext(filePath, extraction, maxChunkTokens);
  }

  try {
    return parseAndChunk(filePath, body, language, definitionTypes, metadata, metadataLineCount, maxChunkTokens);
  } catch (err) {
    console.warn(`[code-chunker] Parse failed for ${filePath}, falling back to plaintext:`, err);
    return chunkPlaintext(filePath, extraction, maxChunkTokens);
  }
}

// ── Parse and Chunk ──────────────────────────────────────────────────────────

interface RawSegment {
  text: string;
  sectionPath: string[];
  startLine: number; // 1-based
  endLine: number;   // 1-based, inclusive
  isDefinition: boolean;
}

/**
 * Parse a source file with Tree-sitter and split it into definition-based chunks.
 */
function parseAndChunk(
  filePath: string,
  body: string,
  language: Parser.Language,
  definitionTypes: string[],
  metadata: Record<string, unknown>,
  metadataLineCount: number,
  maxChunkTokens: number,
): ChunkRecord[] {
  if (!ParserClass) throw new Error('Tree-sitter not initialised');

  const parser = new ParserClass();
  parser.setLanguage(language);
  const tree = parser.parse(body);

  const root = tree.rootNode;
  const filename = filePath.split(/[/\\]/).pop() ?? filePath;
  const definitionSet = new Set(definitionTypes);

  // Categorize top-level children into segments
  const segments = buildSegments(root, filename, definitionSet);

  // Attach leading comments/decorators to following definitions
  const mergedSegments = attachLeadingComments(segments);

  // Build ChunkRecords from segments
  const chunks: ChunkRecord[] = [];

  for (const seg of mergedSegments) {
    const text = seg.text.trim();
    if (text.length === 0) continue;

    const tokens = estimateTokens(text);

    if (tokens <= maxChunkTokens) {
      chunks.push({
        filePath,
        chunkIndex: chunks.length,
        sectionPath: seg.sectionPath,
        text,
        startLine: seg.startLine + metadataLineCount,
        endLine: seg.endLine + metadataLineCount,
        metadata,
        contentHash: hashText(text),
      });
    } else {
      // Sub-split oversized definitions on line boundaries.
      // Unlike prose (which splits on paragraph/sentence boundaries),
      // code is best split on newlines to keep individual lines intact.
      const subChunks = subSplitCode(text, maxChunkTokens);
      for (const sub of subChunks) {
        chunks.push({
          filePath,
          chunkIndex: chunks.length,
          sectionPath: seg.sectionPath,
          text: sub,
          startLine: seg.startLine + metadataLineCount,
          endLine: seg.endLine + metadataLineCount,
          metadata,
          contentHash: hashText(sub),
        });
      }
    }
  }

  // Clean up Tree-sitter resources
  tree.delete();
  parser.delete();

  return chunks;
}

/**
 * Walk the root node's children and categorize them as definitions or
 * inter-definition content.
 */
function buildSegments(
  root: Parser.SyntaxNode,
  filename: string,
  definitionSet: Set<string>,
): RawSegment[] {
  const segments: RawSegment[] = [];
  const children = root.children;

  for (const child of children) {
    const nodeType = child.type;
    const startLine = child.startPosition.row + 1; // Tree-sitter uses 0-based rows
    const endLine = child.endPosition.row + 1;
    const text = child.text;

    if (definitionSet.has(nodeType)) {
      const name = extractDefinitionName(child, nodeType);
      segments.push({
        text,
        sectionPath: name ? [name] : [filename],
        startLine,
        endLine,
        isDefinition: true,
      });
    } else if (nodeType === 'comment') {
      segments.push({
        text,
        sectionPath: [filename],
        startLine,
        endLine,
        isDefinition: false,
      });
    } else {
      segments.push({
        text,
        sectionPath: [filename],
        startLine,
        endLine,
        isDefinition: false,
      });
    }
  }

  return segments;
}

/**
 * Attach comments that immediately precede a definition to that definition's
 * chunk. This ensures JSDoc blocks, Python docstrings in comments, and
 * Rust doc-comments stay with the code they describe.
 */
function attachLeadingComments(segments: RawSegment[]): RawSegment[] {
  const result: RawSegment[] = [];

  let i = 0;
  while (i < segments.length) {
    if (!segments[i].isDefinition) {
      result.push(segments[i]);
      i++;
      continue;
    }

    // Found a definition. Look backward in result to absorb leading comments.
    const def = segments[i];
    let leadingText = '';
    let leadingStartLine = def.startLine;

    while (result.length > 0) {
      const prev = result[result.length - 1];
      const isComment = !prev.isDefinition && isCommentText(prev.text);
      const hasNoGap = (leadingStartLine - prev.endLine) <= 1;

      if (isComment && hasNoGap) {
        leadingText = prev.text + '\n' + leadingText;
        leadingStartLine = prev.startLine;
        result.pop();
      } else {
        break;
      }
    }

    const finalText = leadingText
      ? leadingText + '\n' + def.text
      : def.text;

    result.push({
      text: finalText,
      sectionPath: def.sectionPath,
      startLine: leadingStartLine,
      endLine: def.endLine,
      isDefinition: true,
    });

    i++;
  }

  return mergeNonDefinitions(result);
}

/**
 * Merge consecutive non-definition segments into single chunks.
 */
function mergeNonDefinitions(segments: RawSegment[]): RawSegment[] {
  const result: RawSegment[] = [];

  for (const seg of segments) {
    if (seg.isDefinition) {
      result.push(seg);
    } else {
      const prev = result.length > 0 ? result[result.length - 1] : null;
      if (prev && !prev.isDefinition) {
        prev.text = prev.text + '\n' + seg.text;
        prev.endLine = Math.max(prev.endLine, seg.endLine);
      } else {
        result.push({ ...seg });
      }
    }
  }

  return result;
}

/**
 * Check if a text snippet looks like a comment (line or block).
 */
function isCommentText(text: string): boolean {
  const trimmed = text.trim();
  return (
    trimmed.startsWith('//') ||
    trimmed.startsWith('/*') ||
    trimmed.startsWith('#') ||
    trimmed.startsWith('"""') ||
    trimmed.startsWith("'''") ||
    trimmed.startsWith('///') ||
    trimmed.startsWith('/**')
  );
}

// ── Definition Name Extraction ───────────────────────────────────────────────

/**
 * Extract a human-readable name from a definition AST node.
 */
function extractDefinitionName(node: Parser.SyntaxNode, nodeType: string): string | null {
  if (nodeType === 'export_statement') {
    // export function foo() {} -> unwrap to the inner declaration
    const inner = node.namedChildren.find(c =>
      c.type !== 'comment' &&
      c.type !== 'export' &&
      c.type !== 'default',
    );
    if (inner) {
      return extractDefinitionName(inner, inner.type);
    }
    const defaultChild = node.childForFieldName('value') ?? node.childForFieldName('declaration');
    if (defaultChild) {
      const name = getNodeName(defaultChild);
      return name ? `export default ${name}` : 'export default';
    }
    return null;
  }

  if (nodeType === 'decorated_definition') {
    // Python: @decorator \n def foo(): -> unwrap to function_definition
    const inner = node.namedChildren.find(c =>
      c.type === 'function_definition' || c.type === 'class_definition',
    );
    if (inner) {
      return extractDefinitionName(inner, inner.type);
    }
    return null;
  }

  if (nodeType === 'lexical_declaration' || nodeType === 'variable_declaration') {
    // const foo = () => {} — extract the variable name
    const declarator = node.namedChildren.find(c =>
      c.type === 'variable_declarator',
    );
    if (declarator) {
      const nameNode = declarator.childForFieldName('name');
      if (nameNode) return nameNode.text;
    }
    return null;
  }

  return getNodeName(node);
}

/**
 * Get the name of a node from its 'name' field.
 */
function getNodeName(node: Parser.SyntaxNode): string | null {
  const nameNode = node.childForFieldName('name');
  if (nameNode) return nameNode.text;

  // Some nodes use 'declarator' (C/C++ functions)
  const declarator = node.childForFieldName('declarator');
  if (declarator) {
    const innerName = declarator.childForFieldName('name') ?? declarator.childForFieldName('declarator');
    if (innerName) return innerName.text;
    return declarator.text.split('(')[0]?.trim() ?? null;
  }

  return null;
}

// ── Code Sub-splitting ───────────────────────────────────────────────────────

/**
 * Split oversized code text into chunks by line boundaries.
 * Unlike `subSplitText` (which splits on blank lines and sentences for prose),
 * this splits on individual newlines — the natural boundary in code.
 * Lines are greedily merged up to the token limit.
 */
function subSplitCode(text: string, maxTokens: number): string[] {
  const lines = text.split('\n');
  return mergeLines(lines, maxTokens);
}

/**
 * Greedily merge lines into chunks that fit within maxTokens.
 */
function mergeLines(lines: string[], maxTokens: number): string[] {
  const chunks: string[] = [];
  let current = '';

  for (const line of lines) {
    const candidate = current.length > 0 ? current + '\n' + line : line;
    if (estimateTokens(candidate) <= maxTokens && current.length > 0) {
      current = candidate;
    } else if (current.length > 0) {
      chunks.push(current);
      current = line;
    } else {
      current = line;
    }
  }

  if (current.length > 0) {
    chunks.push(current);
  }

  return chunks;
}

// ── Exports ──────────────────────────────────────────────────────────────────

/** All supported code file extensions */
export const CODE_EXTENSIONS = Object.keys(EXTENSION_TO_GRAMMAR);

/** Check if an extension has a Tree-sitter grammar available */
export function hasGrammar(ext: string): boolean {
  return ext.toLowerCase() in EXTENSION_TO_GRAMMAR;
}
