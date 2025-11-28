#!/usr/bin/env node
import { spawnSync } from 'node:child_process';

const run = (cmd, args) => {
  const result = spawnSync(cmd, args, { stdio: 'inherit', shell: process.platform === 'win32' });
  if (result.status !== 0) {
    console.error(`[host1:auto] Command failed: ${cmd} ${args.join(' ')}`);
  }
};

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const loop = async () => {
  console.log('[host1:auto] Starting 5-minute publish loop (Ctrl+C to stop)');
  while (true) {
    const started = new Date().toLocaleString();
    console.log(`[host1:auto] Run started at ${started}`);
    run('npm', ['run', 'host1:metrics']);
    run('npm', ['run', 'host1:sync']);
    console.log('[host1:auto] Sleeping for 5 minutes...');
    await delay(5 * 60 * 1000);
  }
};

loop().catch((err) => {
  console.error('[host1:auto] Loop crashed:', err);
  process.exit(1);
});
