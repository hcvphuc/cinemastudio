
import { GoogleGenAI, Modality, Type } from "@google/genai";

const OUTPUT_MIME_TYPE = 'image/png';

const getAi = (apiKey: string) => {
    const trimmedKey = apiKey?.trim();
    if (!trimmedKey) {
        throw new Error("API_KEY is required for Gemini Image Generation.");
    }
    return new GoogleGenAI({ apiKey: trimmedKey });
};

export interface GeneratedImage {
    base64: string;
    mimeType: string;
}

// Helper: Delay function
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// Helper: Retry wrapper for transient errors (503, 429, etc.)
// Does NOT retry policy violations - content issues won't be fixed by retry
const withRetry = async <T>(
    fn: () => Promise<T>,
    operationName: string,
    maxRetries: number = 3
): Promise<T> => {
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            return await fn();
        } catch (error: any) {
            lastError = error;
            const errorMessage = String(error?.message || error).toLowerCase();

            // Check for POLICY VIOLATIONS - these should NOT be retried
            const isPolicyViolation =
                errorMessage.includes('policy') ||
                errorMessage.includes('safety') ||
                errorMessage.includes('blocked') ||
                errorMessage.includes('harmful') ||
                errorMessage.includes('inappropriate') ||
                errorMessage.includes('prohibited') ||
                errorMessage.includes('violation') ||
                errorMessage.includes('content filter') ||
                errorMessage.includes('nsfw') ||
                errorMessage.includes('sexual') ||
                errorMessage.includes('violence') ||
                errorMessage.includes('hate speech') ||
                errorMessage.includes('dangerous');

            if (isPolicyViolation) {
                console.log(`[${operationName}] ❌ Policy violation - NOT retrying:`, errorMessage.substring(0, 100));
                throw error;
            }

            // Check if it's a retryable transient error
            const isRetryable =
                errorMessage.includes('500') ||
                errorMessage.includes('503') ||
                errorMessage.includes('429') ||
                errorMessage.includes('overloaded') ||
                errorMessage.includes('unavailable') ||
                errorMessage.includes('internal') ||
                errorMessage.includes('resource_exhausted');

            if (!isRetryable || attempt === maxRetries) {
                throw error;
            }

            // Exponential backoff: 2s, 4s, 8s...
            const waitTime = Math.pow(2, attempt) * 1000;
            console.log(`[${operationName}] ⚠️ Attempt ${attempt}/${maxRetries} failed (transient). Retrying in ${waitTime / 1000}s...`);
            await delay(waitTime);
        }
    }

    throw lastError;
};

// Helper function to convert URL (including blob: URLs) to base64
const urlToBase64 = async (url: string): Promise<{ data: string; mimeType: string }> => {
    // Handle blob: URLs (from base64ToBlobUrl memory optimization)
    if (url.startsWith('blob:')) {
        const response = await fetch(url);
        const blob = await response.blob();
        const mimeType = blob.type || 'image/jpeg';
        const base64 = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onloadend = () => resolve((reader.result as string).split(',')[1]);
            reader.onerror = reject;
            reader.readAsDataURL(blob);
        });
        return { data: base64, mimeType };
    }

    const response = await fetch(url);
    if (!response.ok) throw new Error('Failed to fetch image from URL');
    const blob = await response.blob();
    const mimeType = blob.type || 'image/jpeg';
    const base64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve((reader.result as string).split(',')[1]);
        reader.onerror = reject;
        reader.readAsDataURL(blob);
    });
    return { data: base64, mimeType };
};

