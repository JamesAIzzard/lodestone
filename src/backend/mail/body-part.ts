import type { Attachment, BodyPartChoice, TextMime } from './types';

export const PARTIAL_FETCH_LIMIT = 2 * 1024 * 1024;

export interface ImapBodyStructure {
  part?: string;
  type: string;
  parameters?: Record<string, string>;
  encoding?: string;
  size?: number;
  disposition?: string;
  dispositionParameters?: Record<string, string>;
  childNodes?: ImapBodyStructure[];
}

interface TextCandidate {
  node: ImapBodyStructure;
  section: string;
  mime: TextMime;
}

export function chooseBodyPart(structure: ImapBodyStructure): BodyPartChoice {
  const candidates: TextCandidate[] = [];
  let hasEncryptedContent = false;

  walkStructure(structure, '1', true, false, (node, section, insideAttachment) => {
    const type = normaliseToken(node.type);
    if (type === 'multipart/encrypted' || type === 'application/pkcs7-mime') {
      hasEncryptedContent = true;
    }
    if (!insideAttachment && (type === 'text/plain' || type === 'text/html')) {
      candidates.push({ node, section, mime: type });
    }
  });

  const choice =
    candidates.find((candidate) => candidate.mime === 'text/plain') ??
    candidates.find((candidate) => candidate.mime === 'text/html');
  if (!choice) {
    return { status: hasEncryptedContent ? 'encrypted' : 'unsupported' };
  }

  return {
    section: choice.node.part ?? choice.section,
    mime: choice.mime,
    encoding: choice.node.encoding ?? '7bit',
    charset: parameter(choice.node.parameters, 'charset') ?? 'utf-8',
    declaredSize: choice.node.size ?? 0,
  };
}

export function listAttachments(structure: ImapBodyStructure): Attachment[] {
  const attachments: Attachment[] = [];
  walkStructure(structure, '1', true, false, (node) => {
    if (node.childNodes?.length) return;

    const type = normaliseToken(node.type);
    const filename =
      parameter(node.dispositionParameters, 'filename') ?? parameter(node.parameters, 'name');
    const isAttachment =
      normaliseToken(node.disposition) === 'attachment' ||
      (!type.startsWith('text/') && filename !== undefined);

    if (isAttachment) {
      attachments.push({
        name: filename ?? null,
        mime: type || 'application/octet-stream',
        size: node.size ?? null,
      });
    }
  });
  return attachments;
}

function walkStructure(
  node: ImapBodyStructure,
  fallbackSection: string,
  isRoot: boolean,
  insideAttachment: boolean,
  visit: (node: ImapBodyStructure, section: string, insideAttachment: boolean) => void,
): void {
  const section = node.part ?? fallbackSection;
  const attached = insideAttachment || normaliseToken(node.disposition) === 'attachment';
  visit(node, section, attached);

  node.childNodes?.forEach((child, index) => {
    const childSection = isRoot ? `${index + 1}` : `${section}.${index + 1}`;
    walkStructure(child, childSection, false, attached, visit);
  });
}

function normaliseToken(value: string | undefined): string {
  return value?.trim().toLowerCase() ?? '';
}

function parameter(values: Record<string, string> | undefined, name: string): string | undefined {
  if (!values) return undefined;
  const entry = Object.entries(values).find(([key]) => key.toLowerCase() === name);
  return entry?.[1];
}
