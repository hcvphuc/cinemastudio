/**
 * Imperial Ultra API Client
 * 
 * Premium API proxy via VietAI Gateway (vertex-key.com)
 * Hỗ trợ OpenAI-compatible protocol
 * 
 * Server: https://vertex-key.com/api/v1
 * Fallback: Groq/Fal.ai via existing proxies
 * 
 * Migrated from ag.itera102.cloud (offline) → vertex-key.com (2026-02-28)
 */

// ═══════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════

const IMPERIAL_CONFIG = {
    baseUrl: '/api/proxy/imperial',  // Proxy through Express backend to avoid CORS
    defaultApiKey: 'vai-VmLHbaQC3xiPibcQwu0D7odKxvFp9bMFVqH0BY2Uvt5zPhTn',
    timeout: 120000, // 120s timeout
    models: {
        // Text models (stable - tested 2026-02-28)
        textFast: 'gem/gemini-2.5-flash',             // Fast & reliable
        textPro: 'gem/gemini-3-pro',                  // Best quality
        textLight: 'gem/gemini-2.5-flash-lite',       // Lightest & fastest

        // ═══════════════════════════════════════════════════════════════
        // 🐣 UNIFIED Image Generation (2026-03-04)
        // All tiers (A/B/C/D/E/F/G/H) merged into 4 models
        // Auto-failover: server auto-routes to best available tier
        // NO PREFIX NEEDED — just use model name directly
        // ═══════════════════════════════════════════════════════════════
        image: 'gemini-image-2k',                     // Default: 2K (2816×1536) $0.45
        imagePro: 'gemini-image-4k',                  // Pro: 4K (5632×3072) $0.50
        imageLight: 'gemini-image-1k',                // Light: 1K (1408×768) $0.36
        imageFast: 'gemini-2.5-flash-image',          // Fast: 1024² $0.25 (cheapest)

        // Image EDIT model: gemini-image-1k supports image_url input
        imageEdit: 'gemini-image-1k',                 // Unified 1K for img2img edits

        // Legacy tier-specific models (still work with old API keys)
        legacyImage: 'gem/gemini-3.1-flash-image-2k',
        legacyImageEdit: 'gem/gemini-3.1-flash-image-1k',

        // Preview models
        preview: 'gem/gemini-3-flash-preview',        // Latest preview

        // Aliases
        claudeSonnet: 'gem/gemini-2.5-flash',         // Mapped to fast
        claudeOpus: 'gem/gemini-3-pro',               // Mapped to pro

        // Thinking models
        flashThinking: 'gem/gemini-2.5-flash',        // Chain of thought
    }
};

// Models confirmed to support image INPUT (img2img editing via chat/completions).
// Updated 2026-03-04: Unified models support image input.
const IMPERIAL_IMAGE_EDIT_SUPPORTED_MODELS = new Set([
    'gemini-image-1k',                     // New unified (auto-failover)
    'gemini-image-2k',                     // New unified (auto-failover)
    'gemini-image-4k',                     // New unified (auto-failover)
    'gemini-2.5-flash-image',              // New unified fast
    'gem/gemini-3.1-flash-image-1k',       // Legacy (still works)
]);

// Get the edit-safe model for a given model:
// If the requested model doesn't support image input, fall back to imageEdit model
function getEditSafeModel(requestedModel: string): string {
    if (IMPERIAL_IMAGE_EDIT_SUPPORTED_MODELS.has(requestedModel)) {
        return requestedModel;
    }
    const fallback = IMPERIAL_CONFIG.models.imageEdit;
    if (requestedModel !== fallback) {
        console.warn(`[Imperial Ultra] ⚠️ Model '${requestedModel}' does NOT support image input. Falling back to '${fallback}' for edit.`);
    }
    return fallback;
}

/**
 * ═══════════════════════════════════════════════════════════════
 * IMAGE TIER FALLBACK SYSTEM — Auto-retry with different tiers
 * ═══════════════════════════════════════════════════════════════
 * 
 * Vertex Key has 5 image tiers, each mapping to different upstream providers:
 *   ima/ → Image A (Gemini Image Gen)
 *   imi/ → Image B (Gemini Image Gen)
 *   imr/ → Image C (Gemini Image Gen, 1K only)
 *   imp/ → Image D (Gemini Image Gen)
 *   imy/ → Image&Video (Gemini Image + Grok Video)
 *   gem/ → Gemini 3.1 Flash Image (legacy)
 * 
 * All share the same API format. If one tier hits 429/503/queue-full,
 * the fallback chain tries the next tier at the same resolution.
 */
