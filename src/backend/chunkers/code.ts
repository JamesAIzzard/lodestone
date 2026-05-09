/**
 * Tree-sitter AST-based code chunker — splits source code by top-level definitions.
 *
 * Produces chunks that map naturally to the units a developer searches for:
 * functions, classes, interfaces, type aliases, etc. Uses Tree-sitter WASM
 * grammars to reliably parse code without fragile regex-based splitting.
 *
 * Fallback: if no grammar is available for a file's extension, or parsing
 * fails, falls back to the plaintext paragraph chunker.
 */

import { Parser, type Node } from 'web-tree-sitter';
import type { ExtractionResult, FileInfo, ChunkOutput } from '../pipeline-types';
import { estimateTokens, hashText, mergeUpTo } from '../chunk-utils';
import { chunkPlaintext } from './plaintext';
import { getCodeGrammar } from '../../shared/file-types';
import { DEFINITION_TYPES } from './definition-types';
import { loadGrammar } from './tree-sitter-loader';

export async function chunkCode(
  extraction: ExtractionResult,
  fileInfo: FileInfo,
  maxChunkTokens: number,
): Promise<ChunkOutput[]> {
  const { body } = extraction;
  if (body.length === 0) return [];

  const grammarName = getCodeGrammar(fileInfo.extension);
  if (!grammarName) return chunkPlaintext(extraction, fileInfo, maxChunkTokens);

  const definitionTypes = DEFINITION_TYPES[grammarName];
  if (!definitionTypes) return chunkPlaintext(extraction, fileInfo, maxChunkTokens);

  const language = await loadGrammar(grammarName);
  if (!language) return chunkPlaintext(extraction, fileInfo, maxChunkTokens);

  const parser = new Parser();
  parser.setLanguage(language);
  try {
    return chunkByDefinitions(body, fileInfo.basename, parser, definitionTypes, maxChunkTokens);
  } catch (err) {
    console.warn(
      `[code-chunker] Parse failed for ${fileInfo.basename}, falling back to plaintext:`,
      err,
    );
    return chunkPlaintext(extraction, fileInfo, maxChunkTokens);
  } finally {
    parser.delete();
  }
}

interface TopLevelCodeBlock {
  text: string;
  sectionPath: string[];
  startLine: number; // 1-based
  endLine: number; // 1-based, inclusive
  isDefinition: boolean;
}

function chunkByDefinitions(
  body: string,
  basename: string,
  parser: Parser,
  definitionTypes: string[],
  maxChunkTokens: number,
): ChunkOutput[] {
  const tree = parser.parse(body);
  // v0.26 types allow null when parsing is cancelled by options; we don't pass
  // cancellation options, but still fail explicitly if the runtime returns none.
  if (!tree) throw new Error('Tree-sitter returned no parse tree');

  try {
    const definitionSet = new Set(definitionTypes);

    const blocks = categorizeTopLevelNodes(tree.rootNode, basename, definitionSet);
    const merged = attachLeadingComments(blocks);
    return buildChunkRecords(merged, maxChunkTokens);
  } finally {
    tree.delete();
  }
}

function buildChunkRecords(blocks: TopLevelCodeBlock[], maxChunkTokens: number): ChunkOutput[] {
  const chunks: ChunkOutput[] = [];

  for (const block of blocks) {
    const text = block.text.trim();
    if (text.length === 0) continue;

    const location = { type: 'lines' as const, start: block.startLine, end: block.endLine };
    // Oversized definitions split on newlines — the prose chunker's blank-line
    // and sentence boundaries don't apply because individual lines are the
    // smallest meaningful unit in source code.
    const parts =
      estimateTokens(text) <= maxChunkTokens ? [text] : splitByLines(text, maxChunkTokens);

    for (const part of parts) {
      chunks.push({
        chunkIndex: chunks.length,
        sectionPath: block.sectionPath,
        text: part,
        locationHint: location,
        contentHash: hashText(part),
      });
    }
  }

  return chunks;
}

function categorizeTopLevelNodes(
  root: Node,
  basename: string,
  definitionSet: Set<string>,
): TopLevelCodeBlock[] {
  return root.children.map((child) => {
    const isDefinition = definitionSet.has(child.type);
    const name = isDefinition ? extractDefinitionName(child, child.type) : null;
    return {
      text: child.text,
      sectionPath: name ? [name] : [basename],
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
function attachLeadingComments(blocks: TopLevelCodeBlock[]): TopLevelCodeBlock[] {
  const result: TopLevelCodeBlock[] = [];

  for (const block of blocks) {
    if (!block.isDefinition) {
      result.push(block);
      continue;
    }

    let leadingText = '';
    let leadingStartLine = block.startLine;

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
      text: leadingText ? leadingText + '\n' + block.text : block.text,
      sectionPath: block.sectionPath,
      startLine: leadingStartLine,
      endLine: block.endLine,
      isDefinition: true,
    });
  }

  return mergeNonDefinitions(result);
}

function mergeNonDefinitions(blocks: TopLevelCodeBlock[]): TopLevelCodeBlock[] {
  const result: TopLevelCodeBlock[] = [];

  for (const block of blocks) {
    if (block.isDefinition) {
      result.push(block);
      continue;
    }

    const prev = result.length > 0 ? result[result.length - 1] : null;
    if (prev && !prev.isDefinition) {
      prev.text = prev.text + '\n' + block.text;
      prev.endLine = Math.max(prev.endLine, block.endLine);
    } else {
      result.push({ ...block });
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

function extractDefinitionName(node: Node, nodeType: string): string | null {
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

function getNodeName(node: Node): string | null {
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
