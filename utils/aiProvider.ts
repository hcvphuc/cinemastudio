/**
 * AI Provider Abstraction Layer
 * 
 * Supports multiple AI backends:
 * - Gemini Direct (@google/genai SDK)
 * - Vertex Key (OpenAI-compatible gateway at vertex-key.com)
 * 
 * Usage:
 *   const provider = getAIProvider();
 *   const text = await provider.generateText('Hello', { model: 'gemini-2.5-flash' });
 */

import { GoogleGenAI, Modality, Type } from "@google/genai";

// ═══════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════

export type ProviderType = 'gemini' | 'vertex-key';

export interface TextGenConfig {
    model?: string;
    temperature?: number;
    maxOutputTokens?: number;
    topP?: number;
    topK?: number;
    responseMimeType?: string;
    responseSchema?: any;
    thinkingConfig?: { thinkingBudget: number };
    systemInstruction?: string;
}

export interface TextGenResponse {
    text: string;
    raw?: any; // Original response object
}

export interface ImageGenResponse {
    imageBase64: string;
    mimeType: string;
    raw?: any;
}

export interface AIProvider {
    type: ProviderType;

    /** Generate text from a text prompt */
    generateText(
        prompt: string | { role: string; parts: any[] }[],
        config?: TextGenConfig
    ): Promise<TextGenResponse>;

    /** Generate text with image inputs (vision) */
    generateTextWithImages(
        prompt: string,
        imageDataParts: { inlineData: { data: string; mimeType: string } }[],
        config?: TextGenConfig
    ): Promise<TextGenResponse>;

    /** Generate image (if supported) */
    generateImage?(
        prompt: string,
        config?: TextGenConfig & { aspectRatio?: string }
    ): Promise<ImageGenResponse | null>;

    /** Get the raw SDK client (for advanced/legacy usage) */
    getRawClient(): any;
}

// ═══════════════════════════════════════════════════════════════
// Provider Configuration (persisted in localStorage)
// ═══════════════════════════════════════════════════════════════

export interface ProviderConfig {
    type: ProviderType;
    geminiApiKey: string;
    vertexKeyApiKey: string;
}

const STORAGE_KEYS = {
    providerType: 'aiProviderType',
    geminiApiKey: 'geminiApiKey',
    vertexKeyApiKey: 'vertexKeyApiKey',
};

export function getProviderConfig(): ProviderConfig {
    return {
        type: (localStorage.getItem(STORAGE_KEYS.providerType) as ProviderType) || 'gemini',
        geminiApiKey: localStorage.getItem(STORAGE_KEYS.geminiApiKey) || '',
        vertexKeyApiKey: localStorage.getItem(STORAGE_KEYS.vertexKeyApiKey) || '',
    };
}

export function setProviderConfig(config: Partial<ProviderConfig>): void {
    if (config.type) localStorage.setItem(STORAGE_KEYS.providerType, config.type);
    if (config.geminiApiKey !== undefined) localStorage.setItem(STORAGE_KEYS.geminiApiKey, config.geminiApiKey);
    if (config.vertexKeyApiKey !== undefined) localStorage.setItem(STORAGE_KEYS.vertexKeyApiKey, config.vertexKeyApiKey);
}

export function getActiveApiKey(): string {
    const config = getProviderConfig();
    return config.type === 'vertex-key' ? config.vertexKeyApiKey : config.geminiApiKey;
}

// ═══════════════════════════════════════════════════════════════
// Gemini Provider (wraps @google/genai)
// ═══════════════════════════════════════════════════════════════

class GeminiProvider implements AIProvider {
    type: ProviderType = 'gemini';
    private ai: GoogleGenAI;
    private apiKey: string;
    private proxyBaseUrl = '/api/proxy/gemini/handler';

    constructor(apiKey: string) {
        this.apiKey = apiKey.trim();
        this.ai = new GoogleGenAI({ apiKey: this.apiKey });
    }

    /**
     * Call Gemini via server-side proxy (avoids browser API key restrictions)
     */
    private async callViaProxy(model: string, body: any): Promise<any> {
        const path = `v1beta/models/${model}:generateContent`;
        const response = await fetch(`${this.proxyBaseUrl}?path=${encodeURIComponent(path)}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Goog-Api-Key': this.apiKey,
            },
            body: JSON.stringify(body),
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Gemini Proxy ${response.status}: ${errorText.substring(0, 200)}`);
        }

