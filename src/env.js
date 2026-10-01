'use strict';

const fs = require('node:fs');
const path = require('node:path');

// Load the project-root .env before server configuration is read. Existing
// process environment values win, so deployment settings can override the file.
const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
  const contents = fs.readFileSync(envPath, 'utf8').replace(/^\uFEFF/, '');
  for (const line of contents.split(/\r?\n/)) {
    const entry = line.trim();
    if (!entry || entry.startsWith('#')) continue;
    const match = entry.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;

    const key = match[1];
    if (Object.prototype.hasOwnProperty.call(process.env, key)) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
      if (match[2].trim().startsWith('"')) value = value.replace(/\\n/g, '\n').replace(/\\r/g, '\r');
    } else {
      value = value.replace(/\s+#.*$/, '').trim();
    }
    process.env[key] = value;
  }
}
