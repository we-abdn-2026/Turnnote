import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/** Minimal subset of Electron safeStorage used here; injectable for tests. */
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

type CredentialFile = Record<string, string>;

/**
 * Provider-keyed credential store backed by safeStorage encryption.
 * Each provider's secret is encrypted and stored as base64 in a JSON file.
 * Reads are lazy (no in-memory cache) to avoid holding secrets longer than needed.
 */
export class CredentialStore {
  private readonly filePath: string;

  constructor(
    filePath: string,
    private readonly storage: SafeStorageLike,
  ) {
    this.filePath = resolve(filePath);
  }

  private read(): CredentialFile {
    if (!existsSync(this.filePath)) return {};
    try {
      const raw = readFileSync(this.filePath, 'utf8');
      const parsed = JSON.parse(raw);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
      return parsed as CredentialFile;
    } catch {
      return {};
    }
  }

  private write(data: CredentialFile): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, JSON.stringify(data), { mode: 0o600 });
  }

  has(provider: string): boolean {
    return provider in this.read();
  }

  /** Returns the decrypted secret, or null if not set or decryption fails. */
  get(provider: string): string | null {
    const data = this.read();
    const encoded = data[provider];
    if (!encoded) return null;
    try {
      const buf = Buffer.from(encoded, 'base64');
      return this.storage.decryptString(buf);
    } catch {
      return null;
    }
  }

  set(provider: string, secret: string): void {
    const data = this.read();
    const buf = this.storage.encryptString(secret);
    data[provider] = buf.toString('base64');
    this.write(data);
  }

  clear(provider: string): void {
    const data = this.read();
    if (!(provider in data)) return;
    delete data[provider];
    this.write(data);
  }
}
