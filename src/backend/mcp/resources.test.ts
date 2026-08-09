import { describe, expect, it } from 'vitest';
import { getGuideText } from './resources';

describe('getGuideText', () => {
  it('points startup guidance to the exact configured note', async () => {
    const guide = await getGuideText('startup', async () => ({
      notePath: 'C:\\Notes\\LLM User Instructions.md',
    }));

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
    const getConfig = async () => ({ notePath });

    const first = await getGuideText('startup', getConfig);
    notePath = 'C:\\Notes\\Current Instructions.md';
    const second = await getGuideText('startup', getConfig);

    expect(first).toContain('LLM user instructions');
    expect(second).toContain('C:\\Notes\\Current Instructions.md');
  });

  it('keeps the notes guide limited to Lodestone mechanics', async () => {
    const guide = await getGuideText('notes', async () => ({}));

    expect(guide).toContain('Staleness detection');
    expect(guide).not.toContain('Note-Writing Conventions');
    expect(guide).not.toContain('MathJax');
  });
});
