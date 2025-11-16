const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const multer = require('multer');
const FormData = require('form-data');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
app.use(cors());
app.use(express.json());

app.use(express.static(path.join(__dirname, 'public')));

const upload = multer({ storage: multer.memoryStorage() });

const uploadsDir = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

const attachmentStorage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, uploadsDir);
  },
  filename: (_req, file, cb) => {
    const timestamp = Date.now();
    const original = file.originalname || 'upload';
    const safeName = original.replace(/[^a-zA-Z0-9._-]/g, '_');
    cb(null, `${timestamp}-${safeName}`);
  }
});

const attachmentUpload = multer({
  storage: attachmentStorage,
  limits: {
    fileSize: Number(process.env.MAX_ATTACHMENT_BYTES) || 25 * 1024 * 1024
  }
});

const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const OLLAMA_GPU_URL = process.env.OLLAMA_GPU_URL || '';
const MODEL = process.env.MODEL || 'llama3';
const PORT = process.env.PORT || 3001;
const STT_URL = process.env.STT_URL || 'http://localhost:5001';
const STT_GPU_URL = process.env.STT_GPU_URL || '';
const TTS_ENABLED = process.env.TTS_ENABLED === 'true';
const TTS_URL = process.env.TTS_URL || 'http://tts:59125';
const TTS_GPU_URL = process.env.TTS_GPU_URL || '';
const TTS_VOICE = process.env.TTS_VOICE || '';
const YOLO_MCP_URL = process.env.YOLO_MCP_URL || 'http://localhost:8000';

const shouldUseGpu = (accelerator) => accelerator === 'gpu';

const pickOllamaBase = (accelerator) => {
  if (shouldUseGpu(accelerator) && OLLAMA_GPU_URL) {
    return OLLAMA_GPU_URL;
  }
  return OLLAMA_URL;
};

const sessions = new Map();
const MAX_SESSION_MESSAGES = Number(process.env.MAX_SESSION_MESSAGES) || 200;
const VALID_ROLES = new Set(['user', 'assistant', 'system']);

const generateId = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`);

const createSession = (name) => {
  const id = generateId();
  const session = {
    id,
    name: name || `Session ${new Date().toLocaleString()}`,
    createdAt: Date.now(),
    messages: []
  };
  sessions.set(id, session);
  return session;
};

const getSession = (id) => {
  if (!id) return null;
  return sessions.get(id) || null;
};

const ensureSession = (id, name) => {
  const existing = getSession(id);
  if (existing) return existing;
  return createSession(name);
};

const addSessionMessage = (session, payload) => {
  const message = {
    id: generateId(),
    timestamp: Date.now(),
    role: payload.role,
    content: payload.content,
    model: payload.model || null,
    sttModel: payload.sttModel || null,
    accelerator: payload.accelerator || null,
    attachmentType: payload.attachmentType || null,
    attachmentName: payload.attachmentName || null,
    attachmentUrl: payload.attachmentUrl || null
  };
  session.messages.push(message);
  while (session.messages.length > MAX_SESSION_MESSAGES) {
    session.messages.shift();
  }
  return message;
};

const hydrateSessionHistory = (session, history) => {
  if (!Array.isArray(history) || !history.length) return;
  history.slice(-MAX_SESSION_MESSAGES).forEach((entry) => {
    if (!entry || typeof entry.content !== 'string') return;
    if (!VALID_ROLES.has(entry.role)) return;
    addSessionMessage(session, {
      role: entry.role,
      content: entry.content,
      model: null,
      sttModel: null,
      accelerator: null
    });
  });
};

const sessionToResponse = (session) => ({
  sessionId: session.id,
  name: session.name,
  createdAt: session.createdAt,
  messages: session.messages
});

const formatMessagesForOllama = (session) =>
  session.messages.map((msg) => ({
    role: msg.role === 'system' ? 'system' : msg.role,
    content: msg.content
  }));

app.post('/sessions', (req, res) => {
  const { name } = req.body || {};
  const session = createSession(name);
  return res.json(sessionToResponse(session));
});

app.get('/sessions/:id', (req, res) => {
  const session = getSession(req.params.id);
  if (!session) {
    return res.status(404).json({ error: 'session_not_found' });
  }
  return res.json(sessionToResponse(session));
});

app.post('/sessions/:id/messages', (req, res) => {
  const session = getSession(req.params.id);
  if (!session) {
    return res.status(404).json({ error: 'session_not_found' });
  }

  const { role, content, model, sttModel, accelerator, attachmentType, attachmentName, attachmentUrl } =
    req.body || {};

  if (!role || !content) {
    return res.status(400).json({ error: 'role_and_content_required' });
  }

  addSessionMessage(session, {
    role,
    content,
    model,
    sttModel,
    accelerator,
    attachmentType,
    attachmentName,
    attachmentUrl
  });

  return res.json({ session: sessionToResponse(session) });
});

const pickSttBase = (accelerator) => {
  if (shouldUseGpu(accelerator) && STT_GPU_URL) {
    return STT_GPU_URL;
  }
  return STT_URL;
};

const pickTtsBase = (accelerator) => {
  if (shouldUseGpu(accelerator) && TTS_GPU_URL) {
    return TTS_GPU_URL;
  }
  return TTS_URL;
};

const ttsDir = path.join(__dirname, 'public', 'tts');
if (!fs.existsSync(ttsDir)) {
  fs.mkdirSync(ttsDir, { recursive: true });
}

const synthesizeSpeech = async (text, accelerator) => {
  if (!TTS_ENABLED || !text || !text.trim()) {
    return null;
  }

  try {
    const baseUrl = pickTtsBase(accelerator);
    const payload = { text };
    if (TTS_VOICE) {
      payload.voice = TTS_VOICE;
    }

    const response = await fetch(`${baseUrl.replace(/\/$/, '')}/synthesize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error('TTS error:', errText);
      return null;
    }

    const arrayBuffer = await response.arrayBuffer();
    const filename = `${Date.now()}-${Math.random().toString(36).slice(2)}.wav`;
    const filepath = path.join(ttsDir, filename);
    await fs.promises.writeFile(filepath, Buffer.from(arrayBuffer));
    return `/tts/${filename}`;
  } catch (err) {
    console.error('TTS synthesis failed:', err);
    return null;
  }
};

