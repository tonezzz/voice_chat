const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const multer = require('multer');
const FormData = require('form-data');
const crypto = require('crypto');
const Tesseract = require('tesseract.js');

const app = express();
const JSON_BODY_LIMIT = process.env.JSON_BODY_LIMIT || '1mb';
app.use(cors());
app.use(express.json({ limit: JSON_BODY_LIMIT }));
app.use(express.urlencoded({ limit: JSON_BODY_LIMIT, extended: true }));

app.use(express.static(path.join(__dirname, 'public')));

const upload = multer({ storage: multer.memoryStorage() });

app.post('/verify-slip', upload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'file is required' });
  }

  const baseUrl = normalizeBaseUrl(BSLIP_MCP_URL || '');
  if (!baseUrl) {
    return res.status(500).json({ error: 'bslip_mcp_unconfigured' });
  }

  const form = new FormData();
  form.append('file', req.file.buffer, {
    filename: req.file.originalname || 'bankslip.jpg',
    contentType: req.file.mimetype || 'application/octet-stream'
  });

  const referenceId = typeof req.body?.reference_id === 'string' ? req.body.reference_id.trim() : '';
  if (referenceId) {
    form.append('reference_id', referenceId);
  }

  try {
    console.log('[bslip] forwarding verify-slip request', {
      target: `${baseUrl}/verify`,
      name: req.file.originalname,
      referenceId: referenceId || undefined
    });

    const response = await fetch(`${baseUrl}/verify`, {
      method: 'POST',
      headers: form.getHeaders(),
      body: form
    });

    if (!response.ok) {
      const detailText = await response.text();
      console.error('BSLIP MCP error:', detailText);
      let detailJson;
      try {
        detailJson = JSON.parse(detailText);
      } catch (parseErr) {
        detailJson = undefined;
      }

      return res.status(502).json({
        error: 'bslip_mcp_error',
        detail: detailJson || detailText,
        target: `${baseUrl}/verify`,
        source: req.file?.originalname,
        mimetype: req.file?.mimetype
      });
    }

    const data = await response.json();
    return res.json(data);
  } catch (err) {
    console.error('Bank slip verification failed:', err);
    return res.status(500).json({
      error: 'server_error',
      message: err?.message || 'Bank slip verification failed',
      source: req.file?.originalname,
      mimetype: req.file?.mimetype,
      stack: process.env.NODE_ENV === 'production' ? undefined : err?.stack
    });
  }
});

app.get('/meeting/sessions', async (req, res) => {
  try {
    if (!MEETING_MCP_URL) {
      return res.status(503).json({ error: 'meeting_mcp_unconfigured' });
    }

    const includeArchived = String(req.query.includeArchived).toLowerCase() === 'true';
    const payload = await invokeMeetingTool('list_sessions', {
      include_archived: includeArchived
    });
    return res.json(unwrapMeetingResponse(payload));
  } catch (err) {
    console.error('meeting sessions list failed', err);
    return res.status(502).json({ error: err?.message || 'meeting_sessions_failed' });
  }
});

app.post('/meeting/sessions', async (req, res) => {
  try {
    if (!MEETING_MCP_URL) {
      return res.status(503).json({ error: 'meeting_mcp_unconfigured' });
    }

    const { sessionId, title, participants, tags, language } = req.body || {};
    if (typeof sessionId !== 'string' || !sessionId.trim()) {
      return res.status(400).json({ error: 'sessionId is required' });
    }
    const session = await invokeMeetingTool('start_meeting', {
      session_id: sessionId.trim(),
      title: typeof title === 'string' ? title : undefined,
      participants: Array.isArray(participants) ? participants : undefined,
      language: typeof language === 'string' ? language : undefined,
      tags: Array.isArray(tags) ? tags : undefined
    });
    return res.json(unwrapMeetingResponse(session));
  } catch (err) {
    console.error('meeting session create failed', err);
    return res.status(502).json({ error: err?.message || 'meeting_session_create_failed' });
  }
});

app.get('/meeting/sessions/:sessionId', async (req, res) => {
  try {
    if (!MEETING_MCP_URL) {
      return res.status(503).json({ error: 'meeting_mcp_unconfigured' });
    }

    const sessionId = (req.params.sessionId || '').trim();
    if (!sessionId) {
      return res.status(400).json({ error: 'sessionId is required' });
    }
    let entryLimit;
    if (typeof req.query.entryLimit !== 'undefined') {
      const parsed = Number(req.query.entryLimit);
      if (Number.isFinite(parsed) && parsed > 0) {
        entryLimit = parsed;
      }
    }
    const payload = await invokeMeetingTool('get_meeting_notes', {
      session_id: sessionId,
      entry_limit: entryLimit
    });
    return res.json(unwrapMeetingResponse(payload));
  } catch (err) {
    console.error('meeting session detail failed', err);
    return res.status(502).json({ error: err?.message || 'meeting_session_detail_failed' });
  }
});

app.post('/meeting/sessions/:sessionId/summarize', async (req, res) => {
  try {
    if (!MEETING_MCP_URL) {
      return res.status(503).json({ error: 'meeting_mcp_unconfigured' });
    }

    const sessionId = (req.params.sessionId || '').trim();
    if (!sessionId) {
      return res.status(400).json({ error: 'sessionId is required' });
    }
    let maxEntries;
    if (typeof req.body?.maxEntries !== 'undefined') {
      const parsed = Number(req.body.maxEntries);
      if (Number.isFinite(parsed) && parsed > 0) {
        maxEntries = parsed;
      }
    }
    const payload = await invokeMeetingTool('summarize_meeting', {
      session_id: sessionId,
      max_entries: maxEntries
    });
    return res.json(unwrapMeetingResponse(payload));
  } catch (err) {
    console.error('meeting session summarize failed', err);
    return res.status(502).json({ error: err?.message || 'meeting_session_summarize_failed' });
  }
});

app.post('/meeting/append-transcript', async (req, res) => {
  try {
    if (!MEETING_MCP_URL) {
      return res.status(503).json({ error: 'meeting_mcp_unconfigured' });
    }

    const { sessionId, text, speaker, participants, title, tags, language } = req.body || {};
    const trimmed = typeof text === 'string' ? text.trim() : '';
    if (!trimmed) {
      return res.status(400).json({ error: 'text is required' });
    }

    const meetingSessionId = typeof sessionId === 'string' && sessionId.trim().length ? sessionId.trim() : `browser-${Date.now()}`;

    await invokeMeetingTool('start_meeting', {
      session_id: meetingSessionId,
      title: typeof title === 'string' ? title : undefined,
      participants: Array.isArray(participants) ? participants : undefined,
      language,
      tags: Array.isArray(tags) ? tags : undefined
    });

    const entry = await invokeMeetingTool('append_transcript', {
      session_id: meetingSessionId,
      text: trimmed,
      speaker: typeof speaker === 'string' ? speaker : undefined,
      source_label: 'browser_stt'
    });

    return res.json({ sessionId: meetingSessionId, entry: unwrapMeetingResponse(entry) });
  } catch (err) {
    console.error('meeting append failed', err);
    const detail = err?.message || 'meeting_append_failed';
    return res.status(502).json({ error: detail });
  }
});

app.post('/voice-chat-stream', async (req, res) => {
  setupSse(res);
  const { message, model, accelerator, sessionId, sessionName, history, voice, provider } = req.body || {};
  if (!message) {
    sendSseEvent(res, { type: 'error', error: 'message is required' });
    closeSse(res);
    return;
  }

  const requestedProvider = normalizeProvider(provider);
  const modelToUse = resolveModelForProvider(requestedProvider, model);
  const selectedVoice = typeof voice === 'string' ? voice.trim() : '';

  if (!providerRequiresKey(requestedProvider)) {
    sendSseEvent(res, { type: 'error', error: 'provider_unavailable' });
    closeSse(res);
    return;
  }

  let session = getSession(sessionId);
  if (!session) {
    session = createSession(sessionName, requestedProvider);
    hydrateSessionHistory(session, history);
  } else if (provider) {
    session.provider = requestedProvider;
  }

  ensureAutomationSystemMessage(session);

  addSessionMessage(session, {
    role: 'user',
    content: message,
    model: modelToUse,
    accelerator,
    voiceId: typeof voice === 'string' ? voice : null
  });

  const streamingEnabled = providerSupportsStreaming(session.provider);

  try {
    let reply = '';
    let resolvedServer = '';
    let toolRuns = [];

    if (streamingEnabled) {
      const commonParams = {
        session,
        modelToUse,
        accelerator,
        body: req.body,
        onDelta: (delta, accumulated) => {
          sendSseEvent(res, { type: 'delta', delta, full: accumulated });
        }
      };

      let streamResult;
      if (isAnthropicProvider(session.provider)) {
        streamResult = await streamAnthropicCompletion(commonParams);
      } else if (isOpenAiProvider(session.provider)) {
        streamResult = await streamOpenAiCompletion(commonParams);
      } else if (isGithubProvider(session.provider)) {
        streamResult = await streamGithubCompletion(commonParams);
      } else {
        streamResult = await streamOllamaCompletion(commonParams);
      }
      reply = streamResult.reply;
      resolvedServer = streamResult.resolvedServer;
      if (reply && MCP0_BASE_URL) {
        const { cleanText, instructions } = extractMcpToolInstructions(reply);
        reply = cleanText || reply;
        toolRuns = await executeMcpInstructions(instructions);
      }
    } else {
      const { reply: fullReply, resolvedServer: usedServer, toolRuns: resolvedTools } = await executeChatCompletion({
        session,
        modelToUse,
        accelerator,
        body: req.body
      });
      reply = fullReply;
      resolvedServer = usedServer;
      toolRuns = resolvedTools;
      if (reply) {
        sendSseEvent(res, { type: 'delta', delta: reply, full: reply });
      }
    }

    addSessionMessage(session, {
      role: 'assistant',
      content: reply,
      model: modelToUse,
      accelerator,
      voiceId: typeof selectedVoice === 'string' ? selectedVoice : null
    });

    const audioUrl = await synthesizeSpeech(reply, accelerator, selectedVoice);
    const diagnosticsPayload = buildDiagnostics({
      provider: session.provider,
      model: modelToUse,
      accelerator,
      server:
        resolvedServer ||
        resolveProviderServerInfo(session.provider, {
          accelerator,
          githubDeployment: req.body?.github_deployment || req.body?.githubDeployment
        })
    });

    sendSseEvent(res, {
      type: 'complete',
      reply,
      audioUrl,
      session: sessionToResponse(session),
      provider: session.provider,
      voiceId: typeof selectedVoice === 'string' ? selectedVoice : null,
      diagnostics: diagnosticsPayload,
      mcpTools: toolRuns
    });
  } catch (err) {
    console.error('Streaming server error:', err);
    sendSseEvent(res, { type: 'error', error: err?.message || 'server error' });
  } finally {
    closeSse(res);
  }
});

app.get('/github-model/health', async (_req, res) => {
  try {
    const status = await checkGithubModelHealth();
    return res.json(status);
  } catch (err) {
    console.error('GitHub model health check failed:', err);
    return res.status(500).json({ name: 'githubModel', status: 'error', detail: err?.message || 'unknown_error' });
  }
});