        return await response.json();
    }

    async generateText(
        prompt: string | { role: string; parts: any[] }[],
        config?: TextGenConfig
    ): Promise<TextGenResponse> {
        const model = config?.model || 'gemini-2.5-flash';

        // Build contents
        let contents: any;
        if (typeof prompt === 'string') {
            contents = [{ role: 'user', parts: [{ text: prompt }] }];
        } else {
            contents = prompt;
        }

        const generationConfig: any = {};
        if (config?.temperature !== undefined) generationConfig.temperature = config.temperature;
        if (config?.maxOutputTokens) generationConfig.maxOutputTokens = config.maxOutputTokens;
        if (config?.topP !== undefined) generationConfig.topP = config.topP;
        if (config?.topK !== undefined) generationConfig.topK = config.topK;
        if (config?.responseMimeType) generationConfig.responseMimeType = config.responseMimeType;
        if (config?.responseSchema) generationConfig.responseSchema = config.responseSchema;
        if (config?.thinkingConfig) generationConfig.thinkingConfig = config.thinkingConfig;

        // Try proxy first (avoids browser API key restrictions)
        try {
            const body: any = { contents };
            if (Object.keys(generationConfig).length > 0) body.generationConfig = generationConfig;
            if (config?.systemInstruction) {
                body.systemInstruction = { parts: [{ text: config.systemInstruction }] };
            }

            const data = await this.callViaProxy(model, body);
            const text = data.candidates?.[0]?.content?.parts
                ?.map((p: any) => p.text || '')
                .join('') || '';

            return { text, raw: data };
        } catch (proxyError: any) {
            console.warn(`[GeminiProvider] Proxy failed (${proxyError.message}), trying SDK direct...`);

            // Fallback to SDK direct (works if API key allows browser access)
            const genConfig: any = { ...generationConfig };
            const response = await this.ai.models.generateContent({
                model,
                contents,
                config: Object.keys(genConfig).length > 0 ? genConfig : undefined,
                ...(config?.systemInstruction ? { systemInstruction: config.systemInstruction } : {}),
            });

            return {
                text: response.text || '',
                raw: response,
            };
        }
    }

    async generateTextWithImages(
        prompt: string,
        imageDataParts: { inlineData: { data: string; mimeType: string } }[],
        config?: TextGenConfig
    ): Promise<TextGenResponse> {
        const model = config?.model || 'gemini-2.5-flash';

        const parts: any[] = [
            { text: prompt },
            ...imageDataParts,
        ];

        const generationConfig: any = {};
        if (config?.temperature !== undefined) generationConfig.temperature = config.temperature;
        if (config?.maxOutputTokens) generationConfig.maxOutputTokens = config.maxOutputTokens;
        if (config?.responseMimeType) generationConfig.responseMimeType = config.responseMimeType;
        if (config?.responseSchema) generationConfig.responseSchema = config.responseSchema;

        // Try proxy first
        try {
            const body: any = {
                contents: [{ role: 'user', parts }],
            };
            if (Object.keys(generationConfig).length > 0) body.generationConfig = generationConfig;

            const data = await this.callViaProxy(model, body);
            const text = data.candidates?.[0]?.content?.parts
                ?.map((p: any) => p.text || '')
                .join('') || '';

            return { text, raw: data };
        } catch (proxyError: any) {
            console.warn(`[GeminiProvider] Proxy failed for vision (${proxyError.message}), trying SDK...`);

            const response = await this.ai.models.generateContent({
                model,
                contents: [{ role: 'user', parts }],
                config: Object.keys(generationConfig).length > 0 ? generationConfig : undefined,
            });

            return {
                text: response.text || '',
                raw: response,
            };
        }
    }

    getRawClient(): GoogleGenAI {
        return this.ai;
    }
}

// ═══════════════════════════════════════════════════════════════
// Vertex Key Provider (OpenAI-compatible gateway)
// ═══════════════════════════════════════════════════════════════

