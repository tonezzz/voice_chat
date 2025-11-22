import { FtpClient } from './ftpClient.js';
import { SftpClient } from './sftpClient.js';
import type { ServiceConfig } from './config.js';
import type { RemoteFileClient } from './types.js';

export function createRemoteClient(config: ServiceConfig): RemoteFileClient {
  if (config.protocol === 'sftp') {
    return new SftpClient({
      host: config.sftpHost ?? config.ftpHost,
      port: config.sftpPort ?? 22,
      username: config.sftpUsername ?? config.ftpUser,
      password: config.sftpPassword,
      privateKey: config.sftpPrivateKey,
      passphrase: config.sftpPassphrase,
      timeoutMs: config.timeoutMs,
    });
  }

  return new FtpClient({
    host: config.ftpHost,
    port: config.ftpPort,
    user: config.ftpUser,
    password: config.ftpPassword,
    secure: config.ftpSecure,
    timeoutMs: config.timeoutMs,
  });
}
