import express from 'express';
import cors from 'cors';
import multer from 'multer';
import FormData from 'form-data';
import fetch from 'node-fetch';
import translate from '@vitalets/google-translate-api';
import { randomUUID } from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import pino from 'pino';

import {
  PORT,
  STT_URL,
  DEFAULT_TARGET_LANGUAGE,
  CLIENT_ORIGIN,
  SUMMARY_SENTENCE_LIMIT,
  SSE_HEARTBEAT_MS,
  AUDIO_CHUNK_LIMIT_BYTES,
  ENABLE_TRANSLATION,
  ENABLE_SUMMARIZER,
} from './config.js';

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

const app = express();
const jsonLimit = process.env.INSTRANS_JSON_LIMIT || '2mb';
const urlEncodedLimit = process.env.INSTRANS_URLENCODED_LIMIT || '2mb';

const allowedOrigins = CLIENT_ORIGIN === '*'
  ? true
  : CLIENT_ORIGIN.split(',').map((entry) => entry.trim()).filter(Boolean);

app.use(cors({ origin: allowedOrigins, credentials: true }));
app.use(express.json({ limit: jsonLimit }));
app.use(express.urlencoded({ limit: urlEncodedLimit, extended: true }));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: AUDIO_CHUNK_LIMIT_BYTES },
});

const sessions = new Map();
const sseClients = new Map();
const MAX_TRANSCRIPTS = Number(process.env.INSTRANS_MAX_TRANSCRIPTS || 200);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const staticDir = path.resolve(__dirname, '../public');
const indexHtmlPath = path.join(staticDir, 'index.html');

app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    port: PORT,
    targetLanguage: DEFAULT_TARGET_LANGUAGE,
    sttUrl: STT_URL,
    translationEnabled: ENABLE_TRANSLATION,
    summaryEnabled: ENABLE_SUMMARIZER,
  });
});

app.post('/api/session', (req, res) => {
  try {
    const desiredLang = sanitizeLang(req.body?.targetLanguage) || DEFAULT_TARGET_LANGUAGE;
    const session = createSession(desiredLang);
    sessions.set(session.id, session);
    logger.info({ sessionId: session.id, targetLanguage: session.targetLanguage }, 'session created');
    res.json({ sessionId: session.id, session: serializeSession(session) });
  } catch (error) {
    logger.error(error, 'failed to create session');
    res.status(500).json({ error: 'session_create_failed' });
  }
});

app.patch('/api/session/:sessionId/target-language', async (req, res) => {
  const sessionId = String(req.params.sessionId || '').trim();
  const newLang = sanitizeLang(req.body?.targetLanguage);
  if (!sessionId) {
    return res.status(400).json({ error: 'session_id_required' });
  }
  if (!newLang) {
    return res.status(400).json({ error: 'target_language_required' });
  }

  const session = sessions.get(sessionId);
  if (!session) {
    return res.status(404).json({ error: 'session_not_found' });
  }

  try {
    session.targetLanguage = newLang;
    if (ENABLE_TRANSLATION && session.transcripts.length) {
      for (const entry of session.transcripts) {
        entry.translation = await translateText(entry.text, newLang);
        entry.targetLanguage = newLang;
      }
    }
    session.summary = buildSummary(session.transcripts);
    session.updatedAt = Date.now();
    broadcastSession(session);
    res.json({ session: serializeSession(session) });
  } catch (error) {
    logger.error({ error, sessionId, newLang }, 'failed to update target language');
    res.status(500).json({ error: 'target_language_update_failed' });
  }
});

