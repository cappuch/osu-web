// Same-origin proxy for osu! hosts. Browser fetch cannot set User-Agent, and
// osu.ppy.sh answers datacenter clients with a Cloudflare challenge unless the
// client identifies as the game.
const { Readable } = require('node:stream');

const HOSTS = {
  osu: 'osu.ppy.sh',
  assets: 'assets.ppy.sh',
  a: 'a.ppy.sh',
  i: 'i.ppy.sh',
};

const HOP = new Set([
  'host', 'connection', 'content-length', 'origin', 'referer',
  'sec-fetch-dest', 'sec-fetch-mode', 'sec-fetch-site', 'accept-encoding',
]);

module.exports = async function handler(req, res) {
  const upstreamHost = HOSTS[req.query.host];
  if (!upstreamHost) {
    res.status(403).end('proxy target not allowed');
    return;
  }

  const segments = [].concat(req.query.path || []).map((segment) => encodeURIComponent(segment));
  const query = new URL(req.url, 'http://local').search;
  const target = `https://${upstreamHost}/${segments.join('/')}${query}`;

  const headers = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (!HOP.has(name.toLowerCase()) && value != null)
      headers[name] = Array.isArray(value) ? value.join(', ') : value;
  }
  headers['user-agent'] = 'osu!';

  const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
  const upstream = await fetch(target, {
    method: req.method,
    headers,
    body: hasBody ? req : undefined,
    duplex: hasBody ? 'half' : undefined,
    redirect: 'follow',
  });

  res.status(upstream.status);
  upstream.headers.forEach((value, name) => {
    if (name === 'content-encoding' || name === 'content-length' || name === 'transfer-encoding')
      return;
    res.setHeader(name, value);
  });

  if (!upstream.body || req.method === 'HEAD') {
    res.end();
    return;
  }

  Readable.fromWeb(upstream.body).pipe(res);
};