const IMAGE_TIER_FALLBACK: Record<string, string[]> = {
    // ═══════════════════════════════════════════════════════════════
    // 🐣 UNIFIED MODELS (2026-03-04) — Server handles failover
    // Client-side fallback: unified → legacy gem/ → cross-resolution
    // ═══════════════════════════════════════════════════════════════
    'gemini-image-1k': ['gem/gemini-3.1-flash-image-1k'],
    'gemini-image-2k': ['gem/gemini-3.1-flash-image-2k', 'gemini-image-1k'],
    'gemini-image-4k': ['gem/gemini-3.1-flash-image-4k', 'gemini-image-2k'],

    // Legacy gem/ prefix fallback → unified models
    'gem/gemini-3.1-flash-image-1k': ['gemini-image-1k'],
    'gem/gemini-3.1-flash-image-2k': ['gemini-image-2k', 'gemini-image-1k'],
    'gem/gemini-3.1-flash-image-4k': ['gemini-image-4k', 'gemini-image-2k'],

    // Legacy tier-specific fallback (for old API keys that still use prefixed models)
    'imy/gemini-image-1k': ['gemini-image-1k', 'ima/gemini-image-1k', 'gem/gemini-3.1-flash-image-1k'],
    'ima/gemini-image-1k': ['gemini-image-1k', 'imy/gemini-image-1k', 'gem/gemini-3.1-flash-image-1k'],
    'imy/gemini-image-2k': ['gemini-image-2k', 'ima/gemini-image-2k', 'gem/gemini-3.1-flash-image-2k'],
    'ima/gemini-image-2k': ['gemini-image-2k', 'imy/gemini-image-2k', 'gem/gemini-3.1-flash-image-2k'],
    'imy/gemini-image-4k': ['gemini-image-4k', 'ima/gemini-image-4k', 'gem/gemini-3.1-flash-image-4k'],
    'ima/gemini-image-4k': ['gemini-image-4k', 'imy/gemini-image-4k', 'gem/gemini-3.1-flash-image-4k'],
};

/**
 * Get fallback models for a given model when it fails (429/503/queue-full)
 * Returns array of alternative models at the SAME resolution
 */
export function getImageFallbackChain(model: string): string[] {
    return IMAGE_TIER_FALLBACK[model] || [];
}

/**
 * Get API key source type for debugging
 */
export function getImperialKeySource(): 'admin' | 'user' | 'default' {
    if (typeof window === 'undefined') return 'default';

    if (localStorage.getItem('assignedImperialKey')) {
        return 'admin';
    }
    if (localStorage.getItem('imperialApiKey')) {
        return 'user';
    }
    return 'default';
}

/**
 * Get API key with priority:
 * 1. Admin-assigned key (from Supabase)
 * 2. User-input key (from localStorage)
 * 3. Default fallback key
 */
export function getImperialApiKey(): string {
    if (typeof window === 'undefined') return IMPERIAL_CONFIG.defaultApiKey;

    // Priority 1: Admin-assigned key (stored from Supabase profile)
    const assignedKey = localStorage.getItem('assignedImperialKey');
    if (assignedKey) {
        return assignedKey;
    }

    // Priority 2: User-input key
    const userKey = localStorage.getItem('imperialApiKey');
    if (userKey) {
        return userKey;
    }

    // Priority 3: Default fallback
    return IMPERIAL_CONFIG.defaultApiKey;
}

/**
 * Set user's Imperial API key
 */
export function setImperialApiKey(key: string): void {
    if (typeof window === 'undefined') return;
    localStorage.setItem('imperialApiKey', key);
    console.log('[Imperial Ultra] User API key saved');
}

/**
 * Set admin-assigned Imperial API key (called from App.tsx on login)
 */
export function setAssignedImperialKey(key: string | null): void {
    if (typeof window === 'undefined') return;
    if (key) {
        localStorage.setItem('assignedImperialKey', key);
        console.log('[Imperial Ultra] Admin-assigned key loaded');
    } else {
        localStorage.removeItem('assignedImperialKey');
    }
}

// ═══════════════════════════════════════════════════════════════
// HEALTH CHECK & STATUS
// ═══════════════════════════════════════════════════════════════

let isHealthy = true;
let lastHealthCheck = 0;
let consecutiveFailures = 0;
const HEALTH_CHECK_INTERVAL = 60000; // 1 minute
const MAX_CONSECUTIVE_FAILURES = 3;

/**
 * Get model name from IMPERIAL_CONFIG by tier key
 * Used by smart routing to resolve correct vertex-key.com model names
 */
export function getImperialModel(tier: keyof typeof IMPERIAL_CONFIG.models): string {
    return IMPERIAL_CONFIG.models[tier] || IMPERIAL_CONFIG.models.textFast;
}

/**
 * Check if Imperial Ultra is enabled in settings
 */
export function isImperialUltraEnabled(): boolean {
    if (typeof window === 'undefined') return false;
    // Default to true since vertex-key.com is active
    const setting = localStorage.getItem('imperialUltraEnabled');
    return setting === null ? true : setting === 'true';
}

