#!/usr/bin/env node
const fs = require('fs/promises');
const path = require('path');

async function main() {
  const root = path.resolve(__dirname, '..');
  const distDir = path.join(root, 'instrans', 'client', 'dist');
  const targetDir = resolveTarget();

  await ensureDir(distDir);
  await fs.rm(targetDir, { recursive: true, force: true });
  await fs.mkdir(targetDir, { recursive: true });
  await fs.cp(distDir, targetDir, { recursive: true });

  console.log(`[instrans] synced ${distDir} -> ${targetDir}`);
}

function resolveTarget() {
  const override = process.env.INSTRANS_STATIC_TARGET;
  if (override) {
    return path.resolve(override);
  }
  return path.resolve('C:/_dev/_models/a_chaba/sites/instrans');
}

async function ensureDir(dirPath) {
  try {
    const stats = await fs.stat(dirPath);
    if (!stats.isDirectory()) {
      throw new Error(`${dirPath} is not a directory`);
    }
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new Error(`instrans build output missing at ${dirPath}. Run the client build first.`);
    }
    throw error;
  }
}

main().catch((error) => {
  console.error('[instrans] sync failed:', error.message);
  process.exit(1);
});