export const editImageWithMask = async (
    apiKey: string,
    base64ImageData: string,
    mimeType: string,
    base64MaskData: string,
    editPrompt: string,
    aspectRatio: string = "1:1",
    resolution: '1k' | '2k' | '4k' = '1k'
): Promise<GeneratedImage> => {
    try {
        const ai = getAi(apiKey);

        // Handle URL images by converting to Base64
        let imageData = base64ImageData;
        let imageMimeType = mimeType;

        if (base64ImageData && base64ImageData.startsWith('http')) {
            console.log('[EditMask] 🌐 Converting URL image to Base64...');
            const converted = await urlToBase64(base64ImageData);
            imageData = converted.data;
            imageMimeType = converted.mimeType;
        }

        if (!imageData || !base64MaskData) {
            throw new Error('Image data or mask data is missing.');
        }

        console.log("Sending to Gemini - Image Length:", imageData.length, "Mask Length:", base64MaskData.length);

        const cleanImage = imageData.includes(',') ? imageData.split(',')[1] : imageData;
        const cleanMask = base64MaskData.includes(',') ? base64MaskData.split(',')[1] : base64MaskData;

        const response = await ai.models.generateContent({
            model: 'gemini-3-pro-image-preview',
            contents: {
                parts: [
                    {
                        inlineData: {
                            data: cleanImage,
                            mimeType: imageMimeType,
                        },
                    },
                    {
                        inlineData: {
                            data: cleanMask,
                            mimeType: 'image/png', // Masks must be PNG
                        },
                    },
                    {
                        text: editPrompt,
                    },
                ],
            },
            config: {
                imageConfig: {
                    aspectRatio: aspectRatio,
                    imageSize: (resolution === '1k' ? '1K' : resolution === '2k' ? '2K' : '4K') as any
                }
            },
        });

        const imagePart = response.candidates?.[0]?.content?.parts?.find(p => p.inlineData);
        if (imagePart?.inlineData) {
            return {
                base64: imagePart.inlineData.data,
                mimeType: imagePart.inlineData.mimeType
            };
        }

        throw new Error("No edited image was returned from the API.");
    } catch (error) {
        console.error("Error editing image with mask:", error);
        throw new Error(`Failed to edit image. ${error instanceof Error ? error.message : String(error)}`);
    }
};

export const upscaleImage = async (
    apiKey: string,
    base64ImageData: string,
    mimeType: string,
    aspectRatio: string = "1:1",
    upscaleLevel: '1k' | '2k' | '4k' = '2k'
): Promise<GeneratedImage> => {
    try {
        const ai = getAi(apiKey);
        const cleanImage = base64ImageData.includes(',') ? base64ImageData.split(',')[1] : base64ImageData;

        const sizeMap: Record<string, string> = {
            '1k': '1K',
            '2k': '2K',
            '4k': '4K'
        };

        const response = await ai.models.generateContent({
            model: 'gemini-3-pro-image-preview',
            contents: {
                parts: [
                    {
                        inlineData: {
                            data: cleanImage,
                            mimeType: mimeType,
                        },
                    },
                    {
                        text: `Upscale this image to ${upscaleLevel.toUpperCase()} resolution. Dramatically increase the clarity, sharpen textures, and enhance intricate details while perfectly preserving the original character features and artistic style. The output should be a crisp, professional, high-definition version of the original.`,
                    },
                ],
            },
            config: {
                imageConfig: {
                    aspectRatio: aspectRatio,
                    imageSize: sizeMap[upscaleLevel] as any
                }
            },
        });

        const imagePart = response.candidates?.[0]?.content?.parts?.find(p => p.inlineData);
        if (imagePart?.inlineData) {
            return {
                base64: imagePart.inlineData.data,
                mimeType: imagePart.inlineData.mimeType
            };
        }

        throw new Error("No upscaled image was returned from the API.");
    } catch (error) {
        console.error("Error upscaling image:", error);
        throw new Error(`Failed to upscale image. ${error instanceof Error ? error.message : String(error)}`);
    }
};

export const expandImage = async (
    apiKey: string,
    base64ImageData: string,
    mimeType: string,
    direction: 'up' | 'down' | 'left' | 'right',
    aspectRatio: string = "1:1",
    resolution: '1k' | '2k' | '4k' = '1k'
): Promise<GeneratedImage> => {
    try {
        const ai = getAi(apiKey);
        const cleanImage = base64ImageData.includes(',') ? base64ImageData.split(',')[1] : base64ImageData;

        const response = await ai.models.generateContent({
            model: 'gemini-3-pro-image-preview',
            contents: {
                parts: [
                    {
                        inlineData: {
                            data: cleanImage,
                            mimeType: mimeType,
                        },
                    },
                    {
                        text: `Expand the image to the ${direction}, seamlessly filling in the new area with matching content and style (outpainting).`,
                    },
                ],
            },
            config: {
                imageConfig: {
                    aspectRatio: aspectRatio,
                    imageSize: (resolution === '1k' ? '1K' : resolution === '2k' ? '2K' : '4K') as any
                }
            },
        });

        const imagePart = response.candidates?.[0]?.content?.parts?.find(p => p.inlineData);
        if (imagePart?.inlineData) {
            return {
                base64: imagePart.inlineData.data,
                mimeType: imagePart.inlineData.mimeType
            };
        }

        throw new Error("No expanded image was returned from the API.");
    } catch (error) {
        console.error("Error expanding image:", error);
        throw new Error(`Failed to expand image. ${error instanceof Error ? error.message : String(error)}`);
    }
}

