import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const envCandidates = [
  path.resolve(__dirname, '../../../.env'),
  path.resolve(__dirname, '../../.env'),
];

for (const candidate of envCandidates) {
  if (fs.existsSync(candidate)) {
    dotenv.config({ path: candidate, override: true });
  }
}

const asNumber = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

export const PORT = asNumber(process.env.INSTRANS_PORT, 3100);
export const STT_URL = process.env.INSTRANS_STT_URL || process.env.STT_URL || 'http://stt-whisper-gpu:5001';
export const DEFAULT_TARGET_LANGUAGE = process.env.INSTRANS_DEFAULT_LANG || 'en';
export const CLIENT_ORIGIN = process.env.INSTRANS_ALLOWED_ORIGIN || '*';
export const SUMMARY_SENTENCE_LIMIT = asNumber(process.env.INSTRANS_SUMMARY_SENTENCES, 3);
export const SSE_HEARTBEAT_MS = asNumber(process.env.INSTRANS_SSE_HEARTBEAT_MS, 15000);
export const AUDIO_CHUNK_LIMIT_BYTES = asNumber(process.env.INSTRANS_AUDIO_CHUNK_LIMIT, 5 * 1024 * 1024);
export const ENABLE_TRANSLATION = process.env.INSTRANS_ENABLE_TRANSLATION !== 'false';
export const ENABLE_SUMMARIZER = process.env.INSTRANS_ENABLE_SUMMARY !== 'false';
