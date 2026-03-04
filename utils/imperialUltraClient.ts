/**
 * Imperial Ultra Client — Vertex Key SDK
 * 
 * Client-side SDK for interacting with vertex-key.com via the Vercel proxy.
 * Provides text generation, image generation, image editing, and vision capabilities.
 * 
 * Features:
 * - Health check with caching
 * - API key priority chain (admin → user → default)
 * - Image tier fallback chain for 429/503 errors
 * - Multiple response format parsing
 * - MIME type auto-detection
 */

// ═══════════════════════════════════════════════════════════════
// Configuration
// ═══════════════════════════════════════════════════════════════

const IMPERIAL_CONFIG = {
    baseUrl: '/api/proxy/imperial/handler',  // Vercel serverless function
    timeout: 120000,
    models: {
        // Text models
        textFast: 'gem/gemini-2.5-flash',
        textPro: 'gem/gemini-3-pro',
        textLight: 'gem/gemini-2.5-flash-lite',

        // Image models (Unified — server auto-failover)
        image: 'gemini-image-2k',
        imagePro: 'gemini-image-4k',
        imageLight: 'gemini-image-1k',
        imageFast: 'gemini-2.5-flash-image',

        // Image Edit
        imageEdit: 'gemini-image-1k',

        // Legacy (prefix-based)
        legacyImage: 'gem/gemini-3.1-flash-image-2k',
    }
};

// Model prefix convention for vertex-key.com
export const VERTEX_PREFIXES = ['gem/', 'imy/', 'ima/', 'imi/', 'imr/', 'imp/'];

// Image tier fallback chain for auto-retry on 429/503
const IMAGE_TIER_FALLBACK: Record<string, string[]> = {
    'gemini-image-1k': ['gem/gemini-3.1-flash-image-1k', 'gemini-2.5-flash-image'],
    'gemini-image-2k': ['gem/gemini-3.1-flash-image-2k', 'gemini-image-1k'],
    'gemini-image-4k': ['gem/gemini-3.1-flash-image-4k', 'gemini-image-2k'],
    'gem/gemini-3.1-flash-image-1k': ['gemini-image-1k', 'gemini-2.5-flash-image'],
    'gem/gemini-3.1-flash-image-2k': ['gemini-image-2k', 'gem/gemini-3.1-flash-image-1k'],
    'gem/gemini-3.1-flash-image-4k': ['gemini-image-4k', 'gem/gemini-3.1-flash-image-2k'],
};

// Models that support image editing (img2img)
const IMPERIAL_IMAGE_EDIT_SUPPORTED_MODELS = new Set([
    'gemini-image-1k', 'gemini-image-2k', 'gemini-image-4k',
    'gemini-2.5-flash-image', 'gem/gemini-3.1-flash-image-1k',
    'gem/gemini-3.1-flash-image-2k', 'gem/gemini-3.1-flash-image-4k',
]);

// ═══════════════════════════════════════════════════════════════
// Storage Keys
// ═══════════════════════════════════════════════════════════════

const STORAGE_KEYS = {
    enabled: 'imperialUltraEnabled',
    apiKey: 'imperialApiKey',
    assignedKey: 'assignedImperialKey',
};

// ═══════════════════════════════════════════════════════════════
// Enable/Disable
// ═══════════════════════════════════════════════════════════════

export function isImperialUltraEnabled(): boolean {
    return localStorage.getItem(STORAGE_KEYS.enabled) === 'true';
}

export function setImperialUltraEnabled(enabled: boolean): void {
    localStorage.setItem(STORAGE_KEYS.enabled, String(enabled));
    console.log(`[Imperial] ${enabled ? '✅ Enabled' : '❌ Disabled'}`);
}

// ═══════════════════════════════════════════════════════════════
// API Key Management (3-priority chain)
// ═══════════════════════════════════════════════════════════════

