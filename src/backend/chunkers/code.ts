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
import { estimateTokens, hashText, mergeUpTo } from '../chunk-utils';
import { chunkPlaintext } from './plaintext';
import { getCodeGrammar } from '../../shared/file-types';
import { DEFINITION_TYPES } from './definition-types';

export async function chunkCode(
  filePath: string,
  extraction: ExtractionResult,
  maxChunkTokens: number,
): Promise<ChunkRecord[]> {
  const { body } = extraction;
  if (body.length === 0) return [];

  const ext = path.extname(filePath).toLowerCase();
  const grammarName = getCodeGrammar(ext);
  if (!grammarName) return chunkPlaintext(filePath, extraction, maxChunkTokens);

  const definitionTypes = DEFINITION_TYPES[grammarName];
  if (!definitionTypes) return chunkPlaintext(filePath, extraction, maxChunkTokens);

  const language = await loadGrammar(grammarName);
  if (!language) return chunkPlaintext(filePath, extraction, maxChunkTokens);

  const parser = createParser(language);
  try {
    return chunkByDefinitions(filePath, body, parser, definitionTypes, maxChunkTokens);
  } catch (err) {
    console.warn(`[code-chunker] Parse failed for ${filePath}, falling back to plaintext:`, err);
    return chunkPlaintext(filePath, extraction, maxChunkTokens);
  } finally {
    parser.delete();
  }
}

interface Segment {
  text: string;
  sectionPath: string[];
  startLine: number; // 1-based
  endLine: number; // 1-based, inclusive
  isDefinition: boolean;
}

function chunkByDefinitions(
  filePath: string,
  body: string,
  parser: Parser,
  definitionTypes: string[],
  maxChunkTokens: number,
): ChunkRecord[] {
  const tree = parser.parse(body);
  try {
    const filename = filePath.split(/[/\\]/).pop() ?? filePath;
    const definitionSet = new Set(definitionTypes);

    const segments = categorizeTopLevelNodes(tree.rootNode, filename, definitionSet);
    const merged = attachLeadingComments(segments);
    return buildChunkRecords(merged, filePath, maxChunkTokens);
  } finally {
    tree.delete();
  }
}

function buildChunkRecords(
  segments: Segment[],
  filePath: string,
  maxChunkTokens: number,
): ChunkRecord[] {
  const chunks: ChunkRecord[] = [];

  for (const seg of segments) {
    const text = seg.text.trim();
    if (text.length === 0) continue;

    const location = { type: 'lines' as const, start: seg.startLine, end: seg.endLine };
    // Oversized definitions split on newlines — the prose chunker's blank-line
    // and sentence boundaries don't apply because individual lines are the
    // smallest meaningful unit in source code.
    const parts =
      estimateTokens(text) <= maxChunkTokens ? [text] : splitByLines(text, maxChunkTokens);

    for (const part of parts) {
      chunks.push({
        filePath,
        chunkIndex: chunks.length,
        sectionPath: seg.sectionPath,
        text: part,
        locationHint: location,
        contentHash: hashText(part),
      });
    }
  }

  return chunks;
}

function categorizeTopLevelNodes(
  root: Parser.SyntaxNode,
  filename: string,
  definitionSet: Set<string>,
): Segment[] {
  return root.children.map((child) => {
    const isDefinition = definitionSet.has(child.type);
    const name = isDefinition ? extractDefinitionName(child, child.type) : null;
    return {
      text: child.text,
      sectionPath: name ? [name] : [filename],
      // Tree-sitter rows are 0-based; we emit 1-based line numbers.
      startLine: child.startPosition.row + 1,
      endLine: child.endPosition.row + 1,
      isDefinition,
    };
  });
}

/**
 * Glue comments that immediately precede a definition onto that definition.
 * Without this, JSDoc blocks and Rust doc-comments would land in a separate
 * chunk from the function they describe — defeating semantic search for
 * questions the doc actually answers.
 */
function attachLeadingComments(segments: Segment[]): Segment[] {
  const result: Segment[] = [];

  for (const seg of segments) {
    if (!seg.isDefinition) {
      result.push(seg);
      continue;
    }

    let leadingText = '';
    let leadingStartLine = seg.startLine;

    while (result.length > 0) {
      const prev = result[result.length - 1];
      const isComment = !prev.isDefinition && isCommentText(prev.text);
      // Single-line gap counts as "attached"; a blank line breaks the bond.
      const hasNoGap = leadingStartLine - prev.endLine <= 1;
      if (!isComment || !hasNoGap) break;

      leadingText = prev.text + '\n' + leadingText;
      leadingStartLine = prev.startLine;
      result.pop();
    }

    result.push({
      text: leadingText ? leadingText + '\n' + seg.text : seg.text,
      sectionPath: seg.sectionPath,
      startLine: leadingStartLine,
      endLine: seg.endLine,
      isDefinition: true,
    });
  }

  return mergeNonDefinitions(result);
}