app.post('/identify-people', upload.single('image'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'image file is required' });
  }

  const requestedAccelerator = typeof req.body?.accelerator === 'string' ? req.body.accelerator.trim().toLowerCase() : 'cpu';
  const { baseUrl, accelerator } = pickIdpBase(requestedAccelerator);
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl || '');
  if (!normalizedBaseUrl) {
    return res.status(500).json({ error: 'idp_mcp_unconfigured' });
  }

  const imageBase64 = `data:${req.file.mimetype || 'application/octet-stream'};base64,${req.file.buffer.toString('base64')}`;
  const payload = { image_base64: imageBase64 };

  const parseScore = (value) => {
    const parsed = Number(value);
    if (Number.isNaN(parsed)) {
      return null;
    }
    return Math.max(0, Math.min(1, parsed));
  };

  if (typeof req.body?.min_detection_score !== 'undefined') {
    const score = parseScore(req.body.min_detection_score);
    if (score !== null) {
      payload.min_detection_score = score;
    }
  }

  if (typeof req.body?.min_identity_score !== 'undefined') {
    const score = parseScore(req.body.min_identity_score);
    if (score !== null) {
      payload.min_identity_score = score;
    }
  }

  try {
    console.log('[idp] forwarding identify request', {
      target: `${normalizedBaseUrl}/identify`,
      accelerator,
      payloadSizeBytes: imageBase64.length
    });

    const response = await fetch(`${normalizedBaseUrl}/identify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const detailText = await response.text();
      console.error('IDP MCP error:', detailText);
      let detailJson;
      try {
        detailJson = JSON.parse(detailText);
      } catch (parseErr) {
        detailJson = undefined;
      }

      return res.status(502).json({
        error: 'idp_mcp_error',
        detail: detailJson || detailText,
        target: `${normalizedBaseUrl}/identify`,
        source: req.file?.originalname,
        mimetype: req.file?.mimetype,
        accelerator
      });
    }

    const data = await response.json();
    return res.json({ ...data, accelerator });
  } catch (err) {
    console.error('IDP identification failed:', err);
    return res.status(500).json({
      error: 'server_error',
      message: err?.message || 'IDP identification failed',
      source: req.file?.originalname,
      mimetype: req.file?.mimetype,
      accelerator,
      payloadSizeBytes: imageBase64.length,
      stack: process.env.NODE_ENV === 'production' ? undefined : err?.stack
    });
  }
});

app.post('/generate-image-stream', async (req, res) => {
  const body = req.body || {};
  const rawAccelerator = typeof body.accelerator === 'string' ? body.accelerator.trim().toLowerCase() : '';
  const requestedAccelerator = rawAccelerator === 'gpu' ? 'gpu' : 'cpu';
  const { baseUrl, accelerator: resolvedAccelerator } = pickMcpImagenBase(requestedAccelerator);
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl || '');
  if (!normalizedBaseUrl) {
    return res.status(500).json({ error: 'image_service_unconfigured' });
  }

  const { prompt, negative_prompt, guidance_scale, num_inference_steps, width, height, seed } = body;

  if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
    return res.status(400).json({ error: 'prompt is required' });
  }

  const payload = { prompt: prompt.trim() };

  if (typeof negative_prompt === 'string' && negative_prompt.trim()) {
    payload.negative_prompt = negative_prompt.trim();
  }
  if (typeof guidance_scale !== 'undefined') {
    const parsed = Number(guidance_scale);
    if (!Number.isNaN(parsed)) {
      payload.guidance_scale = parsed;
    }
  }
  if (typeof num_inference_steps !== 'undefined') {
    const parsed = parseInt(num_inference_steps, 10);
    if (!Number.isNaN(parsed)) {
      payload.num_inference_steps = parsed;
    }
  }
  if (typeof width !== 'undefined') {
    const parsed = parseInt(width, 10);
    if (!Number.isNaN(parsed)) {
      payload.width = parsed;
    }
  }
  if (typeof height !== 'undefined') {
    const parsed = parseInt(height, 10);
    if (!Number.isNaN(parsed)) {
      payload.height = parsed;
    }
  }
  if (typeof seed !== 'undefined') {
    const parsed = parseInt(seed, 10);
    if (!Number.isNaN(parsed)) {
      payload.seed = parsed;
    }
  }

  try {
    console.log('[image-mcp] streaming generate-image request', {
      target: `${normalizedBaseUrl}/generate-stream`,
      accelerator: resolvedAccelerator,
      promptLength: payload.prompt.length,
      width: payload.width,
      height: payload.height
    });

    const response = await fetch(`${normalizedBaseUrl}/generate-stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (!response.ok || !response.body) {
      const detail = await response.text();
      console.error('Image generator stream error:', detail);
      return res.status(502).json({ error: 'image_service_error', detail });
    }

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('X-Accel-Buffering', 'no');

    const cleanup = () => {
      if (response.body && typeof response.body.destroy === 'function' && !response.body.destroyed) {
        response.body.destroy();
      }
    };

    req.on('close', cleanup);
    response.body.on('error', (err) => {
      console.error('Image MCP stream transport error:', err);
      cleanup();
      if (!res.headersSent) {
        res.status(500).end();
      } else {
        res.end();
      }
    });

    response.body.pipe(res);
  } catch (err) {
    console.error('Streaming image generation failed:', err);
    return res.status(500).json({ error: 'server_error' });
  }
});

const uploadsDir = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

const safeJsonParse = (value, fallback) => {
  if (typeof value !== 'string') {
    return fallback;
  }
  try {
    return JSON.parse(value);
  } catch (err) {
    console.warn('safeJsonParse failed:', err.message);
    return fallback;
  }
};

app.post('/preview-voice', async (req, res) => {
  if (!VOICE_FEATURE_ENABLED) {
    return res.status(503).json({ error: 'voice_feature_disabled' });
  }
  const { voiceId, accelerator, text } = req.body || {};
  const selectedVoice = typeof voiceId === 'string' && voiceId.trim() ? voiceId.trim() : '';
  if (!selectedVoice) {
    return res.status(400).json({ error: 'voice_id_required' });
  }

  const previewText = typeof text === 'string' && text.trim().length >= 6 ? text.trim() : 'Premium voice preview.';
  try {
    const audioUrl = await synthesizeWithOpenvoice(previewText, accelerator, selectedVoice);
    return res.json({ audioUrl });
  } catch (err) {
    console.error('Voice preview failed:', err);
    return res.status(500).json({ error: 'voice_preview_failed', detail: err.message });
  }
});

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

const resolveServiceUrl = (value, fallback = '') => {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed || trimmed.toLowerCase() === 'disabled') {
      return '';
    }
    return trimmed;
  }
  return fallback;
};

const OLLAMA_URL = resolveServiceUrl(process.env.OLLAMA_URL, 'http://localhost:11434');
const OLLAMA_GPU_URL = resolveServiceUrl(process.env.OLLAMA_GPU_URL);
const MODEL = process.env.MODEL || 'llama3';
const PORT = process.env.PORT || 3001;
const STT_URL = resolveServiceUrl(process.env.STT_URL, 'http://localhost:5001');
const STT_GPU_URL = resolveServiceUrl(process.env.STT_GPU_URL);
const OPENVOICE_URL = resolveServiceUrl(process.env.OPENVOICE_URL);
const OPENVOICE_GPU_URL = resolveServiceUrl(process.env.OPENVOICE_GPU_URL);
const YOLO_MCP_URL = resolveServiceUrl(process.env.YOLO_MCP_URL, 'http://localhost:8000');
const BSLIP_MCP_URL = resolveServiceUrl(process.env.BSLIP_MCP_URL, 'http://localhost:8002');
const IMAGE_MCP_URL = resolveServiceUrl(process.env.IMAGE_MCP_URL, 'http://localhost:8001');
const IMAGE_MCP_GPU_URL = resolveServiceUrl(process.env.IMAGE_MCP_GPU_URL);
const IDP_MCP_URL = resolveServiceUrl(process.env.IDP_MCP_URL, 'http://localhost:8004');
const IDP_MCP_GPU_URL = resolveServiceUrl(process.env.IDP_MCP_GPU_URL, 'http://localhost:8104');
const MEMENTO_MCP_URL = resolveServiceUrl(process.env.MEMENTO_MCP_URL, 'http://localhost:8005');
const MEETING_MCP_URL = resolveServiceUrl(process.env.MEETING_MCP_URL, 'http://localhost:8008');
const MEETING_PROVIDER_NAME = 'meeting';
const VMS_MCP_URL = resolveServiceUrl(process.env.VMS_MCP_URL, 'http://localhost:8006');
const TUYA_MCP_URL = resolveServiceUrl(process.env.TUYA_MCP_URL, 'http://localhost:8007');
const MCP0_URL = process.env.MCP0_URL || '';
const MCP0_BASE_URL = MCP0_URL ? MCP0_URL.replace(/\/$/, '') : '';
const MCP0_TIMEOUT_MS = Number(process.env.MCP0_TIMEOUT_MS) || 25000;
const GITHUB_MCP_URL = process.env.GITHUB_MCP_URL || 'https://mcp.github.com';
const GITHUB_MCP_HEALTH_PATH = process.env.GITHUB_MCP_HEALTH_PATH || '/health';
const CARWATCH_SNAPSHOT_TTL_MS = Number(process.env.CARWATCH_SNAPSHOT_TTL_MS) || 120000;
const OCR_DEFAULT_LANG = process.env.OCR_LANG || 'eng';
const RAW_LLM_PROVIDER = (process.env.LLM_PROVIDER || 'ollama').toLowerCase();
const NORMALIZED_BASE_PROVIDER =
  RAW_LLM_PROVIDER === 'claude'
    ? 'anthropic'
    : RAW_LLM_PROVIDER === 'chatgpt'
    ? 'openai'
    : RAW_LLM_PROVIDER;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY || '';
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || 'claude-3-5-sonnet-20241022';
const ANTHROPIC_MAX_TOKENS = Number(process.env.ANTHROPIC_MAX_TOKENS) || 1024;
const ANTHROPIC_VERSION = process.env.ANTHROPIC_VERSION || '2023-06-01';
const parsedAnthropicTemp = Number(process.env.ANTHROPIC_TEMPERATURE);
const ANTHROPIC_TEMPERATURE = Number.isFinite(parsedAnthropicTemp) ? parsedAnthropicTemp : 0.2;
const ANTHROPIC_API_URL = process.env.ANTHROPIC_API_URL || 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_MODELS_URL = process.env.ANTHROPIC_MODELS_URL || 'https://api.anthropic.com/v1/models';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || process.env.CHATGPT_API_KEY || '';
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const OPENAI_API_URL = process.env.OPENAI_API_URL || 'https://api.openai.com/v1/chat/completions';
const OPENAI_MODELS_URL = process.env.OPENAI_MODELS_URL || 'https://api.openai.com/v1/models';
const parsedOpenAiTemp = Number(process.env.OPENAI_TEMPERATURE);
const OPENAI_TEMPERATURE = Number.isFinite(parsedOpenAiTemp) ? parsedOpenAiTemp : 0.2;
const OPENAI_MAX_TOKENS = Number(process.env.OPENAI_MAX_TOKENS) || 1024;
const GITHUB_MODEL_TOKEN = process.env.GITHUB_MODEL_TOKEN || '';
const GITHUB_MODEL = process.env.GITHUB_MODEL || 'gpt-4o-mini';
const GITHUB_MODEL_DEPLOYMENT = process.env.GITHUB_MODEL_DEPLOYMENT || GITHUB_MODEL;
const DEFAULT_GITHUB_CHAT_BASE = 'https://api.github.com/openai/deployments';
const GITHUB_MODEL_CHAT_BASE_URL = process.env.GITHUB_MODEL_CHAT_BASE_URL || DEFAULT_GITHUB_CHAT_BASE;
const GITHUB_MODEL_CHAT_URL = process.env.GITHUB_MODEL_CHAT_URL || '';
const parsedGithubTemp = Number(process.env.GITHUB_MODEL_TEMPERATURE);
const GITHUB_MODEL_TEMPERATURE = Number.isFinite(parsedGithubTemp) ? parsedGithubTemp : 0.2;
const GITHUB_MODEL_MAX_TOKENS = Number(process.env.GITHUB_MODEL_MAX_TOKENS) || 1024;
const GITHUB_API_VERSION = process.env.GITHUB_API_VERSION || '2023-07-01';

