import { describe, it, expect, beforeAll } from 'vitest';
import { chunkCodeAsync } from './code';
import { extractCode } from '../extractors/code';
import type { ExtractionResult } from '../pipeline-types';

// Helper: extract then async-chunk in one step
async function chunkCode(
  filePath: string,
  content: string,
  maxChunkTokens: number = 8192,
) {
  const extraction = extractCode(content);
  return chunkCodeAsync(filePath, extraction, maxChunkTokens);
}

// ── extractCode ──────────────────────────────────────────────────────────────

describe('extractCode', () => {
  it('passes through code content with no shebang', () => {
    const content = 'function hello() {\n  console.log("hi");\n}';
    const result = extractCode(content);
    expect(result.body).toBe(content);
    expect(result.metadata).toEqual({});
    expect(result.metadataLineCount).toBe(0);
  });

  it('strips shebang line and sets metadataLineCount', () => {
    const content = '#!/usr/bin/env python3\nimport os\n\ndef main():\n    pass';
    const result = extractCode(content);
    expect(result.body).not.toContain('#!/usr/bin/env');
    expect(result.body).toContain('import os');
    expect(result.metadataLineCount).toBe(1);
  });

  it('handles file that is only a shebang', () => {
    const result = extractCode('#!/bin/bash');
    expect(result.body).toBe('');
    expect(result.metadataLineCount).toBe(1);
  });

  it('handles empty content', () => {
    const result = extractCode('');
    expect(result.body).toBe('');
    expect(result.metadataLineCount).toBe(0);
  });
});

// ── chunkCodeAsync — TypeScript ──────────────────────────────────────────────

describe('chunkCodeAsync — TypeScript', () => {
  it('produces separate chunks for each top-level definition', async () => {
    const content = `import { something } from 'somewhere';

export function processFile(path: string): void {
  console.log(path);
}

export class FileManager {
  private files: string[] = [];

  add(file: string): void {
    this.files.push(file);
  }

  remove(file: string): void {
    this.files = this.files.filter(f => f !== file);
  }
}

export interface Config {
  name: string;
  directories: string[];
}

export type FileExtension = '.ts' | '.js' | '.py';

export enum Status {
  Active = 'active',
  Inactive = 'inactive',
}

export const helper = (x: number): number => x * 2;
`;

    const chunks = await chunkCode('/test/example.ts', content);

    // Should have: preamble (import), function, class, interface, type, enum, const
    expect(chunks.length).toBeGreaterThanOrEqual(5);

    // Find chunks by their section paths
    const sectionPaths = chunks.map(c => c.sectionPath.join('/'));

    // Each top-level definition should have its name in the sectionPath
    expect(sectionPaths).toContain('processFile');
    expect(sectionPaths).toContain('FileManager');
    expect(sectionPaths).toContain('Config');

    // Verify the class chunk includes its methods
    const classChunk = chunks.find(c => c.sectionPath.includes('FileManager'));
    expect(classChunk).toBeDefined();
    expect(classChunk!.text).toContain('add(file: string)');
    expect(classChunk!.text).toContain('remove(file: string)');
  });

  it('includes leading JSDoc comments with the definition', async () => {
    const content = `/**
 * Process a file and return the result.
 * @param path - The file path to process.
 * @returns The processed content.
 */
function processFile(path: string): string {
  return path.toUpperCase();
}
`;

    const chunks = await chunkCode('/test/jsdoc.ts', content);

    // The JSDoc comment should be part of the function chunk
    const fnChunk = chunks.find(c => c.sectionPath.includes('processFile'));
    expect(fnChunk).toBeDefined();
    expect(fnChunk!.text).toContain('/**');
    expect(fnChunk!.text).toContain('@param path');
    expect(fnChunk!.text).toContain('function processFile');
  });

  it('creates a preamble chunk for imports and top-level constants', async () => {
    const content = `import fs from 'node:fs';
import path from 'node:path';

const MAX_SIZE = 1024;
const DEFAULT_NAME = 'untitled';

export function doWork(): void {
  console.log('working');
}
`;

    const chunks = await chunkCode('/test/preamble.ts', content);

    // Should have a preamble and a function
    expect(chunks.length).toBeGreaterThanOrEqual(2);

    // The preamble should contain imports
    const preamble = chunks[0];
    expect(preamble.text).toContain("import fs from 'node:fs'");
  });

  it('has correct line numbers', async () => {
    const content = `function first(): void {
  console.log('first');
}

function second(): void {
  console.log('second');
}
`;

    const chunks = await chunkCode('/test/lines.ts', content);

    const first = chunks.find(c => c.sectionPath.includes('first'));
    const second = chunks.find(c => c.sectionPath.includes('second'));

    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(first!.startLine).toBe(1);
    expect(second!.startLine).toBeGreaterThan(first!.endLine);
  });

  it('generates unique content hashes', async () => {
    const content = `function a(): number { return 1; }
function b(): number { return 2; }
`;

    const chunks = await chunkCode('/test/hashes.ts', content);
    const hashes = chunks.map(c => c.contentHash);
    const uniqueHashes = new Set(hashes);
    expect(uniqueHashes.size).toBe(hashes.length);
  });

  it('assigns sequential chunkIndex values', async () => {
    const content = `function a() {}
function b() {}
function c() {}
`;

    const chunks = await chunkCode('/test/indices.ts', content);
    expect(chunks.map(c => c.chunkIndex)).toEqual(
      Array.from({ length: chunks.length }, (_, i) => i),
    );
  });
});