function mergeNonDefinitions(segments: Segment[]): Segment[] {
  const result: Segment[] = [];

  for (const seg of segments) {
    if (seg.isDefinition) {
      result.push(seg);
      continue;
    }

    const prev = result.length > 0 ? result[result.length - 1] : null;
    if (prev && !prev.isDefinition) {
      prev.text = prev.text + '\n' + seg.text;
      prev.endLine = Math.max(prev.endLine, seg.endLine);
    } else {
      result.push({ ...seg });
    }
  }

  return result;
}

function splitByLines(text: string, maxTokens: number): string[] {
  return mergeUpTo(text.split('\n'), maxTokens, '\n');
}

// Covers JS/TS/Rust line+block, Python/Ruby/Shell line, and Python triple-quoted
// strings used as docstrings. `///` and `/**` are subsumed by `//` and `/*`.
const COMMENT_PREFIXES = ['//', '/*', '#', '"""', "'''"];

function isCommentText(text: string): boolean {
  const trimmed = text.trim();
  return COMMENT_PREFIXES.some((prefix) => trimmed.startsWith(prefix));
}

function extractDefinitionName(node: Parser.SyntaxNode, nodeType: string): string | null {
  if (nodeType === 'export_statement') {
    // export function foo() {} → unwrap to inner declaration
    const inner = node.namedChildren.find(
      (c) => c.type !== 'comment' && c.type !== 'export' && c.type !== 'default',
    );
    if (inner) return extractDefinitionName(inner, inner.type);

    const defaultChild = node.childForFieldName('value') ?? node.childForFieldName('declaration');
    if (defaultChild) {
      const name = getNodeName(defaultChild);
      return name ? `export default ${name}` : 'export default';
    }
    return null;
  }

  if (nodeType === 'decorated_definition') {
    // Python: @decorator \n def foo() → unwrap to function_definition
    const inner = node.namedChildren.find(
      (c) => c.type === 'function_definition' || c.type === 'class_definition',
    );
    if (inner) return extractDefinitionName(inner, inner.type);
    return null;
  }

  if (nodeType === 'lexical_declaration' || nodeType === 'variable_declaration') {
    // const foo = () => {} — name lives on the variable_declarator, not the parent
    const declarator = node.namedChildren.find((c) => c.type === 'variable_declarator');
    const nameNode = declarator?.childForFieldName('name');
    return nameNode?.text ?? null;
  }

  return getNodeName(node);
}

function getNodeName(node: Parser.SyntaxNode): string | null {
  const nameNode = node.childForFieldName('name');
  if (nameNode) return nameNode.text;

  // C/C++ functions expose their name through 'declarator' instead of 'name'.
  const declarator = node.childForFieldName('declarator');
  if (declarator) {
    const innerName =
      declarator.childForFieldName('name') ?? declarator.childForFieldName('declarator');
    if (innerName) return innerName.text;
    return declarator.text.split('(')[0]?.trim() ?? null;
  }

  return null;
}

// In v0.20.x, web-tree-sitter's default export *is* the Parser class, with
// Parser.Language as a nested class. The runtime needs an async one-time init
// to load tree-sitter.wasm into Emscripten's linear memory before any parser
// can be constructed.
let ParserClass: typeof Parser | null = null;
const languageCache = new Map<string, Parser.Language>();
let initPromise: Promise<void> | null = null;

// Safe to non-null-assert: every caller awaits loadGrammar first, which awaits
// ensureInit, which sets ParserClass.
function createParser(language: Parser.Language): Parser {
  const parser = new ParserClass!();
  parser.setLanguage(language);
  return parser;
}

async function loadGrammar(grammarName: string): Promise<Parser.Language | null> {
  const cached = languageCache.get(grammarName);
  if (cached) return cached;

  await ensureInit();
  if (!ParserClass) return null;

  try {
    const wasmPath = resolveGrammarWasm(grammarName);
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

async function ensureInit(): Promise<void> {
  if (initPromise) return initPromise;

  initPromise = (async () => {
    const mod = await import('web-tree-sitter');
    // Handle both CJS-style default export and direct named export.
    ParserClass = (mod as any).default ?? mod;

    // When Vite bundles the chunker into .vite/build/, Emscripten's default
    // resolution can't find tree-sitter.wasm. locateFile bridges the gap.
    const wasmDir = resolveRuntimeWasmDir();
    await ParserClass!.init(
      wasmDir
        ? { locateFile: (scriptName: string) => path.join(wasmDir, scriptName) }
        : undefined,
    );
  })();
  return initPromise;
}

function resolveRuntimeWasmDir(): string | null {
  const file = walkUpForFile(path.join('node_modules', 'web-tree-sitter', 'tree-sitter.wasm'));
  return file ? path.dirname(file) : null;
}

function resolveGrammarWasm(grammarName: string): string | null {
  return walkUpForFile(
    path.join('node_modules', 'tree-sitter-wasms', 'out', `tree-sitter-${grammarName}.wasm`),
  );
}

/**
 * Walk upward from __dirname looking for a file at the given relative path.
 * Returns the absolute path, or null if not found within 10 levels.
 * Works from both vitest and Electron's bundled output, where the chunker's
 * own location relative to node_modules varies.
 */
function walkUpForFile(relPath: string): string | null {
  let dir = __dirname;
  for (let i = 0; i < 10; i++) {
    const candidate = path.join(dir, relPath);
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}
