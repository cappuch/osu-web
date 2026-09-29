// Minimal development server with cross-origin isolation headers (required for SharedArrayBuffer / wasm threads).
import https from 'node:https';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Readable } from 'node:stream';

const root = path.resolve(process.argv[2] || '.');
const port = Number(process.argv[3] || 8080);
const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm', '.json': 'application/json', '.dat': 'application/octet-stream', '.css': 'text/css', '.png': 'image/png' };
const isolationHeaders = {
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Embedder-Policy': 'require-corp',
    'Cross-Origin-Resource-Policy': 'same-origin',
};

function corsHeaders(req) {
    return {
        'Access-Control-Allow-Origin': req.headers.origin || '*',
        'Access-Control-Allow-Methods': 'GET, HEAD, POST, PUT, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': req.headers['access-control-request-headers'] || '*',
        'Access-Control-Max-Age': '86400',
        Vary: 'Origin',
    };
}
const proxyHosts = {
    osu: 'osu.ppy.sh',
    assets: 'assets.ppy.sh',
    a: 'a.ppy.sh',
    i: 'i.ppy.sh',
};

async function proxy(req, res, target) {

    const headers = { ...req.headers };
    for (const name of ['host', 'connection', 'content-length', 'origin', 'referer', 'sec-fetch-dest', 'sec-fetch-mode', 'sec-fetch-site'])
        delete headers[name];
    // Browser fetch cannot set User-Agent. osu.ppy.sh rejects other clients.
    headers['user-agent'] = 'osu!';

    try {
        const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
        const upstream = await fetch(target, {
            method: req.method,
            headers,
            body: hasBody ? req : undefined,
            duplex: hasBody ? 'half' : undefined,
            redirect: 'follow',
        });

        const responseHeaders = Object.fromEntries(upstream.headers);
        for (const name of ['content-encoding', 'content-length', 'transfer-encoding'])
            delete responseHeaders[name];

        delete responseHeaders['access-control-allow-origin'];
        res.writeHead(upstream.status, { ...responseHeaders, ...isolationHeaders, ...corsHeaders(req), 'Cache-Control': 'no-cache' });
        if (upstream.body)
            Readable.fromWeb(upstream.body).pipe(res);
        else
            res.end();
    } catch (error) {
        res.writeHead(502, { ...isolationHeaders, ...corsHeaders(req) });
        res.end(`proxy failed: ${error.message}`);
    }
}

// Chrome ignores COOP/COEP on http://192.168.x.x (not a trustworthy origin), which disables SharedArrayBuffer.
// A local HTTPS certificate makes the LAN address eligible once the warning is accepted.
function localCertificate() {
    const dir = path.join(path.dirname(new URL(import.meta.url).pathname), '.certs');
    const keyFile = path.join(dir, 'key.pem');
    const certFile = path.join(dir, 'cert.pem');
    const ips = new Set(['127.0.0.1']);
    for (const entries of Object.values(os.networkInterfaces())) {
        for (const entry of entries ?? []) {
            if (entry.family === 'IPv4') ips.add(entry.address);
        }
    }
    const san = ['DNS:localhost', ...[...ips].map((ip) => `IP:${ip}`)].join(',');
    fs.mkdirSync(dir, { recursive: true });
    execFileSync('openssl', [
        'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '30',
        '-keyout', keyFile, '-out', certFile,
        '-subj', '/CN=osu-web', '-addext', `subjectAltName=${san}`,
    ], { stdio: 'ignore' });
    return { key: fs.readFileSync(keyFile), cert: fs.readFileSync(certFile) };
}

const server = https.createServer(localCertificate(), (req, res) => {
    const requestUrl = new URL(req.url, 'http://localhost');

    if (req.method === 'OPTIONS') {
        res.writeHead(204, { ...isolationHeaders, ...corsHeaders(req) });
        return res.end();
    }

    const proxyMatch = requestUrl.pathname.match(/^\/__proxy\/([^/]+)(\/.*)?$/);
    if (proxyMatch) {
        const host = proxyHosts[proxyMatch[1]];
        if (!host) {
            res.writeHead(403, { ...isolationHeaders, ...corsHeaders(req) });
            return res.end('proxy target not allowed');
        }

        proxy(req, res, new URL(`https://${host}${proxyMatch[2] || '/'}${requestUrl.search}`));
        return;
    }

    let p = decodeURIComponent(requestUrl.pathname);
    if (p.endsWith('/')) p += 'index.html';
    const file = path.join(root, p);
    if (!file.startsWith(`${root}${path.sep}`)) { res.writeHead(403, { ...isolationHeaders, ...corsHeaders(req) }); return res.end(); }
    fs.stat(file, (err, st) => {
        if (err || !st.isFile()) { res.writeHead(404, { ...isolationHeaders, ...corsHeaders(req) }); return res.end('not found'); }
        res.writeHead(200, {
            'Content-Type': types[path.extname(file)] || 'application/octet-stream',
            'Content-Length': st.size,
            ...isolationHeaders,
            ...corsHeaders(req),
            'Cache-Control': 'no-cache',
        });
        fs.createReadStream(file).pipe(res);
    });
});

server.listen(port, '0.0.0.0', () => console.log(`serving ${root} on https://0.0.0.0:${port}`));