const GPU_WORKER_TOKEN = (process.env.GPU_WORKER_TOKEN || '').trim();
const GPU_MAX_PENDING_JOBS = Number(process.env.GPU_MAX_PENDING_JOBS) || 100;
const GPU_JOB_LEASE_SECONDS = Number(process.env.GPU_JOB_LEASE_SECONDS) || 900;

const gpuJobQueue = [];
const gpuJobStore = new Map();

const now = () => Date.now();

const cleanupExpiredJobs = () => {
  const cutoff = now() - GPU_JOB_LEASE_SECONDS * 1000;
  for (const job of gpuJobStore.values()) {
    if (job.status === 'leased' && job.startedAt && job.startedAt < cutoff) {
      job.status = 'queued';
      job.workerId = null;
      job.startedAt = null;
      gpuJobQueue.push(job);
    }
  }
};

const enqueueJob = (job) => {
  if (job.priority === 'high') {
    gpuJobQueue.unshift(job);
  } else {
    gpuJobQueue.push(job);
  }
};

const requireWorkerAuth = (req, res, next) => {
  if (!GPU_WORKER_TOKEN) {
    return res.status(503).json({ error: 'gpu_worker_api_disabled' });
  }
  const header = req.headers.authorization || '';
  if (!header.toLowerCase().startsWith('bearer ')) {
    return res.status(401).json({ error: 'missing_worker_token' });
  }
  const provided = header.split(' ', 2)[1].trim();
  if (provided !== GPU_WORKER_TOKEN) {
    return res.status(403).json({ error: 'invalid_worker_token' });
  }
  next();
};

const VOICE_FEATURE_ENABLED =
  (process.env.ENABLE_VOICE_FEATURE || process.env.VOICE_FEATURE_ENABLED || '').toLowerCase() === 'true';

const MCP_AUTOMATION_PROMPT = `You can request external tool executions via MCP0.
When a GitHub operation is needed, emit a fenced code block labeled mcp0 using strict JSON:
\`\`\`mcp0
{
  "provider": "githubModel",
  "tool": "list_models",
  "arguments": { }
}
\`\`\`
Keep your natural language reply outside the fenced block. Only include tool blocks when the user explicitly asks for GitHub automation (repos, workflows, issues, etc.).`;
const MCP_ALLOWED_PROVIDERS = new Set(['githubModel']);
const MCP_TOOL_BLOCK_PATTERN = '```mcp0\\s+([\\s\\S]*?)```';
const MCP_TOOL_BLOCK_REGEX = new RegExp(MCP_TOOL_BLOCK_PATTERN, 'gi');
const buildMcpToolBlockRegex = () => new RegExp(MCP_TOOL_BLOCK_PATTERN, 'gi');
const getAutomationSystemMessage = () => (MCP0_BASE_URL ? MCP_AUTOMATION_PROMPT : null);

const shouldUseGpu = (accelerator) => accelerator === 'gpu';
const normalizeProvider = (provider) => {
  if (!provider) return NORMALIZED_BASE_PROVIDER;
  const lowered = provider.toLowerCase();
  if (lowered === 'claude') return 'anthropic';
  if (lowered === 'chatgpt') return 'openai';
  return lowered;
};

const providerSupportsStreaming = (provider) => {
  const normalized = normalizeProvider(provider);
  return normalized === 'ollama' || normalized === 'anthropic' || normalized === 'openai' || normalized === 'github';
};

const isAnthropicProvider = (provider = NORMALIZED_BASE_PROVIDER) => normalizeProvider(provider) === 'anthropic';
const isOpenAiProvider = (provider = NORMALIZED_BASE_PROVIDER) => normalizeProvider(provider) === 'openai';
const isGithubProvider = (provider = NORMALIZED_BASE_PROVIDER) => normalizeProvider(provider) === 'github';

const providerRequiresKey = (provider) => {
  const normalized = normalizeProvider(provider);
  if (normalized === 'anthropic') {
    return !!ANTHROPIC_API_KEY;
  }
  if (normalized === 'openai') {
    return !!OPENAI_API_KEY;
  }
  if (normalized === 'github') {
    return !!GITHUB_MODEL_TOKEN;
  }
  return true;
};

const normalizeBaseUrl = (url) => (url || '').replace(/\/$/, '');

// ---------------------------------------------------------------------------
// GPU job queue API
// ---------------------------------------------------------------------------
app.post('/gpu-jobs', (req, res) => {
  const { tool, payload, priority } = req.body || {};
  if (typeof tool !== 'string' || !tool.trim()) {
    return res.status(400).json({ error: 'tool_required' });
  }
  if (gpuJobQueue.length >= GPU_MAX_PENDING_JOBS) {
    return res.status(429).json({ error: 'gpu_queue_full' });
  }
  const job = {
    id: crypto.randomUUID(),
    tool: tool.trim(),
    payload: payload ?? null,
    priority: priority === 'high' ? 'high' : 'normal',
    status: 'queued',
    enqueuedAt: now(),
    startedAt: null,
    completedAt: null,
    workerId: null,
    attempts: 0
  };
  gpuJobStore.set(job.id, job);
  enqueueJob(job);
  return res.json({ job });
});

app.get('/gpu-jobs/next', requireWorkerAuth, (req, res) => {
  cleanupExpiredJobs();
  if (!gpuJobQueue.length) {
    return res.status(204).end();
  }
  const job = gpuJobQueue.shift();
  job.status = 'leased';
  job.workerId =
    typeof req.query.worker === 'string' && req.query.worker.trim() ? req.query.worker.trim() : 'gpu-worker';
  job.attempts += 1;
  job.startedAt = now();
  return res.json({ job });
});

app.post('/gpu-jobs/:jobId/complete', requireWorkerAuth, (req, res) => {
  const job = gpuJobStore.get(req.params.jobId);
  if (!job) {
    return res.status(404).json({ error: 'job_not_found' });
  }
  if (job.status !== 'leased') {
    return res.status(400).json({ error: 'job_not_in_progress' });
  }
  const { status, result, detail } = req.body || {};
  const normalized = status === 'error' ? 'failed' : 'completed';
  job.status = normalized;
  job.completedAt = now();
  job.result = result ?? null;
  job.detail = detail ?? null;
  return res.json({ job });
});

app.get('/gpu-jobs/:jobId', (req, res) => {
  const job = gpuJobStore.get(req.params.jobId);
  if (!job) {
    return res.status(404).json({ error: 'job_not_found' });
  }
  return res.json({ job });
});

const getDefaultModelForProvider = (provider) => {
  const normalized = normalizeProvider(provider);
  if (normalized === 'anthropic') {
    return ANTHROPIC_MODEL;
  }
  if (normalized === 'openai') {
    return OPENAI_MODEL;
  }
  if (normalized === 'github') {
    return GITHUB_MODEL;
  }
  return MODEL;
};

const resolveModelForProvider = (provider, requestedModel) => {
  const normalized = normalizeProvider(provider);
  const trimmed = typeof requestedModel === 'string' ? requestedModel.trim() : '';

  if (normalized === 'github') {
    const allowedGithubModels = [GITHUB_MODEL, GITHUB_MODEL_DEPLOYMENT]
      .map((value) => (typeof value === 'string' ? value.trim() : ''))
      .filter(Boolean);
    if (trimmed && allowedGithubModels.includes(trimmed)) {
      return trimmed;
    }
    return allowedGithubModels[0] || GITHUB_MODEL || GITHUB_MODEL_DEPLOYMENT || 'gpt-4o-mini';
  }

  if (trimmed) {
    return trimmed;
  }

  return getDefaultModelForProvider(normalized);
};

const resolveGithubEndpoint = (deploymentOverride) => {
  if (GITHUB_MODEL_CHAT_URL) {
    return GITHUB_MODEL_CHAT_URL;
  }
  const baseUrl = normalizeBaseUrl(GITHUB_MODEL_CHAT_BASE_URL || DEFAULT_GITHUB_CHAT_BASE);
  const resolvedDeployment =
    typeof deploymentOverride === 'string' && deploymentOverride.trim()
      ? deploymentOverride.trim()
      : GITHUB_MODEL_DEPLOYMENT;
  if (!baseUrl || !resolvedDeployment) {
    return '';
  }
  return `${baseUrl}/${encodeURIComponent(resolvedDeployment)}/chat/completions`;
};

const resolveProviderServerInfo = (provider, { accelerator, githubDeployment } = {}) => {
  const normalized = normalizeProvider(provider);
  if (normalized === 'anthropic') {
    return ANTHROPIC_API_URL;
  }
  if (normalized === 'openai') {
    return OPENAI_API_URL;
  }
  if (normalized === 'github') {
    return resolveGithubEndpoint(githubDeployment);
  }
  return pickOllamaBase(accelerator);
};

const buildDiagnostics = ({ provider, model, accelerator, server }) => ({
  provider,
  model,
  accelerator: accelerator || null,
  server: server || null,
  mcp0: MCP0_URL || null,
  timestamp: new Date().toISOString()
});

const setupSse = (res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();
};

const sendSseEvent = (res, payload) => {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
};

const closeSse = (res) => {
  res.write('data: {"type":"done"}\n\n');
  res.end();
};

const parseReadableChunks = async function* (readableStream) {
  if (!readableStream) {
    return;
  }

  const isWebStream = typeof readableStream.getReader === 'function';
  const hasAsyncIterator = typeof readableStream[Symbol.asyncIterator] === 'function';

  if (isWebStream) {
    const reader = readableStream.getReader();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) {
          if (value) {
            yield value;
          }
          break;
        }
        if (value) {
          yield value;
        }
      }
    } finally {
      reader.releaseLock?.();
    }
    return;
  }

  if (hasAsyncIterator) {
    for await (const chunk of readableStream) {
      yield chunk;
    }
    return;
  }

  // Fall back to legacy Node Readable streams without async iterator (very old libs)
  if (typeof readableStream.on === 'function') {
    const { once } = require('events');
    readableStream.pause?.();
    try {
      while (true) {
        const [chunk] = await once(readableStream, 'data');
        if (!chunk) {
          break;
        }
        yield chunk;
      }
    } catch {
      // ignore
    }
    return;
  }

  throw new Error('Unsupported readable stream type');
};

