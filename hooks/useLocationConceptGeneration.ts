/**
 * useLocationConceptGeneration Hook
 * 
 * Generates concept art for detected locations in batch.
 * Uses the image generation pipeline with location-specific prompts.
 */

import { useState, useCallback, useRef } from 'react';
import { GoogleGenAI } from "@google/genai";
import { Location } from '../types';
import { LocationAnalysis } from './useScriptAnalysis';
import { base64ToBlobUrl } from '../utils/geminiUtils';

interface GenerationProgress {
    current: number;
    total: number;
    currentLocationName: string;
    status: 'idle' | 'generating' | 'complete' | 'error';
    completedIds: string[];
    failedIds: string[];
    error?: string;
}

interface GenerationResult {
    locationId: string;
    conceptImage: string | null;
    success: boolean;
    error?: string;
}

export function useLocationConceptGeneration(apiKey: string | null) {
    const [progress, setProgress] = useState<GenerationProgress>({
        current: 0,
        total: 0,
        currentLocationName: '',
        status: 'idle',
        completedIds: [],
        failedIds: []
    });

    const abortRef = useRef(false);

    /**
     * Generate concept arts for multiple locations
     */
    const generateLocationConcepts = useCallback(async (
        locations: LocationAnalysis[],
        options: {
            globalStyle?: string;
            directorDna?: string;
            aspectRatio?: string;
            onProgress?: (progress: GenerationProgress) => void;
            onLocationComplete?: (result: GenerationResult) => void;
        } = {}
    ): Promise<Location[]> => {
        if (!apiKey) {
            throw new Error('API key required');
        }

        const {
            globalStyle = '',
            directorDna = '',
            aspectRatio = '16:9',
            onProgress,
            onLocationComplete
        } = options;

        abortRef.current = false;

        const results: Location[] = [];
        const completedIds: string[] = [];
        const failedIds: string[] = [];

        // Update progress
        const updateProgress = (updates: Partial<GenerationProgress>) => {
            setProgress(prev => {
                const next = { ...prev, ...updates };
                onProgress?.(next);
                return next;
            });
        };

        updateProgress({
            total: locations.length,
            current: 0,
            status: 'generating',
            completedIds: [],
            failedIds: []
        });

        const ai = new GoogleGenAI({ apiKey });

        for (let i = 0; i < locations.length; i++) {
            if (abortRef.current) {
                console.log('[LocationConcept] Generation aborted');
                break;
            }

            const location = locations[i];

            updateProgress({
                current: i + 1,
                currentLocationName: location.name
            });

            console.log(`[LocationConcept] Generating ${i + 1}/${locations.length}: ${location.name}`);

            try {
                // Build the concept prompt with style tokens
                const fullPrompt = buildConceptPrompt(location, globalStyle, directorDna);

                // Generate using Gemini Imagen
                const response = await ai.models.generateImages({
                    model: 'imagen-3.0-generate-002',
                    prompt: fullPrompt,
                    config: {
                        numberOfImages: 1,
                        aspectRatio: aspectRatio as any,
                        personGeneration: 'DONT_ALLOW' as any // No people in concept art
                    }
                });

                const imageData = response.generatedImages?.[0]?.image?.imageBytes;

                if (!imageData) {
                    throw new Error('No image generated');
                }

                const base64Image = base64ToBlobUrl(imageData, 'image/webp');

                // Create Location entity
                const newLocation: Location = {
                    id: location.id,
                    name: location.name,
                    description: location.description,
                    conceptImage: base64Image,
                    keywords: location.keywords,
                    createdAt: new Date().toISOString(),
                    usageCount: location.chapterIds.length
                };

                results.push(newLocation);
                completedIds.push(location.id);

                onLocationComplete?.({
                    locationId: location.id,
                    conceptImage: base64Image,
                    success: true
                });

                console.log(`[LocationConcept] ✅ Generated: ${location.name}`);

                // Delay between generations to avoid rate limits
                if (i < locations.length - 1) {
                    await new Promise(resolve => setTimeout(resolve, 1000));
                }

            } catch (error: any) {
                console.error(`[LocationConcept] ❌ Failed ${location.name}:`, error);

                failedIds.push(location.id);

                // Still create location but without concept
                const failedLocation: Location = {
                    id: location.id,
                    name: location.name,
                    description: location.description,
                    conceptImage: null,
                    keywords: location.keywords,
                    createdAt: new Date().toISOString(),
                    usageCount: location.chapterIds.length
                };

                results.push(failedLocation);

                onLocationComplete?.({
                    locationId: location.id,
                    conceptImage: null,
                    success: false,
                    error: error.message
                });

                // Continue with next location (don't stop on error)
            }

            updateProgress({ completedIds, failedIds });
        }

        updateProgress({
            status: 'complete',
            completedIds,
            failedIds
        });

        console.log(`[LocationConcept] Complete: ${completedIds.length} succeeded, ${failedIds.length} failed`);

        return results;
    }, [apiKey]);

    /**
     * Abort ongoing generation
     */
    const abortGeneration = useCallback(() => {
        abortRef.current = true;
    }, []);

    /**
     * Reset progress state
     */
    const resetProgress = useCallback(() => {
        setProgress({
            current: 0,
            total: 0,
            currentLocationName: '',
            status: 'idle',
            completedIds: [],
            failedIds: []
        });
    }, []);

    return {
        progress,
        generateLocationConcepts,
        abortGeneration,
        resetProgress
    };
}

/**
 * Build a concept art prompt for a location
 */
function buildConceptPrompt(
    location: LocationAnalysis,
    globalStyle: string = '',
    directorDna: string = ''
): string {
    const parts: string[] = [];

    // Start with the location's concept prompt
    parts.push(location.conceptPrompt);

    // Add style tokens
    if (globalStyle) {
        parts.push(`Style: ${globalStyle}`);
    }

    if (directorDna) {
        parts.push(`Cinematography: ${directorDna}`);
    }

    // Add environment-specific instructions
    parts.push(
        'IMPORTANT: This is an ESTABLISHING SHOT of the environment.',
        'NO PEOPLE in the image - focus on architecture and atmosphere.',
        'Cinematic composition, professional lighting.',
        'High detail on textures, materials, and spatial depth.'
    );

    // Add time of day if specified
    if (location.timeOfDay) {
        parts.push(`Time of day: ${location.timeOfDay}`);
    }

    // Add mood if specified
    if (location.mood) {
        parts.push(`Mood: ${location.mood}`);
    }

    return parts.join('\n\n');
}

export default useLocationConceptGeneration;
