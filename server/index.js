import express from 'express';
import cors from 'cors';
import axios from 'axios';

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

// ==================== EXTENSION TOKEN STORAGE ====================
const EXTENSION_TOKENS = {
    recaptchaToken: null,
    projectId: null,
    sessionToken: null,
    oauthToken: null,
    lastUpdated: null
};

// Token Pool from Extension
const TOKEN_POOL = [];

// Endpoint: Update token pool from Extension
app.post('/api/update-token-pool', (req, res) => {
    const { tokens } = req.body;

    if (!tokens || !Array.isArray(tokens)) {
        return res.status(400).json({ error: 'Invalid tokens array' });
    }

    // Replace pool with new tokens
    TOKEN_POOL.length = 0;
    TOKEN_POOL.push(...tokens);

    console.log(`📥 Token pool updated: ${TOKEN_POOL.length} tokens`);
    res.json({ success: true, poolSize: TOKEN_POOL.length });
});

// Endpoint: Consume tokens from pool (get and remove)
app.post('/api/consume-tokens', (req, res) => {
    const { count = 1 } = req.body;

    if (TOKEN_POOL.length < count) {
        return res.status(400).json({
            error: 'Not enough tokens in pool',
            available: TOKEN_POOL.length,
            requested: count
        });
    }

    // Remove and return tokens from pool
    const consumedTokens = TOKEN_POOL.splice(0, count);

    console.log(`🔥 Consumed ${count} tokens, ${TOKEN_POOL.length} remaining`);

    res.json({
        success: true,
        tokens: consumedTokens,
        remaining: TOKEN_POOL.length
    });
});

// ==================== PENDING TOKEN REQUESTS ====================
const PENDING_REQUESTS = new Map(); // requestId -> {status, token, timestamp}

