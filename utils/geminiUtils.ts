import { GoogleGenAI } from "@google/genai";
import {
    isImperialUltraEnabled,
    checkImperialHealth,
    callImperialText,
    callImperialImage,
    callImperialVision,
    getImperialKeySource,
    getImageFallbackChain,
} from './imperialUltraClient';

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// IMAGE CACHE - Avoids re-fetching same images during generation
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
const imageCache = new Map<string, { data: string; mimeType: string }>();
const CACHE_MAX_SIZE = 20; // Reduced from 100 to limit memory usage
const CACHE_TTL = 10 * 60 * 1000; // 10 minutes (reduced from 30 min)
const FETCH_TIMEOUT = 15000; // 15 second timeout for slow connections
let cacheTimestamp = Date.now();

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// PROVIDER COOLDOWN SYSTEM
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
const providerCooldowns: Record<string, { until: number; reason: string }> = {};
const COOLDOWN_RATE_LIMIT = 60000;   // 60s for rate limit errors
const COOLDOWN_HARD_ERROR = 300000;  // 5min for hard errors

function isProviderOnCooldown(provider: string): boolean {
    const cd = providerCooldowns[provider];
    if (!cd) return false;
    if (Date.now() > cd.until) {
        delete providerCooldowns[provider];
        return false;
    }
    return true;
}

function setCooldown(provider: string, error: string): void {
    const isRateLimit = error.includes('429') || error.includes('rate') || error.includes('quota');
    providerCooldowns[provider] = {
        until: Date.now() + (isRateLimit ? COOLDOWN_RATE_LIMIT : COOLDOWN_HARD_ERROR),
        reason: error.substring(0, 100)
    };
    console.warn(`[SmartRouter] â³ ${provider} on cooldown for ${isRateLimit ? '60s' : '5min'}: ${error.substring(0, 80)}`);
}

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// PROVIDER CACHE - Remembers which provider worked last
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
let cachedTextProvider: { provider: 'imperial' | 'gemini'; timestamp: number } | null = null;
const PROVIDER_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

/**
 * Convert base64 data to a Blob URL to save memory.
 * A base64 string for a 1024x1024 image is ~3-5MB in JS heap.
 * A Blob URL is just a ~50 byte string pointer - the binary data 
 * lives in browser blob storage (outside JS heap).
 */
export const base64ToBlobUrl = (base64Data: string, mimeType: string): string => {
    try {
        const byteCharacters = atob(base64Data);
        const byteNumbers = new Uint8Array(byteCharacters.length);
        for (let i = 0; i < byteCharacters.length; i++) {
            byteNumbers[i] = byteCharacters.charCodeAt(i);
        }
        const blob = new Blob([byteNumbers], { type: mimeType });
        return URL.createObjectURL(blob);
    } catch (e) {
        console.warn('[base64ToBlobUrl] Failed to convert, returning data URI');
        return `data:${mimeType};base64,${base64Data}`;
    }
};

/**
 * Compress a base64 image to JPEG using Canvas API.
 * PNG ~3-5MB → JPEG 95% ~400-700KB (near-invisible quality loss).
 * Returns a Blob URL for memory efficiency.
 */