// ── chunkCodeAsync — Python ──────────────────────────────────────────────────

describe('chunkCodeAsync — Python', () => {
  it('splits Python functions and classes', async () => {
    const content = `import os
import sys

def process_data(data: list) -> dict:
    """Process the incoming data."""
    result = {}
    for item in data:
        result[item] = True
    return result

class DataManager:
    """Manages data operations."""

    def __init__(self, path: str):
        self.path = path

    def load(self) -> list:
        return []

    def save(self, data: list) -> None:
        pass
`;

    const chunks = await chunkCode('/test/example.py', content);

    // Should have: preamble (imports), function, class
    expect(chunks.length).toBeGreaterThanOrEqual(2);

    const sectionPaths = chunks.map(c => c.sectionPath.join('/'));
    expect(sectionPaths).toContain('process_data');
    expect(sectionPaths).toContain('DataManager');

    // Class chunk should include all methods
    const classChunk = chunks.find(c => c.sectionPath.includes('DataManager'));
    expect(classChunk).toBeDefined();
    expect(classChunk!.text).toContain('def __init__');
    expect(classChunk!.text).toContain('def load');
  });

  it('includes decorators with the decorated definition', async () => {
    const content = `def decorator(func):
    return func

@decorator
def decorated_function():
    pass
`;

    const chunks = await chunkCode('/test/decorators.py', content);

    const decoratedChunk = chunks.find(c =>
      c.sectionPath.includes('decorated_function'),
    );
    expect(decoratedChunk).toBeDefined();
    expect(decoratedChunk!.text).toContain('@decorator');
  });

  it('handles shebang lines correctly', async () => {
    const content = `#!/usr/bin/env python3

def main():
    print("Hello, world!")

if __name__ == "__main__":
    main()
`;

    const chunks = await chunkCode('/test/script.py', content);

    // Shebang should be stripped by extractor
    for (const chunk of chunks) {
      expect(chunk.text).not.toContain('#!/usr/bin/env');
    }

    // Line numbers should be offset by 1 for the shebang
    const mainFn = chunks.find(c => c.sectionPath.includes('main'));
    expect(mainFn).toBeDefined();
  });
});

// ── chunkCodeAsync — Oversized definitions ───────────────────────────────────

describe('chunkCodeAsync — oversized definitions', () => {
  it('sub-splits a very large function', async () => {
    // Create a function that is unambiguously oversized.
    // estimateTokens = Math.ceil(text.length / 4), so maxChunkTokens=50 means
    // anything over ~200 chars must be sub-split.
    const lines = Array.from({ length: 30 }, (_, i) =>
      `  const result${i} = processItem(data[${i}], "${'x'.repeat(30)}");`,
    );
    const content = `function bigFunction(): void {\n${lines.join('\n')}\n}`;

    const chunks = await chunkCode('/test/big.ts', content, 50);

    // Should be sub-split into multiple chunks
    expect(chunks.length).toBeGreaterThan(1);

    // All chunks should share the same sectionPath
    for (const chunk of chunks) {
      expect(chunk.sectionPath).toContain('bigFunction');
    }
  });
});

// ── chunkCodeAsync — Empty and edge cases ────────────────────────────────────

describe('chunkCodeAsync — edge cases', () => {
  it('returns empty array for empty file', async () => {
    const chunks = await chunkCode('/test/empty.ts', '');
    expect(chunks).toEqual([]);
  });

  it('handles comment-only file', async () => {
    const content = `// This is a comment
// Another comment
/* Block comment */
`;

    const chunks = await chunkCode('/test/comments.ts', content);
    // Should produce at most one chunk (the comments as preamble)
    expect(chunks.length).toBeLessThanOrEqual(1);
  });

  it('falls back to plaintext for unknown extension', async () => {
    const content = 'some random content\n\nin a file with no grammar';
    const extraction: ExtractionResult = {
      body: content,
      metadata: {},
      metadataLineCount: 0,
    };
    const chunks = await chunkCodeAsync('/test/unknown.xyz', extraction, 8192);

    // Should still produce chunks (via plaintext fallback)
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks[0].text).toContain('some random content');
  });

  it('handles file with only imports', async () => {
    const content = `import fs from 'node:fs';
import path from 'node:path';
import { something } from './somewhere';
`;

    const chunks = await chunkCode('/test/imports.ts', content);
    // Should produce one preamble chunk with all imports
    expect(chunks.length).toBeGreaterThanOrEqual(1);
    expect(chunks[0].text).toContain('import fs');
  });
});
