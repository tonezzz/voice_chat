export type DirectoryEntry = {
  name: string;
  type: 'file' | 'directory' | 'other';
  size: number;
  modifiedDate?: string;
};

export type TransferProtocol = 'ftp' | 'sftp';

export interface RemoteFileClient {
  list(remotePath: string): Promise<DirectoryEntry[]>;
  download(remotePath: string): Promise<string>;
  upload(remotePath: string, contents: string): Promise<void>;
  ensureDirectory(remotePath: string): Promise<void>;
  deleteFile(remotePath: string): Promise<void>;
  deleteDirectory(remotePath: string): Promise<void>;
  ping(): Promise<void>;
}
