/**
 * usePostImportGeneration Hook
 * 
 * After an Excel/CSV import, this hook orchestrates automatic generation of:
 * 1. Character master images (from text descriptions)
 * 2. Character Face ID + Body (Character Consistency)
 * 3. Product/Prop reference images
 * 
 * All generation is sequential to avoid API rate limits.
 */

import { useState, useCallback, useRef } from 'react';
import { ProjectState, Character, Product } from '../types';
import { callCharacterImageAPI, callGeminiAPI } from '../utils/geminiUtils';

export interface PostImportProgress {
    isGenerating: boolean;
    currentPhase: 'idle' | 'characters' | 'consistency' | 'products' | 'done';
    current: number;
    total: number;
    currentName: string;
    errors: string[];
    completedCharacters: number;
    completedProducts: number;
}

const INITIAL_PROGRESS: PostImportProgress = {
    isGenerating: false,
    currentPhase: 'idle',
    current: 0,
    total: 0,
    currentName: '',
    errors: [],
    completedCharacters: 0,
    completedProducts: 0,
};

export function usePostImportGeneration(
    state: ProjectState,
    updateStateWithoutHistory: (updater: (prevState: ProjectState) => ProjectState) => void,
    userApiKey: string | null,
    setAgentState?: (agent: 'director' | 'dop', status: any, message?: string, stage?: string) => void
) {
    const [progress, setProgress] = useState<PostImportProgress>(INITIAL_PROGRESS);
    const abortRef = useRef(false);

    const cancelGeneration = useCallback(() => {
        abortRef.current = true;
        setProgress(p => ({ ...p, isGenerating: false, currentPhase: 'done', currentName: 'Cancelled' }));
    }, []);

    /**
     * Start the post-import generation pipeline.
     * @param characterIds - IDs of characters to generate images for
     * @param productIds - IDs of products to generate images for
     */
    const startPostImportGeneration = useCallback(async (
        characterIds: string[],
        productIds: string[]
    ) => {
        const rawApiKey = userApiKey || (process.env as any).API_KEY;
        const apiKey = typeof rawApiKey === 'string' ? rawApiKey.trim() : rawApiKey;

        if (!apiKey) {
            setProgress(p => ({ ...p, errors: ['Missing API Key. Please set Gemini API Key first.'] }));
            return;
        }

        abortRef.current = false;

        // Prepare Gommo credentials
        const gommoCredentials = state.gommoDomain && state.gommoAccessToken
            ? { domain: state.gommoDomain, accessToken: state.gommoAccessToken }
            : undefined;

        const model = state.imageModel || 'gemini-3-pro-image-preview';
        const stylePrompt = state.stylePrompt || 'cinematic-realistic';

        // Get characters and products from current state
        const characters = state.characters.filter(c => characterIds.includes(c.id) && c.description && !c.masterImage);
        const products = (state.products || []).filter(p => productIds.includes(p.id) && p.description && !p.masterImage);

        const totalTasks = characters.length * 2 + products.length; // master + consistency per char + products

        setProgress({
            isGenerating: true,
            currentPhase: 'characters',
            current: 0,
            total: totalTasks,
            currentName: '',
            errors: [],
            completedCharacters: 0,
            completedProducts: 0,
        });

        if (setAgentState) {
            setAgentState('dop', 'working', `🎨 Starting auto-generation: ${characters.length} characters + ${products.length} props`, 'post_import');
        }

        let tasksDone = 0;
        const errors: string[] = [];

        // ═══════════════════════════════════════════════════════
        // PHASE A: Generate Character Master Images
        // ═══════════════════════════════════════════════════════
        for (const char of characters) {
            if (abortRef.current) break;

            setProgress(p => ({
                ...p,
                currentPhase: 'characters',
                current: tasksDone,
                currentName: `🧑 Tạo hình ${char.name}...`,
            }));

            if (setAgentState) {
                setAgentState('dop', 'working', `🧑 Generating master image: ${char.name}`, 'char_master');
            }

            try {
                // Build character generation prompt
                const charPrompt = `
SINGLE CHARACTER REFERENCE - FULL BODY on pure white background.
Generate EXACTLY ONE character based on this description:

${char.description}

REQUIREMENTS:
- EXACTLY 1 person in the image
- Full body, head to toe, feet visible
- Pure solid white studio background
- Professional studio lighting
- A-pose or natural standing pose
- Sharp detailed face
- Complete outfit with shoes
                `.trim();

                const imageUrl = await callCharacterImageAPI(
                    apiKey,
                    charPrompt,
                    '9:16',
                    model,
                    null, // no reference image
                    gommoCredentials
                );

                if (imageUrl) {
                    updateStateWithoutHistory(s => ({
                        ...s,
                        characters: s.characters.map(c =>
                            c.id === char.id
                                ? { ...c, masterImage: imageUrl }
                                : c
                        )
                    }));
                    console.log(`[PostImport] ✅ Master image generated for: ${char.name}`);
                } else {
                    errors.push(`Failed to generate master image for ${char.name}`);
                }
            } catch (err: any) {
                console.error(`[PostImport] ❌ Error generating ${char.name}:`, err);
                errors.push(`${char.name}: ${err.message}`);
            }

            tasksDone++;
            setProgress(p => ({
                ...p,
                current: tasksDone,
                errors: [...errors],
            }));

            // Rate limit delay
            if (!abortRef.current) await delay(2000);
        }

        // ═══════════════════════════════════════════════════════
        // PHASE B: Generate Face ID + Body (Character Consistency)
        // ═══════════════════════════════════════════════════════
        setProgress(p => ({ ...p, currentPhase: 'consistency' }));

        for (const char of characters) {
            if (abortRef.current) break;

            // Re-read from state to get the masterImage we just generated
            const currentState = await getLatestState(updateStateWithoutHistory);
            const updatedChar = currentState.characters.find(c => c.id === char.id);

            if (!updatedChar?.masterImage) {
                tasksDone++;
                continue;
            }

            setProgress(p => ({
                ...p,
                currentPhase: 'consistency',
                current: tasksDone,
                currentName: `🎭 Face ID + Body: ${char.name}...`,
            }));

            if (setAgentState) {
                setAgentState('dop', 'working', `🎭 Generating Face ID + Body: ${char.name}`, 'char_consistency');
            }

            try {
                const description = updatedChar.description || char.description || 'Character';

                // Generate Face ID
                const facePrompt = `
EXTREME CLOSE-UP FACE PORTRAIT on pure white background.
Character: ${description}
STYLE: Match the reference image exactly.
Focus on: facial features, expression, skin tone, hair.
Background: Pure solid white (#FFFFFF).
                `.trim();

                const faceUrl = await callCharacterImageAPI(
                    apiKey,
                    facePrompt,
                    '1:1',
                    model,
                    updatedChar.masterImage,
                    gommoCredentials
                );

                if (faceUrl) {
                    updateStateWithoutHistory(s => ({
                        ...s,
                        characters: s.characters.map(c =>
                            c.id === char.id
                                ? { ...c, faceImage: faceUrl, bodyImage: updatedChar.masterImage }
                                : c
                        )
                    }));
                    console.log(`[PostImport] ✅ Face ID generated for: ${char.name}`);
                }
            } catch (err: any) {
                console.error(`[PostImport] ❌ Error generating consistency for ${char.name}:`, err);
                errors.push(`${char.name} (Face ID): ${err.message}`);
            }

            tasksDone++;
            setProgress(p => ({
                ...p,
                current: tasksDone,
                completedCharacters: p.completedCharacters + 1,
                errors: [...errors],
            }));

            // Rate limit delay
            if (!abortRef.current) await delay(2000);
        }

        // ═══════════════════════════════════════════════════════
        // PHASE C: Generate Product/Prop Images
        // ═══════════════════════════════════════════════════════
        setProgress(p => ({ ...p, currentPhase: 'products' }));

        for (const product of products) {
            if (abortRef.current) break;

            setProgress(p => ({
                ...p,
                currentPhase: 'products',
                current: tasksDone,
                currentName: `📦 Tạo hình: ${product.name}...`,
            }));

            if (setAgentState) {
                setAgentState('dop', 'working', `📦 Generating prop: ${product.name}`, 'product_gen');
            }

            try {
                const prodPrompt = `Professional product photography of ${product.description}. 
Studio lighting, pure white background, 8K detail, centered, front view, high quality product shot.
The object should be clearly visible and well-lit.`.trim();

                const imageUrl = await callGeminiAPI(apiKey, prodPrompt, '1:1', model);

                if (imageUrl) {
                    updateStateWithoutHistory(s => ({
                        ...s,
                        products: (s.products || []).map(p =>
                            p.id === product.id
                                ? { ...p, masterImage: imageUrl }
                                : p
                        )
                    }));
                    console.log(`[PostImport] ✅ Product image generated for: ${product.name}`);
                }
            } catch (err: any) {
                console.error(`[PostImport] ❌ Error generating product ${product.name}:`, err);
                errors.push(`${product.name}: ${err.message}`);
            }

            tasksDone++;
            setProgress(p => ({
                ...p,
                current: tasksDone,
                completedProducts: p.completedProducts + 1,
                errors: [...errors],
            }));

            // Rate limit delay
            if (!abortRef.current) await delay(2000);
        }

        // ═══════════════════════════════════════════════════════
        // DONE
        // ═══════════════════════════════════════════════════════
        setProgress(p => ({
            ...p,
            isGenerating: false,
            currentPhase: 'done',
            current: totalTasks,
            currentName: errors.length > 0
                ? `⚠️ Hoàn tất với ${errors.length} lỗi`
                : '✅ Hoàn tất tạo hình!',
            errors: [...errors],
        }));

        if (setAgentState) {
            if (errors.length > 0) {
                setAgentState('dop', 'error', `⚠️ Auto-gen complete with ${errors.length} errors`, 'post_import_done');
            } else {
                setAgentState('dop', 'success', `✅ Auto-generated ${characters.length} characters + ${products.length} props!`, 'post_import_done');
            }
        }

        console.log('[PostImport] 🏁 Pipeline complete:', {
            characters: characters.length,
            products: products.length,
            errors: errors.length,
        });
    }, [state, userApiKey, updateStateWithoutHistory, setAgentState]);

    return {
        progress,
        startPostImportGeneration,
        cancelGeneration,
    };
}

// ═══════════════════════════════════════════════════════
// UTILITY FUNCTIONS
// ═══════════════════════════════════════════════════════

function delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Get latest state by triggering a no-op update and reading the result.
 * This is needed because React state may not be up-to-date in async callbacks.
 */
function getLatestState(updateStateAndRecord: (fn: (s: ProjectState) => ProjectState) => void): Promise<ProjectState> {
    return new Promise(resolve => {
        updateStateAndRecord(s => {
            resolve(s);
            return s; // No-op update
        });
    });
}