app.get('/api/stream/:sessionId', (req, res) => {
  const sessionId = String(req.params.sessionId || '').trim();
  const session = sessions.get(sessionId);
  if (!session) {
    return res.status(404).json({ error: 'session_not_found' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  if (allowedOrigins === true) {
    res.setHeader('Access-Control-Allow-Origin', '*');
  }
  res.flushHeaders?.();

  registerSseClient(sessionId, res);
  sendSse(res, 'session', serializeSession(session));

  const heartbeat = setInterval(() => {
    sendSse(res, 'heartbeat', { timestamp: Date.now() });
  }, SSE_HEARTBEAT_MS);

  req.on('close', () => {
    clearInterval(heartbeat);
    unregisterSseClient(sessionId, res);
    res.end();
  });
});

app.post('/api/chunk', upload.single('audio'), async (req, res) => {
  const sessionId = String(req.body?.sessionId || '').trim();
  const session = sessions.get(sessionId);
  if (!session) {
    return res.status(404).json({ error: 'session_not_found' });
  }

  if (!req.file) {
    return res.status(400).json({ error: 'audio_file_required' });
  }

  try {
    if (req.body?.targetLanguage) {
      const updated = sanitizeLang(req.body.targetLanguage);
      if (updated) {
        session.targetLanguage = updated;
      }
    }

    const sttResult = await transcribeWithWhisper(req.file, req.body?.sourceLanguage);
    const rawText = (sttResult?.text || '').trim();
    if (!rawText) {
      return res.status(422).json({ error: 'empty_transcript' });
    }

    const translation = await translateText(rawText, session.targetLanguage);
    const entry = buildTranscriptEntry({
      text: rawText,
      translation,
      detectedLanguage: sttResult?.language || 'auto',
      targetLanguage: session.targetLanguage,
    });

    session.transcripts.push(entry);
    if (session.transcripts.length > MAX_TRANSCRIPTS) {
      session.transcripts.splice(0, session.transcripts.length - MAX_TRANSCRIPTS);
    }
    session.summary = buildSummary(session.transcripts);
    session.updatedAt = Date.now();

    broadcastSession(session);
    res.json({ entry, session: serializeSession(session) });
  } catch (error) {
    logger.error({ error }, 'chunk processing failed');
    res.status(500).json({ error: 'chunk_processing_failed', detail: error.message });
  }
});

if (fs.existsSync(staticDir)) {
  app.use(express.static(staticDir));
}

app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api')) {
    return next();
  }
  if (fs.existsSync(indexHtmlPath)) {
    return res.sendFile(indexHtmlPath);
  }
  return res.status(200).send('instrans UI not built yet. Run the client build first.');
});

app.listen(PORT, () => {
  logger.info({ port: PORT }, 'instrans service ready');
});

function createSession(targetLanguage) {
  return {
    id: randomUUID(),
    targetLanguage: targetLanguage || DEFAULT_TARGET_LANGUAGE,
    transcripts: [],
    summary: '',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

function sanitizeLang(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

async function transcribeWithWhisper(file, sourceLanguage) {
  const form = new FormData();
  form.append('file', file.buffer, {
    filename: file.originalname || `chunk-${Date.now()}.webm`,
    contentType: file.mimetype || 'audio/webm',
  });
  const normalized = sanitizeLang(sourceLanguage);
  if (normalized && normalized !== 'auto') {
    form.append('language', normalized);
  }
  const response = await fetch(`${STT_URL}/transcribe`, {
    method: 'POST',
    body: form,
    headers: form.getHeaders(),
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`stt_failed: ${detail}`);
  }
  return response.json();
}

async function translateText(text, targetLanguage) {
  if (!ENABLE_TRANSLATION) {
    return text;
  }
  const trimmed = (text || '').trim();
  if (!trimmed) {
    return '';
  }
  const lang = sanitizeLang(targetLanguage) || DEFAULT_TARGET_LANGUAGE;
  if (lang === 'auto' || lang === '') {
    return trimmed;
  }
  try {
    const result = await translate(trimmed, { to: lang });
    return result?.text || trimmed;
  } catch (error) {
    logger.warn({ error }, 'translation failed, falling back to original text');
    return trimmed;
  }
}

function buildTranscriptEntry({ text, translation, detectedLanguage, targetLanguage }) {
  return {
    id: randomUUID(),
    text,
    translation,
    detectedLanguage,
    targetLanguage,
    timestamp: Date.now(),
  };
}

function buildSummary(entries) {
  if (!ENABLE_SUMMARIZER || !entries.length) {
    return '';
  }
  const recent = entries
    .map((entry) => entry.translation || entry.text)
    .filter(Boolean)
    .slice(-SUMMARY_SENTENCE_LIMIT);
  if (!recent.length) {
    return '';
  }
  return recent
    .map((line, index) => `${index + 1}. ${line}`)
    .join('\n');
}

function serializeSession(session) {
  return {
    id: session.id,
    targetLanguage: session.targetLanguage,
    summary: session.summary,
    transcripts: session.transcripts,
    updatedAt: session.updatedAt,
  };
}

function registerSseClient(sessionId, res) {
  const existing = sseClients.get(sessionId) || new Set();
  existing.add(res);
  sseClients.set(sessionId, existing);
}

function unregisterSseClient(sessionId, res) {
  const clients = sseClients.get(sessionId);
  if (!clients) {
    return;
  }
  clients.delete(res);
  if (!clients.size) {
    sseClients.delete(sessionId);
  }
}

function broadcastSession(session) {
  const clients = sseClients.get(session.id);
  if (!clients || !clients.size) {
    return;
  }
  const payload = JSON.stringify(serializeSession(session));
  for (const client of clients) {
    sendSse(client, 'session', payload, true);
  }
}

function sendSse(res, event, data, isSerialized = false) {
  const payload = isSerialized ? data : JSON.stringify(data);
  res.write(`event: ${event}\n`);
  res.write(`data: ${payload}\n\n`);
}