// Endpoint: Create a pending token request
app.post('/api/genyu/request-fresh-token', (req, res) => {
    const requestId = `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    PENDING_REQUESTS.set(requestId, {
        status: 'pending',
        token: null,
        timestamp: Date.now()
    });

    console.log(`[Token Request] Created: ${requestId}`);

    res.json({
        success: true,
        requestId: requestId,
        message: 'Extension will generate token shortly'
    });
});

// Endpoint: Extension checks for pending requests
app.get('/api/genyu/check-pending-requests', (req, res) => {
    const pendingIds = [];

    for (const [id, data] of PENDING_REQUESTS.entries()) {
        if (data.status === 'pending') {
            // Only return requests < 30s old
            if (Date.now() - data.timestamp < 30000) {
                pendingIds.push(id);
            } else {
                // Timeout old requests
                PENDING_REQUESTS.delete(id);
            }
        }
    }

    res.json({
        hasPending: pendingIds.length > 0,
        requests: pendingIds
    });
});

// Endpoint: Extension submits fresh token
app.post('/api/genyu/submit-fresh-token', (req, res) => {
    const { requestId, token } = req.body;

    if (!requestId || !token) {
        return res.status(400).json({ error: 'Missing requestId or token' });
    }

    const request = PENDING_REQUESTS.get(requestId);
    if (!request) {
        return res.status(404).json({ error: 'Request not found' });
    }

    request.status = 'completed';
    request.token = token;
    PENDING_REQUESTS.set(requestId, request);

    console.log(`[Token Request] ✅ Completed: ${requestId}, token length: ${token.length}`);

    res.json({ success: true });
});

// Endpoint: Server waits for token
app.get('/api/genyu/wait-for-token/:requestId', async (req, res) => {
    const { requestId } = req.params;
    const maxWaitTime = 15000; // 15 seconds
    const checkInterval = 500; // Check every 500ms
    const startTime = Date.now();

    while (Date.now() - startTime < maxWaitTime) {
        const request = PENDING_REQUESTS.get(requestId);

        if (!request) {
            return res.status(404).json({ error: 'Request not found' });
        }

        if (request.status === 'completed' && request.token) {
            PENDING_REQUESTS.delete(requestId); // Cleanup
            return res.json({
                success: true,
                token: request.token
            });
        }

        // Wait before checking again
        await new Promise(resolve => setTimeout(resolve, checkInterval));
    }

    // Timeout
    PENDING_REQUESTS.delete(requestId);
    res.status(408).json({ error: 'Token generation timeout' });
});

// ==================== EXTENSION TOKEN UPDATE (OLD) ====================
app.post('/api/update-tokens', (req, res) => {
    const received = Object.keys(req.body);
    console.log('[DEBUG] Received tokens:', received);

    if (req.body.recaptchaToken) {
        EXTENSION_TOKENS.recaptchaToken = req.body.recaptchaToken;
        console.log(`✅ [Extension] reCAPTCHA token received (${req.body.recaptchaToken.length} chars)`);
    }

    if (req.body.projectId) {
        EXTENSION_TOKENS.projectId = req.body.projectId;
    }

    if (req.body.sessionToken) {
        EXTENSION_TOKENS.sessionToken = req.body.sessionToken;
        console.log(`✅ [Extension] Session token received (${req.body.sessionToken.length} chars)`);
    }

    if (req.body.oauthToken) {
        EXTENSION_TOKENS.oauthToken = req.body.oauthToken;
        console.log(`✅ [Extension] OAuth token received (${req.body.oauthToken.length} chars)`);
    }

    EXTENSION_TOKENS.lastUpdated = Date.now();

    res.json({ success: true, message: 'Tokens updated' });
});

// Endpoint: Get token status
app.get('/api/tokens', (req, res) => {
    const tokenAge = EXTENSION_TOKENS.lastUpdated
        ? Math.floor((Date.now() - EXTENSION_TOKENS.lastUpdated) / 1000)
        : null;

    res.json({
        hasRecaptcha: !!EXTENSION_TOKENS.recaptchaToken,
        recaptchaLength: EXTENSION_TOKENS.recaptchaToken?.length || 0,
        projectId: EXTENSION_TOKENS.projectId,
        lastUpdated: EXTENSION_TOKENS.lastUpdated,
        tokenAgeSeconds: tokenAge,
        extensionActive: TOKEN_POOL.length > 0, // Check pool instead of token age
        recaptchaToken: EXTENSION_TOKENS.recaptchaToken,
        sessionToken: EXTENSION_TOKENS.sessionToken,
        oauthToken: EXTENSION_TOKENS.oauthToken,
        // Token Pool
        tokenPool: TOKEN_POOL,
        poolSize: TOKEN_POOL.length
    });
});

// Endpoint: Get fresh reCAPTCHA from Extension Pool
app.get('/api/get-pooled-token', async (req, res) => {
    try {
        // This would need to communicate with Extension
        // For now, return the stored token or null
        if (EXTENSION_TOKENS.recaptchaToken) {
            const token = EXTENSION_TOKENS.recaptchaToken;
            // Clear after use
            EXTENSION_TOKENS.recaptchaToken = null;
            res.json({ success: true, token });
        } else {
            res.json({ success: false, message: 'No token available in pool' });
        }
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// ==================== PUPPETEER AUTO-GENERATE ====================
import { saveCookies, autoGenerate } from './puppeteer-genyu.js';

app.post('/api/save-cookies', saveCookies);
app.post('/api/genyu/auto-generate', autoGenerate);

// ==================== IMPERIAL ULTRA PROXY (vertex-key.com) ====================
// Proxy all /api/proxy/imperial/* → vertex-key.com/api/*
// Handles: /v1/chat/completions, /v1/images/generations, /v1/models, /embeddings
app.all(/^\/api\/proxy\/imperial\/(.*)/, async (req, res) => {
    const path = req.params[0]; // e.g. "v1/chat/completions"
    const targetUrl = `https://vertex-key.com/api/${path}`;

    console.log(`[Imperial Proxy] ${req.method} /${path}`);

    try {
        // Forward Authorization header from client
        const headers = {
            'Content-Type': 'application/json',
        };

        if (req.headers.authorization) {
            headers['Authorization'] = req.headers.authorization;
        }

        const fetchOptions = {
            method: req.method,
            headers,
        };

        // Only add body for non-GET requests
        if (req.method !== 'GET' && req.body) {
            fetchOptions.body = JSON.stringify(req.body);
        }

        const response = await fetch(targetUrl, fetchOptions);

        // Forward status code
        if (!response.ok) {
            const errorData = await response.text().catch(() => '');
            console.error(`[Imperial Proxy] ❌ ${response.status}: ${errorData.substring(0, 200)}`);
            return res.status(response.status).json({
                error: `Upstream error (${response.status})`,
                details: errorData.substring(0, 500)
            });
        }

        const data = await response.json();
        console.log(`[Imperial Proxy] ✅ ${req.method} /${path} OK`);
        res.json(data);
    } catch (error) {
        console.error('[Imperial Proxy] ❌ Error:', error.message);
        res.status(502).json({ error: `Imperial proxy error: ${error.message}` });
    }
});