export const compressToJpeg = (base64Data: string, mimeType: string, quality: number = 0.95): Promise<string> => {
    return new Promise((resolve) => {
        try {
            const img = new Image();
            img.onload = () => {
                const canvas = document.createElement('canvas');
                canvas.width = img.naturalWidth;
                canvas.height = img.naturalHeight;
                const ctx = canvas.getContext('2d');
                if (!ctx) {
                    console.warn('[Compress] Canvas context failed, using toDataURL fallback');
                    // Fallback: try simple data URL conversion
                    try {
                        const c2 = document.createElement('canvas');
                        c2.width = img.naturalWidth;
                        c2.height = img.naturalHeight;
                        const ctx2 = c2.getContext('2d');
                        if (ctx2) {
                            ctx2.drawImage(img, 0, 0);
                            resolve(c2.toDataURL('image/jpeg', quality));
                            return;
                        }
                    } catch (e) { /* fall through */ }
                    resolve(base64ToBlobUrl(base64Data, 'image/jpeg'));
                    return;
                }
                // High-quality rendering
                ctx.imageSmoothingEnabled = true;
                ctx.imageSmoothingQuality = 'high';
                ctx.drawImage(img, 0, 0);
                canvas.toBlob(
                    (blob) => {
                        if (blob) {
                            const originalSize = Math.round(base64Data.length * 0.75 / 1024); // approx KB
                            const compressedSize = Math.round(blob.size / 1024);
                            console.log(`[Compress] 📦 ${originalSize}KB → ${compressedSize}KB (JPEG ${Math.round(quality * 100)}%) — ${Math.round((1 - compressedSize / originalSize) * 100)}% reduction`);
                            resolve(URL.createObjectURL(blob));
                        } else {
                            // toBlob returned null — try toDataURL as fallback (still JPEG)
                            console.warn('[Compress] toBlob returned null, trying toDataURL fallback');
                            try {
                                const dataUrl = canvas.toDataURL('image/jpeg', quality);
                                resolve(dataUrl);
                            } catch (e) {
                                console.warn('[Compress] toDataURL also failed, returning original as JPEG blob');
                                resolve(base64ToBlobUrl(base64Data, 'image/jpeg'));
                            }
                        }
                    },
                    'image/jpeg',
                    quality
                );
            };
            img.onerror = () => {
                console.warn('[Compress] Image load failed, returning original as JPEG blob');
                // Still mark as JPEG so downstream consumers handle it correctly
                resolve(base64ToBlobUrl(base64Data, 'image/jpeg'));
            };
            img.src = `data:${mimeType};base64,${base64Data}`;
        } catch (e) {
            console.warn('[Compress] Error, returning original as JPEG blob');
            resolve(base64ToBlobUrl(base64Data, 'image/jpeg'));
        }
    });
};


// Clear cache if too old
const checkCacheExpiry = () => {
    if (Date.now() - cacheTimestamp > CACHE_TTL) {
        imageCache.clear();
        cacheTimestamp = Date.now();
        console.log('[ImageCache] ðŸ—‘ï¸ Cache cleared (TTL expired)');
    }
};

/**
 * Fix MIME type for APIs that reject 'application/octet-stream'
 * Gemini AI and Veo require valid image MIME types
 * @param mimeType - The original MIME type from blob.type
 * @param urlOrFilename - Optional URL or filename to infer type from extension
 * @returns Valid image MIME type
 */
export const fixMimeType = (mimeType: string | undefined, urlOrFilename?: string): string => {
    // If valid MIME type, return as is
    if (mimeType && mimeType.startsWith('image/') && mimeType !== 'application/octet-stream') {
        return mimeType;
    }

    // Try to infer from URL/filename extension
    if (urlOrFilename) {
        const ext = urlOrFilename.split('?')[0].split('.').pop()?.toLowerCase();
        if (ext === 'png') return 'image/png';
        if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
        if (ext === 'webp') return 'image/webp';
        if (ext === 'gif') return 'image/gif';
    }

    // Default fallback
    console.warn(`[fixMimeType] âš ï¸ Fixed invalid MIME: '${mimeType}' -> 'image/jpeg'`);
    return 'image/jpeg';
};

// Helper: Fetch with timeout
const fetchWithTimeout = async (url: string, timeout: number): Promise<Response> => {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeout);
    try {
        const response = await fetch(url, { signal: controller.signal });
        clearTimeout(id);
        return response;
    } catch (error) {
        clearTimeout(id);
        throw error;
    }
};