const parseSseStream = async function* (readableStream) {
  const decoder = new TextDecoder();
  let buffer = '';

  const emitBufferedEvents = function* () {
    let separatorIndex;
    while ((separatorIndex = buffer.indexOf('\n\n')) >= 0) {
      const rawEvent = buffer.slice(0, separatorIndex);
      buffer = buffer.slice(separatorIndex + 2);
      if (!rawEvent.trim()) {
        continue;
      }
      const lines = rawEvent.split(/\r?\n/);
      const dataLines = lines
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trim());
      if (!dataLines.length) {
        continue;
      }
      yield dataLines.join('\n');
    }
  };

  const flushTrailingBuffer = function* () {
    if (!buffer.trim()) {
      return;
    }
    const lines = buffer.split(/\r?\n/);
    const dataLines = lines
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trim());
    if (dataLines.length) {
      yield dataLines.join('\n');
    }
  };

  const appendChunk = (value, options) => {
    if (typeof value === 'string') {
      buffer += value;
    } else if (value != null) {
      buffer += decoder.decode(value, options);
    }
  };

  for await (const chunk of parseReadableChunks(readableStream)) {
    if (typeof chunk === 'string') {
      buffer += chunk;
    } else if (chunk) {
      const decoded = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : decoder.decode(chunk, { stream: true });
      buffer += decoded;
    }
    for (const event of emitBufferedEvents()) {
      yield event;
    }
  }

  appendChunk(null, { stream: false });
  for (const event of flushTrailingBuffer()) {
    yield event;
  }
};

const parseNewlineJsonStream = async function* (readableStream) {
  const decoder = new TextDecoder();
  let buffer = '';

  for await (const chunk of parseReadableChunks(readableStream)) {
    if (!chunk) continue;
    buffer += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });

    let newlineIndex;
    while ((newlineIndex = buffer.indexOf('\n')) >= 0) {
      const rawLine = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      if (!rawLine) {
        continue;
      }
      yield rawLine;
    }
  }

  const tail = buffer.trim();
  if (tail) {
    yield tail;
  }
};

const HEALTH_CHECK_TIMEOUT_MS = Number(process.env.HEALTH_CHECK_TIMEOUT_MS) || 2000;

const joinServicePath = (baseUrl, path = '/health') => {
  const normalized = normalizeBaseUrl(baseUrl);
  if (!normalized) return '';
  if (!path || path === '/') return `${normalized}/`;
  return path.startsWith('/') ? `${normalized}${path}` : `${normalized}/${path}`;
};

const checkAnthropicHealth = async () => {
  if (!ANTHROPIC_API_KEY) {
    return { name: 'anthropic', status: 'unconfigured' };
  }

  try {
    const response = await requestWithTimeout(ANTHROPIC_MODELS_URL, {
      headers: {
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': ANTHROPIC_VERSION
      }
    });
    if (!response.ok) {
      return { name: 'anthropic', status: 'error', detail: `HTTP ${response.status}` };
    }
    const data = await response.json().catch(() => null);
    const detail = Array.isArray(data?.data) ? { models: data.data.map((entry) => entry?.id).filter(Boolean) } : null;
    return { name: 'anthropic', status: 'ok', detail };
  } catch (err) {
    return { name: 'anthropic', status: 'error', detail: err.message };
  }
};

const checkOpenAiHealth = async () => {
  if (!OPENAI_API_KEY) {
    return { name: 'openai', status: 'unconfigured' };
  }

  try {
    const response = await requestWithTimeout(OPENAI_MODELS_URL, {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`
      }
    });
    if (!response.ok) {
      return { name: 'openai', status: 'error', detail: `HTTP ${response.status}` };
    }
    const data = await response.json().catch(() => null);
    const detail = Array.isArray(data?.data)
      ? { models: data.data.map((entry) => entry?.id).filter(Boolean) }
      : null;
    return { name: 'openai', status: 'ok', detail };
  } catch (err) {
    return { name: 'openai', status: 'error', detail: err.message };
  }
};

const checkGithubModelHealth = async () => {
  if (!isGithubProvider()) {
    return { name: 'githubModel', status: 'disabled' };
  }
  if (!GITHUB_MODEL_TOKEN) {
    return { name: 'githubModel', status: 'unconfigured' };
  }

  const baseUrl = normalizeBaseUrl(GITHUB_MODEL_CHAT_BASE_URL || DEFAULT_GITHUB_CHAT_BASE);
  const targetEndpoint = GITHUB_MODEL_CHAT_URL
    ? GITHUB_MODEL_CHAT_URL
    : baseUrl && GITHUB_MODEL_DEPLOYMENT
    ? `${baseUrl}/${encodeURIComponent(GITHUB_MODEL_DEPLOYMENT)}/chat/completions`
    : '';

  if (!targetEndpoint) {
    return { name: 'githubModel', status: 'unconfigured' };
  }

  const payload = {
    model: GITHUB_MODEL || GITHUB_MODEL_DEPLOYMENT,
    max_tokens: 4,
    messages: [{ role: 'user', content: 'ping' }]
  };

  try {
    const response = await requestWithTimeout(targetEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${GITHUB_MODEL_TOKEN}`,
        'X-GitHub-Api-Version': GITHUB_API_VERSION
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      return { name: 'githubModel', status: 'error', detail: `HTTP ${response.status}` };
    }

    return { name: 'githubModel', status: 'ok' };
  } catch (err) {
    return { name: 'githubModel', status: 'error', detail: err.message };
  }
};

const requestWithTimeout = (url, options = {}) => {
  const { timeoutMs = HEALTH_CHECK_TIMEOUT_MS, ...rest } = options;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('timeout'));
    }, timeoutMs);

    fetch(url, rest)
      .then((response) => {
        clearTimeout(timer);
        resolve(response);
      })
      .catch((err) => {
        clearTimeout(timer);
        reject(err);
      });
  });
};

const CARWATCH_ALLOWED_CONNECTIONS = new Set(['online', 'connecting', 'offline']);

const carwatchStore = {
  snapshot: null,
  receivedAt: null
};

const clampBetween = (value, min, max, fallback = null) => {
  const num = Number(value);
  if (Number.isFinite(num)) {
    if (typeof min === 'number' && num < min) {
      return min;
    }
    if (typeof max === 'number' && num > max) {
      return max;
    }
    return num;
  }
  return fallback;
};

const normalizeCarwatchDetections = (detections) => {
  if (!Array.isArray(detections)) return [];
  return detections
    .map((det, idx) => {
      const label = typeof det?.label === 'string' && det.label.trim() ? det.label.trim() : `Object ${idx + 1}`;
      const count = clampBetween(det?.count, 0, Number.POSITIVE_INFINITY, 0) || 0;
      const confidence = clampBetween(det?.confidence, 0, 1, 0) || 0;
      return { label, count, confidence };
    })
    .filter((det) => det.count > 0 || det.confidence > 0);
};

const normalizeCarwatchEvents = (events) => {
  if (!Array.isArray(events)) return [];
  return events
    .map((event, idx) => ({
      id: typeof event?.id === 'string' && event.id.trim() ? event.id.trim() : `evt-${idx + 1}`,
      label: typeof event?.label === 'string' && event.label.trim() ? event.label.trim() : 'Event',
      detail: typeof event?.detail === 'string' ? event.detail.trim() : '',
      timestamp:
        typeof event?.timestamp === 'string' && event.timestamp.trim()
          ? event.timestamp.trim()
          : new Date().toISOString()
    }))
    .filter((event) => !!event.label);
};

const storeCarwatchSnapshot = (payload = {}) => {
  const now = new Date();
  const connectionValue = (payload.connection || '').toLowerCase();
  const connection = CARWATCH_ALLOWED_CONNECTIONS.has(connectionValue) ? connectionValue : 'online';
  const snapshot = {
    deviceName: typeof payload.deviceName === 'string' && payload.deviceName.trim() ? payload.deviceName.trim() : 'CarWatch device',
    connection,
    batteryPercent: clampBetween(payload.batteryPercent, 0, 100, null),
    temperatureC: clampBetween(payload.temperatureC, -20, 120, null),
    fps: clampBetween(payload.fps, 0, 120, null),
    latencyMs: clampBetween(payload.latencyMs, 0, Number.POSITIVE_INFINITY, null),
    streamUrl: typeof payload.streamUrl === 'string' ? payload.streamUrl.trim() : '',
    thumbUrl: typeof payload.thumbUrl === 'string' ? payload.thumbUrl.trim() : '',
    imageBase64: typeof payload.imageBase64 === 'string' ? payload.imageBase64.trim() : '',
    detections: normalizeCarwatchDetections(payload.detections),
    events: normalizeCarwatchEvents(payload.events),
    timestamp: typeof payload.timestamp === 'string' && payload.timestamp.trim() ? payload.timestamp.trim() : now.toISOString()
  };

  carwatchStore.snapshot = snapshot;
  carwatchStore.receivedAt = now.getTime();
  return snapshot;
};

const getCarwatchSnapshot = () => {
  if (!carwatchStore.snapshot || !carwatchStore.receivedAt) {
    return null;
  }
  if (Date.now() - carwatchStore.receivedAt > CARWATCH_SNAPSHOT_TTL_MS) {
    return null;
  }
  return carwatchStore.snapshot;
};

const checkCarwatchHealth = () => {
  if (!carwatchStore.snapshot || !carwatchStore.receivedAt) {
    return { name: 'carwatch', status: 'unavailable', detail: 'no_snapshot' };
  }
  const ageMs = Date.now() - carwatchStore.receivedAt;
  if (ageMs > CARWATCH_SNAPSHOT_TTL_MS) {
    return { name: 'carwatch', status: 'stale', detail: { ageMs } };
  }
  return {
    name: 'carwatch',
    status: 'ok',
    detail: {
      device: carwatchStore.snapshot.deviceName,
      ageMs
    }
  };
};

const buildMcpProxyUrl = (provider, relativePath = '') => {
  if (!MCP0_BASE_URL || !provider) {
    return '';
  }
  const cleanRelative = relativePath ? `/${relativePath.replace(/^\/+/, '')}` : '';
  return `${MCP0_BASE_URL}/proxy/${encodeURIComponent(provider)}${cleanRelative}`;
};

const callMcpProxy = async ({ provider, relativePath = '', payload = {} }) => {
  if (!MCP0_BASE_URL) {
    throw new Error('mcp0_unconfigured');
  }
  if (!provider) {
    throw new Error('mcp_provider_missing');
  }

  const target = buildMcpProxyUrl(provider, relativePath);
  if (!target) {
    throw new Error('mcp_proxy_unavailable');
  }

  const response = await requestWithTimeout(target, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload ?? {}),
    timeoutMs: MCP0_TIMEOUT_MS
  });

  const text = await response.text();
  let parsed;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      parsed = text;
    }
  } else {
    parsed = null;
  }

  if (!response.ok) {
    const detail = typeof parsed === 'string' ? parsed : JSON.stringify(parsed);
    throw new Error(detail || 'mcp_proxy_error');
  }

  return parsed;
};

