const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const multer = require('multer');
const FormData = require('form-data');
const crypto = require('crypto');
const Tesseract = require('tesseract.js');
const {
  isRedisEnabled,
  getJson: getRedisJson,
  setJson: setRedisJson,
  DEFAULT_CACHE_TTL_SECONDS
} = require('./services/redisClient');

const app = express();
const JSON_BODY_LIMIT = process.env.JSON_BODY_LIMIT || '50mb';
app.use(cors());
app.use(express.json({ limit: JSON_BODY_LIMIT }));
app.use(express.urlencoded({ limit: JSON_BODY_LIMIT, extended: true }));

app.use(express.static(path.join(__dirname, 'public')));

const dynamicEndpointRegistry = new Map();

const MIN_GITHUB_MODELS_REFRESH_INTERVAL_MS = 60 * 1000;
const DEFAULT_GITHUB_MODELS_REFRESH_INTERVAL_MS = 15 * 60 * 1000;
const GITHUB_MODELS_CATALOG_URL = process.env.GITHUB_MODELS_CATALOG_URL || 'https://models.github.ai/v1/models';
const GITHUB_MODELS_REFRESH_INTERVAL_MS = Math.max(
  MIN_GITHUB_MODELS_REFRESH_INTERVAL_MS,
  Number(process.env.GITHUB_MODELS_REFRESH_INTERVAL_MS) || DEFAULT_GITHUB_MODELS_REFRESH_INTERVAL_MS
);

const resolveGithubModelsSharedPath = () => {
  const customPath = (process.env.GITHUB_MODELS_SHARED_PATH || '').trim();
  if (customPath) {
    return path.isAbsolute(customPath) ? customPath : path.join(__dirname, '..', customPath);
  }
  return path.join(__dirname, '..', 'shared', 'models', 'github-public-models.json');
};

const checkGithubCatalogHealth = async () => {
  try {
    const snapshot = await getGithubModelsCatalogSnapshot();
    const summary = summarizeGithubCatalogSnapshot(snapshot, { includeModels: false });
    const status = summary.status === 'ok' ? 'ok' : summary.status === 'empty' ? 'warning' : 'error';
    return { name: 'githubModelsCatalog', status, detail: summary };
  } catch (err) {
    return { name: 'githubModelsCatalog', status: 'error', detail: err?.message || 'catalog_unavailable' };
  }
};

const GITHUB_MODELS_SHARED_PATH = resolveGithubModelsSharedPath();
const GITHUB_MODELS_SHARED_DIR = path.dirname(GITHUB_MODELS_SHARED_PATH);

const githubModelsCatalogState = {
  source: GITHUB_MODELS_CATALOG_URL,
  fetchedAt: null,
  fetchedAtMs: 0,
  total: 0,
  models: [],
  lastError: null,
  filePath: GITHUB_MODELS_SHARED_PATH
};

let githubModelsRefreshPromise = null;
let githubModelsRefreshTimer = null;

const ensureGithubModelsDirectory = () => {
  try {
    fs.mkdirSync(GITHUB_MODELS_SHARED_DIR, { recursive: true });
  } catch (err) {
    console.error('[github-models] failed to create shared directory:', err?.message || err);
  }
};

const applyGithubCatalogSnapshot = (snapshot) => {
  if (!snapshot || !Array.isArray(snapshot.models)) {
    return;
  }
  githubModelsCatalogState.source = snapshot.source || GITHUB_MODELS_CATALOG_URL;
  githubModelsCatalogState.models = snapshot.models;
  githubModelsCatalogState.total = typeof snapshot.total === 'number' ? snapshot.total : snapshot.models.length;
  githubModelsCatalogState.fetchedAt = snapshot.fetchedAt || new Date().toISOString();
  githubModelsCatalogState.fetchedAtMs = Date.parse(githubModelsCatalogState.fetchedAt) || Date.now();
  githubModelsCatalogState.lastError = null;
};

const persistGithubCatalogSnapshot = async (snapshot) => {
  if (!snapshot || !Array.isArray(snapshot.models)) {
    return;
  }
  ensureGithubModelsDirectory();
  try {
    await fsp.writeFile(GITHUB_MODELS_SHARED_PATH, JSON.stringify(snapshot, null, 2), 'utf8');
  } catch (err) {
    console.error('[github-models] failed to write catalog cache:', err?.message || err);
  }
};

const hydrateGithubCatalogFromDisk = async () => {
  try {
    const raw = await fsp.readFile(GITHUB_MODELS_SHARED_PATH, 'utf8');
    const snapshot = JSON.parse(raw);
    if (snapshot && Array.isArray(snapshot.models)) {
      applyGithubCatalogSnapshot(snapshot);
    }
  } catch (err) {
    if (err?.code !== 'ENOENT') {
      console.warn('[github-models] failed to read cached catalog:', err?.message || err);
    }
  }
};