/**
 * Enable/disable Imperial Ultra
 */
export function setImperialUltraEnabled(enabled: boolean): void {
    if (typeof window === 'undefined') return;
    localStorage.setItem('imperialUltraEnabled', enabled ? 'true' : 'false');
    console.log(`[Imperial Ultra] ${enabled ? 'Enabled' : 'Disabled'}`);
}

/**
 * Check health of Imperial Ultra server
 */
export async function checkImperialHealth(): Promise<boolean> {
    // Use cached result if recent
    if (Date.now() - lastHealthCheck < HEALTH_CHECK_INTERVAL) {
        return isHealthy;
    }

    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 10000);

        const response = await fetch(`${IMPERIAL_CONFIG.baseUrl}/v1/models`, {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${getImperialApiKey()}`
            },
            signal: controller.signal
        });

        clearTimeout(timeoutId);

        isHealthy = response.ok;
        consecutiveFailures = isHealthy ? 0 : consecutiveFailures + 1;

        console.log(`[Imperial Ultra] Health check: ${isHealthy ? '✅ Healthy' : '❌ Unhealthy'}`);
    } catch (error) {
        isHealthy = false;
        consecutiveFailures++;
        console.warn('[Imperial Ultra] Health check failed:', error);
    }

    lastHealthCheck = Date.now();

    // Auto-disable after too many failures
    if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        console.warn(`[Imperial Ultra] Too many failures (${consecutiveFailures}), temporarily disabled`);
    }

    return isHealthy && consecutiveFailures < MAX_CONSECUTIVE_FAILURES;
}

/**
 * Get current status
 */
export function getImperialStatus(): { enabled: boolean; healthy: boolean; failures: number } {
    return {
        enabled: isImperialUltraEnabled(),
        healthy: isHealthy,
        failures: consecutiveFailures
    };
}

// ═══════════════════════════════════════════════════════════════
// TEXT GENERATION
// ═══════════════════════════════════════════════════════════════

export interface ImperialTextOptions {
    model?: string;
    systemPrompt?: string;
    temperature?: number;
    maxTokens?: number;
    jsonMode?: boolean;
}

/**
 * Call Imperial Ultra for text generation
 * Uses OpenAI-compatible /v1/chat/completions endpoint
 */
export async function callImperialText(
    prompt: string,
    options: ImperialTextOptions = {}
): Promise<string> {
    const {
        model = IMPERIAL_CONFIG.models.textFast,
        systemPrompt = '',
        temperature = 0.7,
        maxTokens = 4096,
        jsonMode = false
    } = options;

    const apiKey = getImperialApiKey();
    const keySource = getImperialKeySource();
    const keyPreview = apiKey.substring(0, 12) + '...' + apiKey.slice(-4);

    console.log(`[Imperial Ultra] 🚀 Text Request:`);
    console.log(`  ├─ Model: ${model}`);
    console.log(`  ├─ API Key: ${keyPreview} (${keySource.toUpperCase()})`);
    console.log(`  ├─ JSON Mode: ${jsonMode}`);
    console.log(`  └─ Prompt length: ${prompt.length} chars`);

    const messages: Array<{ role: string; content: string }> = [];

    if (systemPrompt) {
        messages.push({ role: 'system', content: systemPrompt });
    }
    messages.push({ role: 'user', content: prompt });

    const requestBody: Record<string, any> = {
        model,
        messages,
        temperature,
        max_tokens: jsonMode ? Math.max(maxTokens, 16384) : maxTokens
    };

    if (jsonMode) {
        requestBody.response_format = { type: 'json_object' };
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), IMPERIAL_CONFIG.timeout);

    try {
        const response = await fetch(`${IMPERIAL_CONFIG.baseUrl}/v1/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${getImperialApiKey()}`
            },
            body: JSON.stringify(requestBody),
            signal: controller.signal
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            throw new Error(`Imperial API error (${response.status}): ${errorData.error?.message || response.statusText}`);
        }

        const data = await response.json();
        let content = data.choices?.[0]?.message?.content || '';
        const usage = data.usage || {};

        // Strip thinking/reasoning text for JSON mode responses
        if (jsonMode && content && !content.trimStart().startsWith('{') && !content.trimStart().startsWith('[')) {
            console.log(`[Imperial Ultra] 🧹 Stripping thinking text from JSON response (${content.length} chars)`);
            const firstBrace = content.indexOf('{');
            if (firstBrace !== -1) {
                let depth = 0, lastBrace = -1;
                for (let i = firstBrace; i < content.length; i++) {
                    if (content[i] === '{') depth++;
                    else if (content[i] === '}') { depth--; if (depth === 0) { lastBrace = i; break; } }
                }
                if (lastBrace !== -1) {
                    content = content.substring(firstBrace, lastBrace + 1);
                    console.log(`[Imperial Ultra] ✅ Extracted JSON: ${content.length} chars`);
                }
            }
        }

        console.log(`[Imperial Ultra] ✅ Text Response:`);
        console.log(`  ├─ Content: ${content.length} chars`);
        console.log(`  ├─ Prompt tokens: ${usage.prompt_tokens || 'N/A'}`);
        console.log(`  └─ Completion tokens: ${usage.completion_tokens || 'N/A'}`);
        consecutiveFailures = 0;

        return content;
    } catch (error: any) {
        clearTimeout(timeoutId);
        consecutiveFailures++;

        if (error.name === 'AbortError') {
            throw new Error('Imperial Ultra request timed out');
        }

        console.error('[Imperial Ultra] ❌ Text request failed:', error.message);
        throw error;
    }
}

// ═══════════════════════════════════════════════════════════════
// IMAGE GENERATION  
// ═══════════════════════════════════════════════════════════════

export interface ImperialImageOptions {
    model?: string;
    aspectRatio?: string;
    size?: string;
    imageContext?: string | null;
    multimodalParts?: any[];
}

/**
 * Call Imperial Ultra for image generation
 * Uses Gemini 3 Pro Image model via OpenAI-compatible endpoint
 */
export async function callImperialImage(
    prompt: string,
    options: ImperialImageOptions = {}
): Promise<{ url?: string; base64?: string }> {
    const {
        model = IMPERIAL_CONFIG.models.image,
        aspectRatio = '16:9',
        imageContext = null
    } = options;

    // Map aspect ratio to size
    const sizeMap: Record<string, string> = {
        '1:1': '1024x1024',
        '16:9': '1280x720',
        '9:16': '720x1280',
        '4:3': '1216x896',
        '3:4': '896x1216',
    };
    const size = sizeMap[aspectRatio] || '1024x1024';

    const mParts = options.multimodalParts || [];
    console.log(`[Imperial Ultra] 🎨 Image Request:`);
    console.log(`  ├─ Model: ${model}`);
    console.log(`  ├─ Aspect Ratio: ${aspectRatio} → Size: ${size}`);
    console.log(`  ├─ Has Reference Image: ${!!imageContext} | Multimodal Parts: ${mParts.length}`);
    console.log(`  └─ Prompt: ${prompt.substring(0, 60)}...`);

    // Build multimodal message content
    let messageContent: any;
    const multimodalParts = options.multimodalParts || [];

    if (multimodalParts.length > 0) {
        const contentParts: any[] = [];
        let imageCount = 0;

        for (const part of multimodalParts) {
            if (part.inlineData) {
                const mimeType = part.inlineData.mimeType || 'image/jpeg';
                const dataUrl = `data:${mimeType};base64,${part.inlineData.data}`;
                contentParts.push({
                    type: 'image_url',
                    image_url: { url: dataUrl }
                });
                imageCount++;
            } else if (part.text) {
                contentParts.push({ type: 'text', text: part.text });
            } else if (part.imageUrl && !part.text) {
                let url = part.imageUrl;
                if (!url.startsWith('data:') && !url.startsWith('http')) {
                    url = `data:image/jpeg;base64,${url}`;
                }
                contentParts.push({
                    type: 'image_url',
                    image_url: { url }
                });
                imageCount++;
            }
        }

        contentParts.push({ type: 'text', text: prompt });
        messageContent = contentParts;
        console.log(`[Imperial Ultra] 📸 Multimodal: ${imageCount} images`);
    } else if (imageContext) {
        let imageUrl = imageContext;
        if (!imageContext.startsWith('data:') && !imageContext.startsWith('http')) {
            imageUrl = `data:image/jpeg;base64,${imageContext}`;
        }

        messageContent = [
            {
                type: 'image_url',
                image_url: { url: imageUrl }
            },
            {
                type: 'text',
                text: prompt
            }
        ];
        console.log(`[Imperial Ultra] 📸 Sending reference image with prompt (multimodal)`);
    } else {
        messageContent = prompt;
    }

    const hasInputImages = !!imageContext || (options.multimodalParts && options.multimodalParts.length > 0);

    // STRICT ROUTING RULES
    const isLegacyModel = model.startsWith('gem/');
    const isUnifiedImageModel = model.includes('image') && !isLegacyModel;
    const isGenerateEndpoint = !hasInputImages && isUnifiedImageModel;

    const endpointPath = isGenerateEndpoint ? '/v1/images/generations' : '/v1/chat/completions';
    let requestBody: any;

    if (isGenerateEndpoint) {
        requestBody = {
            model,
            prompt: prompt,
            size,
            aspect_ratio: aspectRatio,
            n: 1
        };
        console.log(`[Imperial Ultra] 🚀 Routing to ${endpointPath} (Standard Generate Format)`);
    } else {
        requestBody = {
            model,
            messages: [
                { role: 'user', content: messageContent }
            ],
            size,
            aspect_ratio: aspectRatio
        };
        console.log(`[Imperial Ultra] 💬 Routing to ${endpointPath} (Chat Completion Format)`);
    }

    const MAX_RETRIES = 3;
    const RETRY_DELAY_MS = 2000;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), IMPERIAL_CONFIG.timeout);

        try {
            const response = await fetch(`${IMPERIAL_CONFIG.baseUrl}${endpointPath}`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${getImperialApiKey()}`
                },
                body: JSON.stringify(requestBody),
                signal: controller.signal
            });

            clearTimeout(timeoutId);

            if (!response.ok) {
                const errorData = await response.json().catch(() => ({}));
                const errMsg = `Imperial Image API error (${response.status}): ${JSON.stringify(errorData)}`;

                const retryable = [401, 429, 502, 503, 504];
                if (retryable.includes(response.status) && attempt < MAX_RETRIES) {
                    const delay = response.status === 429 ? RETRY_DELAY_MS * 2 : RETRY_DELAY_MS;
                    console.warn(`[Imperial Ultra] ⚠️ Attempt ${attempt}/${MAX_RETRIES} failed (${response.status}), retrying in ${delay}ms...`);
                    await new Promise(r => setTimeout(r, delay));
                    continue;
                }
                throw new Error(errMsg);
            }

            const data = await response.json();

            // 1. Standard OpenAI Images API response
            if (data.data && Array.isArray(data.data) && data.data.length > 0) {
                if (data.data[0].b64_json) {
                    console.log(`[Imperial Ultra] ✅ Image received (OpenAI b64_json, attempt ${attempt})`);
                    return { base64: `data:image/png;base64,${data.data[0].b64_json}` };
                }
                if (data.data[0].url) {
                    console.log(`[Imperial Ultra] ✅ Image received (OpenAI url, attempt ${attempt})`);
                    return { url: data.data[0].url };
                }
            }

            // 2. Legacy images array
            if (data.images && Array.isArray(data.images) && data.images.length > 0) {
                if (data.images[0].url) return { url: data.images[0].url };
                if (data.images[0].b64_json) return { base64: `data:image/png;base64,${data.images[0].b64_json}` };
            }

            // 3. Chat Completions format
            const content = data.choices?.[0]?.message?.content;
            if (content) {
                const markdownMatch = content.match(/!\[.*?\]\((data:image\/[^;]+;base64,[A-Za-z0-9+/=]+)\)/);
                if (markdownMatch) {
                    consecutiveFailures = 0;
                    return { base64: markdownMatch[1] };
                }
                if (content.startsWith('data:image')) {
                    consecutiveFailures = 0;
                    return { base64: content };
                }
                if (content.match(/^[A-Za-z0-9+/=]{100,}/)) {
                    consecutiveFailures = 0;
                    return { base64: `data:image/png;base64,${content}` };
                }
                if (content.startsWith('http')) {
                    consecutiveFailures = 0;
                    return { url: content };
                }
            }

            // 4. Inline parts (Gemini format)
            const parts = data.choices?.[0]?.message?.parts;
            if (parts && Array.isArray(parts)) {
                for (const part of parts) {
                    if (part.inlineData?.data) {
                        const mimeType = part.inlineData.mimeType || 'image/png';
                        consecutiveFailures = 0;
                        return { base64: `data:${mimeType};base64,${part.inlineData.data}` };
                    }
                }
            }

            throw new Error(`Unexpected response format: ${JSON.stringify(data).substring(0, 100)}`);
        } catch (error: any) {
            clearTimeout(timeoutId);

            if (error.name === 'AbortError') {
                if (attempt < MAX_RETRIES) {
                    console.warn(`[Imperial Ultra] ⚠️ Attempt ${attempt}/${MAX_RETRIES} timed out, retrying...`);
                    await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
                    continue;
                }
                consecutiveFailures++;
                throw new Error('Imperial Ultra image request timed out after all retries');
            }

            if (attempt >= MAX_RETRIES) {
                consecutiveFailures++;
                console.error('[Imperial Ultra] ❌ Image request failed after all retries:', error.message);
                throw error;
            }

            console.warn(`[Imperial Ultra] ⚠️ Attempt ${attempt}/${MAX_RETRIES} error: ${error.message}, retrying...`);
            await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
        }
    }

    throw new Error('Imperial Ultra image request failed after all retries');
}