const callMcpTool = async ({ provider, tool, args = {} }) => {
  if (!tool || typeof tool !== 'string') {
    throw new Error('mcp_tool_missing');
  }
  return callMcpProxy({ provider, relativePath: 'invoke', payload: { tool, arguments: args || {} } });
};

const invokeMeetingTool = async (tool, args = {}) => {
  if (!MEETING_MCP_URL) {
    throw new Error('meeting_mcp_unconfigured');
  }
  return callMcpTool({ provider: MEETING_PROVIDER_NAME, tool, args });
};

const unwrapMeetingResponse = (payload) => {
  if (payload && typeof payload === 'object' && payload.response && typeof payload.response === 'object') {
    return payload.response;
  }
  return payload;
};

const extractMcpToolInstructions = (text) => {
  if (typeof text !== 'string' || !text.trim()) {
    return { cleanText: text || '', instructions: [] };
  }

  const regex = buildMcpToolBlockRegex();
  const instructions = [];
  let match;
  while ((match = regex.exec(text))) {
    const raw = match[1] || '';
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      instructions.push({ raw, error: `invalid_json: ${err.message}` });
      continue;
    }

    const provider = typeof parsed?.provider === 'string' ? parsed.provider.trim() : '';
    const tool = typeof parsed?.tool === 'string' ? parsed.tool.trim() : '';
    const args = parsed?.arguments && typeof parsed.arguments === 'object' ? parsed.arguments : {};
    if (!provider || !MCP_ALLOWED_PROVIDERS.has(provider)) {
      instructions.push({ raw, provider, tool, args, error: 'provider_not_allowed' });
      continue;
    }
    if (!tool) {
      instructions.push({ raw, provider, tool, args, error: 'tool_missing' });
      continue;
    }
    instructions.push({ raw, provider, tool, args });
  }

  const cleanText = text.replace(buildMcpToolBlockRegex(), '').trim();
  return { cleanText, instructions };
};

const executeMcpInstructions = async (instructions = []) => {
  if (!Array.isArray(instructions) || !instructions.length) {
    return [];
  }
  const results = [];
  for (const instruction of instructions) {
    if (instruction.error) {
      results.push({ ...instruction, result: null });
      continue;
    }
    try {
      const response = await callMcpTool({ provider: instruction.provider, tool: instruction.tool, args: instruction.args });
      results.push({ ...instruction, result: response || null });
    } catch (err) {
      results.push({ ...instruction, error: err?.message || 'mcp_execution_failed', result: null });
    }
  }
  return results;
};

const checkServiceHealth = async ({ name, baseUrl, path = '/health', method = 'GET' }) => {
  if (!baseUrl) {
    return { name, status: 'unconfigured' };
  }

  const target = joinServicePath(baseUrl, path);
  try {
    const response = await requestWithTimeout(target, { method });
    if (!response.ok) {
      return { name, status: 'error', detail: `HTTP ${response.status}` };
    }

    let detail = null;
    const contentType = response.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      detail = await response.json().catch(() => null);
    }

    return { name, status: 'ok', detail };
  } catch (err) {
    return { name, status: 'error', detail: err.message };
  }
};

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

const createSession = (name, providerOverride) => {
  const id = generateId();
  const session = {
    id,
    name: name || `Session ${new Date().toLocaleString()}`,
    createdAt: Date.now(),
    messages: [],
    provider: normalizeProvider(providerOverride)
  };
  sessions.set(id, session);
  return session;
};

const ensureSession = (id, name, providerOverride) => {
  const existing = getSession(id);
  if (existing) {
    if (providerOverride) {
      existing.provider = normalizeProvider(providerOverride);
    }
    return existing;
  }
  return createSession(name, providerOverride);
};

const getSession = (id) => {
  if (!id) return null;
  return sessions.get(id) || null;
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
    attachmentUrl: payload.attachmentUrl || null,
    voiceId: payload.voiceId || null
  };
  session.messages.push(message);
  while (session.messages.length > MAX_SESSION_MESSAGES) {
    session.messages.shift();
  }
  return message;
};

const ensureAutomationSystemMessage = (session) => {
  if (!session || !MCP0_BASE_URL) {
    return;
  }
  const alreadyHasAutomation = session.messages?.some(
    (msg) => msg.role === 'system' && typeof msg.content === 'string' && msg.content.includes('MCP0')
  );
  if (alreadyHasAutomation) {
    return;
  }
  addSessionMessage(session, {
    role: 'system',
    content: MCP_AUTOMATION_PROMPT,
    model: null,
    sttModel: null,
    accelerator: null
  });
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

const formatMessagesForAnthropic = (session) =>
  session.messages
    .filter((msg) => VALID_ROLES.has(msg.role))
    .map((msg) => ({
      role: msg.role === 'assistant' ? 'assistant' : msg.role === 'system' ? 'system' : 'user',
      content: [{ type: 'text', text: msg.content || '' }]
    }));

const formatMessagesForOpenAi = (session) =>
  session.messages
    .filter((msg) => VALID_ROLES.has(msg.role))
    .map((msg) => ({
      role: msg.role === 'assistant' ? 'assistant' : msg.role === 'system' ? 'system' : 'user',
      content: msg.content || ''
    }));

const executeChatCompletion = async ({ session, modelToUse, accelerator, body }) => {
  const providerForSession = session.provider || NORMALIZED_BASE_PROVIDER;
  let reply = '';
  let resolvedServer = '';

  ensureAutomationSystemMessage(session);

  if (isAnthropicProvider(providerForSession)) {
    resolvedServer = ANTHROPIC_API_URL;
    const anthropicMessages = formatMessagesForAnthropic(session);
    const { text } = await callAnthropicMessages({
      messages: anthropicMessages,
      model: modelToUse,
      maxTokens: resolveAnthropicMaxTokens(body?.anthropic_max_tokens),
      temperature: resolveAnthropicTemperature(body?.anthropic_temperature)
    });
    reply = text;
  } else if (isOpenAiProvider(providerForSession)) {
    resolvedServer = OPENAI_API_URL;
    const openAiMessages = formatMessagesForOpenAi(session);
    const { text } = await callOpenAiMessages({
      messages: openAiMessages,
      model: modelToUse,
      maxTokens: resolveOpenAiMaxTokens(body?.openai_max_tokens),
      temperature: resolveOpenAiTemperature(body?.openai_temperature)
    });
    reply = text;
  } else if (isGithubProvider(providerForSession)) {
    const githubMessages = formatMessagesForOpenAi(session);
    const { text, endpoint } = await callGithubModelMessages({
      messages: githubMessages,
      model: modelToUse,
      maxTokens: resolveGithubMaxTokens(
        body?.github_max_tokens ?? body?.githubMaxTokens ?? body?.max_tokens
      ),
      temperature: resolveGithubTemperature(
        body?.github_temperature ?? body?.githubTemperature ?? body?.temperature
      ),
      deployment: body?.github_deployment || body?.githubDeployment
    });
    reply = text;
    resolvedServer = endpoint;
  } else {
    const baseUrl = pickOllamaBase(accelerator);
    resolvedServer = baseUrl;
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
      throw new Error(text || 'ollama_error');
    }

    const data = await response.json();
    reply = (data.message && data.message.content) || data.response || '';
  }

  let toolRuns = [];
  if (reply && MCP0_BASE_URL) {
    const { cleanText, instructions } = extractMcpToolInstructions(reply);
    reply = cleanText || reply;
    toolRuns = await executeMcpInstructions(instructions);
  }

  return { reply, resolvedServer, toolRuns };
};

const streamOllamaCompletion = async ({ session, modelToUse, accelerator, onDelta }) => {
  const baseUrl = pickOllamaBase(accelerator);
  const response = await fetch(`${baseUrl}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: modelToUse,
      messages: formatMessagesForOllama(session),
      stream: true
    })
  });

  if (!response.ok || !response.body) {
    const detail = await response.text().catch(() => '');
    throw new Error(detail || 'ollama_stream_error');
  }

  let accumulated = '';
  for await (const rawLine of parseNewlineJsonStream(response.body)) {
    if (!rawLine) continue;
    let payload;
    try {
      payload = JSON.parse(rawLine);
    } catch (err) {
      console.warn('Skipping malformed Ollama stream chunk', rawLine, err);
      continue;
    }
    const chunkText =
      (payload?.message && typeof payload.message.content === 'string' && payload.message.content) ||
      (typeof payload?.response === 'string' ? payload.response : '');
    if (chunkText) {
      accumulated += chunkText;
      if (typeof onDelta === 'function') {
        onDelta(chunkText, accumulated);
      }
    }
    if (payload?.done) {
      break;
    }
  }

  return { reply: accumulated, resolvedServer: baseUrl };
};

const streamAnthropicCompletion = async ({ session, modelToUse, body, onDelta }) => {
  if (!ANTHROPIC_API_KEY) {
    throw new Error('anthropic_api_key_missing');
  }

  const payload = {
    model: modelToUse || ANTHROPIC_MODEL,
    max_tokens: resolveAnthropicMaxTokens(body?.anthropic_max_tokens),
    temperature: resolveAnthropicTemperature(body?.anthropic_temperature),
    messages: formatMessagesForAnthropic(session),
    stream: true
  };

  const response = await fetch(ANTHROPIC_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': ANTHROPIC_VERSION
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok || !response.body) {
    const detail = await response.text().catch(() => '');
    throw new Error(detail || 'anthropic_stream_error');
  }

  let accumulated = '';
  for await (const rawEvent of parseSseStream(response.body)) {
    if (!rawEvent) continue;
    let eventPayload;
    try {
      eventPayload = JSON.parse(rawEvent);
    } catch (err) {
      console.warn('Skipping malformed Anthropic stream chunk', rawEvent, err);
      continue;
    }

    if (eventPayload?.type === 'content_block_delta' && eventPayload?.delta?.type === 'text_delta') {
      const chunkText = eventPayload.delta.text || '';
      if (chunkText) {
        accumulated += chunkText;
        if (typeof onDelta === 'function') {
          onDelta(chunkText, accumulated);
        }
      }
    }

    if (eventPayload?.type === 'message_stop' || eventPayload?.type === 'message_delta') {
      if (eventPayload?.delta?.stop_reason) {
        break;
      }
    }
  }

  return { reply: accumulated, resolvedServer: ANTHROPIC_API_URL };
};

const extractOpenAiDeltaText = (payload) => {
  const choice = Array.isArray(payload?.choices) ? payload.choices[0] : null;
  const delta = choice?.delta;
  if (!delta) {
    return '';
  }

  if (typeof delta.content === 'string') {
    return delta.content;
  }

  if (Array.isArray(delta.content)) {
    return delta.content
      .map((part) => {
        if (!part) return '';
        if (typeof part === 'string') return part;
        if (typeof part?.text === 'string') return part.text;
        return '';
      })
      .join('');
  }

  if (typeof delta.text === 'string') {
    return delta.text;
  }

  if (typeof delta?.content?.text === 'string') {
    return delta.content.text;
  }

  return '';
};

const streamOpenAiCompletion = async ({ session, modelToUse, body, onDelta }) => {
  if (!OPENAI_API_KEY) {
    throw new Error('openai_api_key_missing');
  }

  const payload = {
    model: modelToUse || OPENAI_MODEL,
    max_tokens: resolveOpenAiMaxTokens(body?.openai_max_tokens),
    temperature: resolveOpenAiTemperature(body?.openai_temperature),
    messages: formatMessagesForOpenAi(session),
    stream: true
  };

  const response = await fetch(OPENAI_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${OPENAI_API_KEY}`
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok || !response.body) {
    const detail = await response.text().catch(() => '');
    throw new Error(detail || 'openai_stream_error');
  }

  let accumulated = '';
  for await (const rawEvent of parseSseStream(response.body)) {
    if (!rawEvent) continue;
    if (rawEvent.trim() === '[DONE]') {
      break;
    }
    let eventPayload;
    try {
      eventPayload = JSON.parse(rawEvent);
    } catch (err) {
      console.warn('Skipping malformed OpenAI stream chunk', rawEvent, err);
      continue;
    }
    const chunkText = extractOpenAiDeltaText(eventPayload);
    if (chunkText) {
      accumulated += chunkText;
      if (typeof onDelta === 'function') {
        onDelta(chunkText, accumulated);
      }
    }
  }

  return { reply: accumulated, resolvedServer: OPENAI_API_URL };
};