// Helper function to safely extract base64 data from both URL and base64 images
// WITH CACHING to avoid duplicate fetches
export const safeGetImageData = async (imageStr: string): Promise<{ data: string; mimeType: string } | null> => {
    if (!imageStr) return null;

    // Check cache first
    checkCacheExpiry();
    if (imageCache.has(imageStr)) {
        console.log('[ImageCache] âš¡ Cache hit');
        return imageCache.get(imageStr)!;
    }

    try {
        let result: { data: string; mimeType: string } | null = null;

        if (imageStr.startsWith('data:')) {
            const mimeType = imageStr.substring(5, imageStr.indexOf(';'));
            const data = imageStr.split('base64,')[1];
            result = { data, mimeType };
        } else if (imageStr.startsWith('blob:')) {
            // Handle Blob URLs - fetch the blob and convert to base64 for API use
            const response = await fetchWithTimeout(imageStr, FETCH_TIMEOUT);
            const blob = await response.blob();
            let mimeType = blob.type;
            if (!mimeType || mimeType === 'application/octet-stream') {
                mimeType = 'image/png';
            }
            result = await new Promise((resolve) => {
                const reader = new FileReader();
                reader.onloadend = () => resolve({
                    data: (reader.result as string).split(',')[1],
                    mimeType
                });
                reader.readAsDataURL(blob);
            });
        } else if (imageStr.startsWith('http')) {
            const startTime = Date.now();
            const response = await fetchWithTimeout(imageStr, FETCH_TIMEOUT);
            if (!response.ok) throw new Error('Failed to fetch image');
            const blob = await response.blob();
            let mimeType = blob.type;

            // [FIX] Gemini API rejects 'application/octet-stream'. We must enforce a valid image MIME type.
            if (!mimeType || mimeType === 'application/octet-stream') {
                // Try to infer from URL file extension
                const extension = imageStr.split('?')[0].split('.').pop()?.toLowerCase();
                if (extension === 'jpg' || extension === 'jpeg') mimeType = 'image/jpeg';
                else if (extension === 'webp') mimeType = 'image/webp';
                else mimeType = 'image/png'; // Default fallback

                console.warn(`[ImageCache] âš ï¸ MIME type fix: '${blob.type}' -> '${mimeType}' for ${imageStr.substring(0, 50)}...`);
            }
            result = await new Promise((resolve) => {
                const reader = new FileReader();
                reader.onloadend = () => resolve({
                    data: (reader.result as string).split(',')[1],
                    mimeType
                });
                reader.readAsDataURL(blob);
            });
            console.log(`[ImageCache] ðŸ“¥ Fetched in ${Date.now() - startTime}ms`);
        }

        // Store in cache
        if (result) {
            if (imageCache.size >= CACHE_MAX_SIZE) {
                // Remove oldest entry
                const firstKey = imageCache.keys().next().value;
                if (firstKey) imageCache.delete(firstKey);
            }
            imageCache.set(imageStr, result);
        }

        return result;
    } catch (error) {
        console.error('Error in safeGetImageData:', error);
        return null;
    }
};

// Pre-warm cache with multiple images in parallel
// Call this when loading a project to speed up first generation
export const preWarmImageCache = async (imageUrls: string[]): Promise<number> => {
    const startTime = Date.now();
    const uniqueUrls = [...new Set(imageUrls.filter(Boolean))];

    if (uniqueUrls.length === 0) return 0;

    console.log(`[ImageCache] ðŸ”¥ Pre-warming cache with ${uniqueUrls.length} images...`);

    const results = await Promise.allSettled(
        uniqueUrls.map(url => safeGetImageData(url))
    );

    const successCount = results.filter(r => r.status === 'fulfilled' && r.value !== null).length;
    console.log(`[ImageCache] âœ… Pre-warmed ${successCount}/${uniqueUrls.length} images in ${Date.now() - startTime}ms`);

    return successCount;
};

// Export cache clear function for manual clearing
export const clearImageCache = () => {
    imageCache.clear();
    cacheTimestamp = Date.now();
    console.log('[ImageCache] ðŸ—‘ï¸ Cache manually cleared');
};

