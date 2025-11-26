const Redis = require('ioredis');

const REDIS_URL = process.env.REDIS_URL || '';
const ENABLE_REDIS_CACHE = String(process.env.ENABLE_REDIS_CACHE || 'false').toLowerCase() === 'true';
const DEFAULT_CACHE_TTL_SECONDS = Math.max(1, Number(process.env.REDIS_CACHE_TTL_SECONDS) || 300);

let client = null;

const isRedisEnabled = () => Boolean(ENABLE_REDIS_CACHE && REDIS_URL);

const connectRedisClient = () => {
  if (!isRedisEnabled()) {
    return null;
  }

  if (client) {
    return client;
  }

  client = new Redis(REDIS_URL, {
    maxRetriesPerRequest: 2,
    enableAutoPipelining: true,
    retryStrategy: (times) => Math.min(times * 100, 2000)
  });

  client.on('connect', () => {
    console.log('[redis] connected');
  });

  client.on('error', (err) => {
    console.error('[redis] connection error:', err?.message || err);
  });

  return client;
};

const getRedisClient = () => client || connectRedisClient();

const serializePayload = (value) => {
  try {
    return JSON.stringify(value);
  } catch (err) {
    console.error('[redis] failed to serialize payload:', err?.message || err);
    return null;
  }
};

const deserializePayload = (raw) => {
  if (typeof raw !== 'string') {
    return null;
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    console.error('[redis] failed to parse payload:', err?.message || err);
    return null;
  }
};

const setJson = async (key, value, ttlSeconds = DEFAULT_CACHE_TTL_SECONDS) => {
  const redis = getRedisClient();
  if (!redis) {
    return false;
  }

  const payload = serializePayload(value);
  if (!payload) {
    return false;
  }

  try {
    if (ttlSeconds > 0) {
      await redis.set(key, payload, 'EX', ttlSeconds);
    } else {
      await redis.set(key, payload);
    }
    return true;
  } catch (err) {
    console.error('[redis] failed to write key', key, err?.message || err);
    return false;
  }
};

const getJson = async (key) => {
  const redis = getRedisClient();
  if (!redis) {
    return null;
  }

  try {
    const raw = await redis.get(key);
    return deserializePayload(raw);
  } catch (err) {
    console.error('[redis] failed to read key', key, err?.message || err);
    return null;
  }
};

module.exports = {
  isRedisEnabled,
  getRedisClient,
  getJson,
  setJson,
  DEFAULT_CACHE_TTL_SECONDS
};