// ═══════════════════════════════════════════════════════════════
// VISION (Image Analysis)
// ═══════════════════════════════════════════════════════════════

export interface ImperialVisionOptions {
    jsonMode?: boolean;
    maxTokens?: number;
    temperature?: number;
    systemPrompt?: string;
}

/**
 * Call Imperial Ultra for vision/image analysis
 */
export async function callImperialVision(
    prompt: string,
    images: Array<{ data: string; mimeType: string }>,
    model: string = IMPERIAL_CONFIG.models.textFast,
    options: ImperialVisionOptions = {}
): Promise<string> {
    const {
        jsonMode = true,
        maxTokens = 4096,
        temperature = 0.4,
        systemPrompt
    } = options;

    const apiKey = getImperialApiKey();
    const keySource = getImperialKeySource();
    const keyPreview = apiKey.substring(0, 12) + '...' + apiKey.slice(-4);

    console.log(`[Imperial Ultra] 🎨 Vision Request:`);
    console.log(`  ├─ Model: ${model}`);
    console.log(`  ├─ API Key: ${keyPreview} (${keySource.toUpperCase()})`);
    console.log(`  ├─ Images: ${images.length}`);
    console.log(`  ├─ JSON Mode: ${jsonMode}`);
    console.log(`  └─ Prompt length: ${prompt.length} chars`);

    const content: Array<{ type: string; text?: string; image_url?: { url: string } }> = [];

    for (const img of images) {
        content.push({
            type: 'image_url',
            image_url: {
                url: img.data.startsWith('data:') ? img.data : `data:${img.mimeType};base64,${img.data}`
            }
        });
    }

    content.push({ type: 'text', text: prompt });

    const messages: Array<{ role: string; content: any }> = [];
    if (systemPrompt) {
        messages.push({ role: 'system', content: systemPrompt });
    }
    messages.push({ role: 'user', content });

    const requestBody: Record<string, any> = {
        model,
        messages,
        max_tokens: maxTokens,
        temperature
    };

    if (jsonMode) {
        requestBody.response_format = { type: 'json_object' };
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), IMPERIAL_CONFIG.timeout);

    try {
        const response = await fetch(`${IMPERIAL_CONFIG.baseUrl}/v1/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${getImperialApiKey()}`
            },
            body: JSON.stringify(requestBody),
            signal: controller.signal
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            throw new Error(`Imperial Vision API error (${response.status}): ${errorData.error?.message || response.statusText}`);
        }

        const data = await response.json();
        let text = data.choices?.[0]?.message?.content || '';

        // Strip thinking/reasoning prefix from JSON responses
        if (jsonMode && text && !text.trimStart().startsWith('{') && !text.trimStart().startsWith('[')) {
            const firstBrace = text.indexOf('{');
            if (firstBrace !== -1) {
                let depth = 0, lastBrace = -1;
                for (let i = firstBrace; i < text.length; i++) {
                    if (text[i] === '{') depth++;
                    else if (text[i] === '}') { depth--; if (depth === 0) { lastBrace = i; break; } }
                }
                if (lastBrace !== -1) {
                    text = text.substring(firstBrace, lastBrace + 1);
                }
            }
        }

        console.log(`[Imperial Ultra] ✅ Vision response received (${text.length} chars)`);
        consecutiveFailures = 0;

        return text;
    } catch (error: any) {
        clearTimeout(timeoutId);
        consecutiveFailures++;

        if (error.name === 'AbortError') {
            throw new Error('Imperial Ultra vision request timed out');
        }

        console.error('[Imperial Ultra] ❌ Vision request failed:', error.message);
        throw error;
    }
}

