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


    /* A range request is answered from the range, never from the cache: a 304
       carries no body, and a media client that asked for a byte range cannot
       use one. */
    if (!req.headers.range && req.headers['if-none-match'] === etag) {
      res.writeHead(304, { etag, ...SECURITY }).end();
      return;
    }

    const headers = {
      'content-type': type,
      etag,
      /* revalidate rather than re-download: the app is served from disk and
         changes during development, but a reload should not refetch 280 KB */
      'cache-control': 'no-cache',
      'accept-ranges': 'bytes',
      ...SECURITY,
    };

    /* Byte ranges. Nothing the app plays comes through here today - user media
       is always a blob: URL - but Safari refuses to seek a progressive file
       served without 206, so the first thing routed through this server breaks
       seeking rather than failing visibly. */
    const range = req.headers.range;
    const match = range && /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (match && (match[1] || match[2])) {
      const size = stat.size;
      /* `bytes=N-` starts at N, `bytes=-N` is the final N bytes. A start at or
         past the end is unsatisfiable and must be refused, NOT clamped down to
         the last byte: clamping answers 206 for a range that does not exist. */
      const start = match[1] === '' ? size - Number(match[2]) : Number(match[1]);
      const end = match[1] === '' || match[2] === '' ? size - 1 : Math.min(Number(match[2]), size - 1);

      if (Number.isNaN(start) || Number.isNaN(end) || start < 0 || start >= size || end < start) {
        return res.writeHead(416, { 'content-range': `bytes */${size}`, ...SECURITY }).end();
      }
      const chunk = { start, end };
      res.writeHead(206, {
        ...headers,
        'content-range': `bytes ${start}-${end}/${size}`,
        'content-length': end - start + 1,
      });
      if (req.method === 'HEAD') return res.end();
      const ranged = fs.createReadStream(file, chunk);
      ranged.on('error', () => res.destroy());
      return ranged.pipe(res);
    }

    const full = { ...headers, 'content-length': stat.size };
    if (req.method === 'HEAD') return res.writeHead(200, full).end();

    /* streamed rather than read whole: bounded memory even if a large asset is
       ever added */
    res.writeHead(200, full);
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