// ==================== GOOGLE LABS PROXY ====================
app.post('/api/proxy/genyu/image', async (req, res) => {
    try {
        const { token, recaptchaToken, prompt, aspect } = req.body;

        if (!token) {
            return res.status(400).json({ error: 'Token required' });
        }

        const projectId = '62c5b3fe-4cf4-42fe-b1b2-f621903e7e23';
        const apiUrl = `https://aisandbox-pa.googleapis.com/v1/projects/${projectId}/flowMedia:batchGenerateImages`;

        const payload = {
            "clientContext": {
                ...(recaptchaToken && { "recaptchaToken": recaptchaToken }),
                "sessionId": `;${Date.now()}`,
                "projectId": projectId,
                "tool": "PINHOLE"
            },
            "requests": [
                {
                    "clientContext": {
                        ...(recaptchaToken && { "recaptchaToken": recaptchaToken }),
                        "sessionId": `;${Date.now()}`,
                        "projectId": projectId,
                        "tool": "PINHOLE"
                    },
                    "seed": Math.floor(Math.random() * 1000000),
                    "imageModelName": "GEM_PIX_2",
                    "imageAspectRatio": aspect || "IMAGE_ASPECT_RATIO_LANDSCAPE",
                    "prompt": prompt,
                    "imageInputs": []
                }
            ]
        };

        const headers = {
            'authorization': `Bearer ${token}`,
            'content-type': 'application/json',
            'origin': 'https://labs.google.com',
            'x-browser-channel': 'stable',
            'x-browser-year': '2025'
        };

        const response = await fetch(apiUrl, {
            method: 'POST',
            headers: headers,
            body: JSON.stringify(payload)
        });

        const data = await response.json();

        if (!response.ok) {
            console.error('Google Labs API Error:', data);
            return res.status(response.status).json(data);
        }

        res.json(data);
    } catch (error) {
        console.error('Proxy error:', error);
        res.status(500).json({ error: error.message });
    }
});

