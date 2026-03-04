/**
 * Vercel Serverless Function — Gemini API Proxy
 * 
 * Forwards requests to Google's generativelanguage API to avoid
 * browser API key restrictions and CORS issues.
 * 
 * Route: /api/proxy/gemini/handler?path=v1beta/models/gemini-2.5-flash:generateContent
 */

const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com';

const CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Goog-Api-Key',
    'Access-Control-Max-Age': '86400',
};

export const maxDuration = 300;

export default async function handler(req, res) {
    Object.entries(CORS_HEADERS).forEach(([k, v]) => res.setHeader(k, v));
    if (req.method === 'OPTIONS') return res.status(200).end();

    try {
        const subPath = req.query.path || '';
        const apiKey = req.headers['x-goog-api-key'] || '';

        if (!apiKey) {
            return res.status(401).json({ error: 'No API key. Send X-Goog-Api-Key header.' });
        }

        // Build target URL with API key as query param (Google's format)
        const targetUrl = `${GEMINI_API_BASE}/${subPath}?key=${apiKey}`;

        const bodyStr = typeof req.body === 'string' ? req.body : JSON.stringify(req.body || {});
        const payloadKB = Math.round(bodyStr.length / 1024);
        const timeout = payloadKB > 500 ? 280000 : payloadKB > 50 ? 240000 : 120000;

        console.log(`[GeminiProxy] ${req.method} /${subPath} | ${payloadKB}KB | ${timeout / 1000}s`);

        const controller = new AbortController();
        const tid = setTimeout(() => controller.abort(), timeout);

        const opts = {
            method: req.method || 'GET',
            headers: { 'Content-Type': 'application/json' },
            signal: controller.signal,
        };
        if (req.method === 'POST' || req.method === 'PUT') opts.body = bodyStr;

        const response = await fetch(targetUrl, opts);
        clearTimeout(tid);

        res.setHeader('Content-Type', response.headers.get('content-type') || 'application/json');
        const body = await response.text();
        console.log(`[GeminiProxy] → ${response.status} | ${Math.round(body.length / 1024)}KB`);
        return res.status(response.status).send(body);
    } catch (error) {
        console.error(`[GeminiProxy] Error:`, error.message);
        if (error.name === 'AbortError') {
            return res.status(504).json({ error: 'Gateway Timeout', timeout: true });
        }
        return res.status(502).json({ error: `Proxy error: ${error.message}` });
    }
}
