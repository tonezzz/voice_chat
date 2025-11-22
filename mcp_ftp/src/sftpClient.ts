import SftpClientLib from 'ssh2-sftp-client';

import { DirectoryEntry, RemoteFileClient } from './types.js';

type SftpConfig = {
  host: string;
  port: number;
  username: string;
  password?: string;
  privateKey?: string;
  passphrase?: string;
  timeoutMs: number;
};

export class SftpClient implements RemoteFileClient {
  private readonly client = new SftpClientLib();

  constructor(private readonly config: SftpConfig) {}

  private async connect(): Promise<void> {
    await this.client.connect({
      host: this.config.host,
      port: this.config.port,
      username: this.config.username,
      password: this.config.password,
      privateKey: this.config.privateKey,
      passphrase: this.config.passphrase,
      readyTimeout: this.config.timeoutMs,
    });
  }

  private async disconnect(): Promise<void> {
    try {
      await this.client.end();
    } catch (error) {
      // ignore disconnect failures
    }
  }

  async ping(): Promise<void> {
    await this.connect();
    try {
      await this.client.cwd();
    } finally {
      await this.disconnect();
    }
  }

  async list(remotePath: string): Promise<DirectoryEntry[]> {
    await this.connect();
    try {
      const entries = await this.client.list(remotePath);
      return entries.map((entry) => ({
        name: entry.name,
        type: entry.type === 'd' ? 'directory' : entry.type === '-' ? 'file' : 'other',
        size: entry.size,
        modifiedDate: entry.modifyTime ? new Date(entry.modifyTime).toISOString() : undefined,
      }));
    } finally {
      await this.disconnect();
    }
  }

  async download(remotePath: string): Promise<string> {
    await this.connect();
    try {
      const buffer = (await this.client.get(remotePath)) as Buffer;
      return buffer.toString('utf8');
    } finally {
      await this.disconnect();
    }
  }

  async upload(remotePath: string, contents: string): Promise<void> {
    await this.connect();
    try {
      await this.client.put(Buffer.from(contents, 'utf8'), remotePath);
    } finally {
      await this.disconnect();
    }
  }

  async ensureDirectory(remotePath: string): Promise<void> {
    await this.connect();
    try {
      await this.client.mkdir(remotePath, true);
    } finally {
      await this.disconnect();
    }
  }

  async deleteFile(remotePath: string): Promise<void> {
    await this.connect();
    try {
      await this.client.delete(remotePath);
    } finally {
      await this.disconnect();
    }
  }

  async deleteDirectory(remotePath: string): Promise<void> {
    await this.connect();
    try {
      await this.client.rmdir(remotePath, true);
    } finally {
      await this.disconnect();
    }
  }
}