// Map Gemini model names to vertex-key compatible model IDs
const VERTEX_KEY_MODEL_MAP: Record<string, string> = {
    // Text models
    'gemini-2.5-flash': 'flash/gemini-2.5-flash',
    'gemini-2.0-flash': 'flash/gemini-2.0-flash',
    'gemini-2.0-flash-exp': 'flash/gemini-2.0-flash',
    'gemini-3-pro-preview': 'pro/gemini-3-pro-preview',
    // Image models
    'gemini-3-pro-image-preview': 'pro/gemini-3-pro-image-preview',
    'gemini-3.1-flash-image-1k': 'flash/gemini-3.1-flash-image-1k',
    'gemini-3.1-flash-image-2k': 'flash/gemini-3.1-flash-image-2k',
    'gemini-3.1-flash-image-4k': 'flash/gemini-3.1-flash-image-4k',
};

function mapModelToVertexKey(geminiModel: string): string {
    return VERTEX_KEY_MODEL_MAP[geminiModel] || `flash/${geminiModel}`;
}

class VertexKeyProvider implements AIProvider {
    type: ProviderType = 'vertex-key';
    private apiKey: string;
    // Route through Vercel serverless proxy to avoid CORS
    private baseURL = '/api/proxy/imperial/handler';

    constructor(apiKey: string) {
        this.apiKey = apiKey.trim();
    }

    async generateText(
        prompt: string | { role: string; parts: any[] }[],
        config?: TextGenConfig
    ): Promise<TextGenResponse> {
        const model = mapModelToVertexKey(config?.model || 'gemini-2.5-flash');

        // Convert Gemini format → OpenAI format
        let messages: { role: string; content: any }[];
        if (typeof prompt === 'string') {
            messages = [{ role: 'user', content: prompt }];
        } else {
            messages = prompt.map(msg => ({
                role: msg.role === 'model' ? 'assistant' : msg.role,
                content: msg.parts.map((p: any) => p.text || '').join('\n'),
            }));
        }

        // Add system instruction if present
        if (config?.systemInstruction) {
            messages.unshift({ role: 'system', content: config.systemInstruction });
        }

        const body: any = {
            model,
            messages,
            temperature: config?.temperature ?? 0.7,
            max_tokens: config?.maxOutputTokens || 8192,
        };

        if (config?.topP !== undefined) body.top_p = config.topP;

        // Handle JSON mode
        if (config?.responseMimeType === 'application/json') {
            body.response_format = { type: 'json_object' };
        }

        const response = await fetch(`${this.baseURL}?path=chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${this.apiKey}`,
            },
            body: JSON.stringify(body),
        });

        if (!response.ok) {
            const error = await response.text();
            throw new Error(`Vertex Key API error (${response.status}): ${error}`);
        }

        const data = await response.json();
        const text = data.choices?.[0]?.message?.content || '';

        return { text, raw: data };
    }

    async generateTextWithImages(
        prompt: string,
        imageDataParts: { inlineData: { data: string; mimeType: string } }[],
        config?: TextGenConfig
    ): Promise<TextGenResponse> {
        const model = mapModelToVertexKey(config?.model || 'gemini-2.5-flash');

        // Build multimodal content (OpenAI vision format)
        const content: any[] = [{ type: 'text', text: prompt }];
        for (const img of imageDataParts) {
            content.push({
                type: 'image_url',
                image_url: {
                    url: `data:${img.inlineData.mimeType};base64,${img.inlineData.data}`,
                },
            });
        }

        const body: any = {
            model,
            messages: [{ role: 'user', content }],
            temperature: config?.temperature ?? 0.7,
            max_tokens: config?.maxOutputTokens || 8192,
        };

        const response = await fetch(`${this.baseURL}?path=chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${this.apiKey}`,
            },
            body: JSON.stringify(body),
        });

        if (!response.ok) {
            const error = await response.text();
            throw new Error(`Vertex Key API error (${response.status}): ${error}`);
        }

        const data = await response.json();
        const text = data.choices?.[0]?.message?.content || '';

        return { text, raw: data };
    }

    getRawClient(): null {
        return null; // No raw SDK client for REST-based provider
    }
}

// ═══════════════════════════════════════════════════════════════
// Factory
// ═══════════════════════════════════════════════════════════════

let cachedProvider: AIProvider | null = null;
let cachedProviderKey: string = '';

/**
 * Get the AI provider based on current settings.
 * Optionally override with a specific API key (for legacy compatibility).
 */
