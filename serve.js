import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 8000;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wasm': 'application/wasm',
};

const SECURITY = {
  // a fetched .svg or .html must never be reinterpreted as another type
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
};

const bad = (res, code, text) => {
  res.writeHead(code, { 'content-type': 'text/plain; charset=utf-8', ...SECURITY }).end(text);
};

const server = http.createServer((req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return bad(res, 405, 'method not allowed');

  /* A malformed percent-encoding throws from decodeURIComponent, and a decoded
     NUL makes fs throw synchronously. Either would escape the request handler
     and take the whole server down, so both are rejected explicitly. */
  let url;
  try {
    url = decodeURIComponent(req.url.split('?')[0]);
  } catch {
    return bad(res, 400, 'bad request');
  }
  if (url.includes('\0')) return bad(res, 400, 'bad request');

  const rel = url === '/' ? 'index.html' : url.replace(/^\/+/, '');
  const file = path.join(ROOT, rel);

  /* Separator-aware: a plain startsWith() would also accept a sibling folder
     whose name merely begins with this project's name. */
  if (file !== ROOT && !file.startsWith(ROOT + path.sep)) return bad(res, 403, 'forbidden');

  fs.stat(file, (err, stat) => {
    if (err || !stat.isFile()) return bad(res, 404, 'not found');

    const type = TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';
    const etag = `W/"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;

    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, { etag, ...SECURITY }).end();
      return;
    }

    const headers = {
      'content-type': type,
      'content-length': stat.size,
      etag,
      /* revalidate rather than re-download: the app is served from disk and
         changes during development, but a reload should not refetch 280 KB */
      'cache-control': 'no-cache',
      ...SECURITY,
    };

    if (req.method === 'HEAD') return res.writeHead(200, headers).end();

    /* streamed rather than read whole: bounded memory even if a large asset is
       ever added, and the precondition for range support later */
    res.writeHead(200, headers);
    const stream = fs.createReadStream(file);
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  });
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') server.listen(0);
  else throw err;
});

server.on('listening', () => {
  const { port } = server.address();
  console.log(`media tools: http://localhost:${port}`);
  if (port !== PORT) console.log(`(port ${PORT} was busy)`);
});

/* Loopback only. This serves the app directory, so on a shared network it would
   hand the whole folder to anyone who asked. */
server.listen(PORT, '127.0.0.1');