const fetchGithubCatalogFromRemote = async () => {
  const response = await fetch(GITHUB_MODELS_CATALOG_URL, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      'User-Agent': 'voice-chat-server/1.0 (+github-models catalog refresh)'
    }
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`catalog_fetch_failed (${response.status}): ${detail?.slice(0, 200) || 'no detail'}`);
  }

  const payload = await response.json();
  const models = Array.isArray(payload?.data)
    ? payload.data
    : Array.isArray(payload?.models)
      ? payload.models
      : Array.isArray(payload)
        ? payload
        : [];

  if (!Array.isArray(models)) {
    throw new Error('catalog_response_invalid');
  }

  return {
    source: GITHUB_MODELS_CATALOG_URL,
    fetchedAt: new Date().toISOString(),
    total: models.length,
    models
  };
};

const refreshGithubModelsCatalog = async ({ force = false, reason = 'scheduled' } = {}) => {
  if (!force && githubModelsRefreshPromise) {
    return githubModelsRefreshPromise;
  }

  if (
    !force &&
    githubModelsCatalogState.fetchedAtMs &&
    Date.now() - githubModelsCatalogState.fetchedAtMs < GITHUB_MODELS_REFRESH_INTERVAL_MS
  ) {
    return githubModelsCatalogState;
  }

  githubModelsRefreshPromise = (async () => {
    const snapshot = await fetchGithubCatalogFromRemote();
    applyGithubCatalogSnapshot(snapshot);
    await persistGithubCatalogSnapshot(snapshot);
    console.log(`[github-models] catalog refreshed (${snapshot.total} models, reason=${reason})`);
    return githubModelsCatalogState;
  })()
    .catch((err) => {
      githubModelsCatalogState.lastError = {
        message: err?.message || 'github_models_refresh_failed',
        at: new Date().toISOString(),
        reason
      };
      console.error('[github-models] catalog refresh failed:', err);
      throw err;
    })
    .finally(() => {
      githubModelsRefreshPromise = null;
    });

  return githubModelsRefreshPromise;
};

const getGithubModelsCatalogSnapshot = async ({ forceRefresh = false } = {}) => {
  if (!githubModelsCatalogState.models.length) {
    await hydrateGithubCatalogFromDisk();
  }

  if (forceRefresh) {
    await refreshGithubModelsCatalog({ force: true, reason: 'manual' }).catch(() => {});
  } else if (!githubModelsCatalogState.models.length) {
    await refreshGithubModelsCatalog({ force: true, reason: 'autoload' }).catch(() => {});
  }

  return {
    source: githubModelsCatalogState.source,
    fetchedAt: githubModelsCatalogState.fetchedAt,
    fetchedAtMs: githubModelsCatalogState.fetchedAtMs || null,
    total: githubModelsCatalogState.total,
    models: githubModelsCatalogState.models,
    filePath: githubModelsCatalogState.filePath,
    lastError: githubModelsCatalogState.lastError
  };
};

const summarizeGithubCatalogSnapshot = (snapshot, { includeModels = true } = {}) => {
  if (!snapshot) {
    return { status: 'empty', source: GITHUB_MODELS_CATALOG_URL, total: 0, models: includeModels ? [] : undefined };
  }

  const parsedFetchedAtMs = typeof snapshot.fetchedAtMs === 'number' && Number.isFinite(snapshot.fetchedAtMs)
    ? snapshot.fetchedAtMs
    : snapshot.fetchedAt
      ? Date.parse(snapshot.fetchedAt)
      : null;
  const now = Date.now();
  const staleMs = parsedFetchedAtMs ? Math.max(0, now - parsedFetchedAtMs) : null;

  const status = snapshot.lastError
    ? 'degraded'
    : snapshot.total > 0
      ? 'ok'
      : 'empty';

  const base = {
    status,
    source: snapshot.source,
    fetchedAt: snapshot.fetchedAt,
    fetchedAtMs: parsedFetchedAtMs,
    total: snapshot.total,
    filePath: snapshot.filePath,
    lastError: snapshot.lastError,
    staleMs,
    refreshIntervalMs: GITHUB_MODELS_REFRESH_INTERVAL_MS
  };

  if (includeModels) {
    base.models = snapshot.models;
  }

  return base;
};

const initializeGithubModelsCatalogPipeline = () => {
  ensureGithubModelsDirectory();
  hydrateGithubCatalogFromDisk().catch((err) => {
    console.warn('[github-models] failed to hydrate catalog from disk:', err?.message || err);
  });
  refreshGithubModelsCatalog({ force: true, reason: 'startup' }).catch((err) => {
    console.warn('[github-models] initial catalog fetch failed:', err?.message || err);
  });
  githubModelsRefreshTimer = setInterval(() => {
    refreshGithubModelsCatalog({ force: true, reason: 'interval' }).catch((err) => {
      console.warn('[github-models] scheduled refresh failed:', err?.message || err);
    });
  }, GITHUB_MODELS_REFRESH_INTERVAL_MS);
  if (typeof githubModelsRefreshTimer?.unref === 'function') {
    githubModelsRefreshTimer.unref();
  }
};

initializeGithubModelsCatalogPipeline();

const serveClientIndex = (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
};

const checkRedisHealth = async () => {
  if (!isRedisEnabled()) {
    return { name: 'redis', status: 'disabled' };
  }
  try {
    await getRedisJson('__health_probe__');
    return { name: 'redis', status: 'ok' };
  } catch (err) {
    return { name: 'redis', status: 'error', detail: err?.message || 'redis_unreachable' };
  }
};

