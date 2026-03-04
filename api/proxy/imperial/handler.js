const VERTEX_API_KEY = process.env.VERTEX_API_KEY || '';
const VERTEX_API_BASE_URL = process.env.VERTEX_API_BASE_URL || 'https://vertex-key.com/api/v1';

const CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Imperial-Api-Key',
    'Access-Control-Max-Age': '86400',
};

export const maxDuration = 300;

export default async function handler(req, res) {
    // CORS headers
    Object.entries(CORS_HEADERS).forEach(([key, value]) => res.setHeader(key, value));
    if (req.method === 'OPTIONS') return res.status(200).end();

    try {
        // Extract sub-path from query param (set by vercel.json rewrite)
        const subPath = req.query.path || 'models';

        const targetUrl = `${VERTEX_API_BASE_URL}/${subPath}`;

        // API Key: Bearer header > Custom header > Env
        const authHeader = (req.headers['authorization'] || '');
        const bearerKey = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
        const apiKey = bearerKey || req.headers['x-imperial-api-key'] || VERTEX_API_KEY;

        if (!apiKey) {
            return res.status(401).json({ error: 'No API key. Set VERTEX_API_KEY or send Authorization header.' });
        }

        const bodyStr = typeof req.body === 'string' ? req.body : JSON.stringify(req.body || {});
        const payloadKB = Math.round(bodyStr.length / 1024);
        const timeout = payloadKB > 500 ? 280000 : payloadKB > 50 ? 240000 : 120000;

        console.log(`[Proxy] ${req.method} /${subPath} | ${payloadKB}KB | ${timeout / 1000}s`);

        const controller = new AbortController();
        const tid = setTimeout(() => controller.abort(), timeout);

        const opts = {
            method: req.method || 'GET',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
            signal: controller.signal,
        };
        if (req.method === 'POST' || req.method === 'PUT') opts.body = bodyStr;

        const response = await fetch(targetUrl, opts);
        clearTimeout(tid);

        res.setHeader('Content-Type', response.headers.get('content-type') || 'application/json');
        const body = await response.text();
        console.log(`[Proxy] → ${response.status} | ${Math.round(body.length / 1024)}KB`);
        return res.status(response.status).send(body);
    } catch (error) {
        console.error(`[Proxy] Error:`, error.message);
        if (error.name === 'AbortError') {
            return res.status(504).json({ error: 'Gateway Timeout', timeout: true });
        }
        return res.status(502).json({ error: `Proxy error: ${error.message}` });
    }
}
