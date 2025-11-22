import fs from 'fs/promises';
import { createReadStream, createWriteStream } from 'fs';
import os from 'os';
import path from 'path';

import ftp, { type FileInfo } from 'basic-ftp';

import { type DirectoryEntry, type RemoteFileClient } from './types.js';

type FtpConfig = {
  host: string;
  port: number;
  user: string;
  password: string;
  secure: boolean;
  timeoutMs: number;
};

export class FtpClient implements RemoteFileClient {
  private readonly client: ftp.Client;
  private readonly tempDir: string;

  constructor(private readonly config: FtpConfig) {
    this.client = new ftp.Client(config.timeoutMs);
    this.client.ftp.verbose = false;
    this.tempDir = path.join(os.tmpdir(), 'mcp-ftp');
  }

  private async ensureTempDir(): Promise<void> {
    await fs.mkdir(this.tempDir, { recursive: true });
  }

  private async connect(): Promise<void> {
    await this.client.access({
      host: this.config.host,
      port: this.config.port,
      user: this.config.user,
      password: this.config.password,
      secure: this.config.secure,
      timeout: this.config.timeoutMs,
    });
  }

  private async disconnect(): Promise<void> {
    try {
      await this.client.close();
    } catch (error) {
      // ignore disconnect issues
    }
  }

  async ping(): Promise<void> {
    await this.connect();
    try {
      await this.client.send('NOOP');
    } finally {
      await this.disconnect();
    }
  }

  async list(remotePath: string): Promise<DirectoryEntry[]> {
    await this.connect();
    try {
      const entries = await this.client.list(remotePath);
      return entries.map((entry: FileInfo) => ({
        name: entry.name,
        type: entry.isDirectory ? 'directory' : entry.isFile ? 'file' : 'other',
        size: entry.size,
        modifiedDate: entry.modifiedAt ? entry.modifiedAt.toISOString() : undefined,
      }));
    } finally {
      await this.disconnect();
    }
  }

  async download(remotePath: string): Promise<string> {
    await this.ensureTempDir();
    const tempPath = path.join(this.tempDir, `download-${Date.now()}-${path.basename(remotePath)}`);
    await this.connect();
    try {
      const writeStream = createWriteStream(tempPath);
      await this.client.downloadTo(writeStream, remotePath);
      await new Promise<void>((resolve, reject) => {
        writeStream.once('finish', resolve);
        writeStream.once('error', reject);
      });
      return await fs.readFile(tempPath, 'utf8');
    } finally {
      await this.disconnect();
      await fs.rm(tempPath, { force: true });
    }
  }

  async upload(remotePath: string, contents: string): Promise<void> {
    await this.ensureTempDir();
    const tempPath = path.join(this.tempDir, `upload-${Date.now()}-${path.basename(remotePath)}`);
    await fs.writeFile(tempPath, contents, 'utf8');
    await this.connect();
    try {
      const readStream = createReadStream(tempPath);
      await this.client.uploadFrom(readStream, remotePath);
    } finally {
      await this.disconnect();
      await fs.rm(tempPath, { force: true });
    }
  }

  async ensureDirectory(remotePath: string): Promise<void> {
    await this.connect();
    try {
      await this.client.ensureDir(remotePath);
    } finally {
      await this.disconnect();
    }
  }

  async deleteFile(remotePath: string): Promise<void> {
    await this.connect();
    try {
      await this.client.remove(remotePath);
    } finally {
      await this.disconnect();
    }
  }

  async deleteDirectory(remotePath: string): Promise<void> {
    await this.connect();
    try {
      await this.client.removeDir(remotePath);
    } finally {
      await this.disconnect();
    }
  }
}