// Get cache stats for debugging
export const getCacheStats = () => ({
    size: imageCache.size,
    maxSize: CACHE_MAX_SIZE,
    ttlMinutes: CACHE_TTL / 60000,
    ageMinutes: Math.round((Date.now() - cacheTimestamp) / 60000)
});

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// GEMINI DIRECT IMAGE GENERATION (original, unchanged)
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

export const callGeminiAPI = async (
    apiKey: string,
    prompt: string,
    aspectRatio: string,
    imageModel: string = 'gemini-3-pro-image-preview',
    imageContext: string | null = null
): Promise<string | null> => {
    const trimmedKey = apiKey?.trim();
    if (!trimmedKey) {
        console.error('[Gemini Gen] âŒ No API key provided');
        return null;
    }

    // Validate and map model names
    let finalModel = imageModel;
    if (imageModel === 'gemini-2.0-flash') {
        finalModel = 'gemini-2.0-flash-preview-image-generation';
    }

    console.log('[Gemini Gen] ðŸŽ¨ Calling Gemini API...', {
        model: finalModel,
        aspectRatio,
        hasContext: !!imageContext,
        promptLength: prompt.length
    });

    try {
        const ai = new GoogleGenAI({ apiKey: trimmedKey });
        const parts: any[] = [];

        if (imageContext) {
            console.log('[Gemini Gen] ðŸ“Ž Processing Reference Image...');
            const contextData = await safeGetImageData(imageContext);
            if (contextData) {
                console.log('[Gemini Gen] âœ… Reference image loaded:', contextData.mimeType);
                parts.push({ inlineData: { data: contextData.data, mimeType: contextData.mimeType } });
            } else {
                console.error('[Gemini Gen] âŒ Failed to load reference image!');
            }
        }

        parts.push({ text: prompt });

        const response = await ai.models.generateContent({
            model: finalModel,
            contents: { parts: parts },
            config: {
                responseModalities: ['IMAGE'],
                imageConfig: {
                    aspectRatio: aspectRatio
                }
            }
        });

        const imagePart = response.candidates?.[0]?.content?.parts?.find(p => p.inlineData);
        if (imagePart?.inlineData) {
            console.log('[Gemini Gen] âœ… Image generated successfully!');
            // Convert to Blob URL to save memory (from ~3MB base64 string to ~50 byte pointer)
            return base64ToBlobUrl(imagePart.inlineData.data, imagePart.inlineData.mimeType);
        }

        console.error('[Gemini Gen] âŒ No image in response:', response);
        return null;
    } catch (err: any) {
        console.error('[Gemini Gen] âŒ Error:', err.message, err);
        return null;
    }
};

export interface TextGenerationResult {
    text: string;
    tokenUsage?: {
        promptTokens: number;
        candidateTokens: number;
        totalTokens: number;
    };
}

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// SMART TEXT GENERATION â€” Imperial â†’ Gemini Direct
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

