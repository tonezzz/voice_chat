import fs from 'fs';
import process from 'process';
import type { ProcessEnv } from 'process';

import { z } from 'zod';

const booleanField = z.union([z.string(), z.boolean(), z.undefined()]).transform((value: string | boolean | undefined): boolean => {
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(normalized)) {
      return true;
    }
    if (['0', 'false', 'no', 'off', ''].includes(normalized)) {
      return false;
    }
  }
  return false;
});

const intField = (fallback: number) =>
  z.union([z.string(), z.number(), z.undefined()]).transform((value: string | number | undefined): number => {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === 'string' && value.trim()) {
      const parsed = Number.parseInt(value, 10);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
    return fallback;
  });

const stringField = (fallback: string) =>
  z.union([z.string(), z.undefined()]).transform((value: string | undefined): string => {
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (trimmed.length > 0) {
        return trimmed;
      }
    }
    return fallback;
  });

const optionalString = z.union([z.string(), z.undefined()]).transform((value: string | undefined) => {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  return undefined;
});

const configSchema = z.object({
  FTP_HOST: stringField('localhost'),
  FTP_PORT: intField(21),
  FTP_USER: stringField('anonymous'),
  FTP_PASSWORD: stringField(''),
  FTP_SECURE: booleanField,
  FTP_PROTOCOL: stringField('ftp').transform((value) => (value.toLowerCase() === 'sftp' ? 'sftp' : 'ftp')),
  SFTP_HOST: optionalString,
  SFTP_PORT: intField(22),
  SFTP_USERNAME: optionalString,
  SFTP_PASSWORD: optionalString,
  SFTP_PRIVATE_KEY: optionalString,
  SFTP_PRIVATE_KEY_PATH: optionalString,
  SFTP_PASSPHRASE: optionalString,
  FTP_ROOT: stringField('/'),
  FTP_TIMEOUT_MS: intField(10000),
});

export type ServiceConfig = {
  ftpHost: string;
  ftpPort: number;
  ftpUser: string;
  ftpPassword: string;
  ftpSecure: boolean;
  protocol: 'ftp' | 'sftp';
  sftpHost?: string;
  sftpPort?: number;
  sftpUsername?: string;
  sftpPassword?: string;
  sftpPrivateKey?: string;
  sftpPassphrase?: string;
  ftpRoot: string;
  timeoutMs: number;
};

function loadPrivateKey(pathOrValue?: string): string | undefined {
  if (!pathOrValue) {
    return undefined;
  }
  try {
    if (fs.existsSync(pathOrValue)) {
      return fs.readFileSync(pathOrValue, 'utf8');
    }
  } catch (error) {
    // If reading from filesystem fails, fall through and treat the value as literal key content
  }
  return pathOrValue;
}

export function resolveConfig(env: ProcessEnv = process.env): ServiceConfig {
  const raw = configSchema.parse(env);
  return {
    ftpHost: raw.FTP_HOST,
    ftpPort: raw.FTP_PORT,
    ftpUser: raw.FTP_USER,
    ftpPassword: raw.FTP_PASSWORD,
    ftpSecure: raw.FTP_SECURE,
    protocol: raw.FTP_PROTOCOL as 'ftp' | 'sftp',
    sftpHost: raw.SFTP_HOST || raw.FTP_HOST,
    sftpPort: raw.SFTP_PORT || 22,
    sftpUsername: raw.SFTP_USERNAME || raw.FTP_USER,
    sftpPassword: raw.SFTP_PASSWORD || raw.FTP_PASSWORD,
    sftpPrivateKey: loadPrivateKey(raw.SFTP_PRIVATE_KEY || raw.SFTP_PRIVATE_KEY_PATH),
    sftpPassphrase: raw.SFTP_PASSPHRASE,
    ftpRoot: raw.FTP_ROOT,
    timeoutMs: raw.FTP_TIMEOUT_MS,
  };
}
