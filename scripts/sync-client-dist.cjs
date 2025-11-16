#!/usr/bin/env node
const fs = require('fs/promises');
const path = require('path');

async function main() {
  const root = path.resolve(__dirname, '..');
  const distDir = path.join(root, 'client', 'dist');
  const publicDir = path.join(root, 'server', 'public');

  try {
    const stat = await fs.stat(distDir);
    if (!stat.isDirectory()) {
      throw new Error('client/dist is not a directory');
    }
  } catch (err) {
    throw new Error('client/dist does not exist. Run "npm run build" first.');
  }

  await fs.rm(publicDir, { recursive: true, force: true });
  await fs.mkdir(publicDir, { recursive: true });
  await fs.cp(distDir, publicDir, { recursive: true });

  console.log(`Synced ${distDir} -> ${publicDir}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