export const applyStyleTransfer = async (
    apiKey: string,
    baseImage: GeneratedImage,
    styleImage: GeneratedImage,
    prompt: string,
    aspectRatio: string = "1:1",
    resolution: '1k' | '2k' | '4k' = '1k'
): Promise<GeneratedImage> => {
    try {
        const ai = getAi(apiKey);
        const response = await ai.models.generateContent({
            model: 'gemini-3-pro-image-preview',
            contents: {
                parts: [
                    {
                        inlineData: {
                            data: baseImage.base64,
                            mimeType: baseImage.mimeType,
                        },
                    },
                    {
                        inlineData: {
                            data: styleImage.base64,
                            mimeType: styleImage.mimeType,
                        },
                    },
                    {
                        text: `Apply the artistic style from the second image to the first image. ${prompt}`,
                    },
                ],
            },
            config: {
                imageConfig: {
                    aspectRatio: aspectRatio,
                    imageSize: (resolution === '1k' ? '1K' : resolution === '2k' ? '2K' : '4K') as any
                }
            },
        });

        const imagePart = response.candidates?.[0]?.content?.parts?.find(p => p.inlineData);
        if (imagePart?.inlineData) {
            return {
                base64: imagePart.inlineData.data,
                mimeType: imagePart.inlineData.mimeType
            };
        }

        throw new Error("No style-transferred image was returned from the API.");
    } catch (error) {
        console.error("Error applying style transfer:", error);
        throw new Error(`Failed to apply style transfer. ${error instanceof Error ? error.message : String(error)}`);
    }
}

export const compositeImages = async (
    apiKey: string,
    baseImage: GeneratedImage,
    objectImage: GeneratedImage,
    prompt: string,
    aspectRatio: string = "1:1",
    resolution: '1k' | '2k' | '4k' = '1k'
): Promise<GeneratedImage> => {
    return withRetry(async () => {
        const ai = getAi(apiKey);
        const fullPrompt = `Use the first image as the base/background. Take the main subject from the second image and composite it into the first image based on the following instructions: "${prompt}". Seamlessly blend the lighting, shadows, and art style to make the composition look natural.`;
        const response = await ai.models.generateContent({
            model: 'gemini-3-pro-image-preview',
            contents: {
                parts: [
                    {
                        inlineData: {
                            data: baseImage.base64,
                            mimeType: baseImage.mimeType,
                        },
                    },
                    {
                        inlineData: {
                            data: objectImage.base64,
                            mimeType: objectImage.mimeType,
                        },
                    },
                    {
                        text: fullPrompt,
                    },
                ],
            },
            config: {
                imageConfig: {
                    aspectRatio: aspectRatio,
                    imageSize: (resolution === '1k' ? '1K' : resolution === '2k' ? '2K' : '4K') as any
                }
            },
        });

        const imagePart = response.candidates?.[0]?.content?.parts?.find(p => p.inlineData);
        if (imagePart?.inlineData) {
            return {
                base64: imagePart.inlineData.data,
                mimeType: imagePart.inlineData.mimeType
            };
        }

        throw new Error("No composited image was returned from the API.");
    }, 'CompositeImages', 3);
}

