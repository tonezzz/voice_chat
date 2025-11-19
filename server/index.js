const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const multer = require('multer');
const FormData = require('form-data');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const Tesseract = require('tesseract.js');

const app = express();
app.use(cors());
app.use(express.json());

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

const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const OLLAMA_GPU_URL = process.env.OLLAMA_GPU_URL || '';
const MODEL = process.env.MODEL || 'llama3';
const PORT = process.env.PORT || 3001;
const STT_URL = process.env.STT_URL || 'http://localhost:5001';
const STT_GPU_URL = process.env.STT_GPU_URL || '';
const OPENVOICE_URL = process.env.OPENVOICE_URL || '';
const OPENVOICE_GPU_URL = process.env.OPENVOICE_GPU_URL || '';
const YOLO_MCP_URL = process.env.YOLO_MCP_URL || 'http://localhost:8000';
const BSLIP_MCP_URL = process.env.BSLIP_MCP_URL || 'http://localhost:8002';
const IMAGE_MCP_URL = process.env.IMAGE_MCP_URL || 'http://localhost:8001';
const IMAGE_MCP_GPU_URL = process.env.IMAGE_MCP_GPU_URL || '';
const IDP_MCP_URL = process.env.IDP_MCP_URL || 'http://localhost:8004';
const IDP_MCP_GPU_URL = process.env.IDP_MCP_GPU_URL || 'http://localhost:8104';
const MCP0_URL = process.env.MCP0_URL || '';
const GITHUB_MCP_URL = process.env.GITHUB_MCP_URL || 'https://mcp.github.com';
const GITHUB_MCP_HEALTH_PATH = process.env.GITHUB_MCP_HEALTH_PATH || '/health';
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

