const path = require('path');
const fs = require('fs');
const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');

dotenv.config({ path: path.join(__dirname, '..', '.env') });

const {
  VAJA_SPEAKERS,
  requestVajaSpeech,
  downloadVajaAudio,
  DEFAULT_VAJA_ENDPOINT
} = require('../shared/tts/vajaClient');

const APP_NAME = 'mcp-vaja';
const APP_VERSION = '0.1.0';
const PORT = Number(process.env.PORT || 8017);
const OUTPUT_ROOT = process.env.VAJA_OUTPUT_DIR || path.join('/tmp', 'vaja-audio');

const ensureOutputDir = () => {
  if (!fs.existsSync(OUTPUT_ROOT)) {
    fs.mkdirSync(OUTPUT_ROOT, { recursive: true });
  }
};

const app = express();
app.use(cors());
app.use(express.json({ limit: process.env.JSON_BODY_LIMIT || '2mb' }));

const TOOL_SCHEMAS = {
  synthesize_speech: {
    name: 'synthesize_speech',
    description: 'Generate Thai speech audio via VAJA (AI4Thai).',
    input_schema: {
      type: 'object',
      required: ['text'],
      properties: {
        text: { type: 'string', minLength: 1, maxLength: 400 },
        speaker: { type: 'string', enum: VAJA_SPEAKERS.map((s) => s.id) },
        style: { type: 'string' },
        download: {
          type: 'boolean',
          description: 'If true, download audio locally and return file metadata.'
        }
      }
    }
  }
};

const validatePayload = (schemaName, payload) => {
  if (schemaName !== 'synthesize_speech') {
    return payload;
  }
  const errors = [];
  if (typeof payload.text !== 'string' || !payload.text.trim()) {
    errors.push('text is required');
  }
  if (payload.text && payload.text.length > 400) {
    errors.push('text must be <= 400 characters');
  }
  if (payload.speaker && !VAJA_SPEAKERS.some((s) => s.id === payload.speaker)) {
    errors.push(`unknown speaker '${payload.speaker}'`);
  }
  if (errors.length) {
    const error = new Error(errors.join(', '));
    error.status = 400;
    throw error;
  }
  return payload;
};

const synthesizeHandler = async (args = {}) => {
  const { text, speaker = 'noina', style, download = false } = args;
  validatePayload('synthesize_speech', args);

  const response = await requestVajaSpeech({
    text: text.trim(),
    speaker,
    style,
    endpoint: process.env.VAJA_ENDPOINT || DEFAULT_VAJA_ENDPOINT
  });

  const result = {
    msg: response.msg,
    audio_url: response.audio_url,
    speaker,
    style: style || null
  };

  if (download) {
    ensureOutputDir();
    const timestamp = Date.now();
    const filename = `${timestamp}-${speaker}.wav`;
    const destinationPath = path.join(OUTPUT_ROOT, filename);
    const downloadResult = await downloadVajaAudio({
      audioUrl: response.audio_url,
      destinationPath,
      onProgress: (progress) => {
        if (progress.totalBytes % 16384 === 0) {
          console.log(`[vaja] downloaded ${progress.totalBytes} bytes`);
        }
      }
    });
    result.download = {
      path: downloadResult.path,
      bytes: downloadResult.bytesWritten
    };
  }

  return result;
};

const TOOL_REGISTRY = {
  synthesize_speech: synthesizeHandler
};

app.get('/health', (_req, res) => {
  try {
    if (!process.env.AI4THAI_API_KEY) {
      return res.status(500).json({ status: 'error', detail: 'AI4THAI_API_KEY missing' });
    }
    return res.json({ status: 'ok', endpoint: process.env.VAJA_ENDPOINT || DEFAULT_VAJA_ENDPOINT });
  } catch (err) {
    return res.status(500).json({ status: 'error', detail: err.message });
  }
});

app.post('/invoke', async (req, res) => {
  const { tool, arguments: args = {} } = req.body || {};
  if (!tool || typeof tool !== 'string') {
    return res.status(400).json({ error: 'tool is required' });
  }
  const handler = TOOL_REGISTRY[tool];
  if (!handler) {
    return res.status(404).json({ error: `Unknown tool '${tool}'` });
  }

  try {
    const result = await handler(args);
    return res.json(result);
  } catch (err) {
    console.error('[mcp-vaja] invoke error', err);
    const status = err.status || 502;
    return res.status(status).json({ error: err.message || 'vaja_error' });
  }
});

app.get('/.well-known/mcp.json', (_req, res) => {
  res.json({
    name: APP_NAME,
    version: APP_VERSION,
    description: 'VAJA (AI4Thai) Text-to-Speech MCP provider',
    capabilities: {
      tools: Object.values(TOOL_SCHEMAS)
    }
  });
});

app.listen(PORT, () => {
  console.log(`[mcp-vaja] listening on port ${PORT}`);
});