export function getImperialApiKey(): string {
    // 1. Admin-assigned key (from Supabase profile)
    const assignedKey = localStorage.getItem(STORAGE_KEYS.assignedKey);
    if (assignedKey) return assignedKey;

    // 2. User-input key (from Settings UI)
    const userKey = localStorage.getItem(STORAGE_KEYS.apiKey);
    if (userKey) return userKey;

    // 3. Read from vertexKeyApiKey (shared with aiProvider.ts)
    const vertexKey = localStorage.getItem('vertexKeyApiKey');
    if (vertexKey) return vertexKey;

    return '';
}

export function setImperialApiKey(key: string): void {
    localStorage.setItem(STORAGE_KEYS.apiKey, key.trim());
    // Also sync with aiProvider system
    localStorage.setItem('vertexKeyApiKey', key.trim());
}

export function getImperialModel(tier: keyof typeof IMPERIAL_CONFIG.models): string {
    return IMPERIAL_CONFIG.models[tier] || IMPERIAL_CONFIG.models.image;
}

export function getImageFallbackChain(model: string): string[] {
    return IMAGE_TIER_FALLBACK[model] || [];
}

export function isVertexModel(model: string): boolean {
    return VERTEX_PREFIXES.some(p => model.startsWith(p));
}

// ═══════════════════════════════════════════════════════════════
// Health Check System (cached)
// ═══════════════════════════════════════════════════════════════

let isHealthy = true;
let lastHealthCheck = 0;
let consecutiveFailures = 0;
const HEALTH_CHECK_INTERVAL = 60000;       // Check every 1 minute
const MAX_CONSECUTIVE_FAILURES = 3;        // Auto-disable after 3 consecutive failures

export async function checkImperialHealth(): Promise<boolean> {
    // Return cached result if fresh
    if (Date.now() - lastHealthCheck < HEALTH_CHECK_INTERVAL) {
        return isHealthy && consecutiveFailures < MAX_CONSECUTIVE_FAILURES;
    }

    const apiKey = getImperialApiKey();
    if (!apiKey) {
        isHealthy = false;
        return false;
    }

    try {
        const response = await fetch(`${IMPERIAL_CONFIG.baseUrl}?path=v1/models`, {
            headers: { 'Authorization': `Bearer ${apiKey}` },
            signal: AbortSignal.timeout(5000),
        });

        lastHealthCheck = Date.now();
        isHealthy = response.ok;

        if (response.ok) {
            consecutiveFailures = 0;
            console.log('[Imperial] ✅ Health check passed');
        } else {
            consecutiveFailures++;
            console.warn(`[Imperial] ⚠️ Health check failed (${response.status}), failures: ${consecutiveFailures}`);
        }
    } catch (error) {
        lastHealthCheck = Date.now();
        isHealthy = false;
        consecutiveFailures++;
        console.warn(`[Imperial] ⚠️ Health check error, failures: ${consecutiveFailures}`);
    }

    return isHealthy && consecutiveFailures < MAX_CONSECUTIVE_FAILURES;
}

export function getImperialStatus(): { enabled: boolean; healthy: boolean; failures: number; hasKey: boolean } {
    return {
        enabled: isImperialUltraEnabled(),
        healthy: isHealthy,
        failures: consecutiveFailures,
        hasKey: !!getImperialApiKey(),
    };
}

// Reset health state (call when user changes settings)
export function resetImperialHealth(): void {
    isHealthy = true;
    lastHealthCheck = 0;
    consecutiveFailures = 0;
}

// ═══════════════════════════════════════════════════════════════
// Cooldown System (rate limit protection)
// ═══════════════════════════════════════════════════════════════

const providerCooldowns: Record<string, number> = {};
const RATE_LIMIT_COOLDOWN = 60 * 1000;     // 429 → 60s cooldown
const ERROR_COOLDOWN = 5 * 60 * 1000;      // Hard errors → 5 min cooldown

function isProviderOnCooldown(provider: string): boolean {
    const cooldownEnd = providerCooldowns[provider];
    if (!cooldownEnd) return false;
    if (Date.now() > cooldownEnd) {
        delete providerCooldowns[provider];
        return false;
    }
    return true;
}

