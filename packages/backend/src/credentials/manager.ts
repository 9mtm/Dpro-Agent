import { safeConsole } from '../services/safe-error-log.js';
/**
 * Credential Manager
 *
 * High-level API for managing credentials
 */

import { v4 as uuidv4 } from 'uuid';
import { credentialStorageFor, type CredentialStorage } from './storage.js';
import { dbDriver, type DbDriver } from '../db/pg/config.js';
import { getEncryptionService } from './encryption.js';
import { isMaskedSecret } from './secret-mask.js';
import { CredentialType } from './types.js';
import type {
  Credential,
  OAuthCredential,
  CreateCredentialRequest,
  UpdateCredentialRequest,
  ICredentialManager
} from './types.js';

export class CredentialManager implements ICredentialManager {
  private storage: CredentialStorage;
  private encryption: ReturnType<typeof getEncryptionService>;

  /** B2.2b-2: the storage of the configured driver unless one is given. */
  constructor(storage: CredentialStorage = credentialStorageFor(dbDriver())) {
    this.storage = storage;
    this.encryption = getEncryptionService();
  }

  /**
   * Create a new credential
   */
  async create(request: CreateCredentialRequest): Promise<Credential> {
    // Check if credential with same name already exists
    const existing = await this.storage.getByName(
      request.name,
      request.userId
    );

    if (existing) {
      throw new Error(
        `Credential with name '${request.name}' already exists`
      );
    }

    // Encrypt the value
    const { encrypted, iv, authTag } = await this.encryption.encrypt(
      request.value
    );

    // Create credential object
    const credential: Credential = {
      id: uuidv4(),
      name: request.name,
      type: request.type,
      encryptedValue: encrypted,
      iv,
      authTag,
      description: request.description,
      skillId: request.skillId,
      userId: request.userId,
      createdAt: new Date(),
      updatedAt: new Date()
    };

    // Save
    await this.storage.save(credential);

    safeConsole.log(`[Credentials] ✅ Created: ${credential.name} (${credential.type})`);

    return credential;
  }

  /**
   * Get a credential by ID
   */
  async get(id: string): Promise<Credential | null> {
    return await this.storage.get(id);
  }

  /**
   * Get a credential's decrypted value
   */
  async getValue(id: string): Promise<string> {
    const credential = await this.storage.get(id);
    if (!credential) {
      throw new Error(`Credential ${id} not found`);
    }

    return await this.storage.decrypt(credential);
  }

  /**
   * Get credential by name
   */
  async getByName(name: string, userId?: string): Promise<Credential | null> {
    return await this.storage.getByName(name, userId);
  }

  /**
   * Get decrypted value by name
   */
  async getValueByName(name: string, userId?: string): Promise<string> {
    const credential = await this.storage.getByName(name, userId);
    if (!credential) {
      throw new Error(`Credential '${name}' not found`);
    }

    return await this.storage.decrypt(credential);
  }

  /**
   * Update a credential
   */
  async update(id: string, updates: UpdateCredentialRequest): Promise<void> {
    const credential = await this.storage.get(id);
    if (!credential) {
      throw new Error(`Credential ${id} not found`);
    }

    // If value is being updated, re-encrypt it. A masked placeholder sent
    // back by a client (e.g. "••••abcd") means "keep the stored value".
    if (updates.value && !isMaskedSecret(updates.value)) {
      const { encrypted, iv, authTag } = await this.encryption.encrypt(
        updates.value
      );

      await this.storage.update(id, {
        encryptedValue: encrypted,
        iv,
        authTag,
        description: updates.description,
        expiresAt: updates.expiresAt,
        updatedAt: new Date()
      });
    } else {
      await this.storage.update(id, {
        description: updates.description,
        expiresAt: updates.expiresAt,
        updatedAt: new Date()
      });
    }

    console.log(`[Credentials] ✅ Updated: ${credential.name}`);
  }

  /**
   * Delete a credential
   */
  async delete(id: string): Promise<void> {
    const credential = await this.storage.get(id);
    if (!credential) {
      throw new Error(`Credential ${id} not found`);
    }

    await this.storage.delete(id);

    console.log(`[Credentials] 🗑️  Deleted: ${credential.name}`);
  }

  /**
   * List all credentials (without decrypted values)
   */
  async list(userId?: string): Promise<Credential[]> {
    if (userId) {
      return await this.storage.getByUser(userId);
    }

    // Return all credentials when no userId filter is provided
    return await this.storage.getAll();
  }

  /**
   * List credentials for a skill
   */
  async listBySkill(skillId: string): Promise<Credential[]> {
    return await this.storage.getBySkill(skillId);
  }

  /**
   * Check if an OAuth credential is expired
   */
  isExpired(credential: OAuthCredential): boolean {
    if (!credential.expiresAt) return false;
    return new Date() >= credential.expiresAt;
  }

  /**
   * Refresh an OAuth token
   * (Implementation depends on OAuth provider)
   */
  async refreshOAuthToken(id: string): Promise<OAuthCredential> {
    const credential = await this.storage.get(id);
    if (!credential) {
      throw new Error(`Credential ${id} not found`);
    }

    if (credential.type !== CredentialType.OAUTH_TOKEN) {
      throw new Error('Credential is not an OAuth token');
    }

    // TODO: Implement OAuth refresh logic
    // This will vary by provider (Google, GitHub, etc.)
    throw new Error('OAuth refresh not implemented yet');
  }

  /**
   * Test if a credential is valid
   */
  async test(id: string): Promise<boolean> {
    try {
      const value = await this.getValue(id);
      return value.length > 0;
    } catch (err) {
      return false;
    }
  }

  /**
   * Export credentials (for backup)
   * Returns encrypted data only, not plaintext
   */
  async export(userId?: string): Promise<Credential[]> {
    return await this.list(userId);
  }

  /**
   * Import credentials from backup
   */
  async import(credentials: Credential[]): Promise<number> {
    let imported = 0;

    for (const credential of credentials) {
      try {
        await this.storage.save(credential);
        imported++;
      } catch (err) {
        console.error(`[Credentials] Failed to import ${credential.name}:`, err);
      }
    }

    console.log(`[Credentials] ✅ Imported ${imported}/${credentials.length} credentials`);

    return imported;
  }
}

// One instance per driver (the process uses dbDriver(); tests may ask for either)
const credentialManagers = new Map<DbDriver, CredentialManager>();

export function credentialManagerFor(driver: DbDriver): CredentialManager {
  let manager = credentialManagers.get(driver);
  if (!manager) {
    manager = new CredentialManager(credentialStorageFor(driver));
    credentialManagers.set(driver, manager);
  }
  return manager;
}

export function getCredentialManager(): CredentialManager {
  return credentialManagerFor(dbDriver());
}