const checkGithubProviderConfigured = () => {
  if (!isGithubProvider()) {
    return { name: 'githubModel', status: 'disabled' };
  }
  if (!GITHUB_MODEL_TOKEN) {
    return { name: 'githubModel', status: 'unconfigured' };
  }
  return { name: 'githubModel', status: 'configured' };
};

app.get(['/preview', '/app-preview', '/imagen', '/imagen/'], serveClientIndex);

const registerDynamicEndpointGroup = (groupName, config = {}) => {
  const { basePath = '', routes = [], enabled = true } = config;
  if (!enabled || !routes.length) {
    console.log(
      `[dynamic-endpoints] skipped group ${groupName} (enabled=${enabled}, routes=${routes.length})`
    );
    return;
  }

  const normalizedBase = basePath
    ? basePath.startsWith('/')
      ? basePath.replace(/\/$/, '')
      : `/${basePath.replace(/\/$/, '')}`
    : '';

  routes.forEach(({ method = 'get', path = '', handler, description, middlewares = [] }) => {
    if (typeof handler !== 'function') {
      console.warn(`[dynamic-endpoints] missing handler for ${groupName}${path}`);
      return;
    }
    const verb = method.toLowerCase();
    if (typeof app[verb] !== 'function') {
      console.warn(`[dynamic-endpoints] unsupported method ${method} for ${groupName}${path}`);
      return;
    }
    const normalizedPath = path ? (path.startsWith('/') ? path : `/${path}`) : '';
    const fullPath = `${normalizedBase}${normalizedPath}` || '/';
    const stack = [];
    if (Array.isArray(middlewares) && middlewares.length) {
      middlewares.forEach((mw) => {
        if (typeof mw === 'function') {
          stack.push(mw);
        } else {
          console.warn(`[dynamic-endpoints] skipped invalid middleware for ${groupName}${path}`);
        }
      });
    }
    stack.push(handler);
    app[verb](fullPath, ...stack);
    const details = description ? ` - ${description}` : '';
    console.log(`[dynamic-endpoints] registered ${verb.toUpperCase()} ${fullPath} (${groupName}${details})`);
  });

  dynamicEndpointRegistry.set(groupName, { basePath: normalizedBase, routes: [...routes] });
};

const serveCarwatchHelper = (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'carwatch-helper.html'));
};

app.get('/carwatch-helper', serveCarwatchHelper);
app.get('/carwatch-helper-v2', serveCarwatchHelper);

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

const ensureMeetingConfigured = (res) => {
  if (!MEETING_MCP_URL) {
    res.status(503).json({ error: 'meeting_mcp_unconfigured' });
    return false;
  }
  return true;
};

const meetingListSessionsHandler = async (req, res) => {
  try {
    if (!ensureMeetingConfigured(res)) return;
    const includeArchived = String(req.query.includeArchived).toLowerCase() === 'true';
    const payload = await invokeMeetingTool('list_sessions', { include_archived: includeArchived });
    return res.json(unwrapMeetingResponse(payload));
  } catch (err) {
    console.error('meeting sessions list failed', err);
    return res.status(502).json({ error: err?.message || 'meeting_sessions_failed' });
  }
};