const streamGithubCompletion = async ({ session, modelToUse, body, onDelta }) => {
  if (!GITHUB_MODEL_TOKEN) {
    throw new Error('github_model_token_missing');
  }

  const deploymentOverride = body?.github_deployment || body?.githubDeployment;
  const endpoint = resolveGithubEndpoint(deploymentOverride);
  if (!endpoint) {
    throw new Error('github_deployment_missing');
  }

  const payload = {
    model: modelToUse || GITHUB_MODEL,
    max_tokens: resolveGithubMaxTokens(body?.github_max_tokens ?? body?.githubMaxTokens ?? body?.max_tokens),
    temperature: resolveGithubTemperature(body?.github_temperature ?? body?.githubTemperature ?? body?.temperature),
    messages: formatMessagesForOpenAi(session),
    stream: true
  };

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${GITHUB_MODEL_TOKEN}`,
      'X-GitHub-Api-Version': GITHUB_API_VERSION
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok || !response.body) {
    const detail = await response.text().catch(() => '');
    throw new Error(detail || 'github_stream_error');
  }

  let accumulated = '';
  for await (const rawEvent of parseSseStream(response.body)) {
    if (!rawEvent) continue;
    if (rawEvent.trim() === '[DONE]') {
      break;
    }
    let eventPayload;
    try {
      eventPayload = JSON.parse(rawEvent);
    } catch (err) {
      console.warn('Skipping malformed GitHub stream chunk', rawEvent, err);
      continue;
    }
    const chunkText = extractOpenAiDeltaText(eventPayload);
    if (chunkText) {
      accumulated += chunkText;
      if (typeof onDelta === 'function') {
        onDelta(chunkText, accumulated);
      }
    }
  }

  return { reply: accumulated, resolvedServer: endpoint };
};

const resolveAnthropicMaxTokens = (override) => {
  const parsed = Number(override);
  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed;
  }
  return ANTHROPIC_MAX_TOKENS;
};

const resolveAnthropicTemperature = (override) => {
  if (typeof override === 'number' && Number.isFinite(override)) {
    return override;
  }
  const parsed = Number(override);
  if (Number.isFinite(parsed)) {
    return parsed;
  }
  return ANTHROPIC_TEMPERATURE;
};

const resolveOpenAiMaxTokens = (override) => {
  const parsed = Number(override);
  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed;
  }
  return OPENAI_MAX_TOKENS;
};

const resolveOpenAiTemperature = (override) => {
  if (typeof override === 'number' && Number.isFinite(override)) {
    return override;
  }
  const parsed = Number(override);
  if (Number.isFinite(parsed)) {
    return parsed;
  }
  return OPENAI_TEMPERATURE;
};

const resolveGithubMaxTokens = (override) => {
  const parsed = Number(override);
  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed;
  }
  return GITHUB_MODEL_MAX_TOKENS;
};

const resolveGithubTemperature = (override) => {
  if (typeof override === 'number' && Number.isFinite(override)) {
    return override;
  }
  const parsed = Number(override);
  if (Number.isFinite(parsed)) {
    return parsed;
  }
  return GITHUB_MODEL_TEMPERATURE;
};

const callAnthropicMessages = async ({ messages, model, maxTokens, temperature }) => {
  if (!ANTHROPIC_API_KEY) {
    throw new Error('anthropic_api_key_missing');
  }

  if (!Array.isArray(messages) || !messages.length) {
    throw new Error('anthropic_messages_missing');
  }

  const payload = {
    model: model || ANTHROPIC_MODEL,
    max_tokens: maxTokens || ANTHROPIC_MAX_TOKENS,
    temperature: typeof temperature === 'number' ? temperature : ANTHROPIC_TEMPERATURE,
    messages
  };

  const response = await fetch(ANTHROPIC_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': ANTHROPIC_VERSION
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`anthropic_error: ${detail || response.status}`);
  }

  const data = await response.json();
  const text = Array.isArray(data?.content)
    ? data.content
        .filter((part) => part && part.type === 'text')
        .map((part) => part.text || '')
        .join('\n')
        .trim()
    : '';

  return { text, data, endpoint: resolvedEndpoint };
};

const callGithubModelMessages = async ({ messages, model, maxTokens, temperature, deployment }) => {
  if (!GITHUB_MODEL_TOKEN) {
    throw new Error('github_model_token_missing');
  }

  if (!Array.isArray(messages) || !messages.length) {
    throw new Error('github_messages_missing');
  }

  const resolvedDeployment = typeof deployment === 'string' && deployment.trim() ? deployment.trim() : GITHUB_MODEL_DEPLOYMENT;
  const resolvedEndpoint = resolveGithubEndpoint(resolvedDeployment);
  if (!resolvedEndpoint) {
    throw new Error('github_deployment_missing');
  }

  const resolvedModel = typeof model === 'string' && model.trim() ? model.trim() : GITHUB_MODEL;
  const payload = {
    model: resolvedModel,
    max_tokens: maxTokens || GITHUB_MODEL_MAX_TOKENS,
    temperature: typeof temperature === 'number' ? temperature : GITHUB_MODEL_TEMPERATURE,
    messages
  };

  const response = await fetch(resolvedEndpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${GITHUB_MODEL_TOKEN}`,
      'X-GitHub-Api-Version': GITHUB_API_VERSION
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`github_model_error: ${detail || response.status}`);
  }

  const data = await response.json();
  const text = Array.isArray(data?.choices)
    ? data.choices
        .map((choice) => choice?.message?.content || '')
        .filter(Boolean)
        .join('\n')
        .trim()
    : '';

  return { text, data };
};