function setCooldown(provider: string, errorMessage: string): void {
    const is429 = errorMessage.includes('429') || errorMessage.includes('rate limit');
    const cooldownMs = is429 ? RATE_LIMIT_COOLDOWN : ERROR_COOLDOWN;
    providerCooldowns[provider] = Date.now() + cooldownMs;
    console.log(`[Imperial] 🕐 ${provider}: cooldown ${cooldownMs / 1000}s`);
}

// ═══════════════════════════════════════════════════════════════
// Core API Functions
// ═══════════════════════════════════════════════════════════════

interface ImperialTextOptions {
    model?: string;
    temperature?: number;
    maxTokens?: number;
    jsonMode?: boolean;
    systemPrompt?: string;
    apiKey?: string;
}

interface ImperialImageOptions {
    model?: string;
    size?: string;
    quality?: string;
    aspectRatio?: string;
    n?: number;
    apiKey?: string;
}

interface ImperialVisionOptions {
    model?: string;
    temperature?: number;
    maxTokens?: number;
    jsonMode?: boolean;
    apiKey?: string;
}

/**
 * Text Generation via vertex-key.com
 */
export async function callImperialText(
    prompt: string,
    options: ImperialTextOptions = {}
): Promise<string> {
    const apiKey = options.apiKey || getImperialApiKey();
    const model = options.model || IMPERIAL_CONFIG.models.textFast;

    if (isProviderOnCooldown('imperial-text')) {
        throw new Error('Imperial text provider on cooldown');
    }

    const messages: any[] = [];
    if (options.systemPrompt) {
        messages.push({ role: 'system', content: options.systemPrompt });
    }
    messages.push({ role: 'user', content: prompt });

    const body: any = {
        model,
        messages,
        temperature: options.temperature ?? 0.7,
        max_tokens: options.maxTokens || 4096,
    };

    if (options.jsonMode) {
        body.response_format = { type: 'json_object' };
    }

    try {
        const response = await fetch(`${IMPERIAL_CONFIG.baseUrl}?path=v1/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`,
            },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(IMPERIAL_CONFIG.timeout),
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Imperial API ${response.status}: ${errorText.substring(0, 200)}`);
        }

        const data = await response.json();
        let content = data.choices?.[0]?.message?.content || '';

        // Strip thinking text for JSON mode
        if (options.jsonMode && content && !content.trimStart().startsWith('{')) {
            const firstBrace = content.indexOf('{');
            if (firstBrace !== -1) {
                let depth = 0, lastBrace = -1;
                for (let i = firstBrace; i < content.length; i++) {
                    if (content[i] === '{') depth++;
                    else if (content[i] === '}') {
                        depth--;
                        if (depth === 0) { lastBrace = i; break; }
                    }
                }
                if (lastBrace !== -1) {
                    content = content.substring(firstBrace, lastBrace + 1);
                }
            }
        }

        return content;
    } catch (error: any) {
        setCooldown('imperial-text', error.message);
        throw error;
    }
}

/**
 * Image Generation (text-to-image + multimodal)
 */
export async function callImperialImage(
    prompt: string,
    options: ImperialImageOptions = {}
): Promise<string> {
    const apiKey = options.apiKey || getImperialApiKey();
    const model = options.model || IMPERIAL_CONFIG.models.image;

    if (isProviderOnCooldown('imperial-image')) {
        throw new Error('Imperial image provider on cooldown');
    }

    // Determine endpoint based on model type
    const isLegacyModel = model.startsWith('gem/');
    const isUnifiedImageModel = model.includes('image') && !isLegacyModel;
    const useGenerateEndpoint = isUnifiedImageModel;

    let response: Response;

    if (useGenerateEndpoint) {
        // OpenAI Images API format
        const body = {
            model,
            prompt,
            n: options.n || 1,
            size: options.size || '1024x1024',
            quality: options.quality || 'standard',
            response_format: 'b64_json',
        };

        response = await fetch(`${IMPERIAL_CONFIG.baseUrl}?path=v1/images/generations`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`,
            },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(180000), // 3 min for image gen
        });
    } else {
        // Chat completions format (supports multimodal)
        const body = {
            model,
            messages: [{ role: 'user', content: prompt }],
            max_tokens: 4096,
        };

        response = await fetch(`${IMPERIAL_CONFIG.baseUrl}?path=v1/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`,
            },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(180000),
        });
    }

    if (!response.ok) {
        const errorText = await response.text();
        setCooldown('imperial-image', `${response.status} ${errorText.substring(0, 100)}`);
        throw new Error(`Imperial Image ${response.status}: ${errorText.substring(0, 200)}`);
    }

    const data = await response.json();
    return parseImageResponse(data);
}