export const callGeminiText = async (
    apiKey: string,
    prompt: string,
    systemPrompt: string = '',
    model: string = 'gemini-2.5-flash',
    jsonMode: boolean = false
): Promise<string> => {
    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
    // SMART ROUTING: Try Imperial Ultra first, then Gemini Direct
    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

    // Check cached provider first
    if (cachedTextProvider && Date.now() - cachedTextProvider.timestamp < PROVIDER_CACHE_TTL) {
        const cached = cachedTextProvider.provider;
        if (cached === 'imperial' && isImperialUltraEnabled() && !isProviderOnCooldown('imperial')) {
            try {
                console.log('[SmartText] âš¡ Using cached provider: Imperial Ultra');
                const result = await callImperialText(prompt, {
                    systemPrompt,
                    jsonMode,
                });
                return result;
            } catch (error: any) {
                setCooldown('imperial', error.message);
                cachedTextProvider = null;
            }
        }
    }

    // Try Imperial Ultra (if enabled and healthy)
    if (isImperialUltraEnabled() && !isProviderOnCooldown('imperial')) {
        try {
            const isHealthy = await checkImperialHealth();
            if (isHealthy) {
                console.log('[SmartText] ðŸ‘‘ Trying Imperial Ultra...');
                const result = await callImperialText(prompt, {
                    systemPrompt,
                    jsonMode,
                });
                cachedTextProvider = { provider: 'imperial', timestamp: Date.now() };
                return result;
            }
        } catch (error: any) {
            setCooldown('imperial', error.message);
            console.warn(`[SmartText] âš ï¸ Imperial failed: ${error.message}, falling back to Gemini...`);
        }
    }

    // Fallback: Gemini Direct (original logic)
    const trimmedKey = apiKey?.trim();
    if (!trimmedKey) throw new Error('Missing API Key');

    try {
        console.log('[SmartText] ðŸ’Ž Using Gemini Direct');
        const ai = new GoogleGenAI({ apiKey: trimmedKey });

        const response = await ai.models.generateContent({
            model: model,
            contents: [{
                role: 'user',
                parts: [{ text: `${systemPrompt}\n\nUSER COMMAND: ${prompt}` }]
            }],
            config: jsonMode ? { responseMimeType: "application/json" } : {}
        });

        // Log token usage if available
        const usage = response.usageMetadata;
        if (usage) {
            console.log('[Gemini Text] Token Usage:', {
                prompt: usage.promptTokenCount,
                candidates: usage.candidatesTokenCount,
                total: usage.totalTokenCount
            });
            // Store in global for tracking (will be picked up by syncUserStatsToCloud)
            (window as any).__lastTextTokenUsage = {
                promptTokens: usage.promptTokenCount || 0,
                candidateTokens: usage.candidatesTokenCount || 0,
                totalTokens: usage.totalTokenCount || 0
            };
        }

        const text = response.candidates?.[0]?.content?.parts?.[0]?.text;
        if (!text) {
            console.warn('[Gemini Text] âš ï¸ Empty response text (check candidate blocked?)');
            return '';
        }
        cachedTextProvider = { provider: 'gemini', timestamp: Date.now() };
        return text;
    } catch (err: any) {
        console.error('[Gemini Text] âŒ Error:', err.message);
        throw err;
    }
};

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// SMART VISION â€” Imperial â†’ Gemini Direct
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

export const callGeminiVisionReasoning = async (
    apiKey: string,
    prompt: string,
    images: { data: string; mimeType: string }[],
    model: string = 'gemini-2.5-flash', // Gemini 3 Standard
): Promise<string> => {
    // Try Imperial Ultra first (if enabled and not on cooldown)
    if (isImperialUltraEnabled() && !isProviderOnCooldown('imperial')) {
        try {
            const isHealthy = await checkImperialHealth();
            if (isHealthy) {
                console.log('[SmartVision] ðŸ‘‘ Trying Imperial Ultra Vision...');
                const result = await callImperialVision(prompt, images, undefined, {
                    jsonMode: true,
                    maxTokens: 4096,
                    temperature: 0.4
                });
                return result;
            }
        } catch (error: any) {
            setCooldown('imperial', error.message);
            console.warn(`[SmartVision] âš ï¸ Imperial failed: ${error.message}, falling back to Gemini...`);
        }
    }

    // Fallback: Gemini Direct (original logic)
    const trimmedKey = apiKey?.trim();
    if (!trimmedKey) throw new Error('Missing API Key');

    try {
        console.log('[SmartVision] ðŸ’Ž Using Gemini Direct Vision');
        const ai = new GoogleGenAI({ apiKey: trimmedKey });

        const parts: any[] = [{ text: prompt }];

        // Add all images
        images.forEach(img => {
            parts.push({ inlineData: { data: img.data, mimeType: img.mimeType } });
        });

        const response = await ai.models.generateContent({
            model: model,
            contents: [{ parts: parts }],
        });

        const text = response.candidates?.[0]?.content?.parts?.[0]?.text;
        return text || '';
    } catch (err: any) {
        console.error('[Gemini Vision] âŒ Reasoning Error:', err.message);
        throw err;
    }
};