const callOpenAiMessages = async ({ messages, model, maxTokens, temperature }) => {
  if (!OPENAI_API_KEY) {
    throw new Error('openai_api_key_missing');
  }

  if (!Array.isArray(messages) || !messages.length) {
    throw new Error('openai_messages_missing');
  }

  const payload = {
    model: model || OPENAI_MODEL,
    max_tokens: maxTokens || OPENAI_MAX_TOKENS,
    temperature: typeof temperature === 'number' ? temperature : OPENAI_TEMPERATURE,
    messages
  };

  const response = await fetch(OPENAI_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${OPENAI_API_KEY}`
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`openai_error: ${detail || response.status}`);
  }

  const data = await response.json();
  const text = Array.isArray(data?.choices)
    ? data.choices
        .map((choice) => choice?.message?.content || '')
        .filter(Boolean)
        .join('\n')
        .trim()
    : '';

  return { text, data };
};

app.post('/sessions', (req, res) => {
  const { name, provider } = req.body || {};
  const normalizedProvider = normalizeProvider(provider);
  if (!providerRequiresKey(normalizedProvider)) {
    return res.status(400).json({ error: 'provider_unavailable' });
  }
  const session = createSession(name, normalizedProvider);
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

  const { role, content, model, sttModel, accelerator, attachmentType, attachmentName, attachmentUrl, voiceId, provider } =
    req.body || {};

  if (!role || !content) {
    return res.status(400).json({ error: 'role_and_content_required' });
  }

  if (provider) {
    session.provider = normalizeProvider(provider);
  }

  addSessionMessage(session, {
    role,
    content,
    model,
    sttModel,
    accelerator,
    attachmentType,
    attachmentName,
    attachmentUrl,
    voiceId
  });

  return res.json({ session: sessionToResponse(session) });
});

app.post('/github-model/chat', async (req, res) => {
  const { messages, model, maxTokens, max_tokens, temperature, deployment } = req.body || {};

  try {
    const response = await callGithubModelMessages({
      messages,
      model,
      maxTokens: maxTokens || max_tokens,
      temperature,
      deployment
    });
    return res.json(response);
  } catch (err) {
    console.error('GitHub model proxy failed:', err);
    const status = err.message === 'github_model_token_missing' || err.message === 'github_messages_missing' ? 400 : 500;
    return res.status(status).json({ error: 'github_model_error', detail: err.message });
  }
});

const pickSttBase = (accelerator) => {
  if (shouldUseGpu(accelerator) && STT_GPU_URL) {
    return STT_GPU_URL;
  }
  return STT_URL;
};

const pickOpenvoiceBase = (accelerator) => {
  if (!VOICE_FEATURE_ENABLED) {
    return '';
  }
  if (shouldUseGpu(accelerator) && OPENVOICE_GPU_URL) {
    return OPENVOICE_GPU_URL;
  }
  return OPENVOICE_URL || OPENVOICE_GPU_URL || '';
};

const pickMcpImagenBase = (accelerator) => {
  if (shouldUseGpu(accelerator) && IMAGE_MCP_GPU_URL) {
    return { baseUrl: IMAGE_MCP_GPU_URL, accelerator: 'gpu' };
  }
  return { baseUrl: IMAGE_MCP_URL, accelerator: 'cpu' };
};

const pickIdpBase = (accelerator) => {
  if (shouldUseGpu(accelerator) && IDP_MCP_GPU_URL) {
    return { baseUrl: IDP_MCP_GPU_URL, accelerator: 'gpu' };
  }
  return { baseUrl: IDP_MCP_URL || IDP_MCP_GPU_URL || '', accelerator: IDP_MCP_URL ? 'cpu' : 'gpu' };
};

const ttsDir = path.join(__dirname, 'public', 'tts');
if (!fs.existsSync(ttsDir)) {
  fs.mkdirSync(ttsDir, { recursive: true });
}

const writeAudioFile = async (arrayBuffer) => {
  const filename = `${Date.now()}-${Math.random().toString(36).slice(2)}.wav`;
  const filepath = path.join(ttsDir, filename);
  await fs.promises.writeFile(filepath, Buffer.from(arrayBuffer));
  return `/tts/${filename}`;
};

const isOpenvoiceVoice = (voiceId) => typeof voiceId === 'string' && voiceId.toLowerCase().startsWith('openvoice-');

const requestOpenvoiceSynthesis = async (baseUrl, text, voiceId) => {
  if (!baseUrl) {
    throw new Error('openvoice_unavailable');
  }

  const response = await fetch(`${normalizeBaseUrl(baseUrl)}/synthesize`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, voice: voiceId })
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`openvoice_synthesis_error: ${errText}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  return writeAudioFile(arrayBuffer);
};

const synthesizeWithOpenvoice = async (text, accelerator, voiceId) => {
  if (!VOICE_FEATURE_ENABLED) {
    throw new Error('openvoice_disabled');
  }
  const prefersGpu = shouldUseGpu(accelerator) && !!OPENVOICE_GPU_URL;
  const hasCpu = !!OPENVOICE_URL;

  if (!prefersGpu && !hasCpu) {
    throw new Error('openvoice_unavailable');
  }

  const failures = [];
  const tried = new Set();
  const tryBase = async (baseUrl, label) => {
    if (!baseUrl || tried.has(baseUrl)) {
      return null;
    }
    tried.add(baseUrl);
    try {
      return await requestOpenvoiceSynthesis(baseUrl, text, voiceId);
    } catch (err) {
      failures.push({ label, message: err?.message || String(err) });
      return null;
    }
  };

  if (prefersGpu) {
    const gpuResult = await tryBase(OPENVOICE_GPU_URL, 'gpu');
    if (gpuResult) {
      return gpuResult;
    }
  }

  if (hasCpu) {
    const cpuResult = await tryBase(OPENVOICE_URL, 'cpu');
    if (cpuResult) {
      return cpuResult;
    }
  }

  const detail = failures.length
    ? failures.map((entry) => `${entry.label}: ${entry.message}`).join('; ')
    : 'openvoice_unavailable';
  throw new Error(detail);
};

const synthesizeSpeech = async (text, accelerator, voice) => {
  if (!text || !text.trim()) {
    return null;
  }

  if (!VOICE_FEATURE_ENABLED) {
    return null;
  }

  const selectedVoice = typeof voice === 'string' ? voice.trim() : '';

  try {
    if (selectedVoice && isOpenvoiceVoice(selectedVoice)) {
      return await synthesizeWithOpenvoice(text, accelerator, selectedVoice);
    }
    if (OPENVOICE_URL || OPENVOICE_GPU_URL) {
      return await synthesizeWithOpenvoice(text, accelerator, selectedVoice || 'openvoice-default');
    }
    return null;
  } catch (err) {
    console.error('TTS synthesis failed:', err);
    return null;
  }
};

app.post('/voice-chat', async (req, res) => {
  const { message, model, accelerator, sessionId, sessionName, history, voice, provider } = req.body || {};
  if (!message) return res.status(400).json({ error: 'message is required' });

  const requestedProvider = normalizeProvider(provider);
  const modelToUse = resolveModelForProvider(requestedProvider, model);
  const selectedVoice = typeof voice === 'string' ? voice.trim() : '';
  if (!providerRequiresKey(requestedProvider)) {
    return res.status(400).json({ error: 'provider_unavailable' });
  }
  let session = getSession(sessionId);
  if (!session) {
    session = createSession(sessionName, requestedProvider);
    hydrateSessionHistory(session, history);
  } else if (provider) {
    session.provider = requestedProvider;
  }
  addSessionMessage(session, {
    role: 'user',
    content: message,
    model: modelToUse,
    accelerator,
    voiceId: typeof voice === 'string' ? voice : null
  });

  try {
    const { reply, resolvedServer: serverUsed, toolRuns } = await executeChatCompletion({
      session,
      modelToUse,
      accelerator,
      body: req.body
    });
    const resolvedServer = serverUsed;

    addSessionMessage(session, {
      role: 'assistant',
      content: reply,
      model: modelToUse,
      accelerator,
      voiceId: typeof selectedVoice === 'string' ? selectedVoice : null
    });
    const audioUrl = await synthesizeSpeech(reply, accelerator, selectedVoice);
    const diagnosticsPayload = buildDiagnostics({
      provider: session.provider,
      model: modelToUse,
      accelerator,
      server: resolvedServer ||
        resolveProviderServerInfo(session.provider, {
          accelerator,
          githubDeployment: req.body?.github_deployment || req.body?.githubDeployment
        })
    });
    return res.json({
      reply,
      audioUrl,
      session: sessionToResponse(session),
      provider: session.provider,
      voiceId: typeof selectedVoice === 'string' ? selectedVoice : null,
      diagnostics: diagnosticsPayload,
      mcpTools: toolRuns
    });
  } catch (err) {
    console.error('Server error:', err);
    return res.status(500).json({ error: 'server error', detail: err.message });
  }
});

app.post('/voice-chat-audio', upload.single('audio'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'audio file is required' });

  try {
    const modelFromForm = req.body && req.body.model;
    const baseProvider = normalizeProvider(
      req.body?.provider || req.body?.sessionProvider || NORMALIZED_BASE_PROVIDER
    );
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

    const requestedLanguage = req.body && typeof req.body.language === 'string' ? req.body.language.trim() : '';
    if (requestedLanguage) {
      formData.append('language', requestedLanguage);
    }

    const targetAccelerator = req.body && req.body.accelerator;
    const selectedVoice = typeof (req.body && req.body.voice) === 'string' ? req.body.voice.trim() : '';
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
    const transcriptLanguage = typeof sttData.language === 'string' ? sttData.language : null;
    if (!transcript) {
      return res.status(500).json({ error: 'no transcript returned from STT' });
    }

    const requestedProvider = normalizeProvider(req.body?.provider || session?.provider || baseProvider);
    const modelToUse = resolveModelForProvider(requestedProvider, modelFromForm);
    if (!providerRequiresKey(requestedProvider)) {
      return res.status(400).json({ error: 'provider_unavailable' });
    }
    const session = ensureSession(req.body && req.body.sessionId, req.body && req.body.sessionName, requestedProvider);
    addSessionMessage(session, {
      role: 'user',
      content: transcript,
      model: modelToUse,
      sttModel: whisperFromForm || null,
      accelerator: targetAccelerator,
      voiceId: typeof req.body?.voice === 'string' ? req.body.voice : null
    });

    const providerForSession = session.provider || requestedProvider || NORMALIZED_BASE_PROVIDER;
    const { reply, resolvedServer: serverUsed, toolRuns } = await executeChatCompletion({
      session,
      modelToUse,
      accelerator: targetAccelerator,
      body: req.body
    });
    const resolvedServer = serverUsed;

    addSessionMessage(session, {
      role: 'assistant',
      content: reply,
      model: modelToUse,
      sttModel: whisperFromForm || null,
      accelerator: targetAccelerator,
      voiceId: typeof req.body?.voice === 'string' ? req.body.voice : null
    });
    const audioUrl = await synthesizeSpeech(reply, targetAccelerator, selectedVoice);
    const diagnosticsPayload = buildDiagnostics({
      provider: providerForSession,
      model: modelToUse,
      accelerator: targetAccelerator,
      server:
        resolvedServer ||
        resolveProviderServerInfo(providerForSession, {
          accelerator: targetAccelerator,
          githubDeployment: req.body?.github_deployment || req.body?.githubDeployment
        })
    });
    return res.json({
      transcript,
      language: transcriptLanguage,
      reply,
      audioUrl,
      session: sessionToResponse(session),
      provider: session.provider,
      voiceId: typeof req.body?.voice === 'string' ? req.body.voice : null,
      diagnostics: diagnosticsPayload,
      mcpTools: toolRuns
    });
  } catch (err) {
    console.error('audio flow error:', err);
    return res.status(500).json({ error: 'server error' });
  }
});

app.get('/mcp0/providers', async (_req, res) => {
  if (!MCP0_BASE_URL) {
    return res.status(503).json({ error: 'mcp0_unconfigured' });
  }
  try {
    const response = await requestWithTimeout(`${MCP0_BASE_URL}/providers`, { timeoutMs: MCP0_TIMEOUT_MS });
    if (!response.ok) {
      const detail = await response.text();
      console.warn('[mcp0] provider list error', detail);
      return res.status(502).json({ error: 'mcp0_providers_error', detail });
    }
    const data = await response.json();
    return res.json(data);
  } catch (err) {
    console.error('Failed to list MCP providers:', err);
    return res.status(500).json({ error: 'mcp0_providers_error', detail: err?.message || 'unknown error' });
  }
});

app.post('/mcp0/tools', async (req, res) => {
  if (!MCP0_BASE_URL) {
    return res.status(503).json({ error: 'mcp0_unconfigured' });
  }
  const provider = typeof req.body?.provider === 'string' ? req.body.provider.trim() : '';
  const tool = typeof req.body?.tool === 'string' ? req.body.tool.trim() : '';
  const args = (req.body && req.body.arguments && typeof req.body.arguments === 'object' && req.body.arguments) || {};
  if (!provider || !tool) {
    return res.status(400).json({ error: 'provider_and_tool_required' });
  }
  if (!MCP_ALLOWED_PROVIDERS.has(provider)) {
    return res.status(400).json({ error: 'provider_not_allowed' });
  }
  try {
    const result = await callMcpTool({ provider, tool, args });
    return res.json({ provider, tool, result });
  } catch (err) {
    console.error('MCP manual invocation failed:', err);
    return res.status(502).json({ error: 'mcp_tool_error', detail: err?.message || 'mcp_error' });
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

app.post('/carwatch/snapshot', async (req, res) => {
  try {
    const payload = req.body || {};
    if (!payload || typeof payload !== 'object') {
      return res.status(400).json({ error: 'invalid_payload' });
    }

    const snapshot = storeCarwatchSnapshot(payload);
    console.log('[carwatch] snapshot stored', {
      device: snapshot.deviceName,
      detections: snapshot.detections.length,
      events: snapshot.events.length
    });

    return res.json({ status: 'ok', snapshot });
  } catch (err) {
    console.error('Failed to store CarWatch snapshot:', err);
    return res.status(500).json({ error: 'server_error', detail: err?.message || 'carwatch_snapshot_failed' });
  }
});

app.get('/carwatch/snapshot', (req, res) => {
  const snapshot = getCarwatchSnapshot();
  if (!snapshot) {
    return res.status(404).json({ error: 'no_snapshot' });
  }
  const ageMs = carwatchStore.receivedAt ? Date.now() - carwatchStore.receivedAt : null;
  return res.json({ snapshot, ageMs });
});

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
      const detailText = await response.text();
      console.error('YOLO MCP error:', detailText);
      let detailJson;
      try {
        detailJson = JSON.parse(detailText);
      } catch (parseErr) {
        detailJson = undefined;
      }

      return res.status(502).json({
        error: 'yolo_mcp_error',
        detail: detailJson || detailText,
        target: `${baseUrl}/detect`,
        source: req.file?.originalname,
        mimetype: req.file?.mimetype,
        confidence: payload.confidence ?? 'default'
      });
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
    return res.status(500).json({
      error: 'server_error',
      message: err?.message || 'YOLO detection failed',
      source: req.file?.originalname,
      mimetype: req.file?.mimetype,
      confidence: payload.confidence ?? 'default',
      payloadSizeBytes: imageBase64.length,
      stack: process.env.NODE_ENV === 'production' ? undefined : err?.stack
    });
  }
});