/**
 * Call Imperial Ultra Vision with Reasoning (gem/gemini-3-pro)
 * Fallback chain: Vertex Pro → Vertex Flash → throw
 */
export async function callImperialVisionReasoning(
    prompt: string,
    images: Array<{ data: string; mimeType: string }>,
    options: ImperialVisionOptions = {}
): Promise<string> {
    const proModel = IMPERIAL_CONFIG.models.textPro;
    const flashModel = IMPERIAL_CONFIG.models.textFast;

    console.log(`[Imperial Vision Reasoning] 🧠 Starting with Pro model: ${proModel}`);

    try {
        return await callImperialVision(prompt, images, proModel, {
            ...options,
            maxTokens: options.maxTokens || 8192,
            temperature: options.temperature || 0.3,
            systemPrompt: options.systemPrompt || 'You are an expert visual analyst. Analyze images with extreme attention to detail.'
        });
    } catch (proError: any) {
        console.warn(`[Imperial Vision Reasoning] ⚠️ Pro failed: ${proError.message}, trying Flash...`);

        try {
            return await callImperialVision(prompt, images, flashModel, {
                ...options,
                maxTokens: options.maxTokens || 4096,
                temperature: options.temperature || 0.4
            });
        } catch (flashError: any) {
            console.error(`[Imperial Vision Reasoning] ❌ Flash also failed: ${flashError.message}`);
            throw new Error(`Vertex Vision failed — Pro: ${proError.message} | Flash: ${flashError.message}`);
        }
    }
}

