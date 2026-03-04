/**
 * Vercel Serverless Function — Vertex Key Proxy
 * 
 * Forwards requests to vertex-key.com to avoid CORS issues.
 * Catch-all route: /api/proxy/imperial/[...path]
 */

const VERTEX_API_KEY = process.env.VERTEX_API_KEY || '';
const VERTEX_API_BASE_URL = process.env.VERTEX_API_BASE_URL || 'https://vertex-key.com/api/v1';

// CORS headers
const CORS_HEADERS: Record<string, string> = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Imperial-Api-Key',
    'Access-Control-Max-Age': '86400',
};

export const maxDuration = 300; // Vercel max duration

export default async function handler(req: any, res: any) {
    // Set CORS headers
    Object.entries(CORS_HEADERS).forEach(([key, value]) => {
        res.setHeader(key, value);
    });

    // Handle preflight
    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    try {
        // Extract the path after /api/proxy/imperial/
        const pathSegments = req.query.path;
        const subPath = Array.isArray(pathSegments) ? pathSegments.join('/') : (pathSegments || '');

        // Build target URL
        const targetUrl = `${VERTEX_API_BASE_URL}/${subPath}`;

        // API Key Resolution: Bearer header > Custom header > Env
        const authHeader = (req.headers['authorization'] || '') as string;
        const bearerKey = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
        const customKey = req.headers['x-imperial-api-key'] as string || '';
        const apiKey = bearerKey || customKey || VERTEX_API_KEY;

        if (!apiKey) {
            return res.status(401).json({
                error: 'No API key provided. Set VERTEX_API_KEY env var or send Authorization header.'
            });
        }

        // Calculate timeout based on payload size
        const bodyStr = typeof req.body === 'string' ? req.body : JSON.stringify(req.body || {});
        const payloadSizeKB = Math.round(bodyStr.length / 1024);
        const isImageEdit = payloadSizeKB > 50;
        const isLargePayload = payloadSizeKB > 500;
        const fetchTimeout = isLargePayload ? 280000 : isImageEdit ? 240000 : 120000;

        console.log(`[Imperial Proxy] ${req.method} ${subPath} | Payload: ${payloadSizeKB}KB | Timeout: ${fetchTimeout / 1000}s | Key: ${apiKey.substring(0, 8)}...`);

        // Forward request with AbortController for timeout
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), fetchTimeout);

        const fetchOptions: RequestInit = {
            method: req.method || 'GET',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`,
            },
            signal: controller.signal,
        };

        // Add body for POST/PUT
        if (req.method === 'POST' || req.method === 'PUT') {
            fetchOptions.body = bodyStr;
        }

        const response = await fetch(targetUrl, fetchOptions);
        clearTimeout(timeoutId);

        // Forward status and content type
        const contentType = response.headers.get('content-type') || 'application/json';
        res.setHeader('Content-Type', contentType);

        const responseBody = await response.text();
        console.log(`[Imperial Proxy] Response: ${response.status} | Size: ${Math.round(responseBody.length / 1024)}KB`);

        return res.status(response.status).send(responseBody);
    } catch (error: any) {
        console.error(`[Imperial Proxy] Error:`, error.message);

        if (error.name === 'AbortError') {
            return res.status(504).json({
                error: 'Gateway Timeout — vertex-key.com took too long to respond',
                timeout: true
            });
        }

        return res.status(502).json({
            error: `Proxy error: ${error.message}`,
            provider: 'vertex-key.com'
        });
    }
}