app.post('/voice-chat', async (req, res) => {
  const { message, model, accelerator, sessionId, sessionName, history } = req.body || {};
  if (!message) return res.status(400).json({ error: 'message is required' });

  const modelToUse = model || MODEL;
  const baseUrl = pickOllamaBase(accelerator);
  let session = getSession(sessionId);
  if (!session) {
    session = createSession(sessionName);
    hydrateSessionHistory(session, history);
  }
  addSessionMessage(session, {
    role: 'user',
    content: message,
    model: modelToUse,
    accelerator
  });

  try {
    const response = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: modelToUse,
        messages: formatMessagesForOllama(session),
        stream: false
      })
    });

    if (!response.ok) {
      const text = await response.text();
      console.error('Ollama error:', text);
      return res.status(500).json({ error: 'ollama error', detail: text });
    }

    const data = await response.json();
    const reply = (data.message && data.message.content) || data.response || '';
    addSessionMessage(session, {
      role: 'assistant',
      content: reply,
      model: modelToUse,
      accelerator
    });
    const audioUrl = await synthesizeSpeech(reply, accelerator);
    return res.json({ reply, audioUrl, session: sessionToResponse(session) });
  } catch (err) {
    console.error('Server error:', err);
    return res.status(500).json({ error: 'server error' });
  }
});

app.post('/attachments', (req, res) => {
  attachmentUpload.single('file')(req, res, (err) => {
    if (err) {
      console.error('Attachment upload error:', err);
      const status = err instanceof multer.MulterError ? 400 : 500;
      return res.status(status).json({ error: 'attachment_upload_failed', detail: err.message });
    }

    if (!req.file) {
      return res.status(400).json({ error: 'file is required' });
    }

    const fileUrl = `/uploads/${req.file.filename}`;
    return res.json({
      url: fileUrl,
      filename: req.file.filename,
      originalName: req.file.originalname,
      mimetype: req.file.mimetype,
      size: req.file.size
    });
  });
});

const normalizeBaseUrl = (url) => (url || '').replace(/\/$/, '');

