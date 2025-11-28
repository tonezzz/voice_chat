#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const readline = require('readline');

const REPO_ROOT = path.resolve(__dirname, '..');
const ENV_PATH = path.join(REPO_ROOT, '.env');
const DEFAULT_OUTPUT_DIR = path.resolve('C:/_chaba/chaba-1/shares/credentials');

const credentialSpecs = [
  {
    name: 'ftp-deployment',
    description: 'FTP deployment credentials',
    required: ['FTP_HOST', 'FTP_USERNAME', 'FTP_PASSWORD', 'FTP_REMOTE_PATH'],
    build: env => ({
      service: 'FTP Deployment',
      host: env.FTP_HOST,
      username: env.FTP_USERNAME,
      password: env.FTP_PASSWORD,
      remote_path: env.FTP_REMOTE_PATH,
      note: 'Used for uploading stack-root artifacts',
      source: '.env'
    })
  },
  {
    name: 'github-model-token',
    description: 'GitHub model API token',
    required: ['GITHUB_MODEL_TOKEN'],
    build: env => ({
      service: 'GitHub Models',
      token: env.GITHUB_MODEL_TOKEN,
      note: 'Used for GitHub model inference endpoints',
      source: '.env'
    })
  },
  {
    name: 'github-mcp-token',
    description: 'GitHub MCP token',
    required: ['GITHUB_MCP_TOKEN'],
    build: env => ({
      service: 'GitHub MCP',
      token: env.GITHUB_MCP_TOKEN,
      source: '.env'
    })
  },
  {
    name: 'github-personal-token',
    description: 'GitHub personal token',
    required: ['GITHUB_PERSONAL_TOKEN'],
    build: env => ({
      service: 'GitHub Personal Access',
      token: env.GITHUB_PERSONAL_TOKEN,
      source: '.env'
    })
  },
  {
    name: 'anthropic-api-key',
    description: 'Anthropic API key',
    required: ['ANTHROPIC_API_KEY', 'ANTHROPIC_MODEL'],
    build: env => ({
      service: 'Anthropic',
      api_key: env.ANTHROPIC_API_KEY,
      model: env.ANTHROPIC_MODEL,
      source: '.env'
    })
  },
  {
    name: 'claude-api-key',
    description: 'Claude API key',
    required: ['CLAUDE_API_KEY'],
    build: env => ({
      service: 'Claude API',
      api_key: env.CLAUDE_API_KEY,
      source: '.env'
    })
  },
  {
    name: 'openai-api-key',
    description: 'OpenAI API key',
    required: ['OPENAI_API_KEY'],
    build: env => ({
      service: 'OpenAI',
      api_key: env.OPENAI_API_KEY,
      source: '.env'
    })
  },
  {
    name: 'ai4thai-api-key',
    description: 'AI4Thai API key',
    required: ['AI4THAI_API_KEY'],
    build: env => ({
      service: 'AI4Thai',
      api_key: env.AI4THAI_API_KEY,
      source: '.env'
    })
  },
  {
    name: 'huggingface-api-key',
    description: 'HuggingFace API key',
    required: ['HUGGINGFACE_API_KEY'],
    build: env => ({
      service: 'HuggingFace',
      api_key: env.HUGGINGFACE_API_KEY,
      source: '.env'
    })
  },
  {
    name: 'service-auth-token',
    description: 'Service auth token',
    required: ['SERVICE_AUTH_TOKEN'],
    build: env => ({
      token_name: 'SERVICE_AUTH_TOKEN',
      token: env.SERVICE_AUTH_TOKEN,
      source: '.env'
    })
  },
  {
    name: 'gpu-worker-token',
    description: 'GPU worker token',
    required: ['GPU_WORKER_TOKEN'],
    build: env => ({
      token_name: 'GPU_WORKER_TOKEN',
      token: env.GPU_WORKER_TOKEN,
      source: '.env'
    })
  },
  {
    name: 'mcp0-admin-token',
    description: 'MCP0 admin token',
    required: ['MCP0_ADMIN_TOKEN'],
    build: env => ({
      token_name: 'MCP0_ADMIN_TOKEN',
      token: env.MCP0_ADMIN_TOKEN,
      source: '.env'
    })
  }
];

function parseEnv(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`.env file not found at ${filePath}`);
  }
  const content = fs.readFileSync(filePath, 'utf8');
  const env = {};
  content.split(/\r?\n/).forEach(line => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      return;
    }
    const idx = trimmed.indexOf('=');
    if (idx === -1) {
      return;
    }
    const key = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + 1).trim();
    env[key] = value;
  });
  return env;
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function deriveKey(passphrase, salt) {
  return crypto.pbkdf2Sync(passphrase, salt, 150000, 32, 'sha256');
}

function encryptPayload(data, passphrase) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = deriveKey(passphrase, salt);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(data, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  const magic = Buffer.from('VCEX01');
  return Buffer.concat([magic, salt, iv, authTag, ciphertext]);
}

function parseArgs(argv) {
  const args = { outputDir: DEFAULT_OUTPUT_DIR };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--passphrase' && i + 1 < argv.length) {
      args.passphrase = argv[i + 1];
      i += 1;
    } else if (arg === '--output-dir' && i + 1 < argv.length) {
      args.outputDir = path.resolve(argv[i + 1]);
      i += 1;
    } else if (arg === '--help') {
      args.help = true;
    } else {
      console.warn(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

function showHelp() {
  console.log(`Usage: node scripts/export-credentials.js [--passphrase ****] [--output-dir <path>]

This script reads .env and writes encrypted JSON credential bundles to the output directory.
If --passphrase is omitted, you will be prompted to enter one.`);
}

async function promptPassphrase() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const question = prompt => new Promise(resolve => rl.question(prompt, resolve));
  const pass = await question('Enter encryption passphrase: ');
  rl.close();
  if (!pass || !pass.trim()) {
    throw new Error('Passphrase is required');
  }
  return pass.trim();
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    showHelp();
    process.exit(0);
  }

  const env = parseEnv(ENV_PATH);
  const passphrase = args.passphrase || await promptPassphrase();

  ensureDir(args.outputDir);

  let exportedCount = 0;
  credentialSpecs.forEach(spec => {
    const missing = spec.required.filter(key => !env[key]);
    if (missing.length) {
      console.warn(`Skipping ${spec.name}: missing ${missing.join(', ')}`);
      return;
    }
    const payload = spec.build(env);
    const json = JSON.stringify(payload, null, 2);
    const encrypted = encryptPayload(json, passphrase);
    const filePath = path.join(args.outputDir, `${spec.name}.json.enc`);
    fs.writeFileSync(filePath, encrypted);
    exportedCount += 1;
    console.log(`Encrypted ${spec.name} -> ${filePath}`);
  });

  if (!exportedCount) {
    console.warn('No credentials were exported.');
  } else {
    console.log(`Finished. ${exportedCount} credential files written to ${args.outputDir}`);
  }
}

main().catch(err => {
  console.error(err.message || err);
  process.exit(1);
});