/**
 * Image Editing (img2img via chat/completions)
 */
export async function callImperialImageEdit(
    sourceImageBase64: string,
    mimeType: string,
    prompt: string,
    maskBase64?: string,
    options: ImperialImageOptions = {}
): Promise<string> {
    const apiKey = options.apiKey || getImperialApiKey();
    let model = options.model || IMPERIAL_CONFIG.models.imageEdit;

    // Validate model supports editing
    if (!IMPERIAL_IMAGE_EDIT_SUPPORTED_MODELS.has(model)) {
        console.warn(`[Imperial] Model ${model} doesn't support editing, falling back to ${IMPERIAL_CONFIG.models.imageEdit}`);
        model = IMPERIAL_CONFIG.models.imageEdit;
    }

    // Auto-detect MIME type from magic bytes
    const validatedMime = detectMimeType(sourceImageBase64) || mimeType;

    // Build multimodal message
    const content: any[] = [
        { type: 'text', text: prompt },
        {
            type: 'image_url',
            image_url: { url: `data:${validatedMime};base64,${sourceImageBase64}` }
        }
    ];

    if (maskBase64) {
        content.push({
            type: 'image_url',
            image_url: { url: `data:image/png;base64,${maskBase64}` }
        });
    }

    const body = {
        model,
        messages: [{ role: 'user', content }],
        max_tokens: 4096,
    };

    const response = await fetch(`${IMPERIAL_CONFIG.baseUrl}?path=v1/chat/completions`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(240000), // 4 min for image edit
    });

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Imperial Edit ${response.status}: ${errorText.substring(0, 200)}`);
    }

    const data = await response.json();
    return parseImageResponse(data);
}

/**
 * Vision / Image Analysis
 */
export async function callImperialVision(
    prompt: string,
    images: Array<{ base64: string; mimeType: string }>,
    options: ImperialVisionOptions = {}
): Promise<string> {
    const apiKey = options.apiKey || getImperialApiKey();
    const model = options.model || IMPERIAL_CONFIG.models.textFast;

    // Build multimodal content
    const content: any[] = [
        { type: 'text', text: prompt },
        ...images.map(img => ({
            type: 'image_url',
            image_url: { url: `data:${img.mimeType};base64,${img.base64}` }
        }))
    ];

    const body: any = {
        model,
        messages: [{ role: 'user', content }],
        temperature: options.temperature ?? 0.3,
        max_tokens: options.maxTokens || 4096,
    };

    if (options.jsonMode) {
        body.response_format = { type: 'json_object' };
    }

    const response = await fetch(`${IMPERIAL_CONFIG.baseUrl}?path=v1/chat/completions`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(IMPERIAL_CONFIG.timeout),
    });

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Imperial Vision ${response.status}: ${errorText.substring(0, 200)}`);
    }

    const data = await response.json();
    let content_result = data.choices?.[0]?.message?.content || '';

    // Strip thinking text for JSON mode
    if (options.jsonMode && content_result && !content_result.trimStart().startsWith('{')) {
        const firstBrace = content_result.indexOf('{');
        if (firstBrace !== -1) {
            let depth = 0, lastBrace = -1;
            for (let i = firstBrace; i < content_result.length; i++) {
                if (content_result[i] === '{') depth++;
                else if (content_result[i] === '}') {
                    depth--;
                    if (depth === 0) { lastBrace = i; break; }
                }
            }
            if (lastBrace !== -1) {
                content_result = content_result.substring(firstBrace, lastBrace + 1);
            }
        }
    }

    return content_result;
}