const meetingCreateSessionHandler = async (req, res) => {
  try {
    if (!ensureMeetingConfigured(res)) return;
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
};

const meetingSessionDetailHandler = async (req, res) => {
  try {
    if (!ensureMeetingConfigured(res)) return;
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
};

const meetingSummarizeHandler = async (req, res) => {
  try {
    if (!ensureMeetingConfigured(res)) return;
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
};

const meetingAppendTranscriptHandler = async (req, res) => {
  try {
    if (!ensureMeetingConfigured(res)) return;
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
};

const meetingIngestAudioHandler = async (req, res) => {
  try {
    if (!ensureMeetingConfigured(res)) return;
    const { sessionId, speaker, title, participants, tags, language, whisperModel } = req.body || {};
    if (!req.file?.buffer) {
      return res.status(400).json({ error: 'audio file is required' });
    }

    const meetingSessionId = typeof sessionId === 'string' && sessionId.trim().length ? sessionId.trim() : `browser-${Date.now()}`;

    await invokeMeetingTool('start_meeting', {
      session_id: meetingSessionId,
      title: typeof title === 'string' ? title : undefined,
      participants: Array.isArray(participants) ? participants : undefined,
      language,
      tags: Array.isArray(tags) ? tags : undefined
    });

    const mimeType = req.file.mimetype || 'audio/webm';
    const encoded = `data:${mimeType};base64,${req.file.buffer.toString('base64')}`;
    const entry = await invokeMeetingTool('ingest_audio_chunk', {
      session_id: meetingSessionId,
      audio_base64: encoded,
      speaker: typeof speaker === 'string' ? speaker : undefined,
      language,
      whisper_model: typeof whisperModel === 'string' ? whisperModel : undefined,
      filename: req.file.originalname || 'meeting-audio.webm'
    });

    return res.json({ sessionId: meetingSessionId, entry: unwrapMeetingResponse(entry) });
  } catch (err) {
    console.error('meeting audio ingest failed', err);
    const detail = err?.message || 'meeting_audio_ingest_failed';
    return res.status(502).json({ error: detail });
  }
};

registerDynamicEndpointGroup('meeting', {
  basePath: '/meeting',
  enabled: true,
  routes: [
    { method: 'get', path: '/sessions', handler: meetingListSessionsHandler, description: 'list sessions' },
    { method: 'post', path: '/sessions', handler: meetingCreateSessionHandler, description: 'start session' },
    { method: 'get', path: '/sessions/:sessionId', handler: meetingSessionDetailHandler, description: 'session detail' },
    { method: 'post', path: '/sessions/:sessionId/summarize', handler: meetingSummarizeHandler, description: 'summarize session' },
    { method: 'post', path: '/append-transcript', handler: meetingAppendTranscriptHandler, description: 'append transcript' },
    {
      method: 'post',
      path: '/ingest-audio',
      handler: meetingIngestAudioHandler,
      description: 'ingest audio chunk',
      middlewares: [upload.single('audio')]
    }
  ]
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

    const contentType = (response.headers.get('content-type') || '').toLowerCase();
    const acceptsNdjson = contentType.includes('application/x-ndjson') || contentType.includes('application/ndjson');
    const acceptsJson = contentType.includes('application/json');
    if (!acceptsJson && !acceptsNdjson) {
      const detail = await response.text().catch(() => '');
      console.error('Image generator returned non-JSON response', { contentType, detail });
      return res.status(502).json({ error: 'image_service_invalid_response', detail: detail || `Unexpected content-type ${contentType || 'unknown'}` });
    }

    res.setHeader('Content-Type', acceptsNdjson ? 'application/x-ndjson' : 'application/json');
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

const buildImagenJobPayload = (body = {}) => {
  const { prompt, negative_prompt, guidance_scale, num_inference_steps, width, height, seed } = body;
  if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
    throw new Error('prompt_required');
  }
  const payload = { prompt: prompt.trim() };
  if (typeof negative_prompt === 'string' && negative_prompt.trim()) {
    payload.negative_prompt = negative_prompt.trim();
  }
  const numericFields = [
    ['guidance_scale', guidance_scale],
    ['num_inference_steps', num_inference_steps],
    ['width', width],
    ['height', height],
    ['seed', seed]
  ];
  for (const [key, value] of numericFields) {
    if (typeof value === 'undefined' || value === null || value === '') continue;
    const parsed = Number(value);
    if (!Number.isNaN(parsed)) {
      payload[key] = key === 'seed' ? Math.trunc(parsed) : parsed;
    }
  }
  return payload;
};

app.post('/generate-image-queued', (req, res) => {
  if (!isGpuWorkerAvailable()) {
    return res.status(503).json({ error: 'gpu_worker_unavailable' });
  }
  if (isGpuQueueFull()) {
    return res.status(429).json({ error: 'gpu_queue_full' });
  }

  let payload;
  try {
    payload = buildImagenJobPayload(req.body || {});
  } catch (err) {
    if (err.message === 'prompt_required') {
      return res.status(400).json({ error: 'prompt_required' });
    }
    console.error('Failed to normalize queued imagen payload', err);
    return res.status(500).json({ error: 'server_error' });
  }

  const priority = (req.body && req.body.priority) || 'normal';
  const job = createGpuJob({ tool: 'imagenGenerate', payload, priority });
  console.log('[gpu-jobs] queued imagen job', { jobId: job.id, priority: job.priority });
  return res.json({ job });
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
  if (!VAJA_ENABLED) {
    return res.status(503).json({ error: 'voice_feature_disabled' });
  }
  const { voiceId, text } = req.body || {};
  const selectedVoice = typeof voiceId === 'string' && voiceId.trim() ? voiceId.trim() : 'noina';
  const previewText = typeof text === 'string' && text.trim().length >= 6 ? text.trim() : 'VAJA preview voice.';
  try {
    const data = await invokeVaja({ text: previewText, speaker: selectedVoice, download: false });
    return res.json({ audioUrl: data?.audio_url || null });
  } catch (err) {
    console.error('Voice preview failed:', err);
    return res.status(500).json({ error: 'voice_preview_failed', detail: err.message });
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
const VAJA_MCP_URL = resolveServiceUrl(process.env.VAJA_MCP_URL || process.env.VAJA_ENDPOINT || '');
const VAJA_VOICES = [
  { id: 'nana', name: 'Nana • Female • Animation' },
  { id: 'noina', name: 'Noina • Female • Commercial/IVR' },
  { id: 'farah', name: 'Farah • Female • Documentary' },
  { id: 'mewzy', name: 'Mewzy • Female • Commercial' },
  { id: 'farsai', name: 'Farsai • Female • Animation' },
  { id: 'prim', name: 'Prim • Female • Announcer' },
  { id: 'ped', name: 'Ped • Female • Announcer' },
  { id: 'poom', name: 'Poom • Male • Commercial/IVR' },
  { id: 'doikham', name: 'Doikham • Male • Northern dialect' },
  { id: 'praw', name: 'Praw • Girl • Youth' },
  { id: 'wayu', name: 'Wayu • Boy • Youth' },
  { id: 'namphueng', name: 'Namphueng • Female • Anchor style' },
  { id: 'toon', name: 'Toon • Female • Broadcast style' },
  { id: 'sanooch', name: 'Sanooch • Female • Teacher style' },
  { id: 'thanwa', name: 'Thanwa • Male • Broadcast style' }
];
const YOLO_MCP_URL = resolveServiceUrl(process.env.YOLO_MCP_URL, 'http://localhost:8000');
const VAJA_ENABLED = !!VAJA_MCP_URL;
const VOICE_FEATURE_ENABLED =
  (process.env.ENABLE_VOICE_FEATURE || process.env.VOICE_FEATURE_ENABLED || '').toLowerCase() === 'true' ||
  VAJA_ENABLED;
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

const ENABLE_EDGE_JOBS = (process.env.ENABLE_EDGE_JOBS || '').toLowerCase() === 'true';
const EDGE_MAX_PENDING_JOBS = Number(process.env.EDGE_MAX_PENDING_JOBS) || 200;
const EDGE_JOB_LEASE_SECONDS = Number(process.env.EDGE_JOB_LEASE_SECONDS) || 120;
const EDGE_HEARTBEAT_SECONDS = Number(process.env.EDGE_HEARTBEAT_SECONDS) || 45;

const gpuJobQueue = [];
const gpuJobStore = new Map();

const edgeJobQueue = [];
const edgeJobStore = new Map();
const edgeWorkers = new Map();

const isGpuQueueFull = () => gpuJobQueue.length >= GPU_MAX_PENDING_JOBS;
const isGpuWorkerAvailable = () => Boolean(GPU_WORKER_TOKEN);

const isEdgeQueueFull = () => edgeJobQueue.length >= EDGE_MAX_PENDING_JOBS;

const createGpuJob = ({ tool, payload = null, priority }) => {
  const normalizedPriority = priority === 'high' ? 'high' : 'normal';
  const job = {
    id: crypto.randomUUID(),
    tool,
    payload,
    priority: normalizedPriority,
    status: 'queued',
    enqueuedAt: now(),
    startedAt: null,
    completedAt: null,
    workerId: null,
    attempts: 0
  };
  gpuJobStore.set(job.id, job);
  enqueueJob(job);
  return job;
};

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

const enqueueEdgeJob = (job) => {
  if (job.priority === 'high') {
    edgeJobQueue.unshift(job);
  } else {
    edgeJobQueue.push(job);
  }
};

const normalizeEdgeTags = (input) => {
  if (!Array.isArray(input)) return [];
  const seen = new Set();
  const tags = [];
  for (const raw of input) {
    if (typeof raw !== 'string') continue;
    const trimmed = raw.trim().toLowerCase();
    if (!trimmed) continue;
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    tags.push(trimmed);
  }
  return tags;
};

const ensureEdgeWorker = (workerId) => edgeWorkers.get(workerId);

const upsertEdgeWorker = ({
  workerId,
  tags,
  battery,
  capabilities
}) => {
  const data = {
    workerId,
    tags,
    battery,
    capabilities,
    updatedAt: now()
  };
  edgeWorkers.set(workerId, data);
  return data;
};

const cleanupExpiredEdgeJobs = () => {
  const cutoff = now() - EDGE_JOB_LEASE_SECONDS * 1000;
  for (const job of edgeJobStore.values()) {
    if (job.status === 'leased' && job.startedAt && job.startedAt < cutoff) {
      job.status = 'queued';
      job.leaseExpiresAt = null;
      job.workerId = null;
      job.startedAt = null;
      enqueueEdgeJob(job);
    }
  }
};

const validateLocalTask = (task) => {
  if (!task || typeof task !== 'object') {
    throw new Error('task_required');
  }
  if (typeof task.kind !== 'string' || !task.kind.trim()) {
    throw new Error('task_kind_required');
  }
  if (typeof task.payload !== 'undefined' && typeof task.payload !== 'object') {
    throw new Error('task_payload_invalid');
  }
};

const createEdgeJob = ({ task, requirements, priority, metadata }) => {
  validateLocalTask(task);
  const normalizedPriority = priority === 'high' ? 'high' : priority === 'low' ? 'low' : 'normal';
  const normalizedRequirements = normalizeEdgeTags(requirements);
  const job = {
    id: crypto.randomUUID(),
    task,
    requirements: normalizedRequirements,
    priority: normalizedPriority,
    status: 'queued',
    enqueuedAt: now(),
    startedAt: null,
    completedAt: null,
    leaseExpiresAt: null,
    workerId: null,
    attempts: 0,
    metadata: typeof metadata === 'object' ? metadata : null,
    result: null,
    detail: null
  };
  edgeJobStore.set(job.id, job);
  enqueueEdgeJob(job);
  return job;
};

const matchEdgeJobForTags = (tags) => {
  if (!Array.isArray(tags) || !tags.length) {
    return null;
  }
  const tagSet = new Set(tags);
  for (let i = 0; i < edgeJobQueue.length; i += 1) {
    const job = edgeJobQueue[i];
    if (!job || job.status !== 'queued') continue;
    const canRun = job.requirements.every((req) => tagSet.has(req));
    if (!canRun) continue;
    edgeJobQueue.splice(i, 1);
    return job;
  }
  return null;
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
  if (isGpuQueueFull()) {
    return res.status(429).json({ error: 'gpu_queue_full' });
  }
  const job = createGpuJob({ tool: tool.trim(), payload: payload ?? null, priority });
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

// ---------------------------------------------------------------------------
// Edge (local compute) job APIs
// ---------------------------------------------------------------------------

const requireEdgeJobsEnabled = (res) => {
  if (!ENABLE_EDGE_JOBS) {
    res.status(503).json({ error: 'edge_jobs_disabled' });
    return false;
  }
  return true;
};

app.post('/edge-workers/register', (req, res) => {
  if (!requireEdgeJobsEnabled(res)) return;
  const { workerId, tags, battery, capabilities } = req.body || {};
  if (typeof workerId !== 'string' || !workerId.trim()) {
    return res.status(400).json({ error: 'workerId_required' });
  }
  const normalizedTags = normalizeEdgeTags(Array.isArray(tags) ? tags : []);
  const worker = upsertEdgeWorker({
    workerId: workerId.trim(),
    tags: normalizedTags,
    battery: battery && typeof battery === 'object' ? battery : null,
    capabilities: capabilities && typeof capabilities === 'object' ? capabilities : null
  });
  return res.json({
    workerId: worker.workerId,
    leaseMs: EDGE_JOB_LEASE_SECONDS * 1000,
    heartbeatIntervalMs: EDGE_HEARTBEAT_SECONDS * 1000,
    tags: worker.tags
  });
});

app.post('/edge-workers/heartbeat', (req, res) => {
  if (!requireEdgeJobsEnabled(res)) return;
  const { workerId, tags, battery, capabilities, activeJobId } = req.body || {};
  if (typeof workerId !== 'string' || !workerId.trim()) {
    return res.status(400).json({ error: 'workerId_required' });
  }
  const existing = ensureEdgeWorker(workerId.trim());
  if (!existing) {
    return res.status(404).json({ error: 'worker_not_registered' });
  }
  const mergedTags = normalizeEdgeTags(Array.isArray(tags) ? tags : existing.tags);
  const worker = upsertEdgeWorker({
    workerId: workerId.trim(),
    tags: mergedTags,
    battery: battery && typeof battery === 'object' ? battery : existing.battery,
    capabilities: capabilities && typeof capabilities === 'object' ? capabilities : existing.capabilities
  });
  if (activeJobId && edgeJobStore.has(activeJobId)) {
    worker.activeJobId = activeJobId;
  } else {
    delete worker.activeJobId;
  }
  return res.json({ ok: true, tags: worker.tags });
});

app.post('/edge-jobs', (req, res) => {
  if (!requireEdgeJobsEnabled(res)) return;
  if (isEdgeQueueFull()) {
    return res.status(429).json({ error: 'edge_queue_full' });
  }
  try {
    const { task, requirements, priority, metadata } = req.body || {};
    const job = createEdgeJob({ task, requirements, priority, metadata });
    return res.json({ job });
  } catch (err) {
    return res.status(400).json({ error: err.message || 'edge_job_create_failed' });
  }
});

app.get('/edge-jobs/next', (req, res) => {
  if (!requireEdgeJobsEnabled(res)) return;
  cleanupExpiredEdgeJobs();
  const workerId = typeof req.query.workerId === 'string' ? req.query.workerId.trim() : '';
  if (!workerId) {
    return res.status(400).json({ error: 'workerId_required' });
  }
  const worker = ensureEdgeWorker(workerId);
  if (!worker) {
    return res.status(404).json({ error: 'worker_not_registered' });
  }
  const tagsParam = typeof req.query.tags === 'string' ? req.query.tags : '';
  const tagList = tagsParam
    ? tagsParam
        .split(',')
        .map((tag) => tag.trim().toLowerCase())
        .filter(Boolean)
    : worker.tags;
  const job = matchEdgeJobForTags(tagList);
  if (!job) {
    return res.status(204).end();
  }
  job.status = 'leased';
  job.workerId = workerId;
  job.startedAt = now();
  job.leaseExpiresAt = job.startedAt + EDGE_JOB_LEASE_SECONDS * 1000;
  job.attempts += 1;
  return res.json({
    job: {
      id: job.id,
      task: job.task,
      requirements: job.requirements,
      priority: job.priority,
      metadata: job.metadata
    }
  });
});

app.post('/edge-jobs/:jobId/complete', (req, res) => {
  if (!requireEdgeJobsEnabled(res)) return;
  const job = edgeJobStore.get(req.params.jobId);
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
  job.result = typeof result === 'undefined' ? null : result;
  job.detail = typeof detail === 'undefined' ? null : detail;
  job.leaseExpiresAt = null;
  return res.json({ job });
});

app.get('/edge-jobs/:jobId', (req, res) => {
  if (!requireEdgeJobsEnabled(res)) return;
  const job = edgeJobStore.get(req.params.jobId);
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
const CARWATCH_REDIS_CACHE_KEY = 'carwatch:snapshot';
const CARWATCH_CACHE_TTL_SECONDS = Math.max(1, Math.round(CARWATCH_SNAPSHOT_TTL_MS / 1000)) || DEFAULT_CACHE_TTL_SECONDS;

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

const storeCarwatchSnapshot = async (payload = {}) => {
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
  if (isRedisEnabled()) {
    const persisted = await setRedisJson(
      CARWATCH_REDIS_CACHE_KEY,
      snapshot,
      CARWATCH_CACHE_TTL_SECONDS || DEFAULT_CACHE_TTL_SECONDS
    );
    if (!persisted) {
      console.warn('[carwatch] failed to cache snapshot in redis');
    }
  }
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

const loadCarwatchSnapshot = async () => {
  const inMemory = getCarwatchSnapshot();
  if (inMemory) {
    return { snapshot: inMemory, source: 'memory' };
  }
  if (!isRedisEnabled()) {
    return { snapshot: null, source: 'memory' };
  }
  const cached = await getRedisJson(CARWATCH_REDIS_CACHE_KEY);
  if (cached) {
    carwatchStore.snapshot = cached;
    carwatchStore.receivedAt = Date.now();
    return { snapshot: cached, source: 'redis' };
  }
  return { snapshot: null, source: 'redis' };
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

  return { text, data, endpoint: resolvedEndpoint };
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

const githubModelHealthHandler = async (_req, res) => {
  try {
    const status = await checkGithubModelHealth();
    return res.json(status);
  } catch (err) {
    console.error('GitHub model health check failed:', err);
    return res.status(500).json({ name: 'githubModel', status: 'error', detail: err?.message || 'unknown_error' });
  }
};

const githubModelChatHandler = async (req, res) => {
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
};

const githubModelCompareHandler = async (req, res) => {
  if (!GITHUB_MODEL_TOKEN) {
    return res.status(503).json({ error: 'github_model_token_missing' });
  }

  const body = req.body || {};
  const rawMessages = Array.isArray(body.messages) && body.messages.length
    ? body.messages
    : typeof body.prompt === 'string' && body.prompt.trim()
      ? [{ role: 'user', content: body.prompt.trim() }]
      : null;

  if (!rawMessages) {
    return res.status(400).json({ error: 'messages_required' });
  }

  const sanitizedMessages = rawMessages
    .map((msg) => {
      const role = typeof msg?.role === 'string' ? msg.role : 'user';
      const content = typeof msg?.content === 'string'
        ? msg.content
        : typeof msg?.content === 'object'
          ? JSON.stringify(msg.content)
          : String(msg?.content ?? '');
      if (!content.trim()) {
        return null;
      }
      return { role, content };
    })
    .filter(Boolean);

  if (!sanitizedMessages.length) {
    return res.status(400).json({ error: 'messages_required' });
  }

  const normalizeSection = (section, fallbackLabel) => {
    const normalizeString = (value) => (typeof value === 'string' && value.trim() ? value.trim() : undefined);
    const normalizeNumber = (value) => {
      if (typeof value === 'number' && Number.isFinite(value)) return value;
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : undefined;
    };
    return {
      label: normalizeString(section?.label) || fallbackLabel,
      model: normalizeString(section?.model),
      deployment: normalizeString(section?.deployment),
      temperature: normalizeNumber(section?.temperature),
      maxTokens: normalizeNumber(section?.maxTokens ?? section?.max_tokens),
    };
  };

  const baselineConfig = normalizeSection(body.baseline, 'Baseline');
  const candidateConfig = normalizeSection(body.candidate, 'Candidate');

  const runComparison = async (config) => {
    const startedAt = Date.now();
    const result = await callGithubModelMessages({
      messages: sanitizedMessages,
      model: config.model,
      maxTokens: config.maxTokens,
      temperature: config.temperature,
      deployment: config.deployment,
    });
    return {
      label: config.label,
      model: result?.data?.model || config.model || GITHUB_MODEL,
      deployment: config.deployment || GITHUB_MODEL_DEPLOYMENT,
      text: result.text,
      endpoint: result.endpoint,
      durationMs: Date.now() - startedAt,
      raw: result.data,
    };
  };

  try {
    const [baselineResult, candidateResult] = await Promise.all([
      runComparison(baselineConfig),
      runComparison(candidateConfig),
    ]);

    return res.json({
      status: 'ok',
      comparison: {
        baseline: baselineResult,
        candidate: candidateResult,
      },
    });
  } catch (err) {
    console.error('GitHub compare failed:', err);
    return res.status(502).json({ error: 'github_compare_failed', detail: err?.message || 'compare_error' });
  }
};

registerDynamicEndpointGroup('github-model', {
  basePath: '/github-model',
  routes: [
    { method: 'get', path: '/health', handler: githubModelHealthHandler, description: 'health' },
    { method: 'post', path: '/chat', handler: githubModelChatHandler, description: 'chat proxy' },
    { method: 'post', path: '/compare', handler: githubModelCompareHandler, description: 'model compare' },
    { method: 'get', path: '/catalog', handler: githubModelCatalogHandler, description: 'public catalog snapshot' },
    {
      method: 'post',
      path: '/catalog/refresh',
      handler: githubModelCatalogRefreshHandler,
      description: 'force catalog refresh'
    }
  ]
});

const pickSttBase = (accelerator) => {
  if (shouldUseGpu(accelerator) && STT_GPU_URL) {
    return STT_GPU_URL;
  }
  return STT_URL;
};

const pickVajaBase = () => (VAJA_ENABLED ? VAJA_MCP_URL : '');

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

const invokeVaja = async ({ text, speaker = 'noina', download = false }) => {
  if (!VAJA_ENABLED) {
    throw new Error('vaja_unconfigured');
  }
  const response = await fetch(`${normalizeBaseUrl(VAJA_MCP_URL)}/invoke`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tool: 'synthesize_speech', arguments: { text, speaker, download } })
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(detail || 'vaja_failed');
  }
  return response.json();
};

const synthesizeSpeech = async (text, voice) => {
  if (!text || !text.trim() || !VAJA_ENABLED) {
    return null;
  }
  const selectedVoice = typeof voice === 'string' && voice.trim() ? voice.trim() : 'noina';
  try {
    const data = await invokeVaja({ text: text.slice(0, 800), speaker: selectedVoice, download: false });
    return data?.audio_url || null;
  } catch (err) {
    console.error('VAJA synthesis failed:', err.message);
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

    const snapshot = await storeCarwatchSnapshot(payload);
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

app.get('/carwatch/snapshot', async (_req, res) => {
  try {
    const { snapshot, source } = await loadCarwatchSnapshot();
    const ageMs = carwatchStore.receivedAt ? Date.now() - carwatchStore.receivedAt : null;

    if (!snapshot) {
      return res.json({ snapshot: null, ageMs: null, error: 'no_snapshot', source });
    }

    return res.json({ snapshot, ageMs, source });
  } catch (err) {
    console.error('Failed to load CarWatch snapshot:', err);
    return res.status(500).json({ error: 'server_error', detail: err?.message || 'carwatch_snapshot_load_failed' });
  }
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

  const serviceChecks = await Promise.all([
    ...coreServiceChecks,
    checkRedisHealth(),
    Promise.resolve(checkCarwatchHealth()),
    Promise.resolve(checkGithubProviderConfigured()),
    checkGithubModelHealth()
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
    redisEnabled: isRedisEnabled(),
    githubProvider: isGithubProvider() ? 'github' : NORMALIZED_BASE_PROVIDER,
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

    const pushVoices = (voices = []) => {
      voices.forEach((voice) => {
        if (!voice?.id) return;
        aggregated.push(voice);
      });
    };

    if (VAJA_ENABLED) {
      const vajaVoices = VAJA_VOICES.map((voice) => ({
        id: voice.id,
        name: voice.name,
        provider: 'vaja',
        accelerator: 'external',
        tier: 'standard',
        language: 'th',
        metadata: { style: voice.name.split('•')[2]?.trim() || null }
      }));
      pushVoices(vajaVoices);
      const firstVajaVoice = vajaVoices.find((voice) => Boolean(voice?.id));
      if (firstVajaVoice?.id) {
        defaultCandidates.push(firstVajaVoice.id);
      }
    }

    const tryOpenvoiceSource = async (baseUrl, label, accelerator) => {
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
        const shaped = voices.map((voice) => ({
          ...voice,
          provider: 'openvoice',
          accelerator,
          tier: voice.tier || 'standard'
        }));
        pushVoices(shaped);
        if (defaultVoice) {
          defaultCandidates.push(defaultVoice);
        }
      } catch (err) {
        console.warn(`Failed to fetch OpenVoice voices (${label}):`, err.message);
      }
    };

    await tryOpenvoiceSource(OPENVOICE_URL, 'cpu', 'cpu');

    if (!aggregated.some((voice) => voice.provider === 'openvoice')) {
      await tryOpenvoiceSource(OPENVOICE_GPU_URL, 'gpu', 'gpu');
    }

    if (!aggregated.length) {
      return res.status(503).json({ error: 'voices_unavailable', detail: 'no voices available' });
    }

    const combinedDefault =
      defaultCandidates.find((candidate) => aggregated.some((voice) => voice.id === candidate)) || aggregated[0]?.id || null;

    return res.json({ voices: aggregated, defaultVoice: combinedDefault });
  } catch (err) {
    console.error('Failed to aggregate voices:', err);
    return res.status(502).json({ error: 'voices_unavailable' });
  }
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Server listening on http://0.0.0.0:${PORT}`);
    if (isRedisEnabled()) {
      console.log(`[redis] cache enabled (ttl=${DEFAULT_CACHE_TTL_SECONDS}s)`);
    } else {
      console.warn('[redis] cache disabled — set ENABLE_REDIS_CACHE=true to enable snapshot persistence');
    }
    const githubStatus = checkGithubProviderConfigured();
    console.log(`[githubModel] status: ${githubStatus.status}`);
    console.log(`Using Ollama at ${OLLAMA_URL} with model ${MODEL}`);
    if (OLLAMA_GPU_URL) {
      console.log(`GPU Ollama available at ${OLLAMA_GPU_URL}`);
    }
    console.log(`Using STT at ${STT_URL}`);
    if (STT_GPU_URL) {
      console.log(`GPU STT available at ${STT_GPU_URL}`);
    }
  });
}

module.exports = app;
