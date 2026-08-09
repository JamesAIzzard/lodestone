import type { SearchResult } from '../../shared/types';

export type InstructionsNoteStatus = 'unset' | 'checking' | 'available' | 'unavailable';

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

function normaliseWindowsPath(filePath: string): string {
  return filePath.replaceAll('/', '\\').toLowerCase();
}