/**
 * Vision with Pro → Flash reasoning fallback
 */
export async function callImperialVisionReasoning(
    prompt: string,
    images: Array<{ base64: string; mimeType: string }>,
    options: ImperialVisionOptions = {}
): Promise<string> {
    // Try Pro first, fallback to Flash
    try {
        return await callImperialVision(prompt, images, {
            ...options,
            model: options.model || IMPERIAL_CONFIG.models.textPro,
        });
    } catch (proError: any) {
        console.warn(`[Imperial] Pro vision failed (${proError.message}), falling back to Flash`);
        return await callImperialVision(prompt, images, {
            ...options,
            model: IMPERIAL_CONFIG.models.textFast,
        });
    }
}

// ═══════════════════════════════════════════════════════════════
// Response Parsing (handles 4 formats from vertex-key.com)
// ═══════════════════════════════════════════════════════════════

function parseImageResponse(data: any): string {
    // Format 1: OpenAI Images API (b64_json)
    if (data.data?.[0]?.b64_json) {
        return `data:image/png;base64,${data.data[0].b64_json}`;
    }
    // Format 1b: OpenAI Images API (URL)
    if (data.data?.[0]?.url) {
        return data.data[0].url;
    }

    // Format 2: Legacy Vertex-Key format
    if (data.images?.[0]?.url) {
        return data.images[0].url;
    }

    // Format 3: Chat Completions format
    const content = data.choices?.[0]?.message?.content;
    if (content) {
        // Markdown image: ![image](data:image/jpeg;base64,...)
        const mdMatch = content.match(/!\[.*?\]\((data:image\/[^;]+;base64,[^\)]+)\)/);
        if (mdMatch) return mdMatch[1];

        // Data URL directly
        if (content.startsWith('data:image/')) return content;

        // Raw base64 (looks like /9j/4AAQ... for JPEG or iVBOR for PNG)
        if (content.match(/^[\/+A-Za-z0-9]{100,}/)) {
            const isJPEG = content.startsWith('/9j/');
            const isPNG = content.startsWith('iVBOR');
            const mime = isJPEG ? 'image/jpeg' : isPNG ? 'image/png' : 'image/png';
            return `data:${mime};base64,${content}`;
        }

        // URL
        if (content.startsWith('http')) return content;
    }

    // Format 4: Gemini inline parts
    const inlineData = data.choices?.[0]?.message?.parts?.[0]?.inlineData;
    if (inlineData?.data) {
        const mime = inlineData.mimeType || 'image/png';
        return `data:${mime};base64,${inlineData.data}`;
    }

    throw new Error('Could not parse image from response');
}

// ═══════════════════════════════════════════════════════════════
// MIME Type Auto-Detection (magic bytes)
// ═══════════════════════════════════════════════════════════════

function detectMimeType(base64Data: string): string | null {
    try {
        const rawBytes = atob(base64Data.substring(0, 16));
        const byte0 = rawBytes.charCodeAt(0);
        const byte1 = rawBytes.charCodeAt(1);

        if (byte0 === 0x89 && byte1 === 0x50) return 'image/png';      // \x89PNG
        if (byte0 === 0xFF && byte1 === 0xD8) return 'image/jpeg';     // \xFF\xD8
        if (byte0 === 0x52 && byte1 === 0x49) return 'image/webp';     // RIFF
        if (byte0 === 0x47 && byte1 === 0x49) return 'image/gif';      // GIF
    } catch { /* ignore */ }
    return null;
}

// ═══════════════════════════════════════════════════════════════
// Edit-Safe Model Validation
// ═══════════════════════════════════════════════════════════════

export function getEditSafeModel(requestedModel: string): string {
    if (IMPERIAL_IMAGE_EDIT_SUPPORTED_MODELS.has(requestedModel)) {
        return requestedModel;
    }
    return IMPERIAL_CONFIG.models.imageEdit;
}
