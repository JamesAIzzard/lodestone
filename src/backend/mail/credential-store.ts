import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import type { SafeStorage } from 'electron';

export type Credential =
  | { kind: 'password'; password: string }
  | { kind: 'oauth'; refreshToken: string; clientId: string };

export interface CredentialStore {
  save(accountHash: string, credential: Credential): Promise<void>;
  load(accountHash: string): Promise<Credential | null>;
  delete(accountHash: string): Promise<void>;
}

export class SafeStorageCredentialStore implements CredentialStore {
  constructor(private readonly userDataDirectory?: string) {}

  async save(accountHash: string, credential: Credential): Promise<void> {
    validateAccountHash(accountHash);
    const { directory: userDataDirectory, safeStorage } = await this.context();
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('Credential encryption is unavailable.');
    }

    const directory = credentialDirectory(userDataDirectory, accountHash);
    const destination = path.join(directory, 'credential.bin');
    const temporary = path.join(directory, `credential.bin.${randomUUID()}`);
    await mkdir(directory, { recursive: true });
    const encrypted = safeStorage.encryptString(JSON.stringify(credential));
    const handle = await open(temporary, 'wx');
    try {
      await handle.writeFile(encrypted);
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await renameWithRetry(temporary, destination);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  }

  async load(accountHash: string): Promise<Credential | null> {
    validateAccountHash(accountHash);
    const { directory: userDataDirectory, safeStorage } = await this.context();
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('Credential encryption is unavailable.');
    }
    try {
      const encrypted = await readFile(
        path.join(credentialDirectory(userDataDirectory, accountHash), 'credential.bin'),
      );
      return parseCredential(safeStorage.decryptString(encrypted));
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) return null;
      throw error;
    }
  }

  async delete(accountHash: string): Promise<void> {
    validateAccountHash(accountHash);
    const { directory: userDataDirectory } = await this.context();
    await rm(path.join(credentialDirectory(userDataDirectory, accountHash), 'credential.bin'), {
      force: true,
    });
  }

  private async context(): Promise<{ directory: string; safeStorage: SafeStorage }> {
    const { app, safeStorage } = await import('electron');
    return { directory: this.userDataDirectory ?? app.getPath('userData'), safeStorage };
  }
}

export class InMemoryCredentialStore implements CredentialStore {
  private readonly credentials = new Map<string, Credential>();

  async save(accountHash: string, credential: Credential): Promise<void> {
    this.credentials.set(accountHash, structuredClone(credential));
  }

  async load(accountHash: string): Promise<Credential | null> {
    const credential = this.credentials.get(accountHash);
    return credential ? structuredClone(credential) : null;
  }

  async delete(accountHash: string): Promise<void> {
    this.credentials.delete(accountHash);
  }
}

export async function saveCredential(accountHash: string, credential: Credential): Promise<void> {
  await new SafeStorageCredentialStore().save(accountHash, credential);
}

export async function loadCredential(accountHash: string): Promise<Credential | null> {
  return new SafeStorageCredentialStore().load(accountHash);
}

export async function deleteCredential(accountHash: string): Promise<void> {
  await new SafeStorageCredentialStore().delete(accountHash);
}

function credentialDirectory(userDataDirectory: string, accountHash: string): string {
  return path.join(userDataDirectory, 'mail', accountHash);
}

function validateAccountHash(accountHash: string): void {
  if (!/^[0-9a-f]{32}$/.test(accountHash)) throw new Error('Invalid mail account hash.');
}

function parseCredential(value: string): Credential {
  const parsed: unknown = JSON.parse(value);
  if (!isRecord(parsed)) throw new Error('Stored credential is invalid.');
  if (parsed.kind === 'password' && typeof parsed.password === 'string') {
    return { kind: 'password', password: parsed.password };
  }
  if (
    parsed.kind === 'oauth' &&
    typeof parsed.refreshToken === 'string' &&
    typeof parsed.clientId === 'string'
  ) {
    return { kind: 'oauth', refreshToken: parsed.refreshToken, clientId: parsed.clientId };
  }
  throw new Error('Stored credential is invalid.');
}

async function renameWithRetry(source: string, destination: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(source, destination);
      return;
    } catch (error) {
      if (attempt >= 2 || (!isNodeError(error, 'EPERM') && !isNodeError(error, 'EBUSY'))) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 20 * (attempt + 1)));
    }
  }
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === code;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