// ═══════════════════════════════════════════════════════════════
// IMAGE EDITING (with mask support)
// ═══════════════════════════════════════════════════════════════

export interface ImperialImageEditOptions {
    model?: string;
    aspectRatio?: string;
    additionalImages?: Array<{ data: string; mimeType: string }>;
}

/**
 * Call Imperial Ultra for image editing (with optional mask)
 */
export async function callImperialImageEdit(
    sourceImage: string,
    sourceMimeType: string,
    prompt: string,
    maskImage?: string,
    options: ImperialImageEditOptions = {}
): Promise<{ url?: string; base64?: string; mimeType?: string }> {
    const {
        model: requestedModel = IMPERIAL_CONFIG.models.imageEdit,
        aspectRatio = '1:1'
    } = options;

    const model = getEditSafeModel(requestedModel);

    const sizeMap: Record<string, string> = {
        '1:1': '1024x1024',
        '16:9': '1280x720',
        '9:16': '720x1280',
        '4:3': '1216x896',
        '3:4': '896x1216',
    };
    const size = sizeMap[aspectRatio] || '1024x1024';

    console.log(`[Imperial Ultra] 🖼️ Image Edit Request:`);
    console.log(`  ├─ Model: ${requestedModel}${model !== requestedModel ? ` → FORCED to ${model}` : ''}`);
    console.log(`  ├─ Aspect Ratio: ${aspectRatio} → Size: ${size}`);
    console.log(`  ├─ Has Mask: ${maskImage ? 'Yes' : 'No'}`);
    console.log(`  └─ Prompt: ${prompt.substring(0, 60)}...`);

    // Image validation & MIME type auto-detection
    let validatedSourceImage = sourceImage;
    let validatedMimeType = sourceMimeType;

    // If source is a URL, fetch and convert to base64
    if (sourceImage.startsWith('http') || sourceImage.startsWith('blob:')) {
        console.log('[Imperial Ultra] 🌐 sourceImage is URL — fetching and converting to base64...');
        try {
            const resp = await fetch(sourceImage);
            const arrayBuf = await resp.arrayBuffer();
            const bytes = new Uint8Array(arrayBuf);
            const isPNG = bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47;
            const isJPEG = bytes[0] === 0xFF && bytes[1] === 0xD8;
            validatedMimeType = isPNG ? 'image/png' : isJPEG ? 'image/jpeg' : 'image/png';
            const base64Str = btoa(String.fromCharCode(...bytes));
            validatedSourceImage = base64Str;
        } catch (e: any) {
            console.warn(`[Imperial Ultra] ⚠️ URL fetch failed: ${e.message} — proceeding with original`);
        }
    } else if (validatedSourceImage.startsWith('data:')) {
        const match = validatedSourceImage.match(/^data:([^;]+);base64,(.+)/);
        if (match) {
            validatedMimeType = match[1];
            validatedSourceImage = match[2];
        }
    }

    // Auto-detect mimeType from magic bytes
    try {
        const rawBytes = atob(validatedSourceImage.substring(0, 32));
        const byte0 = rawBytes.charCodeAt(0);
        const byte1 = rawBytes.charCodeAt(1);
        const byte2 = rawBytes.charCodeAt(2);
        const byte3 = rawBytes.charCodeAt(3);

        const isPNG = byte0 === 0x89 && byte1 === 0x50 && byte2 === 0x4E && byte3 === 0x47;
        const isJPEG = byte0 === 0xFF && byte1 === 0xD8;
        const isWebP = byte0 === 0x52 && byte1 === 0x49 && byte2 === 0x46 && byte3 === 0x46;

        const detectedMime = isPNG ? 'image/png' : isJPEG ? 'image/jpeg' : isWebP ? 'image/webp' : null;

        if (detectedMime && detectedMime !== validatedMimeType) {
            console.warn(`[Imperial Ultra] ⚠️ mimeType mismatch: declared='${validatedMimeType}' detected='${detectedMime}' → using detected`);
            validatedMimeType = detectedMime;
        } else if (!detectedMime && !validatedMimeType) {
            validatedMimeType = 'image/png';
        }
    } catch (e) {
        if (!validatedMimeType) validatedMimeType = 'image/png';
    }

    // Build multi-part content message
    const content: Array<{ type: string; text?: string; image_url?: { url: string } }> = [];

    const sourceDataUrl = `data:${validatedMimeType};base64,${validatedSourceImage}`;
    content.push({
        type: 'image_url',
        image_url: { url: sourceDataUrl }
    });

    // Add additional images
    if (options.additionalImages && options.additionalImages.length > 0) {
        for (const addImg of options.additionalImages) {
            const addBase64 = addImg.data.startsWith('data:')
                ? addImg.data.split(',')[1]
                : addImg.data;
            const addDataUrl = `data:${addImg.mimeType || 'image/png'};base64,${addBase64}`;
            content.push({
                type: 'image_url',
                image_url: { url: addDataUrl }
            });
        }
    }

    // Add mask if provided
    if (maskImage) {
        const maskBase64 = maskImage.startsWith('data:')
            ? maskImage.split(',')[1]
            : maskImage;
        const maskDataUrl = `data:image/png;base64,${maskBase64}`;
        content.push({
            type: 'image_url',
            image_url: { url: maskDataUrl }
        });
    }

    content.push({ type: 'text', text: prompt });

    const requestBody = {
        model,
        messages: [{ role: 'user', content }],
        size
    };

    const EDIT_TIMEOUT = 300000;
    const MAX_EDIT_RETRIES = 3;
    const EDIT_RETRY_DELAY = 3000;

    for (let attempt = 1; attempt <= MAX_EDIT_RETRIES; attempt++) {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), EDIT_TIMEOUT);

        try {
            const response = await fetch(`${IMPERIAL_CONFIG.baseUrl}/v1/chat/completions`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${getImperialApiKey()}`
                },
                body: JSON.stringify(requestBody),
                signal: controller.signal
            });

            clearTimeout(timeoutId);

            if (!response.ok) {
                const errorData = await response.json().catch(() => ({}));
                const errMsg = `Imperial Image Edit API error (${response.status}): ${JSON.stringify(errorData).substring(0, 200)}`;

                const retryStatuses = [429, 502, 503, 504];
                if (retryStatuses.includes(response.status) && attempt < MAX_EDIT_RETRIES) {
                    const delay = response.status === 429 ? EDIT_RETRY_DELAY * 2 : EDIT_RETRY_DELAY;
                    console.warn(`[Imperial Ultra] ⚠️ Image edit attempt ${attempt}/${MAX_EDIT_RETRIES} failed (${response.status}), retrying in ${delay}ms...`);
                    await new Promise(r => setTimeout(r, delay));
                    continue;
                }
                throw new Error(errMsg);
            }

            const data = await response.json();
            const contentStr = data.choices?.[0]?.message?.content;

            if (!contentStr) {
                throw new Error('Empty response from Imperial Ultra image edit API');
            }

            // Parse response
            const markdownMatch = contentStr.match(/!\[.*?\]\((data:image\/[^;]+;base64,[A-Za-z0-9+/=]+)\)/);
            if (markdownMatch) {
                consecutiveFailures = 0;
                return { base64: markdownMatch[1], mimeType: 'image/png' };
            }

            if (contentStr.startsWith('data:image')) {
                consecutiveFailures = 0;
                return { base64: contentStr, mimeType: 'image/png' };
            }

            if (contentStr.match(/^[A-Za-z0-9+/=]{100,}/)) {
                consecutiveFailures = 0;
                return { base64: `data:image/png;base64,${contentStr}`, mimeType: 'image/png' };
            }

            if (contentStr.startsWith('http')) {
                consecutiveFailures = 0;
                return { url: contentStr, mimeType: 'image/png' };
            }

            throw new Error('Unexpected response format from Imperial Ultra image edit API');
        } catch (error: any) {
            clearTimeout(timeoutId);

            if (error.name === 'AbortError') {
                if (attempt < MAX_EDIT_RETRIES) {
                    console.warn(`[Imperial Ultra] ⚠️ Image edit attempt ${attempt}/${MAX_EDIT_RETRIES} timed out, retrying...`);
                    await new Promise(r => setTimeout(r, EDIT_RETRY_DELAY));
                    continue;
                }
                consecutiveFailures++;
                throw new Error('Imperial Ultra image edit request timed out after all retries');
            }

            if (attempt >= MAX_EDIT_RETRIES) {
                consecutiveFailures++;
                throw error;
            }

            const isNetworkError = error.message.includes('fetch') || error.message.includes('network') ||
                error.message.includes('502') || error.message.includes('504');
            if (isNetworkError) {
                console.warn(`[Imperial Ultra] ⚠️ Image edit attempt ${attempt}/${MAX_EDIT_RETRIES} network error, retrying...`);
                await new Promise(r => setTimeout(r, EDIT_RETRY_DELAY));
                continue;
            }

            consecutiveFailures++;
            throw error;
        }
    }

    throw new Error('Imperial Ultra image edit failed after all retries');
}


// ═══════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════

export const IMPERIAL_MODELS = IMPERIAL_CONFIG.models;
export default {
    callImperialText,
    callImperialImage,
    callImperialImageEdit,
    callImperialVision,
    callImperialVisionReasoning,
    checkImperialHealth,
    isImperialUltraEnabled,
    setImperialUltraEnabled,
    getImperialStatus,
    getImageFallbackChain,
    IMPERIAL_MODELS
};
