// Zero-dependency static server + proxy to the local Ollama System One API.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.PORT ?? 3000);
const OLLAMA = (process.env.OLLAMA_HOST ?? 'http://localhost:11434').replace(/\/$/, '');
const PUBLIC = fileURLToPath(new URL('./public/', import.meta.url));

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml' };

function send(res, status, body, type = 'application/json') {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

async function status() {
  try {
    const [version, tags] = await Promise.all([
      fetch(`${OLLAMA}/api/version`).then((r) => r.json()),
      fetch(`${OLLAMA}/api/tags`).then((r) => r.json()),
    ]);
    return { ok: true, host: OLLAMA, version: version.version, models: tags.models.map((m) => m.name) };
  } catch (err) {
    return { ok: false, host: OLLAMA, error: `Cannot reach Ollama at ${OLLAMA}: ${err.message}` };
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname === '/api/status' && req.method === 'GET') {
      return send(res, 200, await status());
    }
    if (url.pathname === '/api/systemone' && req.method === 'POST') {
      const upstream = await fetch(`${OLLAMA}/v1/systemone`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: await readBody(req),
      });
      return send(res, upstream.status, await upstream.text());
    }
    if (req.method !== 'GET') return send(res, 405, { error: 'method not allowed' });

    const path = normalize(join(PUBLIC, url.pathname === '/' ? 'index.html' : url.pathname));
    if (!path.startsWith(PUBLIC)) return send(res, 403, { error: 'forbidden' });
    const file = await readFile(path).catch(() => null);
    if (!file) return send(res, 404, { error: 'not found' });
    return send(res, 200, file, TYPES[extname(path)] ?? 'application/octet-stream');
  } catch (err) {
    return send(res, 502, { error: err.message });
  }
});

server.listen(PORT, () => {
  console.log(`Pac-Man × System One → http://localhost:${PORT}  (Ollama: ${OLLAMA})`);
});
