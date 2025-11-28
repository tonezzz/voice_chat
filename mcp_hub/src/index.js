import express from 'express';
import fs from 'node:fs';
import path from 'node:path';

const app = express();
const PORT = Number(process.env.MCP_HUB_PORT || 8031);
const STORAGE_ROOT = process.env.MCP_HUB_STORAGE_ROOT || '/workspace/hub-storage';
const MAX_FILE_AGE_MS = Number(process.env.MCP_HUB_RETENTION_MS || 24 * 60 * 60 * 1000);

app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true }));

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function writeLog(hostId, payload) {
  const date = new Date();
  const datePrefix = date.toISOString().slice(0, 10);
  const dir = path.join(STORAGE_ROOT, hostId, datePrefix);
  ensureDir(dir);
  const filePath = path.join(dir, `${Date.now()}.jsonl`);
  fs.appendFileSync(filePath, JSON.stringify(payload) + '\n', 'utf-8');
  return filePath;
}

function pruneOldFiles() {
  const cutoff = Date.now() - MAX_FILE_AGE_MS;
  if (!fs.existsSync(STORAGE_ROOT)) return;
  for (const host of fs.readdirSync(STORAGE_ROOT)) {
    const hostDir = path.join(STORAGE_ROOT, host);
    for (const dateFolder of fs.readdirSync(hostDir)) {
      const dateDir = path.join(hostDir, dateFolder);
      for (const file of fs.readdirSync(dateDir)) {
        const filePath = path.join(dateDir, file);
        const stat = fs.statSync(filePath);
        if (stat.mtimeMs < cutoff) {
          fs.rmSync(filePath, { force: true });
        }
      }
      if (fs.readdirSync(dateDir).length === 0) {
        fs.rmdirSync(dateDir);
      }
    }
    if (fs.readdirSync(hostDir).length === 0) {
      fs.rmdirSync(hostDir);
    }
  }
}

app.post('/logs/:hostId', (req, res) => {
  const hostId = req.params.hostId || 'unknown';
  const entry = {
    hostId,
    receivedAt: new Date().toISOString(),
    ...req.body
  };
  const filePath = writeLog(hostId, entry);
  pruneOldFiles();
  res.json({ status: 'ok', file: filePath });
});

app.get('/logs/:hostId', (req, res) => {
  const hostId = req.params.hostId || 'unknown';
  const hostDir = path.join(STORAGE_ROOT, hostId);
  if (!fs.existsSync(hostDir)) {
    return res.status(404).json({ error: 'No logs for host' });
  }
  const files = [];
  for (const dateFolder of fs.readdirSync(hostDir)) {
    const dateDir = path.join(hostDir, dateFolder);
    for (const file of fs.readdirSync(dateDir)) {
      files.push({
        path: path.relative(STORAGE_ROOT, path.join(dateDir, file)),
        modified: fs.statSync(path.join(dateDir, file)).mtime
      });
    }
  }
  files.sort((a, b) => b.modified - a.modified);
  res.json({ files });
});

app.listen(PORT, () => {
  ensureDir(STORAGE_ROOT);
  console.log(`[mcp-hub] Listening on ${PORT}, storage root ${STORAGE_ROOT}`);
});
