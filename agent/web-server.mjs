// Serves the browser voice page and mints LiveKit tokens for it (dev keys by default).
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { AccessToken } from 'livekit-server-sdk';

const env = process.env;
const WEB = path.join(path.dirname(fileURLToPath(import.meta.url)), 'web');
const cfg = {
  url: env.LIVEKIT_URL ?? 'ws://127.0.0.1:7880',
  key: env.LIVEKIT_API_KEY ?? 'devkey',
  secret: env.LIVEKIT_API_SECRET ?? 'secret',
  room: env.LK_ROOM ?? 'lk-voice',
  port: Number(env.WEB_PORT ?? 8801),
};
const TYPES = { '.html': 'text/html', '.js': 'text/javascript' };

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/token') {
    const identity = url.searchParams.get('identity') ?? 'browser';
    const at = new AccessToken(cfg.key, cfg.secret, { identity });
    at.addGrant({ roomJoin: true, room: cfg.room, canPublish: true, canSubscribe: true });
    res.setHeader('content-type', 'application/json');
    return res.end(JSON.stringify({ url: cfg.url, token: await at.toJwt() }));
  }
  const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
  try {
    const body = await readFile(path.join(WEB, path.basename(file)));
    res.setHeader('content-type', TYPES[path.extname(file)] ?? 'application/octet-stream');
    res.end(body);
  } catch {
    res.statusCode = 404;
    res.end('not found');
  }
}).listen(cfg.port, '127.0.0.1', () => console.log(`voice page on http://127.0.0.1:${cfg.port}`));