app.post('/detect-image', upload.single('image'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'image file is required' });
  }

  const baseUrl = normalizeBaseUrl(YOLO_MCP_URL || '');
  if (!baseUrl) {
    return res.status(500).json({ error: 'yolo_mcp_unconfigured' });
  }

  const imageBase64 = `data:${req.file.mimetype || 'application/octet-stream'};base64,${req.file.buffer.toString('base64')}`;
  const payload = {
    image_base64: imageBase64
  };

  if (req.body && typeof req.body.confidence !== 'undefined') {
    const parsed = Number(req.body.confidence);
    if (!Number.isNaN(parsed)) {
      payload.confidence = Math.max(0, Math.min(1, parsed));
    }
  }

  try {
    console.log('[yolo] forwarding detect-image request', {
      target: `${baseUrl}/detect`,
      payloadSizeBytes: imageBase64.length,
      confidence: payload.confidence ?? 'default'
    });
    const response = await fetch(`${baseUrl}/detect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const detail = await response.text();
      console.error('YOLO MCP error:', detail);
      return res.status(502).json({ error: 'yolo_mcp_error', detail });
    }

    const data = await response.json();
    console.log('[yolo] detection response received', {
      detectionCount: Array.isArray(data?.detections) ? data.detections.length : 0
    });
    const detections = Array.isArray(data?.detections) ? data.detections : [];

    return res.json({
      detections,
      image: imageBase64,
      confidence: typeof payload.confidence === 'number' ? payload.confidence : 0.25
    });
  } catch (err) {
    console.error('YOLO detection failed:', err);
    return res.status(500).json({ error: 'server_error' });
  }
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.post('/voice-chat-audio', upload.single('audio'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'audio file is required' });

  try {
    const modelFromForm = req.body && req.body.model;
    const modelToUse = modelFromForm || MODEL;
    const whisperFromForm =
      req.body && (req.body.whisper_model || req.body.whisperModel);
    const formData = new FormData();
    formData.append('file', req.file.buffer, {
      filename: 'audio.webm',
      contentType: req.file.mimetype || 'audio/webm'
    });

    if (whisperFromForm) {
      formData.append('whisper_model', whisperFromForm);
    }

    const targetAccelerator = req.body && req.body.accelerator;
    const sttBase = pickSttBase(targetAccelerator);
    const sttRes = await fetch(`${sttBase}/transcribe`, {
      method: 'POST',
      body: formData
    });

    if (!sttRes.ok) {
      const text = await sttRes.text();
      console.error('STT error:', text);
      return res.status(500).json({ error: 'stt_error', detail: text });
    }

    const sttData = await sttRes.json();
    const transcript = sttData.text;
    if (!transcript) {
      return res.status(500).json({ error: 'no transcript returned from STT' });
    }

    const session = ensureSession(req.body && req.body.sessionId, req.body && req.body.sessionName);
    addSessionMessage(session, {
      role: 'user',
      content: transcript,
      model: modelToUse,
      sttModel: whisperFromForm || null,
      accelerator: targetAccelerator
    });

    const ollamaBase = pickOllamaBase(targetAccelerator);
    const ollamaRes = await fetch(`${ollamaBase}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: modelToUse,
        messages: formatMessagesForOllama(session),
        stream: false
      })
    });

    if (!ollamaRes.ok) {
      const text = await ollamaRes.text();
      console.error('Ollama error:', text);
      return res.status(500).json({ error: 'ollama_error', detail: text });
    }

    const ollamaData = await ollamaRes.json();
    const reply = (ollamaData.message && ollamaData.message.content) || ollamaData.response || '';
    addSessionMessage(session, {
      role: 'assistant',
      content: reply,
      model: modelToUse,
      sttModel: whisperFromForm || null,
      accelerator: targetAccelerator
    });
    const audioUrl = await synthesizeSpeech(reply, targetAccelerator);
    return res.json({ transcript, reply, audioUrl, session: sessionToResponse(session) });
  } catch (err) {
    console.error('audio flow error:', err);
    return res.status(500).json({ error: 'server error' });
  }
});

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    port: PORT,
    ollamaUrl: OLLAMA_URL,
    ollamaGpuUrl: OLLAMA_GPU_URL || null,
    defaultModel: MODEL,
    sttUrl: STT_URL,
    sttGpuUrl: STT_GPU_URL || null
  });
});

app.listen(PORT, () => {
  console.log(`Server listening on http://0.0.0.0:${PORT}`);
  console.log(`Using Ollama at ${OLLAMA_URL} with model ${MODEL}`);
  if (OLLAMA_GPU_URL) {
    console.log(`GPU Ollama available at ${OLLAMA_GPU_URL}`);
  }
  console.log(`Using STT at ${STT_URL}`);
  if (STT_GPU_URL) {
    console.log(`GPU STT available at ${STT_GPU_URL}`);
  }
});
