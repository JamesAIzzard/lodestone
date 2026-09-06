import { describe, expect, it } from 'vitest';
import type { SiloStatus } from '../../shared/types';
import { getStartupGuide, type GuideDeps } from './resources';

function silo(
  name: string,
  overrides: { contentDescription?: string; readOnly?: boolean; managedBy?: string } = {},
): SiloStatus {
  return {
    config: {
      name,
      indexedDirectories: [],
      contentDescription: overrides.contentDescription ?? '',
      readOnly: overrides.readOnly ?? false,
      managedBy: overrides.managedBy,
    },
    available: true,
    indexCaughtUp: true,
    indexedFileCount: 0,
    chunkCount: 0,
    lastUpdated: null,
    databaseSizeBytes: 0,
    watcherState: 'ready',
  } as unknown as SiloStatus;
}

const WORKSPACE = silo('workspace', {
  contentDescription: 'Personal and business notes, and knowledge base.',
});
const MAIL = silo('james@example.com', {
  contentDescription: 'Personal email account.',
  readOnly: true,
  managedBy: 'mail:abc123',
});
const BARE = silo('scratch');

function deps(
  silos: SiloStatus[] | (() => Promise<{ silos: SiloStatus[] }>),
  notePath?: string,
): GuideDeps {
  return {
    getLlmInstructionsConfig: async () => (notePath ? { notePath } : {}),
    getSilos: typeof silos === 'function' ? silos : async () => ({ silos }),
  };
}

describe('getStartupGuide', () => {
  it('points to the exact configured note and nothing more', async () => {
    const guide = await getStartupGuide(deps([], 'C:\\Notes\\LLM User Instructions.md'));

    expect(guide).toContain('C:\\Notes\\LLM User Instructions.md');
    expect(guide).toContain('lodestone_read');
    expect(guide).not.toContain('Follow its links');
    expect(guide).not.toContain('take precedence');
  });

  it('suggests searching for user instructions when no note is configured', async () => {
    const guide = await getStartupGuide(deps([]));

    expect(guide).toContain('lodestone_search');
    expect(guide).toContain('LLM user instructions');
  });

  it('lists each silo with its description and flags', async () => {
    const guide = await getStartupGuide(deps([WORKSPACE, MAIL, BARE]));

    expect(guide).toContain('## Silos');
    expect(guide).toContain('- `workspace`: Personal and business notes, and knowledge base.');
    expect(guide).toContain('- `james@example.com` (mail, read-only): Personal email account.');
    expect(guide).toContain('- `scratch`\n');
    expect(guide).not.toContain('- `scratch`:');
  });

  it('reports when no silos are configured', async () => {
    const guide = await getStartupGuide(deps([]));

    expect(guide).toContain('No silos are configured.');
  });

  it('falls back to lodestone_status when the silo list cannot be loaded', async () => {
    const guide = await getStartupGuide(
      deps(async () => {
        throw new Error('gui offline');
      }),
    );

    expect(guide).toContain('The silo list is unavailable; call `lodestone_status`.');
    expect(guide).toContain('## Mail Silos');
  });

  it('explains mail silo mechanics only when a mail silo exists', async () => {
    const withMail = await getStartupGuide(deps([WORKSPACE, MAIL]));
    const withoutMail = await getStartupGuide(deps([WORKSPACE]));

    expect(withMail).toContain('## Mail Silos');
    expect(withMail).toContain('read-only mirrors of an email account');
    expect(withMail).toContain('dated by its received time');
    expect(withMail).toContain(
      'frontmatter records the sender, recipients, date, folders and attachment names',
    );
    expect(withMail).toContain('`lodestone_read` returns the whole message');
    expect(withMail).toContain('`lodestone_read_email_attachment`');
    expect(withMail).toContain('lag the mailbox by up to the sync interval');
    expect(withMail).toContain('`lodestone_edit` cannot modify them');
    expect(withoutMail).not.toContain('## Mail Silos');
  });

  it('leaves attachment limits and mail naming to the tool descriptions', async () => {
    const guide = await getStartupGuide(deps([MAIL]));

    expect(guide).not.toContain('Mail: …');
    expect(guide).not.toContain('5 MiB');
    expect(guide).not.toContain('without being indexed or retained');
  });

  it('mentions date bounds and silo references once in the tool overview', async () => {
    const guide = await getStartupGuide(deps([WORKSPACE]));

    expect(guide).toContain('Every search result carries a date');
    expect(guide).toContain('`since` and `until` bounds');
    expect(guide).toContain('with no query it lists everything in that window');
    expect(guide).toContain('silo name or s reference, or an array of them');
    expect(guide.match(/`since` and `until`/g)).toHaveLength(1);
  });

  it('retrieves current configuration and silos for each request', async () => {
    const config: { notePath?: string } = {};
    const silos: SiloStatus[] = [];
    const live: GuideDeps = {
      getLlmInstructionsConfig: async () => config,
      getSilos: async () => ({ silos }),
    };

    const first = await getStartupGuide(live);
    config.notePath = 'C:\\Notes\\Current Instructions.md';
    silos.push(WORKSPACE);
    const second = await getStartupGuide(live);

    expect(first).toContain('LLM user instructions');
    expect(first).toContain('No silos are configured.');
    expect(second).toContain('C:\\Notes\\Current Instructions.md');
    expect(second).toContain('- `workspace`:');
  });
});
