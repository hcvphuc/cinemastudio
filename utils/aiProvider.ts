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

    constructor(apiKey: string) {
        this.ai = new GoogleGenAI({ apiKey: apiKey.trim() });
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

        const genConfig: any = {};
        if (config?.temperature !== undefined) genConfig.temperature = config.temperature;
        if (config?.maxOutputTokens) genConfig.maxOutputTokens = config.maxOutputTokens;
        if (config?.topP !== undefined) genConfig.topP = config.topP;
        if (config?.topK !== undefined) genConfig.topK = config.topK;
        if (config?.responseMimeType) genConfig.responseMimeType = config.responseMimeType;
        if (config?.responseSchema) genConfig.responseSchema = config.responseSchema;
        if (config?.thinkingConfig) genConfig.thinkingConfig = config.thinkingConfig;

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

        const genConfig: any = {};
        if (config?.temperature !== undefined) genConfig.temperature = config.temperature;
        if (config?.maxOutputTokens) genConfig.maxOutputTokens = config.maxOutputTokens;
        if (config?.responseMimeType) genConfig.responseMimeType = config.responseMimeType;
        if (config?.responseSchema) genConfig.responseSchema = config.responseSchema;

        const response = await this.ai.models.generateContent({
            model,
            contents: [{ role: 'user', parts }],
            config: Object.keys(genConfig).length > 0 ? genConfig : undefined,
        });

        return {
            text: response.text || '',
            raw: response,
        };
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
    private baseURL = 'https://vertex-key.com/api/v1';

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

        const response = await fetch(`${this.baseURL}/chat/completions`, {
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

        const response = await fetch(`${this.baseURL}/chat/completions`, {
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
            // Use /models endpoint — lightweight and reliable
            const response = await fetch('https://vertex-key.com/api/v1/models', {
                headers: { 'Authorization': `Bearer ${apiKey.trim()}` },
            });
            if (response.status === 401 || response.status === 403) return false;
            if (response.ok) {
                const data = await response.json();
                return Array.isArray(data?.data) && data.data.length > 0;
            }
            // 502/503 = server issue, not key issue — still validate key format
            if (response.status >= 500) {
                // Key format check: must start with vai-
                return apiKey.trim().startsWith('vai-') && apiKey.trim().length > 10;
            }
            return false;
        } else {
            const provider = createProvider(type, apiKey);
            const result = await provider.generateText('Say "ok"', {
                model: 'gemini-2.5-flash',
                maxOutputTokens: 10,
            });
            return result.text.length > 0;
        }
    } catch {
        // For vertex-key, accept if format looks valid (server might be down)
        if (type === 'vertex-key') {
            return apiKey.trim().startsWith('vai-') && apiKey.trim().length > 10;
        }
        return false;
    }
}
