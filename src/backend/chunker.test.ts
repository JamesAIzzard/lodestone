import { describe, it, expect } from 'vitest';
import { extractMarkdown, chunkMarkdown } from './chunker';

// ── extractMarkdown ──────────────────────────────────────────────────────────

describe('extractMarkdown', () => {
  it('strips YAML frontmatter and returns body + metadata', () => {
    const content = `---
title: Test Note
tags:
  - lodestone
---
# Heading

Body text here.`;
    const result = extractMarkdown(content);
    expect(result.frontmatter).toEqual({ title: 'Test Note', tags: ['lodestone'] });
    expect(result.body).toContain('# Heading');
    expect(result.body).toContain('Body text here.');
    expect(result.body).not.toContain('title: Test Note');
  });

  it('handles files with no frontmatter', () => {
    const content = '# Just a heading\n\nSome text.';
    const result = extractMarkdown(content);
    expect(result.frontmatter).toEqual({});
    expect(result.body).toBe('# Just a heading\n\nSome text.');
  });

  it('handles empty files', () => {
    const result = extractMarkdown('');
    expect(result.frontmatter).toEqual({});
    expect(result.body).toBe('');
  });
});

// ── chunkMarkdown — basic heading splitting ──────────────────────────────────

describe('chunkMarkdown', () => {
  it('splits on headings with hierarchy metadata', () => {
    const content = `# Architecture

Overview of the system.

## File Processing Pipeline

Extraction, chunking, embedding.

## Vector Store

Orama-based storage.

# Configuration

TOML-based config.`;

    const chunks = chunkMarkdown('/test/doc.md', content, 8192);

    expect(chunks.length).toBe(4);

    expect(chunks[0].headingPath).toEqual(['Architecture']);
    expect(chunks[0].text).toContain('Overview of the system');

    expect(chunks[1].headingPath).toEqual(['Architecture', 'File Processing Pipeline']);
    expect(chunks[1].text).toContain('Extraction, chunking, embedding');

    expect(chunks[2].headingPath).toEqual(['Architecture', 'Vector Store']);
    expect(chunks[2].text).toContain('Orama-based storage');

    expect(chunks[3].headingPath).toEqual(['Configuration']);
    expect(chunks[3].text).toContain('TOML-based config');
  });

  it('uses filename for content before first heading', () => {
    const content = `Some intro text before any heading.

# First Heading

Content under heading.`;

    const chunks = chunkMarkdown('/path/to/notes.md', content, 8192);

    expect(chunks.length).toBe(2);
    expect(chunks[0].headingPath).toEqual(['notes.md']);
    expect(chunks[0].text).toContain('Some intro text');
    expect(chunks[1].headingPath).toEqual(['First Heading']);
  });

  it('handles files with no headings', () => {
    const content = 'Just a plain paragraph of text with no headings at all.';
    const chunks = chunkMarkdown('/test/plain.md', content, 8192);

    expect(chunks.length).toBe(1);
    expect(chunks[0].headingPath).toEqual(['plain.md']);
    expect(chunks[0].text).toContain('Just a plain paragraph');
  });

  it('handles files with frontmatter', () => {
    const content = `---
title: My Note
---
# Heading

Content here.`;

    const chunks = chunkMarkdown('/test/note.md', content, 8192);

    expect(chunks.length).toBe(1);
    expect(chunks[0].frontmatter).toEqual({ title: 'My Note' });
    expect(chunks[0].text).toContain('Content here');
    // Frontmatter should not appear in chunk text
    expect(chunks[0].text).not.toContain('title: My Note');
  });

  it('returns empty array for empty files', () => {
    const chunks = chunkMarkdown('/test/empty.md', '', 8192);
    expect(chunks).toEqual([]);
  });

  it('handles # characters inside fenced code blocks correctly', () => {
    const content = `# Real Heading

Some text.

\`\`\`python
# This is a Python comment, not a heading
def foo():
    # Another comment
    pass
\`\`\`

More text after the code block.

# Second Heading

Final text.`;

    const chunks = chunkMarkdown('/test/code.md', content, 8192);

    // Should only split on the real headings, not the # in code blocks
    expect(chunks.length).toBe(2);
    expect(chunks[0].headingPath).toEqual(['Real Heading']);
    expect(chunks[0].text).toContain('# This is a Python comment');
    expect(chunks[1].headingPath).toEqual(['Second Heading']);
  });

  // ── Chunk metadata ───────────────────────────────────────────────────────

  it('assigns sequential chunk indices', () => {
    const content = '# A\nText\n# B\nText\n# C\nText';
    const chunks = chunkMarkdown('/test/idx.md', content, 8192);
    expect(chunks.map((c) => c.chunkIndex)).toEqual([0, 1, 2]);
  });

  it('generates content hashes', () => {
    const content = '# Heading\n\nSome text.';
    const chunks = chunkMarkdown('/test/hash.md', content, 8192);
    expect(chunks[0].contentHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('produces different hashes for different content', () => {
    const chunks1 = chunkMarkdown('/test/a.md', '# H\nText A', 8192);
    const chunks2 = chunkMarkdown('/test/b.md', '# H\nText B', 8192);
    expect(chunks1[0].contentHash).not.toBe(chunks2[0].contentHash);
  });

  it('includes line numbers', () => {
    const content = `# First

Paragraph 1.

# Second

Paragraph 2.`;

    const chunks = chunkMarkdown('/test/lines.md', content, 8192);
    expect(chunks[0].startLine).toBe(1);
    expect(chunks[1].startLine).toBeGreaterThan(1);
  });

  // ── Oversized chunk sub-splitting ────────────────────────────────────────

  it('sub-splits oversized chunks on paragraph boundaries', () => {
    // Create a chunk that's ~200 tokens (800 chars) with clear paragraph breaks
    const longParagraph1 = 'Word '.repeat(40).trim(); // ~200 chars = ~50 tokens
    const longParagraph2 = 'Text '.repeat(40).trim();
    const longParagraph3 = 'Data '.repeat(40).trim();
    const content = `# Big Section\n\n${longParagraph1}\n\n${longParagraph2}\n\n${longParagraph3}`;

    // Set maxChunkTokens low enough to force splitting
    const chunks = chunkMarkdown('/test/big.md', content, 60);

    expect(chunks.length).toBeGreaterThan(1);
    // Each chunk should be under the limit
    for (const chunk of chunks) {
      expect(chunk.text.length / 4).toBeLessThanOrEqual(70); // some slack
    }
    // All chunks should share the same heading path
    expect(new Set(chunks.map((c) => JSON.stringify(c.headingPath))).size).toBe(1);
  });

  // ── Deep heading nesting ────────────────────────────────────────────────

  it('handles deeply nested headings', () => {
    const content = `# Level 1

Text.

## Level 2

Text.

### Level 3

Text.

#### Level 4

Text.`;

    const chunks = chunkMarkdown('/test/deep.md', content, 8192);

    expect(chunks[0].headingPath).toEqual(['Level 1']);
    expect(chunks[1].headingPath).toEqual(['Level 1', 'Level 2']);
    expect(chunks[2].headingPath).toEqual(['Level 1', 'Level 2', 'Level 3']);
    expect(chunks[3].headingPath).toEqual(['Level 1', 'Level 2', 'Level 3', 'Level 4']);
  });
});