const shouldUseGpu = (accelerator) => accelerator === 'gpu';
const normalizeProvider = (provider) => {
  if (!provider) return NORMALIZED_BASE_PROVIDER;
  const lowered = provider.toLowerCase();
  if (lowered === 'claude') return 'anthropic';
  if (lowered === 'chatgpt') return 'openai';
  return lowered;
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

const HEALTH_CHECK_TIMEOUT_MS = Number(process.env.HEALTH_CHECK_TIMEOUT_MS) || 2000;

const joinServicePath = (baseUrl, path = '/health') => {
  const normalized = normalizeBaseUrl(baseUrl);
  if (!normalized) return '';
  if (!path || path === '/') return `${normalized}/`;
  return path.startsWith('/') ? `${normalized}${path}` : `${normalized}/${path}`;
};

const checkAnthropicHealth = async () => {
  if (!isAnthropicProvider()) {
    return { name: 'anthropic', status: 'disabled' };
  }
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
  if (!isOpenAiProvider()) {
    return { name: 'openai', status: 'disabled' };
  }
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

  return { text, data };
};

const callGithubModelMessages = async ({ messages, model, maxTokens, temperature, deployment }) => {
  if (!GITHUB_MODEL_TOKEN) {
    throw new Error('github_model_token_missing');
  }

  if (!Array.isArray(messages) || !messages.length) {
    throw new Error('github_messages_missing');
  }

  const resolvedDeployment = typeof deployment === 'string' && deployment.trim() ? deployment.trim() : GITHUB_MODEL_DEPLOYMENT;
  if (!resolvedDeployment) {
    throw new Error('github_deployment_missing');
  }

  const resolvedModel = typeof model === 'string' && model.trim() ? model.trim() : GITHUB_MODEL;
  const baseUrl = normalizeBaseUrl(GITHUB_MODEL_CHAT_BASE_URL || DEFAULT_GITHUB_CHAT_BASE);
  const endpoint = GITHUB_MODEL_CHAT_URL
    ? GITHUB_MODEL_CHAT_URL
    : `${baseUrl}/${encodeURIComponent(resolvedDeployment)}/chat/completions`;

  const payload = {
    model: resolvedModel,
    max_tokens: maxTokens || GITHUB_MODEL_MAX_TOKENS,
    temperature: typeof temperature === 'number' ? temperature : GITHUB_MODEL_TEMPERATURE,
    messages
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

  const modelToUse = model || MODEL;
  const selectedVoice = typeof voice === 'string' ? voice.trim() : '';
  const requestedProvider = normalizeProvider(provider);
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
    let reply = '';
    if (isAnthropicProvider(session.provider)) {
      const anthropicMessages = formatMessagesForAnthropic(session);
      const { text } = await callAnthropicMessages({
        messages: anthropicMessages,
        model: modelToUse,
        maxTokens: resolveAnthropicMaxTokens(req.body?.anthropic_max_tokens),
        temperature: resolveAnthropicTemperature(req.body?.anthropic_temperature)
      });
      reply = text;
    } else if (isOpenAiProvider(session.provider)) {
      const openAiMessages = formatMessagesForOpenAi(session);
      const { text } = await callOpenAiMessages({
        messages: openAiMessages,
        model: modelToUse,
        maxTokens: resolveOpenAiMaxTokens(req.body?.openai_max_tokens),
        temperature: resolveOpenAiTemperature(req.body?.openai_temperature)
      });
      reply = text;
    } else if (isGithubProvider(session.provider)) {
      const githubMessages = formatMessagesForOpenAi(session);
      const { text } = await callGithubModelMessages({
        messages: githubMessages,
        model: modelToUse,
        maxTokens: resolveGithubMaxTokens(
          req.body?.github_max_tokens ?? req.body?.githubMaxTokens ?? req.body?.max_tokens
        ),
        temperature: resolveGithubTemperature(
          req.body?.github_temperature ?? req.body?.githubTemperature ?? req.body?.temperature
        ),
        deployment: req.body?.github_deployment || req.body?.githubDeployment
      });
      reply = text;
    } else {
      const baseUrl = pickOllamaBase(accelerator);
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
      reply = (data.message && data.message.content) || data.response || '';
    }

    addSessionMessage(session, {
      role: 'assistant',
      content: reply,
      model: modelToUse,
      accelerator,
      voiceId: typeof selectedVoice === 'string' ? selectedVoice : null
    });
    const audioUrl = await synthesizeSpeech(reply, accelerator, selectedVoice);
    return res.json({
      reply,
      audioUrl,
      session: sessionToResponse(session),
      provider: session.provider,
      voiceId: typeof selectedVoice === 'string' ? selectedVoice : null
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

    const requestedProvider = normalizeProvider(req.body?.provider || session?.provider || NORMALIZED_BASE_PROVIDER);
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

    let reply = '';
    const providerForSession = session.provider || requestedProvider || NORMALIZED_BASE_PROVIDER;

    if (isAnthropicProvider(providerForSession)) {
      const anthropicMessages = formatMessagesForAnthropic(session);
      const { text } = await callAnthropicMessages({
        messages: anthropicMessages,
        model: modelToUse,
        maxTokens: resolveAnthropicMaxTokens(req.body?.anthropic_max_tokens),
        temperature: resolveAnthropicTemperature(req.body?.anthropic_temperature)
      });
      reply = text;
    } else if (isOpenAiProvider(providerForSession)) {
      const openAiMessages = formatMessagesForOpenAi(session);
      const { text } = await callOpenAiMessages({
        messages: openAiMessages,
        model: modelToUse,
        maxTokens: resolveOpenAiMaxTokens(req.body?.openai_max_tokens),
        temperature: resolveOpenAiTemperature(req.body?.openai_temperature)
      });
      reply = text;
    } else if (isGithubProvider(providerForSession)) {
      const githubMessages = formatMessagesForOpenAi(session);
      const { text } = await callGithubModelMessages({
        messages: githubMessages,
        model: modelToUse,
        maxTokens: resolveGithubMaxTokens(
          req.body?.github_max_tokens ?? req.body?.githubMaxTokens ?? req.body?.max_tokens
        ),
        temperature: resolveGithubTemperature(
          req.body?.github_temperature ?? req.body?.githubTemperature ?? req.body?.temperature
        ),
        deployment: req.body?.github_deployment || req.body?.githubDeployment
      });
      reply = text;
    } else {
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
      reply = (ollamaData.message && ollamaData.message.content) || ollamaData.response || '';
    }

    addSessionMessage(session, {
      role: 'assistant',
      content: reply,
      model: modelToUse,
      sttModel: whisperFromForm || null,
      accelerator: targetAccelerator,
      voiceId: typeof req.body?.voice === 'string' ? req.body.voice : null
    });
    const audioUrl = await synthesizeSpeech(reply, targetAccelerator, selectedVoice);
    return res.json({
      transcript,
      language: transcriptLanguage,
      reply,
      audioUrl,
      session: sessionToResponse(session),
      provider: session.provider,
      voiceId: typeof req.body?.voice === 'string' ? req.body.voice : null
    });
  } catch (err) {
    console.error('audio flow error:', err);
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

app.get('/health', async (_req, res) => {
  const serviceChecks = await Promise.all([
    checkServiceHealth({ name: 'ollama', baseUrl: OLLAMA_URL, path: '/' }),
    checkServiceHealth({ name: 'ollamaGpu', baseUrl: OLLAMA_GPU_URL, path: '/' }),
    checkServiceHealth({ name: 'stt', baseUrl: STT_URL }),
    checkServiceHealth({ name: 'sttGpu', baseUrl: STT_GPU_URL }),
    checkServiceHealth({ name: 'openvoice', baseUrl: OPENVOICE_URL, path: '/hc' }),
    checkServiceHealth({ name: 'openvoiceGpu', baseUrl: OPENVOICE_GPU_URL, path: '/hc' }),
    checkServiceHealth({ name: 'yolo', baseUrl: YOLO_MCP_URL, path: '/' }),
    checkServiceHealth({ name: 'bslip', baseUrl: BSLIP_MCP_URL, path: '/health' }),
    checkServiceHealth({ name: 'mcpImagen', baseUrl: IMAGE_MCP_URL, path: '/' }),
    checkServiceHealth({ name: 'mcpImagenGpu', baseUrl: IMAGE_MCP_GPU_URL, path: '/' }),
    checkServiceHealth({ name: 'idp', baseUrl: IDP_MCP_URL, path: '/health' }),
    checkServiceHealth({ name: 'idpGpu', baseUrl: IDP_MCP_GPU_URL, path: '/health' }),
    checkServiceHealth({ name: 'mcp0', baseUrl: MCP0_URL, path: '/health' }),
    checkServiceHealth({ name: 'githubMcp', baseUrl: GITHUB_MCP_URL, path: GITHUB_MCP_HEALTH_PATH }),
    checkAnthropicHealth(),
    checkOpenAiHealth()
  ]);

  const hasError = serviceChecks.some((svc) => svc.status === 'error');

  res.json({
    status: hasError ? 'error' : 'ok',
    port: PORT,
    ollamaUrl: OLLAMA_URL,
    ollamaGpuUrl: OLLAMA_GPU_URL || null,
    defaultModel: MODEL,
    sttUrl: STT_URL,
    sttGpuUrl: STT_GPU_URL || null,
    openvoiceUrl: OPENVOICE_URL || null,
    openvoiceGpuUrl: OPENVOICE_GPU_URL || null,
    yoloUrl: YOLO_MCP_URL || null,
    mcpImagenUrl: IMAGE_MCP_URL || null,
    mcpImagenGpuUrl: IMAGE_MCP_GPU_URL || null,
    idpUrl: IDP_MCP_URL || null,
    idpGpuUrl: IDP_MCP_GPU_URL || null,
    mcp0Url: MCP0_URL || null,
    githubMcpUrl: GITHUB_MCP_URL || null,
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