app.post('/ocr-image', upload.single('image'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'image file is required' });
  }

  const lang = typeof req.body?.lang === 'string' && req.body.lang.trim() ? req.body.lang.trim() : OCR_DEFAULT_LANG;

  try {
    console.log('[ocr] starting recognition', { size: req.file.size, lang });
    const result = await Tesseract.recognize(req.file.buffer, lang, {
      logger: (message) => {
        if (message && message.status) {
          console.log('[ocr] progress', message);
        }
      }
    });

    const mapSpans = (spans) => {
      if (!Array.isArray(spans)) return [];
      return spans
        .filter(Boolean)
        .map((span, idx) => ({
          id: span.id || `span-${idx}`,
          text: typeof span.text === 'string' ? span.text.trim() : '',
          confidence: typeof span.confidence === 'number' ? span.confidence : null,
          bbox:
            span?.bbox && typeof span.bbox.x0 === 'number'
              ? [span.bbox.x0, span.bbox.y0, span.bbox.x1, span.bbox.y1]
              : null
        }));
    };

    const data = result?.data || {};
    return res.json({
      text: typeof data.text === 'string' ? data.text.trim() : '',
      confidence: typeof data.confidence === 'number' ? data.confidence : null,
      lang,
      blocks: mapSpans(data.blocks),
      lines: mapSpans(data.lines),
      words: mapSpans(Array.isArray(data.words) ? data.words.slice(0, 200) : [])
    });
  } catch (err) {
    console.error('OCR failed:', err);
    return res.status(500).json({ error: 'ocr_failed', detail: err?.message || 'unknown_error' });
  }
});

app.post('/generate-image', async (req, res) => {
  const body = req.body || {};
  const rawAccelerator = typeof body.accelerator === 'string' ? body.accelerator.trim().toLowerCase() : '';
  const requestedAccelerator = rawAccelerator === 'gpu' ? 'gpu' : 'cpu';
  const { baseUrl, accelerator: resolvedAccelerator } = pickImageMcpBase(requestedAccelerator);
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl || '');
  if (!normalizedBaseUrl) {
    return res.status(500).json({ error: 'image_service_unconfigured' });
  }

  const {
    prompt,
    negative_prompt,
    guidance_scale,
    num_inference_steps,
    width,
    height,
    seed
  } = body;

  if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
    return res.status(400).json({ error: 'prompt is required' });
  }

  const payload = { prompt: prompt.trim() };

  if (typeof negative_prompt === 'string' && negative_prompt.trim()) {
    payload.negative_prompt = negative_prompt.trim();
  }
  if (typeof guidance_scale !== 'undefined') {
    const parsed = Number(guidance_scale);
    if (!Number.isNaN(parsed)) {
      payload.guidance_scale = parsed;
    }
  }
  if (typeof num_inference_steps !== 'undefined') {
    const parsed = parseInt(num_inference_steps, 10);
    if (!Number.isNaN(parsed)) {
      payload.num_inference_steps = parsed;
    }
  }
  if (typeof width !== 'undefined') {
    const parsed = parseInt(width, 10);
    if (!Number.isNaN(parsed)) {
      payload.width = parsed;
    }
  }
  if (typeof height !== 'undefined') {
    const parsed = parseInt(height, 10);
    if (!Number.isNaN(parsed)) {
      payload.height = parsed;
    }
  }
  if (typeof seed !== 'undefined') {
    const parsed = parseInt(seed, 10);
    if (!Number.isNaN(parsed)) {
      payload.seed = parsed;
    }
  }

  try {
    console.log('[mcp-imagen] forwarding generate-image request', {
      target: `${normalizedBaseUrl}/generate`,
      accelerator: resolvedAccelerator,
      promptLength: payload.prompt.length,
      width: payload.width,
      height: payload.height
    });

    const response = await fetch(`${normalizedBaseUrl}/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const detail = await response.text();
      console.error('Image generator error:', detail);
      return res.status(502).json({ error: 'image_service_error', detail });
    }

    const data = await response.json();
    return res.json({ ...data, accelerator: resolvedAccelerator });
  } catch (err) {
    console.error('Image generation failed:', err);
    return res.status(500).json({ error: 'server_error' });
  }
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/mcp/providers', async (req, res) => {
  if (!MCP0_BASE_URL) {
    return res.status(503).json({ error: 'mcp0_unconfigured' });
  }

  const refreshParam = req.query?.refresh === 'true' ? '?refresh=true' : '';
  const target = `${MCP0_BASE_URL}/providers${refreshParam}`;

  try {
    const response = await requestWithTimeout(target, {
      method: 'GET',
      timeoutMs: MCP0_TIMEOUT_MS
    });

    if (!response.ok) {
      const detail = await response.text();
      console.warn('[mcp0] proxy providers error', detail);
      return res.status(502).json({ error: 'mcp0_providers_error', detail });
    }

    const payload = await response.json();
    return res.json(payload);
  } catch (err) {
    console.error('Failed to load MCP providers:', err);
    return res.status(502).json({ error: 'mcp0_unreachable', detail: err.message });
  }
});

app.get('/health', async (_req, res) => {
  const coreServiceChecks = [
    checkServiceHealth({ name: 'ollama', baseUrl: OLLAMA_URL, path: '/' }),
    checkServiceHealth({ name: 'ollamaGpu', baseUrl: OLLAMA_GPU_URL, path: '/' }),
    checkServiceHealth({ name: 'stt', baseUrl: STT_URL }),
    checkServiceHealth({ name: 'sttGpu', baseUrl: STT_GPU_URL }),
    checkServiceHealth({ name: 'yolo', baseUrl: YOLO_MCP_URL, path: '/' }),
    checkServiceHealth({ name: 'bslip', baseUrl: BSLIP_MCP_URL, path: '/health' }),
    checkServiceHealth({ name: 'mcpImagen', baseUrl: IMAGE_MCP_URL, path: '/' }),
    checkServiceHealth({ name: 'mcpImagenGpu', baseUrl: IMAGE_MCP_GPU_URL, path: '/' }),
    checkServiceHealth({ name: 'idp', baseUrl: IDP_MCP_URL, path: '/health' }),
    checkServiceHealth({ name: 'idpGpu', baseUrl: IDP_MCP_GPU_URL, path: '/health' }),
    checkServiceHealth({ name: 'memento', baseUrl: MEMENTO_MCP_URL, path: '/health' }),
    checkServiceHealth({ name: 'meeting', baseUrl: MEETING_MCP_URL, path: '/health' }),
    checkServiceHealth({ name: 'vms', baseUrl: VMS_MCP_URL, path: '/health' }),
    checkServiceHealth({ name: 'tuyaBridge', baseUrl: TUYA_MCP_URL, path: '/health' }),
    checkServiceHealth({ name: 'mcp0', baseUrl: MCP0_URL, path: '/health' }),
    checkServiceHealth({ name: 'githubMcp', baseUrl: GITHUB_MCP_URL, path: GITHUB_MCP_HEALTH_PATH }),
    checkAnthropicHealth(),
    checkOpenAiHealth()
  ];

  if (VOICE_FEATURE_ENABLED) {
    coreServiceChecks.splice(4, 0,
      checkServiceHealth({ name: 'openvoice', baseUrl: OPENVOICE_URL, path: '/hc' }),
      checkServiceHealth({ name: 'openvoiceGpu', baseUrl: OPENVOICE_GPU_URL, path: '/hc' })
    );
  }

  const serviceChecks = await Promise.all([...coreServiceChecks, Promise.resolve(checkCarwatchHealth())]);

  const hasError = serviceChecks.some((svc) => svc.status === 'error');

  res.json({
    status: hasError ? 'error' : 'ok',
    port: PORT,
    ollamaUrl: OLLAMA_URL,
    ollamaGpuUrl: OLLAMA_GPU_URL || null,
    defaultModel: MODEL,
    sttUrl: STT_URL,
    sttGpuUrl: STT_GPU_URL || null,
    openvoiceUrl: VOICE_FEATURE_ENABLED ? OPENVOICE_URL || null : null,
    openvoiceGpuUrl: VOICE_FEATURE_ENABLED ? OPENVOICE_GPU_URL || null : null,
    mementoUrl: MEMENTO_MCP_URL || null,
    meetingUrl: MEETING_MCP_URL || null,
    vmsUrl: VMS_MCP_URL || null,
    tuyaMcpUrl: TUYA_MCP_URL || null,
    mcpImagenUrl: IMAGE_MCP_URL || null,
    mcpImagenGpuUrl: IMAGE_MCP_GPU_URL || null,
    idpUrl: IDP_MCP_URL || null,
    idpGpuUrl: IDP_MCP_GPU_URL || null,
    mcp0Url: MCP0_URL || null,
    githubMcpUrl: GITHUB_MCP_URL || null,
    voiceFeatureEnabled: VOICE_FEATURE_ENABLED,
    services: serviceChecks,
    timestamp: new Date().toISOString()
  });
});

const fetchVoicesFromService = async (baseUrl, engine) => {
  const response = await fetch(`${normalizeBaseUrl(baseUrl)}/voices`);
  if (!response.ok) {
    throw new Error(`${engine}_voices_error: ${await response.text()}`);
  }
  const data = await response.json();
  const voices = Array.isArray(data?.voices) ? data.voices : [];
  const shaped = voices.map((voice) => ({
    id: String(voice.id || '').trim(),
    name: typeof voice.name === 'string' && voice.name.trim() ? voice.name.trim() : String(voice.id || '').trim(),
    sampleRate: typeof voice.sampleRate === 'number' ? voice.sampleRate : null,
    engine,
    language: voice.language || null,
    style: voice.style || null,
    type: voice.type || null,
    tier: typeof voice.tier === 'string' ? voice.tier : null,
  })).filter((voice) => !!voice.id);
  return {
    voices: shaped,
    defaultVoice: typeof data?.defaultVoice === 'string' ? data.defaultVoice : null,
  };
};

app.get('/voices', async (req, res) => {
  if (!VOICE_FEATURE_ENABLED) {
    return res.status(503).json({ error: 'voice_feature_disabled' });
  }
  try {
    const aggregated = [];
    const defaultCandidates = [];
    const triedBases = new Set();

    const tryOpenvoiceSource = async (baseUrl, label) => {
      if (!baseUrl) {
        return;
      }
      const normalized = normalizeBaseUrl(baseUrl);
      if (!normalized || triedBases.has(normalized)) {
        return;
      }
      triedBases.add(normalized);
      try {
        const { voices, defaultVoice } = await fetchVoicesFromService(normalized, 'openvoice');
        aggregated.push(...voices);
        if (defaultVoice) {
          defaultCandidates.push(defaultVoice);
        }
      } catch (err) {
        console.warn(`Failed to fetch OpenVoice voices (${label}):`, err.message);
      }
    };

    await tryOpenvoiceSource(OPENVOICE_URL, 'cpu');

    if (!aggregated.length) {
      await tryOpenvoiceSource(OPENVOICE_GPU_URL, 'gpu');
    }

    if (!aggregated.length) {
      return res.status(503).json({ error: 'voices_unavailable', detail: 'no openvoice voices available' });
    }

    const combinedDefault =
      defaultCandidates.find((candidate) => aggregated.some((voice) => voice.id === candidate)) || aggregated[0]?.id || null;

    return res.json({ voices: aggregated, defaultVoice: combinedDefault });
  } catch (err) {
    console.error('Failed to aggregate voices:', err);
    return res.status(502).json({ error: 'voices_unavailable' });
  }
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
