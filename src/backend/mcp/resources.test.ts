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

  it('explains how clients should use mail silos', async () => {
    const guide = await getGuideText('startup', async () => ({}));

    expect(guide).toContain('Silos named `Mail: …` are read-only email mirrors');
    expect(guide).toContain('shows its received date');
    expect(guide).toContain('`since` and `until` filter on that date');
    expect(guide).toContain(
      'frontmatter records the sender, recipients, date, folders and attachment names',
    );
    expect(guide).toContain('`lodestone_read` returns the whole message');
    expect(guide).toContain('`lodestone_read_email_attachment`');
    expect(guide).toContain('without being indexed or retained');
    expect(guide).toContain('lag the mailbox by up to the sync interval');
    expect(guide).toContain('`lodestone_edit` cannot modify them');
    expect(guide).toContain('Every search result carries a date');
  });

  it('retrieves current configuration for each startup guide request', async () => {
    const currentConfig: { notePath?: string } = {};
    const getConfig = async () => currentConfig;

    const first = await getGuideText('startup', getConfig);
    currentConfig.notePath = 'C:\\Notes\\Current Instructions.md';
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