// Import GommoAI if needed for callCharacterImageAPI
import { GommoAI, urlToBase64 } from './gommoAI';
import { IMAGE_MODELS } from './appConstants';

/**
 * Character Image API with Smart Routing
 * Priority: Imperial Ultra â†’ Gemini Direct â†’ Gommo
 * Used for Lora generation (Face ID, Body sheets)
 */
export const callCharacterImageAPI = async (
    apiKey: string | null,
    prompt: string,
    aspectRatio: string,
    imageModel: string = 'gemini-3-pro-image-preview',
    imageContext: string | null = null,
    gommoCredentials?: { domain: string; accessToken: string }
): Promise<string | null> => {
    // Determine provider from model
    const model = IMAGE_MODELS.find(m => m.value === imageModel);
    let provider = model?.provider || 'gemini';

    // Force 'imperial' for all vertex-key.com prefixed models
    const vertexPrefixes = ['gem/', 'imy/', 'ima/', 'imi/', 'imr/', 'imp/'];
    if (vertexPrefixes.some(p => imageModel.startsWith(p)) || imageModel.startsWith('gemini-image-')) {
        provider = 'imperial';
    }

    // If it's a Google model being used via Gommo Proxy
    if (provider === 'google' && gommoCredentials?.domain && gommoCredentials?.accessToken) {
        provider = 'gommo';
    }

    console.log(`[CharacterGen] Provider: ${provider}, Model: ${imageModel}`);

    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
    // ðŸ‘‘ IMPERIAL ULTRA PATH - Premium Character Generation
    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
    if (provider === 'imperial') {
        console.log('[CharacterGen] â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”');
        console.log('[CharacterGen] ðŸ‘‘ Using IMPERIAL ULTRA provider');

        if (isImperialUltraEnabled()) {
            const isHealthy = await checkImperialHealth();
            if (isHealthy) {
                // Auto-fallback: try primary model â†’ then fallback tiers
                const fallbackChain = getImageFallbackChain(imageModel);
                const modelsToTry = [imageModel, ...fallbackChain];
                const errors: string[] = [];

                for (let i = 0; i < modelsToTry.length; i++) {
                    const currentModel = modelsToTry[i];
                    const tierLabel = i === 0 ? '(primary)' : `(fallback #${i})`;

                    try {
                        const keySource = getImperialKeySource();
                        console.log(`[CharacterGen] ðŸ‘‘ Imperial Character Request ${tierLabel}:`);
                        console.log(`  â”œâ”€ Model: ${currentModel}`);
                        console.log(`  â”œâ”€ Key Source: ${keySource.toUpperCase()}`);
                        console.log(`  â”œâ”€ Aspect Ratio: ${aspectRatio}`);
                        console.log(`  â””â”€ Prompt: ${prompt.substring(0, 60)}...`);

                        const result = await callImperialImage(prompt, {
                            model: currentModel,
                            aspectRatio: aspectRatio,
                            imageContext: imageContext
                        });

                        if (result.base64) {
                            if (i > 0) console.log(`[CharacterGen] ðŸ‘‘ âœ… Fallback SUCCESS with ${currentModel}`);
                            else console.log('[CharacterGen] ðŸ‘‘ âœ… Imperial character generated (base64)');
                            console.log('[CharacterGen] â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”');
                            return result.base64;
                        } else if (result.url) {
                            if (i > 0) console.log(`[CharacterGen] ðŸ‘‘ âœ… Fallback SUCCESS with ${currentModel}`);
                            else console.log('[CharacterGen] ðŸ‘‘ âœ… Imperial character generated (URL)');
                            const base64 = await urlToBase64(result.url);
                            console.log('[CharacterGen] â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”');
                            return base64;
                        }
                        throw new Error('No image in Imperial response');
                    } catch (error: any) {
                        const errMsg = error.message || String(error);
                        errors.push(`${currentModel}: ${errMsg}`);

                        const isRetryable = errMsg.includes('429') || errMsg.includes('503') ||
                            errMsg.includes('502') || errMsg.includes('queue') ||
                            errMsg.includes('RESOURCE_EXHAUSTED') || errMsg.includes('overloaded') ||
                            errMsg.includes('rate') || errMsg.includes('capacity');

                        if (isRetryable && i < modelsToTry.length - 1) {
                            console.warn(`[CharacterGen] âš ï¸ ${currentModel} failed (${errMsg.substring(0, 60)}) â†’ trying next tier...`);
                            continue;
                        }

                        console.error('[CharacterGen] ðŸ‘‘ âŒ Imperial failed:', errMsg);
                        console.log('[CharacterGen] ðŸ“‰ All tiers exhausted, falling back to Gemini/Gommo...');
                    }
                }
            } else {
                console.warn('[CharacterGen] âš ï¸ Imperial Ultra unhealthy, falling back...');
            }
        } else {
            console.warn('[CharacterGen] âš ï¸ Imperial Ultra disabled, falling back...');
        }
        console.log('[CharacterGen] â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”');
        // Fall through to Gemini/Gommo
    }

    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
    // GOMMO PATH
    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
    if (provider === 'gommo') {
        // STRICT CHECK: Only use Gommo if provider is explicitly Gommo
        if (gommoCredentials?.domain && gommoCredentials?.accessToken) {
            console.log('[CharacterGen] ðŸŸ¡ Using GOMMO provider');
            try {
                const client = new GommoAI(gommoCredentials.domain, gommoCredentials.accessToken);
                const gommoRatio = GommoAI.convertRatio(aspectRatio);

                // Prepare subjects if imageContext provided
                const subjects: Array<{ data?: string }> = [];
                if (imageContext) {
                    let base64Data = '';
                    if (imageContext.startsWith('data:')) {
                        base64Data = imageContext.split(',')[1] || '';
                    } else if (imageContext.startsWith('http')) {
                        const fetched = await urlToBase64(imageContext);
                        base64Data = fetched.split(',')[1] || '';
                    }
                    if (base64Data) {
                        subjects.push({ data: base64Data });
                    }
                }

                const cdnUrl = await client.generateImage(prompt, {
                    ratio: gommoRatio,
                    model: imageModel,
                    subjects: subjects.length > 0 ? subjects : undefined,
                    onProgress: (status, attempt) => {
                        console.log(`[CharacterGen] Polling ${attempt}/60: ${status}`);
                    }
                });

                // Convert CDN URL to blob URL for memory efficiency
                const base64Image = await urlToBase64(cdnUrl);
                console.log('[CharacterGen] âœ… Gommo image generated successfully');
                // Convert base64 dataURI to blob URL to save RAM
                if (base64Image.startsWith('data:')) {
                    const match = base64Image.match(/^data:([^;]+);base64,(.+)$/);
                    if (match) {
                        return base64ToBlobUrl(match[2], match[1]);
                    }
                }
                return base64Image;
            } catch (error: any) {
                console.error('[CharacterGen] âŒ Gommo error:', error.message);
                throw error;
            }
        } else {
            // Gommo selected but no creds
            console.error('[CharacterGen] âŒ Gommo model selected but credentials missing!');
            throw new Error('Gommo credentials chÆ°a Ä‘Æ°á»£c cáº¥u hÃ¬nh. VÃ o Profile â†’ Gommo AI Ä‘á»ƒ nháº­p Domain vÃ  Access Token.');
        }
    }

    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
    // GEMINI PATH (Default or fallback)
    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
    if (!apiKey?.trim()) {
        console.error('[CharacterGen] âŒ No API key');
        return null;
    }

    console.log('[CharacterGen] ðŸ”µ Using GEMINI provider');
    return callGeminiAPI(apiKey, prompt, aspectRatio, imageModel, imageContext);
};