export function getAIProvider(apiKeyOverride?: string): AIProvider {
    const config = getProviderConfig();
    const apiKey = apiKeyOverride || getActiveApiKey();

    if (!apiKey) {
        throw new Error('No API key configured. Please set your API key in Settings.');
    }

    // Auto-detect provider type from key format when override is used
    // This prevents mismatches (e.g. Gemini key used with VertexKey provider)
    let providerType: ProviderType;
    if (apiKeyOverride) {
        // Detect from key format
        if (apiKeyOverride.startsWith('vai-')) {
            providerType = 'vertex-key';
        } else {
            providerType = 'gemini'; // AIza... or any other key = treat as Gemini Direct
        }
    } else {
        providerType = config.type;
    }

    const cacheKey = `${providerType}:${apiKey}`;
    if (cachedProvider && cachedProviderKey === cacheKey) {
        return cachedProvider;
    }

    switch (providerType) {
        case 'vertex-key':
            cachedProvider = new VertexKeyProvider(apiKey);
            break;
        case 'gemini':
        default:
            cachedProvider = new GeminiProvider(apiKey);
            break;
    }

    cachedProviderKey = cacheKey;
    console.log(`[AIProvider] Created ${providerType} provider (key: ${apiKey.substring(0, 8)}...)`);
    return cachedProvider;
}

/**
 * Get a fallback provider when the primary one fails.
 * If primary is vertex-key and a Gemini key exists → return GeminiProvider.
 * Returns null if no fallback is available.
 */
export function getFallbackProvider(): AIProvider | null {
    const config = getProviderConfig();

    // If primary is vertex-key, try Gemini Direct as fallback
    if (config.type === 'vertex-key' && config.geminiApiKey) {
        console.log('[AIProvider] ⚡ Falling back to Gemini Direct provider');
        return new GeminiProvider(config.geminiApiKey);
    }

    // If primary is gemini, try vertex-key as fallback
    if (config.type === 'gemini' && config.vertexKeyApiKey) {
        console.log('[AIProvider] ⚡ Falling back to Vertex Key provider');
        return new VertexKeyProvider(config.vertexKeyApiKey);
    }

    return null;
}

/**
 * Create a provider for a specific type (ignoring global settings).
 * Useful for testing or one-off calls.
 */
export function createProvider(type: ProviderType, apiKey: string): AIProvider {
    switch (type) {
        case 'vertex-key':
            return new VertexKeyProvider(apiKey);
        case 'gemini':
        default:
            return new GeminiProvider(apiKey);
    }
}

/**
 * Clear the cached provider (on logout or key change).
 */
export function clearProviderCache(): void {
    cachedProvider = null;
    cachedProviderKey = '';
}

/**
 * Validate an API key by making a minimal test call.
 * For vertex-key: uses /models endpoint (lightweight, always available).
 * For gemini: uses a minimal generateText call.
 */
export async function validateApiKey(type: ProviderType, apiKey: string): Promise<boolean> {
    try {
        if (type === 'vertex-key') {
            // Use /models endpoint via proxy — lightweight and reliable
            const response = await fetch('/api/proxy/imperial/handler?path=models', {
                headers: { 'Authorization': `Bearer ${apiKey.trim()}` },
            });
            if (response.status === 401 || response.status === 403) return false;
            if (response.ok) {
                const data = await response.json();
                return Array.isArray(data?.data) && data.data.length > 0;
            }
            // 502/503 = server issue, not key issue — still validate key format
            if (response.status >= 500) {
                return apiKey.trim().startsWith('vai-') && apiKey.trim().length > 10;
            }
            return false;
        } else {
            // Gemini Direct — validate by listing models (fast, no generation needed)
            const trimmedKey = apiKey.trim();

            // Format check first
            if (!trimmedKey.startsWith('AIza') || trimmedKey.length < 30) {
                return false;
            }

            // Try listing models — fastest validation
            try {
                const response = await fetch(
                    `https://generativelanguage.googleapis.com/v1beta/models?key=${trimmedKey}&pageSize=1`
                );
                if (response.ok) return true;
                if (response.status === 400 || response.status === 401 || response.status === 403) return false;
            } catch {
                // Network error — fall through to format-only validation
            }

            // If network fails, accept valid format
            return true;
        }
    } catch {
        // For vertex-key, accept if format looks valid (server might be down)
        if (type === 'vertex-key') {
            return apiKey.trim().startsWith('vai-') && apiKey.trim().length > 10;
        }
        // For Gemini, accept if format looks valid
        if (apiKey.trim().startsWith('AIza') && apiKey.trim().length > 30) {
            return true;
        }
        return false;
    }
}