// ==================== GOOGLE VEO VIDEO PROXY ====================
app.post('/api/proxy/google/video/start', async (req, res) => {
    try {
        const { token, recaptchaToken, prompt, mediaId, aspectRatio } = req.body;
        console.log(`[Video] Starting gen... ID: ${mediaId?.substring(0, 10)}`);

        if (!token) return res.status(400).json({ error: 'Token required' });
        if (!mediaId) return res.status(400).json({ error: 'Media ID required for I2V' });

        const projectId = '07c3d6ef-3305-4196-bcc2-7db5294be436'; // Standard for VideoFX
        const apiUrl = `https://aisandbox-pa.googleapis.com/v1/projects/${projectId}/flowMedia:batchGenerateImages`;

        const payload = {
            "clientContext": {
                "recaptchaToken": recaptchaToken,
                "sessionId": `;${Date.now()}`,
                "projectId": projectId,
                "tool": "PINHOLE",
                "userPaygateTier": "PAYGATE_TIER_TWO"
            },
            "requests": [{
                "aspectRatio": aspectRatio || "VIDEO_ASPECT_RATIO_LANDSCAPE",
                "seed": Math.floor(Math.random() * 1000000),
                "textInput": { "prompt": prompt },
                "videoModelKey": "veo_3_1_i2v_s_fast_ultra",
                "startImage": mediaId ? { "mediaId": mediaId } : { "image": { "content": req.body.imageBase64 } },
                // "metadata": { "sceneId": "proxy-request" } // Optional
            }]
        };

        const headers = {
            'authorization': `Bearer ${token}`,
            'content-type': 'application/json',
            'origin': 'https://labs.google.com',
            'x-browser-channel': 'stable',
            'x-browser-year': '2025'
        };

        const response = await fetch(apiUrl, {
            method: 'POST',
            headers: headers,
            body: JSON.stringify(payload)
        });

        const data = await response.json();

        if (!response.ok) {
            console.error('Veo Start Error:', data);
            return res.status(response.status).json(data);
        }

        console.log('[Video] Started OK:', data.requests?.[0]?.operation?.name);
        res.json(data);
    } catch (error) {
        console.error('Video Proxy error:', error);
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/proxy/google/video/status', async (req, res) => {
    try {
        const { token, operations } = req.body;
        if (!token || !operations) return res.status(400).json({ error: 'Invalid payload' });

        // Retrieve status for each operation
        // Labs API uses individual GETs usually, or batchGet if supported.
        // Assuming we iterate or use a batch endpoint if known.
        // Since we don't know the exact batch status endpoint for Veo, 
        // we can try `google.longrunning.Operations.GetOperation` for each.
        // URL: https://aisandbox-pa.googleapis.com/v1/{name}

        const headers = {
            'authorization': `Bearer ${token}`,
            'content-type': 'application/json',
            'origin': 'https://labs.google.com'
        };

        const results = await Promise.all(operations.map(async (op) => {
            const opName = op.operation.name;
            const url = `https://aisandbox-pa.googleapis.com/v1/${opName}`;

            try {
                const r = await fetch(url, { headers });
                const d = await r.json();

                // Map to frontend expected format
                // App.tsx expects: { status: 'MEDIA_GENERATION_STATUS_SUCCEEDED', result: { video: { url: ... } } }
                // Labs usually returns: { name: ..., done: true, response: { result: ... } } OR metadata: { status: ... }

                // Helper to normalize Labs response to our App format
                let status = 'MEDIA_GENERATION_STATUS_ACTIVE';
                let result = null;

                if (d.done) {
                    if (d.error) {
                        status = 'MEDIA_GENERATION_STATUS_FAILED';
                    } else {
                        status = 'MEDIA_GENERATION_STATUS_SUCCEEDED';
                        // Extract video URL
                        // Look inside d.response or d.metadata
                        const media = d.response?.result?.video || d.metadata?.result?.video;
                        /* 
                           Warning: Veo response structure might differ.
                           Commonly: d.response['@type'] ... 
                           Let's dump the whole thing into 'result' so App.tsx can find it.
                        */
                        result = d.response?.result || d.metadata?.result;

                        // If still not found, check top level text/image fields
                        if (!result && d.response) result = d.response;
                    }
                }

                return {
                    sceneId: op.sceneId,
                    status: status,
                    result: result,
                    original: d
                };

            } catch (e) {
                console.error("Status fetch fail:", e);
                return { sceneId: op.sceneId, status: 'MEDIA_GENERATION_STATUS_FAILED' };
            }
        }));

        res.json({ operations: results });

    } catch (error) {
        console.error('Video Status Proxy error:', error);
        res.status(500).json({ error: error.message });
    }
});

// ==================== SERVER START ====================
const PORT = 3001;
const server = app.listen(PORT, () => {
    console.log(`🚀 Proxy running at http://localhost:${PORT}`);
    console.log(`📡 Fresh token request endpoint ready`);
});

server.setTimeout(300000);
