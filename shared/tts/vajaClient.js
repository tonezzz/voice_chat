const fs = require('fs');
const path = require('path');
const { once } = require('events');

const resolveFetch = () => {
  if (typeof globalThis.fetch === 'function') {
    return globalThis.fetch.bind(globalThis);
  }
  try {
    // eslint-disable-next-line global-require
    return require('node-fetch');
  } catch (err) {
    throw new Error('Fetch API is unavailable. Please use Node 18+ or install node-fetch.');
  }
};

const fetch = resolveFetch();

const DEFAULT_VAJA_ENDPOINT = 'https://api.aiforthai.in.th/vaja';

const VAJA_SPEAKERS = [
  { id: 'nana', description: 'Female | Animation' },
  { id: 'noina', description: 'Female | Commercial / IVR' },
  { id: 'farah', description: 'Female | Documentary / Presentation' },
  { id: 'mewzy', description: 'Female | Commercial' },
  { id: 'farsai', description: 'Female | Animation' },
  { id: 'prim', description: 'Female | Announcer' },
  { id: 'ped', description: 'Female | Announcer' },
  { id: 'poom', description: 'Male | Commercial / IVR' },
  { id: 'doikham', description: 'Male | Northern dialect' },
  { id: 'praw', description: 'Girl | Youth' },
  { id: 'wayu', description: 'Boy | Youth' },
  { id: 'namphueng', description: 'Female | Anchor style' },
  { id: 'toon', description: 'Female | Broadcast style' },
  { id: 'sanooch', description: 'Female | Teacher style' },
  { id: 'thanwa', description: 'Male | Broadcast style' }
];

const assertString = (value, label) => {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${label} is required`);
  }
  return value.trim();
};

const resolveApiKey = (apiKeyFromOptions) => {
  const key = apiKeyFromOptions || process.env.AI4THAI_API_KEY;
  if (!key || !key.trim()) {
    throw new Error('AI4THAI_API_KEY is not configured');
  }
  return key.trim();
};

async function requestVajaSpeech({
  text,
  speaker = 'noina',
  style,
  apiKey,
  endpoint = DEFAULT_VAJA_ENDPOINT,
  fetchImpl = fetch
} = {}) {
  const payload = {
    text: assertString(text, 'text'),
    speaker: assertString(speaker, 'speaker')
  };
  if (style && typeof style === 'string' && style.trim()) {
    payload.style = style.trim();
  }

  const resolvedEndpoint = assertString(endpoint, 'endpoint');
  const key = resolveApiKey(apiKey);

  const response = await fetchImpl(resolvedEndpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Apikey: key
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`VAJA request failed (${response.status}): ${detail}`);
  }

  const data = await response.json();
  if (!data?.audio_url) {
    throw new Error('VAJA response missing audio_url');
  }

  return data;
}

async function downloadVajaAudio({
  audioUrl,
  apiKey,
  destinationPath,
  onProgress,
  fetchImpl = fetch
} = {}) {
  const resolvedUrl = assertString(audioUrl, 'audioUrl');
  const headers = {};
  const key = apiKey || process.env.AI4THAI_API_KEY;
  if (key && key.trim()) {
    headers.Apikey = key.trim();
  }

  const response = await fetchImpl(resolvedUrl, { headers });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Audio download failed (${response.status}): ${detail}`);
  }

  const reader = response.body;
  if (!reader || typeof reader[Symbol.asyncIterator] !== 'function') {
    throw new Error('Audio response stream is not readable');
  }

  let totalBytes = 0;
  let buffers;
  let fileStream;
  let resolvedPath;

  if (destinationPath) {
    resolvedPath = path.resolve(destinationPath);
    fileStream = fs.createWriteStream(resolvedPath);
  } else {
    buffers = [];
  }

  try {
    for await (const chunk of reader) {
      if (!chunk) continue;
      const bufferChunk = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes += bufferChunk.length;
      if (fileStream) {
        fileStream.write(bufferChunk);
      } else {
        buffers.push(bufferChunk);
      }
      if (typeof onProgress === 'function') {
        onProgress({ totalBytes, chunkBytes: bufferChunk.length });
      }
    }
  } finally {
    if (fileStream) {
      fileStream.end();
      await once(fileStream, 'finish');
    }
  }

  if (fileStream) {
    return { bytesWritten: totalBytes, path: resolvedPath };
  }

  return { bytesWritten: totalBytes, buffer: Buffer.concat(buffers) };
}

module.exports = {
  DEFAULT_VAJA_ENDPOINT,
  VAJA_SPEAKERS,
  requestVajaSpeech,
  downloadVajaAudio
};