export const analyzeImage = async (apiKey: string, image: GeneratedImage): Promise<string[]> => {
    try {
        const ai = getAi(apiKey);
        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: [{
                parts: [
                    {
                        text: "Analyze the image and identify all distinct objects, characters, and key visual elements. Return your findings as a JSON array of short, descriptive strings in English. For example: ['A wizard with a white beard', 'Glowing crystal staff', 'Pointy blue hat', 'Dark cave background'].",
                    },
                    {
                        inlineData: {
                            data: image.base64,
                            mimeType: image.mimeType,
                        },
                    },
                ],
            }],
            config: {
                responseMimeType: 'application/json',
                responseSchema: {
                    type: Type.ARRAY,
                    items: {
                        type: Type.STRING
                    }
                }
            },
        });

        const text = response.text;
        const result = JSON.parse(text);
        if (!Array.isArray(result)) {
            throw new Error("API did not return a valid array.");
        }
        return result;
    } catch (error) {
        console.error("Error analyzing image:", error);
        throw new Error(`Failed to analyze image. ${error instanceof Error ? error.message : String(error)}`);
    }
};
export const generateImageFromImage = async (
    apiKey: string,
    base64ImageData: string,
    mimeType: string,
    prompt: string,
    aspectRatio: string = "1:1",
    resolution: '1k' | '2k' | '4k' = '1k'
): Promise<GeneratedImage> => {
    try {
        const ai = getAi(apiKey);
        const cleanImage = base64ImageData.includes(',') ? base64ImageData.split(',')[1] : base64ImageData;

        const response = await ai.models.generateContent({
            model: 'gemini-3-pro-image-preview',
            contents: {
                parts: [
                    {
                        inlineData: {
                            data: cleanImage,
                            mimeType: mimeType,
                        },
                    },
                    {
                        text: prompt,
                    },
                ],
            },
            config: {
                imageConfig: {
                    aspectRatio: aspectRatio,
                    imageSize: (resolution === '1k' ? '1K' : resolution === '2k' ? '2K' : '4K') as any
                }
            },
        });

        const imagePart = response.candidates?.[0]?.content?.parts?.find(p => p.inlineData);
        if (imagePart?.inlineData) {
            return {
                base64: imagePart.inlineData.data,
                mimeType: imagePart.inlineData.mimeType
            };
        }

        throw new Error("No image was returned from the API.");
    } catch (error) {
        console.error("Error generating image from image:", error);
        throw new Error(`Failed to generate image from reference. ${error instanceof Error ? error.message : String(error)}`);
    }
};

export const tryOnOutfit = async (
    apiKey: string,
    base64TargetImage: string,
    base64OutfitImage: string,
    base64MaskData: string | null,
    aspectRatio: string = "1:1",
    resolution: '1k' | '2k' | '4k' = '1k'
): Promise<GeneratedImage> => {
    try {
        const ai = getAi(apiKey);
        const cleanTarget = base64TargetImage.includes(',') ? base64TargetImage.split(',')[1] : base64TargetImage;
        const cleanOutfit = base64OutfitImage.includes(',') ? base64OutfitImage.split(',')[1] : base64OutfitImage;

        const parts: any[] = [
            {
                inlineData: {
                    data: cleanTarget,
                    mimeType: 'image/png',
                },
            },
            {
                inlineData: {
                    data: cleanOutfit,
                    mimeType: 'image/png',
                },
            }
        ];

        if (base64MaskData) {
            const cleanMask = base64MaskData.includes(',') ? base64MaskData.split(',')[1] : base64MaskData;
            parts.push({
                inlineData: {
                    data: cleanMask,
                    mimeType: 'image/png',
                },
            });
        }

        parts.push({
            text: `Virtually apply the outfit elements from the second image (corkboard) onto the person in the first image. ${base64MaskData ? "Carefully follow the painted mask for placement." : "Automatically determine the best placement for the clothes."} Maintain the character's features and overall composition. Generate a high-quality result.`
        });

        const response = await ai.models.generateContent({
            model: 'gemini-3-pro-image-preview',
            contents: { parts },
            config: {
                imageConfig: {
                    aspectRatio: aspectRatio,
                    imageSize: (resolution === '1k' ? '1K' : resolution === '2k' ? '2K' : '4K') as any
                }
            },
        });

        const imagePart = response.candidates?.[0]?.content?.parts?.find(p => p.inlineData);
        if (imagePart?.inlineData) {
            return {
                base64: imagePart.inlineData.data,
                mimeType: imagePart.inlineData.mimeType
            };
        }

        throw new Error("No image was returned from the API.");
    } catch (error) {
        console.error("Error in tryOnOutfit:", error);
        throw new Error(`Failed to try on outfit. ${error instanceof Error ? error.message : String(error)}`);
    }
};
