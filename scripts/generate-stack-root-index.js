const fs = require('fs');
const path = require('path');

const envPath = path.join(__dirname, '..', '.env');
const outputPath = path.join(__dirname, '..', 'stack-root-index.html');

const rawEnv = fs.readFileSync(envPath, 'utf8');

const shouldMask = key => /(PASSWORD|TOKEN|SECRET|KEY|ACCESS_PW|ACCESS_ID|AUTHTOKEN|API_KEY|PRIVATE)/i.test(key);

const maskValue = value => {
  if (!value) return '(empty)';
  if (value.length <= 6) {
    return '*'.repeat(Math.max(4, value.length));
  }
  return `${value.slice(0, 4)}…${value.slice(-2)}`;
};

const entries = [];

rawEnv.split(/\r?\n/).forEach(line => {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) {
    return;
  }
  const equalsIndex = trimmed.indexOf('=');
  if (equalsIndex === -1) {
    return;
  }
  const key = trimmed.slice(0, equalsIndex).trim();
  const value = trimmed.slice(equalsIndex + 1).trim();
  const sensitive = shouldMask(key);
  entries.push({
    key,
    value,
    displayValue: sensitive ? maskValue(value) : value || '(empty)',
    sensitive
  });
});

const byPredicate = predicate => entries.filter(predicate);

const ftpHost = entries.find(entry => entry.key === 'FTP_HOST');
const ftpUser = entries.find(entry => entry.key === 'FTP_USERNAME');
const ftpPath = entries.find(entry => entry.key === 'FTP_REMOTE_PATH');

const pathEntries = byPredicate(entry => /PATH|DIR|ROOT/i.test(entry.key));
const serviceEntries = byPredicate(entry => /(URL|HOST|PORT)/i.test(entry.key) && !entry.key.startsWith('FTP_'));
const secretCount = entries.filter(entry => entry.sensitive).length;

const renderRows = list => list.map(entry => `
          <tr>
            <td>${entry.key}</td>
            <td class="value">${entry.displayValue || '(empty)'}</td>
            <td>${entry.sensitive ? 'masked' : ''}</td>
          </tr>`).join('\n');

const generatedAt = new Date().toLocaleString('en-US', { timeZone: 'UTC' });

const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Voice Chat Stack Overview</title>
  <style>
    :root {
      color-scheme: light dark;
      font-family: "Inter", "Segoe UI", system-ui, -apple-system, BlinkMacSystemFont, sans-serif;
      line-height: 1.5;
      font-size: 16px;
    }
    body {
      margin: 0;
      padding: 2rem;
      background: #0b1020;
      color: #f5f7ff;
    }
    main {
      max-width: 960px;
      margin: 0 auto;
      background: rgba(255, 255, 255, 0.04);
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 18px;
      padding: 2rem;
      box-shadow: 0 20px 45px rgba(10, 14, 35, 0.4);
    }
    h1 {
      margin-top: 0;
      font-size: clamp(2rem, 3vw, 2.75rem);
    }
    section {
      margin-top: 2rem;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 0.95rem;
    }
    th, td {
      text-align: left;
      padding: 0.6rem 0.4rem;
      border-bottom: 1px solid rgba(255, 255, 255, 0.08);
    }
    th {
      text-transform: uppercase;
      letter-spacing: 0.1em;
      font-size: 0.75rem;
      color: rgba(255, 255, 255, 0.6);
    }
    .value {
      font-family: "JetBrains Mono", "Fira Code", Consolas, Menlo, Monaco, monospace;
      word-break: break-all;
      color: #9de1ff;
    }
    .pill {
      display: inline-flex;
      align-items: center;
      gap: 0.4rem;
      background: rgba(255, 255, 255, 0.08);
      border-radius: 999px;
      padding: 0.35rem 0.9rem;
      font-size: 0.85rem;
    }
    .pill strong {
      font-size: 1rem;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      gap: 1rem;
      margin: 1.25rem 0 0;
    }
    .card {
      padding: 1rem;
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 14px;
      background: rgba(255, 255, 255, 0.03);
    }
    ul {
      padding-left: 1.2rem;
      margin: 0.4rem 0 0;
    }
  </style>
</head>
<body>
  <main>
    <header>
      <h1>Voice Chat Stack Overview</h1>
      <p class="pill"><strong>${entries.length}</strong> variables detected · ${secretCount} masked · Generated ${generatedAt} UTC</p>
    </header>

    <section>
      <h2>FTP Endpoint</h2>
      <div class="grid">
        <article class="card">
          <strong>Host</strong>
          <p>${ftpHost?.value || 'not set'}</p>
        </article>
        <article class="card">
          <strong>Username</strong>
          <p>${ftpUser?.value || 'not set'}</p>
        </article>
        <article class="card">
          <strong>Remote Path</strong>
          <p>${ftpPath?.value || 'not set'}</p>
        </article>
      </div>
      <p style="margin-top:1rem;font-size:0.9rem;color:rgba(255,255,255,0.7)">Password and tokens remain masked in public exports.</p>
    </section>

    <section>
      <h2>Paths & Directories</h2>
      <table>
        <thead>
          <tr>
            <th>Variable</th>
            <th>Value</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
${renderRows(pathEntries)}
        </tbody>
      </table>
    </section>

    <section>
      <h2>Service Endpoints</h2>
      <table>
        <thead>
          <tr>
            <th>Variable</th>
            <th>Value</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
${renderRows(serviceEntries)}
        </tbody>
      </table>
    </section>

    <section>
      <h2>Complete Variable Snapshot</h2>
      <table>
        <thead>
          <tr>
            <th>Variable</th>
            <th>Value</th>
            <th>Notes</th>
          </tr>
        </thead>
        <tbody>
${renderRows(entries)}
        </tbody>
      </table>
    </section>
  </main>
</body>
</html>`;

fs.writeFileSync(outputPath, html, 'utf8');
console.log(`Stack index written to ${outputPath}`);
