#!/usr/bin/env node
const { spawn } = require('node:child_process');

const HEALTH_URL = process.env.MAIN_STACK_HEALTH_URL || 'http://voice-chat-server:3000/health';
const PUBLISH_INTERVAL_SECONDS = Number.parseInt(process.env.HOST1_PUBLISH_INTERVAL_SECONDS || '300', 10);
const HEALTH_CHECK_INTERVAL_SECONDS = Number.parseInt(process.env.HOST1_HEALTH_CHECK_INTERVAL_SECONDS || '60', 10);
const HOST_ID = process.env.HOST1_ID || 'host01';
const LOG_ENDPOINT = process.env.HOST1_LOG_ENDPOINT || '';

const fetchFn = globalThis.fetch
  ? globalThis.fetch.bind(globalThis)
  : (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function sendLog(event, extra = {}) {
  if (!LOG_ENDPOINT) {
    return;
  }
  try {
    const payload = {
      event,
      hostId: HOST_ID,
      timestamp: new Date().toISOString(),
      ...extra,
    };
    await fetchFn(LOG_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch (error) {
    console.warn(`[mcp-host01] failed to send log: ${error.message}`);
  }
}

async function isMainStackHealthy() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number(process.env.HOST1_HEALTH_TIMEOUT_MS || 5000));
  try {
    const response = await fetch(HEALTH_URL, { signal: controller.signal });
    return response.ok;
  } catch (error) {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

function runPublish() {
  return new Promise((resolve) => {
    const child = spawn('npm', ['run', 'host1:publish'], {
      stdio: 'inherit',
      shell: process.platform === 'win32'
    });
    child.on('exit', (code) => {
      if (code !== 0) {
        console.error(`[mcp-host01] host1:publish exited with code ${code}`);
      }
      resolve(code ?? 0);
    });
  });
}

async function main() {
  console.log(`[mcp-host01] Watching ${HEALTH_URL}. Publish interval: ${PUBLISH_INTERVAL_SECONDS}s`);
  await sendLog('watcher_started', {
    healthUrl: HEALTH_URL,
    publishIntervalSeconds: PUBLISH_INTERVAL_SECONDS,
  });
  while (true) {
    const healthy = await isMainStackHealthy();
    if (healthy) {
      const timestamp = new Date().toISOString();
      console.log(`[mcp-host01] ${timestamp} main stack healthy → running host1:publish`);
      await sendLog('stack_healthy');
      const exitCode = await runPublish();
      await sendLog('publish_complete', { exitCode });
      console.log(`[mcp-host01] Sleeping for ${PUBLISH_INTERVAL_SECONDS}s`);
      await sleep(PUBLISH_INTERVAL_SECONDS * 1000);
    } else {
      console.log(`[mcp-host01] Main stack unhealthy. Retrying health check in ${HEALTH_CHECK_INTERVAL_SECONDS}s`);
      await sendLog('stack_unhealthy', { healthUrl: HEALTH_URL });
      await sleep(HEALTH_CHECK_INTERVAL_SECONDS * 1000);
    }
  }
}

main().catch((error) => {
  console.error('[mcp-host01] Watcher crashed:', error);
  process.exit(1);
});
