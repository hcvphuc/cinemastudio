import React, { useState, useCallback, useRef } from 'react';
import { GoogleGenAI } from "@google/genai";
import { ProjectState, Scene, AgentStatus } from '../types';

import {
    GLOBAL_STYLES, CAMERA_MODELS, LENS_OPTIONS, CAMERA_ANGLES,
    DEFAULT_META_TOKENS, TRANSITION_TYPES
} from '../constants/presets';
import { DIRECTOR_PRESETS, DirectorCategory } from '../constants/directors';
import { getPresetById } from '../utils/scriptPresets';
import { uploadImageToSupabase, syncUserStatsToCloud } from '../utils/storageUtils';
import { safeGetImageData, callGeminiVisionReasoning, preWarmImageCache, fixMimeType, base64ToBlobUrl } from '../utils/geminiUtils';
import { GommoAI, urlToBase64 } from '../utils/gommoAI';
import { IMAGE_MODELS } from '../utils/appConstants';
import { normalizePrompt, normalizePromptAsync, formatNormalizationLog, needsNormalization, containsVietnamese } from '../utils/promptNormalizer';
import { recordPrompt, approvePrompt, getSuggestedKeywords } from '../utils/dopLearning';
import { analyzeSceneContinuity, extractCharacterState } from '../utils/dopIntelligence';
import { incrementGlobalStats, recordGeneratedImage } from '../utils/userGlobalStats';
import { validateRaccord as validateRaccordWithVision, formatValidationResult } from '../utils/dopRaccordValidator';
import type { RaccordValidationResult } from '../utils/dopRaccordValidator';
import { isGridModel, splitImageGrid } from '../utils/imageUtils';
import { RetryContext, getCorrectionPrompt } from '../utils/dopCorrections';
import { loadDirectorMemory, saveDirectorMemory, recordGeneration as recordDirectorGeneration } from '../utils/directorBrain';
// Helper function to clean VEO-specific tokens from prompt for image generation
const cleanPromptForImageGen = (prompt: string): string => {
    return prompt
        .replace(/\[\d{2}:\d{2}-\d{2}:\d{2}\]/g, '') // Remove timestamps [00:00-00:05]
        .replace(/SFX:.*?(\.|$)/gi, '') // Remove SFX descriptions
        .replace(/Emotion:.*?(\.|$)/gi, '') // Remove Emotion descriptions
        .replace(/\s+/g, ' ') // Collapse whitespace
        .trim();
};

// Helper: Determine which provider to use based on model ID
const getProviderFromModel = (modelId: string): 'gemini' | 'gommo' => {
    const model = IMAGE_MODELS.find(m => m.value === modelId);
    return (model?.provider as 'gemini' | 'gommo') || 'gemini';
};

// Helper: Delay function for retries
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// Helper: Retry wrapper for transient API errors (500, 503, 429)
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
                console.log(`[${operationName}] ❌ Policy violation detected - NOT retrying:`, errorMessage.substring(0, 100));
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

            // Exponential backoff: 2s, 4s, 8s
            const waitTime = Math.pow(2, attempt) * 1000;
            console.log(`[${operationName}] ⚠️ Attempt ${attempt}/${maxRetries} failed (transient). Retrying in ${waitTime / 1000}s...`);
            await delay(waitTime);
        }
    }

    throw lastError;
};

// Helper: Create inline data object with sanitized MIME type
// This prevents "Unsupported MIME type: application/octet-stream" errors
const createInlineData = (data: string, mimeType: string, sourceUrl?: string) => {
    return {
        inlineData: {
            data,
            mimeType: fixMimeType(mimeType, sourceUrl)
        }
    };
};

export function useImageGeneration(
    state: ProjectState,
    stateRef: React.MutableRefObject<ProjectState>,
    updateStateAndRecord: (updater: (prevState: ProjectState) => ProjectState) => void,
    userApiKey: string | null,
    setApiKeyModalOpen: (open: boolean) => void,
    isContinuityMode: boolean,
    setAgentState: (agent: 'director' | 'dop', status: AgentStatus, message?: string, stage?: string) => void,
    addProductionLog?: (sender: 'director' | 'dop' | 'user' | 'system', message: string, type?: string, stage?: string) => void,

    userId?: string,
    isOutfitLockMode?: boolean,
    addToGallery?: (image: string, type: string, prompt?: string, sourceId?: string) => void,
    isDOPEnabled?: boolean,
    validateRaccordWithVision?: (currentImage: string, prevImage: string, currentScene: Scene, prevScene: Scene, apiKey: string) => Promise<{ isValid: boolean; errors: { type: string; description: string }[]; correctionPrompt?: string; decision?: 'retry' | 'skip' | 'try_once' }>,
    makeRetryDecision?: (failedImage: string, referenceImage: string, originalPrompt: string, errors: { type: string; description: string }[], apiKey: string) => Promise<{ action: 'retry' | 'skip' | 'try_once'; reason: string; enhancedPrompt?: string; confidence: number }>
) {


    const [isBatchGenerating, setIsBatchGenerating] = useState(false);
    const [isStopping, setIsStopping] = useState(false);
    const stopRef = useRef(false);

    // Generation Lock: Track which scenes are currently being generated to prevent duplicates
    const generatingSceneIdsRef = useRef<Set<string>>(new Set());

    // [Fix] Signal stop when the hook instance is destroyed, key changes, or project changes
    React.useEffect(() => {
        return () => {
            console.log('[BatchGen] 🧹 Cleaning up generation state (key/project change)');
            stopRef.current = true;
            generatingSceneIdsRef.current.clear();
            setIsBatchGenerating(false);
            setIsStopping(false);
        };
    }, [userApiKey, state.projectName]);

    /**
     * Storyboard Mode: Find the best cascade reference image for visual consistency
     * Priority: Nearest KEY FRAME > Nearest any scene > Group conceptImage
     * - Looks for the nearest scene with an image in the SAME SceneGroup
     * - KEY FRAMES are prioritized as they are hero shots
     * - Falls back to group's conceptImage if no scene has image
     * - Returns undefined if no reference available (first scene in group)
     */
    const findCascadeReference = useCallback((
        currentScene: Scene,
        currentState: ProjectState
    ): string | undefined => {
        if (!currentScene.groupId) return undefined;

        // 1. Get ALL scenes in same group that have generated images AND are valid (no critical errors)
        const sameGroupScenes = (currentState.scenes || []).filter(
            s => s.groupId === currentScene.groupId &&
                s.generatedImage &&
                s.id !== currentScene.id &&
                // IGNORE scenes with Critical DOP Errors (Unfixable / Wrong Person) to prevent error propagation
                (!s.error || (!s.error.includes('UNFIXABLE') && !s.error.includes('DOP Skip')))
        );

        if (sameGroupScenes.length === 0) {
            // No scenes with images in this group - try conceptImage
            const group = currentState.sceneGroups?.find(g => g.id === currentScene.groupId);
            if (group?.conceptImage) {
                console.log(`[Cascade] Using group conceptImage as reference for scene ${currentScene.sceneNumber}`);
                return group.conceptImage;
            }
            return undefined;
        }

        const currentNum = parseInt(currentScene.sceneNumber);

        // 2. PRIORITY: Find nearest KEY FRAME (hero shot) first
        const keyFramesInGroup = sameGroupScenes.filter(s => s.isKeyFrame);
        if (keyFramesInGroup.length > 0) {
            // Find nearest key frame by scene number distance
            const sortedByDistance = keyFramesInGroup.sort((a, b) => {
                const distA = Math.abs(parseInt(a.sceneNumber) - currentNum);
                const distB = Math.abs(parseInt(b.sceneNumber) - currentNum);
                return distA - distB;
            });
            console.log(`[Cascade] Scene ${currentScene.sceneNumber} referencing KEY FRAME Scene ${sortedByDistance[0].sceneNumber} ⭐`);
            return sortedByDistance[0].generatedImage!;
        }

        // 3. Fallback: Find nearest scene BEFORE current (by sceneNumber)
        const beforeScenes = sameGroupScenes
            .filter(s => parseInt(s.sceneNumber) < currentNum)
            .sort((a, b) => parseInt(b.sceneNumber) - parseInt(a.sceneNumber));

        if (beforeScenes.length > 0) {
            console.log(`[Cascade] Scene ${currentScene.sceneNumber} referencing Scene ${beforeScenes[0].sceneNumber} for consistency`);
            return beforeScenes[0].generatedImage!;
        }

        // 4. If no scene before, check if any scene AFTER has image (edge case: regenerating earlier scene)
        const afterScenes = sameGroupScenes
            .filter(s => parseInt(s.sceneNumber) > currentNum)
            .sort((a, b) => parseInt(a.sceneNumber) - parseInt(b.sceneNumber));

        if (afterScenes.length > 0) {
            console.log(`[Cascade] Scene ${currentScene.sceneNumber} referencing Scene ${afterScenes[0].sceneNumber} (forward ref)`);
            return afterScenes[0].generatedImage!;
        }

        return undefined;
    }, []);

    const stopBatchGeneration = useCallback(() => {
        if (isBatchGenerating) {
            stopRef.current = true;
            setIsStopping(true);
        }
    }, [isBatchGenerating]);

    const callAIImageAPI = async (
        prompt: string,
        apiKey: string | null,
        model: string,
        aspectRatio: string,
        parts: any[] = [],
        imageSize: string = '1K',
        gommoCredentials?: { domain: string; accessToken: string }
    ): Promise<{ imageUrl: string; mediaId?: string }> => {
        const provider = getProviderFromModel(model);

        console.log(`[ImageGen] Provider: ${provider}, Model: ${model}`);
        console.log(`[ImageGen] Gommo credentials check:`, {
            domain: gommoCredentials?.domain || '(empty)',
            hasToken: !!gommoCredentials?.accessToken,
            tokenLength: gommoCredentials?.accessToken?.length || 0
        });

        // ═══════════════════════════════════════════════════════════════
        // GOMMO PATH: Supports subjects array for Face ID references
        // ═══════════════════════════════════════════════════════════════
        if (provider === 'gommo' && gommoCredentials?.domain && gommoCredentials?.accessToken) {
            console.log('[ImageGen] 🟡 Using GOMMO provider');

            // Convert Gemini parts to Gommo subjects format
            // Gommo expects: { id_base?, url?, data? } where data is base64 WITHOUT prefix
            const subjects: Array<{ id_base?: string; url?: string; data?: string }> = [];

            for (let i = 0; i < parts.length; i++) {
                const part = parts[i];
                if (part.inlineData?.data && part.inlineData?.mimeType) {
                    // Gommo expects base64 WITHOUT the data:image/...;base64, prefix
                    const base64Data = part.inlineData.data;
                    subjects.push({ data: base64Data });
                }
            }

            if (subjects.length > 0) {
                console.log(`[ImageGen] 🎭 Converted ${subjects.length} reference image(s) to Gommo subjects`);
            }

            try {
                const client = new GommoAI(gommoCredentials.domain, gommoCredentials.accessToken);
                const gommoRatio = GommoAI.convertRatio(aspectRatio);

                // GOMMO IDENTITY INJECTION: Prepend instruction to match subject images
                // Gommo models need explicit instruction to use subjects for face/body
                let gommoPrompt = prompt;
                if (subjects.length > 0) {
                    const identityPrefix = `[IDENTITY LOCK] Use the provided reference image(s) as the ONLY source for character face and body. Match the face structure, features, and clothing EXACTLY from the reference. Do NOT generate a different face. `;
                    gommoPrompt = identityPrefix + prompt;
                    console.log('[ImageGen] 🔒 Added IDENTITY LOCK prefix for Gommo');
                }

                // Limit subjects to first 3 (Face, Body, Continuity) - too many confuses API
                const limitedSubjects = subjects.slice(0, 3);
                if (subjects.length > 3) {
                    console.log(`[ImageGen] ⚠️ Limiting subjects from ${subjects.length} to 3 for Gommo`);
                }

                // Map UI resolution to Gommo format
                const gommoResolution = imageSize as '1K' | '2K' | '4K';
                console.log(`[ImageGen] Gommo resolution setting: ${gommoResolution}`);

                // Generate image via Gommo (async with polling)
                const cdnUrl = await client.generateImage(gommoPrompt, {
                    ratio: gommoRatio,
                    resolution: gommoResolution,
                    model: model,
                    subjects: limitedSubjects.length > 0 ? limitedSubjects : undefined,
                    onProgress: (status, attempt) => {
                        console.log(`[Gommo] Polling ${attempt}/60: ${status}`);
                    }
                });

                // Convert CDN URL to blob URL for memory efficiency
                const base64Image = await urlToBase64(cdnUrl);
                console.log('[ImageGen] ✅ Gommo image generated successfully');
                // Convert to Blob URL to save RAM
                if (base64Image.startsWith('data:')) {
                    const match = base64Image.match(/^data:([^;]+);base64,(.+)$/);
                    if (match) {
                        return { imageUrl: base64ToBlobUrl(match[2], match[1]) };
                    }
                }
                return { imageUrl: base64Image };
            } catch (error: any) {
                console.error('[ImageGen] ❌ Gommo generation failed:', error.message);
                throw new Error(`Gommo Error: ${error.message}`);
            }
        }

        // ═══════════════════════════════════════════════════════════════
        // ERROR: Gommo model selected but credentials missing
        // ═══════════════════════════════════════════════════════════════
        if (provider === 'gommo') {
            console.error('[ImageGen] ❌ Gommo model selected but credentials missing!', {
                domain: gommoCredentials?.domain || '(empty)',
                token: gommoCredentials?.accessToken ? '(set)' : '(empty)'
            });
            throw new Error('Gommo credentials chưa được cấu hình. Vào Profile → Gommo AI để nhập Domain và Access Token.');
        }

        // ═══════════════════════════════════════════════════════════════
        // GEMINI PATH: Full multi-modal generation with image references
        // ═══════════════════════════════════════════════════════════════
        // Use Gemini API for all Gemini-provider models
        if (provider === 'gemini') {
            if (!apiKey) {
                if (gommoCredentials?.accessToken) {
                    throw new Error("Bạn đang chọn Model ảnh của hệ thống Gemini, nhưng chỉ mới nhập Key của Gommo. Vui lòng vào Cài đặt đổi Ảnh Model sang một Model của Gommo (có chữ 🟡), hoặc nhập thêm Gemini API Key.");
                } else {
                    throw new Error("Missing Credentials (API Key bật Gemini hoặc Gommo Token để dùng các model Gommo)");
                }
            }

            console.log('[ImageGen] 🔵 Using GEMINI provider');
            const ai = new GoogleGenAI({ apiKey: apiKey.trim() });

            // Build parts in Google's recommended order: TEXT FIRST, then IMAGES
            const fullParts: any[] = [];
            if (prompt) fullParts.push({ text: prompt }); // Text FIRST per docs
            fullParts.push(...parts); // Then all image references

            console.log(`[ImageGen] Generating with resolution: ${imageSize}, aspectRatio: ${aspectRatio}, parts: ${fullParts.length}`);

            // Wrap API call with retry for transient errors (500, 503)
            const response = await withRetry(async () => {
                return await ai.models.generateContent({
                    model: model,
                    contents: [{ parts: fullParts }],
                    config: {
                        responseModalities: ["IMAGE"], // Enforce Image output
                        imageConfig: {
                            aspectRatio: aspectRatio || "16:9",
                            imageSize: imageSize || '1K' // Pass resolution to API
                        }
                    },
                });
            }, 'ImageGeneration', 3);

            const imagePart = response.candidates?.[0]?.content?.parts?.find((p: any) => p.inlineData);
            if (imagePart?.inlineData) {
                // Convert to Blob URL to save memory (from ~3MB base64 string to ~50 byte pointer)
                return { imageUrl: base64ToBlobUrl(imagePart.inlineData.data, imagePart.inlineData.mimeType) };
            } else {
                throw new Error("Không nhận được ảnh từ API.");
            }
        }

        throw new Error("Provider không hợp lệ hoặc thiếu Model.");
    };

    // referenceImage: Optional image URL to use as visual DNA reference (from another scene)
    const performImageGeneration = useCallback(async (
        sceneId: string,
        refinementPrompt?: string,
        fromManual: boolean = false,
        referenceImage?: string,
        baseImage?: string, // NEW: Optional base image for Img2Img editing
        negativePrompt?: string, // NEW: Negative constraints for DOP retries
        retryContext?: RetryContext // NEW: Smart Retry Context
    ) => {
        const currentState = stateRef.current;
        const currentSceneIndex = (currentState.scenes || []).findIndex(s => s.id === sceneId);
        const sceneToUpdate = (currentState.scenes || [])[currentSceneIndex];
        if (!sceneToUpdate) return;

        updateStateAndRecord(s => ({
            ...s,
            scenes: s.scenes.map(sc => sc.id === sceneId ? { ...sc, isGenerating: true, error: null, generationStartTime: Date.now(), generationDuration: undefined } : sc)
        }));

        const startTime = Date.now();
        console.log(`[ImageGen] Starting Generation for Scene ${sceneId}`, {
            refinementPrompt, fromManual, hasRetryContext: !!retryContext, retryReason: retryContext?.reason
        });

        try {
            // --- 1. GET STYLE PROMPT ---
            let styleInstruction = '';
            const currentGroupObj = currentState.sceneGroups?.find(g => g.id === sceneToUpdate.groupId);
            const effectiveStylePrompt = currentGroupObj?.stylePrompt || currentState.stylePrompt;

            // Use group's custom style if it has one, otherwise fallback to global
            const effectiveCustomStyle = (currentGroupObj?.stylePrompt === 'custom' && currentGroupObj?.customStyleInstruction)
                ? currentGroupObj.customStyleInstruction
                : currentState.customStyleInstruction;

            if (effectiveStylePrompt === 'custom') {
                styleInstruction = effectiveCustomStyle || '';
                console.log('[ImageGen] ✨ CUSTOM style check:', {
                    effectiveStylePrompt,
                    effectiveCustomStyle: effectiveCustomStyle?.substring(0, 50) + '...',
                    customStyleImage: currentState.customStyleImage ? '✅ Image attached' : '❌ No image',
                    stateCustomStyleInstruction: currentState.customStyleInstruction?.substring(0, 50) + '...'
                });
            } else {
                const selectedStyle = GLOBAL_STYLES.find(s => s.value === effectiveStylePrompt);
                styleInstruction = selectedStyle ? selectedStyle.prompt : '';
                console.log('[ImageGen] 🎨 PRESET style:', effectiveStylePrompt, '| Prompt:', styleInstruction?.substring(0, 50));
            }

            // --- 2. CINEMATOGRAPHY ---
            const cameraModelInfo = CAMERA_MODELS.find(c => c.value === currentState.cameraModel);
            const cameraPrompt = currentState.cameraModel === 'custom' ? (currentState.customCameraModel ? `Shot on ${currentState.customCameraModel}` : '') : (cameraModelInfo?.prompt || '');

            const effectiveLens = sceneToUpdate.lensOverride || currentState.defaultLens || '';
            const lensInfo = LENS_OPTIONS.find(l => l.value === effectiveLens);
            const lensPrompt = effectiveLens === 'custom' ? (sceneToUpdate.customLensOverride || currentState.customDefaultLens || '') : (lensInfo?.prompt || '');

            const angleInfo = CAMERA_ANGLES.find(a => a.value === (sceneToUpdate.cameraAngleOverride || ''));
            const anglePrompt = (sceneToUpdate.cameraAngleOverride === 'custom' ? sceneToUpdate.customCameraAngle : angleInfo?.label) || '';

            const activePreset = getPresetById(currentState.activeScriptPreset, currentState.customScriptPresets);
            const metaTokens = currentState.customMetaTokens || DEFAULT_META_TOKENS[activePreset?.category || 'custom'] || DEFAULT_META_TOKENS['custom'];

            const cinematographyPrompt = [cameraPrompt, lensPrompt, anglePrompt].filter(Boolean).join(', ');

            // Clean context from AI meta-instructions - broader regex
            let cleanedContext = (sceneToUpdate.contextDescription || '')
                .replace(/Referencing environment from.*?(consistency|logic|group|refgroup|nhất quán)\.?/gi, '')
                .replace(/Tham chiếu bối cảnh từ.*?(nhất quán|consistency)\.?/gi, '')
                .trim();

            // STRIP VEO-specific tokens (timestamps, SFX, Emotion) for image generation
            cleanedContext = cleanPromptForImageGen(cleanedContext);

            // STRIP character names from context if they are NOT selected for this scene
            const unselectedChars = (currentState.characters || []).filter(c => !(sceneToUpdate.characterIds || []).includes(c.id));
            unselectedChars.forEach(c => {
                if (!c.name) return;
                const escapedName = c.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                const regex = new RegExp(`\\b${escapedName}\\b`, 'gi');
                cleanedContext = cleanedContext.replace(regex, '');
            });
            cleanedContext = cleanedContext.replace(/\s+/g, ' ').trim();

            // --- PROMPT LENGTH OPTIMIZATION ---
            // Strip verbose sections that AI may ignore anyway
            // SCENE STATE MEMORY is already handled by extractPoseFromVO, so remove redundant text prompts
            // NOTE: LOCATION ANCHOR is KEPT as it's critical for scene diversity!
            cleanedContext = cleanedContext
                .replace(/\[SCENE STATE MEMORY[^\]]*\]:?[^[]*(?=\[|$)/gi, '')
                // REMOVED: .replace(/\[LOCATION ANCHOR[^\]]*\]:?[^[]*(?=\[|$)/gi, '')  
                // ^^ DO NOT STRIP LOCATION ANCHOR - it's essential for distinguishing scenes!
                .trim();

            // Warn if context is excessively long
            if (cleanedContext.length > 8000) {
                console.warn('[ImageGen] ⚠️ LONG CONTEXT:', cleanedContext.length, 'chars - may slow generation');
                // Truncate to last 8000 chars to keep most relevant (recent) context
                cleanedContext = '...' + cleanedContext.slice(-7997);
            }


            const isHighRes = (currentState.imageModel || 'gemini-3-pro-image-preview') === 'gemini-3-pro-image-preview';

            // --- REASONING STEP (Refinement/Edit Mode) ---
            // If we have a Base Image (Edit Mode) and a Command, we use "Gemini 3 Reasoning" to plan the edit first.
            let reasonedContext = null;
            if (baseImage && (refinementPrompt || sceneToUpdate.contextDescription) && isHighRes) {
                try {
                    const baseImgData = await safeGetImageData(baseImage);

                    // Detect Reference Image (for Composite / Transfer)
                    // Priority: Explicit arg -> Scene property
                    const refImgUrl = referenceImage || sceneToUpdate.referenceImage;
                    const refImgData = refImgUrl ? await safeGetImageData(refImgUrl) : null;

                    if (baseImgData && userApiKey) {
                        console.log('[Reasoning] 🧠 Analyzing Images + Request with Gemini Vision...');

                        const imagesToSend = [baseImgData];
                        let instructionExtra = "";

                        if (refImgData) {
                            imagesToSend.push(refImgData);
                            instructionExtra = `
IMAGE 2 IS A REFERENCE OBJECT/SOURCE.
- The User Command may ask to "use the object from Scene X" or "transfer the style".
- Look at IMAGE 2 to identify the specific object, texture, or detail requested.
- COMPOSITE instruction: Describe the scene from IMAGE 1, but include the object/element from IMAGE 2 as requested, ensuring it fits the lighting and perspective of IMAGE 1.
`;
                        }

                        const analysisPrompt = `Role: Expert VFX Supervisor & Prompt Engineer.
Task: The user wants to EDIT the attached IMAGE 1.
User Command: "${refinementPrompt || sceneToUpdate.contextDescription}".
Current Scene Context: "${sceneToUpdate.contextDescription}".
${instructionExtra}

INSTRUCTIONS:
1. Analyze IMAGE 1 (Context, Composition, Lighting, Subject).
${refImgData ? "2. Analyze IMAGE 2 (Reference Object/Detail)." : ""}
3. Interpret the User Command.
   - Does it ask to CHANGE the CAMERA ANGLE (e.g. "Zoom in", "Pan left", "High angle")?
   - Does it ask to CHANGE the POSE?
   - Or is it just adding/changing an object/detail?

4. Generate a precise Image Generation Prompt that:
   - IF CAMERA/POSE CHANGE REQUESTED: Describe the NEW angle/pose clearly.
   - IF NO CAMERA/POSE CHANGE: Start with "EDIT REQUEST: Keep the exact camera angle, subject pose, and lighting from the source image."
   - Describes the scene fully, integrating the changes NATURALISTICALLY.

OUTPUT ONLY THE PROMPT. DO NOT OUTPUT MARKDOWN OR EXPLANATION.`;

                        const reasonedPrompt = await callGeminiVisionReasoning(
                            userApiKey,
                            analysisPrompt,
                            imagesToSend,
                            'gemini-2.5-flash' // "Gemini 3 Reasoning"
                        );

                        if (reasonedPrompt) {
                            console.log('[Reasoning] ✨ Enhanced Prompt:', reasonedPrompt);
                            // Detect if angle change was requested
                            const isAngleChange = /zoom|pan|angle|close.?up|wide|medium|long|shot/i.test(reasonedPrompt);
                            console.log(`[Reasoning] 📐 Angle Change Detected: ${isAngleChange}`);
                            cleanedContext = reasonedPrompt.trim(); // Override context with smart prompt
                            reasonedContext = reasonedPrompt.trim();
                        }
                    }
                } catch (err) {
                    console.warn('[Reasoning] Failed:', err);
                }
            }


            // --- 3. CHARACTERS & PRODUCTS ---
            const selectedChars = (currentState.characters || []).filter(c => (sceneToUpdate.characterIds || []).includes(c.id));
            let charPrompt = '';
            const isDocumentary = activePreset?.category === 'documentary';

            if (selectedChars.length > 0) {
                // Find group to check for overrides
                const group = sceneToUpdate.groupId
                    ? currentState.sceneGroups?.find(g => g.id === sceneToUpdate.groupId)
                    : null;

                const charDesc = selectedChars.map(c => {
                    const override = group?.outfitOverrides?.[c.id];
                    const visualState = sceneToUpdate.characterVisualStates?.[c.id];

                    let desc = `[${c.name}: ${c.description}`;

                    if (override) {
                        desc += `. MANDATORY OUTFIT OVERRIDE: ${override}. IGNORE PRIOR CLOTHING DETAILS`;
                    }

                    if (visualState) {
                        desc += `. CURRENT CONDITION/STATE: ${visualState} (Apply this damage/dirt/state ON TOP of the outfit)`;
                    }

                    desc += `]`;
                    return desc;
                }).join(' ');

                const hasAnimal = selectedChars.some(c =>
                    /horse|snake|dog|cat|wolf|bird|lion|tiger|dragon|animal|creature|bear|eagle|fish|shark|whale/i.test(c.name) ||
                    /horse|snake|dog|cat|wolf|bird|lion|tiger|dragon|animal|creature|bear|eagle|fish|shark|whale/i.test(c.description)
                );

                const outfitConstraint = hasAnimal
                    ? '' // No outfit lock for animals
                    : ' (MANDATORY COSTUME LOCK: Character MUST be wearing the exact clothing/uniform shown in their FULL BODY reference image OR the specified OUTFIT OVERRIDE. ABSOLUTELY NO NAKEDNESS.)';

                // FACELESS ENFORCEMENT
                const isFacelessMode = currentState.globalCharacterStyleId?.includes('faceless');
                const facelessConstraint = (isFacelessMode && !hasAnimal)
                    ? ' !!! STRICT FACELESS MODE: NO FACES, NO EYES, NO MOUTH. Heads must be smooth/featureless. EMOTION MUST BE SHOWN VIA EXAGGERATED BODY LANGUAGE, POSTURE AND HAND GESTURES ONLY. !!! '
                    : '';

                // MANNEQUIN MATERIAL ENFORCEMENT (Critical for style consistency)
                const isMannequinMode = currentState.globalCharacterStyleId?.includes('mannequin');
                const mannequinMaterialConstraint = (isMannequinMode && !hasAnimal)
                    ? `[STYLE TRIGGER]: !!! STRICT FACELESS MANNEQUIN PROTOCOL ACTIVE !!!
- HEAD: Humanoid shape, smooth MATTE WHITE RESIN material. ABSOLUTELY NO EYES, NO NOSE, NO MOUTH, NO EARS.
- HANDS: Matching white hard plastic articulation. NO skin texture, NO veins.
- BODY: Fully clothed. Any exposed parts MUST be white plastic.
- MATERIAL: "High-end store mannequin", "Clean minimal resin", "Abstract white figure".`
                    : '';

                charPrompt = `${mannequinMaterialConstraint} Appearing Characters: ${charDesc}${outfitConstraint}${facelessConstraint}`;

                // IDENTITY LOCK: When characters have reference images, enforce strict consistency
                const hasReferenceImages = selectedChars.some(c => c.faceImage || c.bodyImage);
                if (hasReferenceImages) {
                    charPrompt += ` [IDENTITY LOCK - CRITICAL]: Keep EXACT facial features, proportions, hairstyle, and clothing from reference images. NO variations, NO changes to face structure. Characters must be 100% recognizable from their reference sheets.`;
                }
            } else if (isDocumentary) {
                // DOCUMENTARY MODE: Check mannequin style first
                const isMannequinMode = currentState.globalCharacterStyleId?.includes('mannequin');
                const mannequinForDocs = isMannequinMode
                    ? `Use FACELESS WHITE MANNEQUIN figures (smooth cast resin material, egg-shaped featureless heads, hard plastic hands, NO skin texture whatsoever)`
                    : `Use realistic anonymous people fitting the scene context`;

                charPrompt = `DOCUMENTARY STYLE: ${mannequinForDocs} for all humans. Focus on storytelling through clothing and body language. NO SKIN TEXTURE - if mannequin style is enabled, ALL body parts must be smooth plastic.`;
            } else {
                // EXPLICIT NO CHARACTER for macro/landscape shots (non-documentary)
                charPrompt = `STRICT NEGATIVE: NO PEOPLE, NO CHARACTERS, NO HUMANS, NO FACES, NO BODY PARTS. EXPLICITLY REMOVE ALL HUMAN ELEMENTS. FOCUS ONLY ON ${cleanedContext.toUpperCase() || 'ENVIRONMENT'}.`;
            }


            // --- 3.5 EXTRACT CORE ACTION ---
            // Try to find the action part after "->" or at least pick key verbs
            let coreAction = '';
            if (cleanedContext.includes('->')) {
                const parts = cleanedContext.split('->');
                coreAction = parts[parts.length - 1].trim();
            } else {
                coreAction = cleanedContext; // Fallback
            }
            const coreActionPrompt = `CORE ACTION: ${coreAction.toUpperCase()}. (Ensure high dynamic energy, motion blur if applicable, realistic physics).`;

            // --- 4. OPTION C: SCENE-BY-SCENE POSE OVERRIDE (CRITICAL FOR CONTINUITY) ---
            // Extract SPECIFIC poses from VO text and enforce them at TOP of prompt
            const extractPoseFromVO = (voText: string): string[] => {
                if (!voText) return [];
                const poses: string[] = [];
                const vo = voText.toLowerCase();

                // Character position patterns
                if (vo.includes('lies face down') || vo.includes('face down')) {
                    poses.push('Character MUST be LYING FACE DOWN on the ground (NOT standing!)');
                }
                if (vo.includes('lying') || vo.includes('lies on')) {
                    poses.push('Character MUST be LYING DOWN (NOT standing or sitting!)');
                }
                if (vo.includes('kneels') || vo.includes('kneeling')) {
                    poses.push('Character MUST be KNEELING (on knees, NOT standing!)');
                }
                if (vo.includes('hands cuffed') || vo.includes('cuffed behind')) {
                    poses.push('Hands MUST be CUFFED BEHIND the back (restrained, not free)');
                }
                if (vo.includes('hands tremble') || vo.includes('trembling')) {
                    poses.push('Show TREMBLING/SHAKING hands (motion blur, nervous energy)');
                }

                // Prop positioning patterns
                if (vo.includes('on his face') || vo.includes('on her face') || vo.includes('wearing')) {
                    if (vo.includes('mask')) {
                        poses.push('Mask MUST be ON THE CHARACTER\'S FACE (worn, NOT on floor/table!)');
                    }
                }
                if (vo.includes('empty eye sockets')) {
                    poses.push('Focus on EMPTY EYE SOCKETS of the mask (dark voids, no eyes visible)');
                }
                if (vo.includes('radio crackles')) {
                    poses.push('Show RADIO device with visible static/activity indicators');
                }

                return poses;
            };

            const voText = sceneToUpdate.voiceOverText || cleanedContext;
            const poseOverrides = extractPoseFromVO(voText);
            let mandatoryPosePrompt = '';
            if (poseOverrides.length > 0) {
                mandatoryPosePrompt = `
!!! MANDATORY POSE/POSITION - DO NOT IGNORE !!!
${poseOverrides.map((p, i) => `${i + 1}. ${p}`).join('\n')}
!!! FAILURE TO FOLLOW THESE POSES = GENERATION FAILURE !!!
`;
                console.log('[ImageGen] 🎭 POSE OVERRIDE:', poseOverrides);
            }

            // --- 5. FINAL PROMPT CONSTRUCTION (Priority Order) ---
            // STYLE & NEGATIVE CONSTRAINTS (Authoritative)
            const isRealistic = effectiveStylePrompt === 'cinematic-realistic' || effectiveStylePrompt === 'vintage-film';
            const negativeStyle = isRealistic ? '!!! STRICT NEGATIVE: NO ANIME, NO CARTOON, NO 2D, NO DRAWING, NO ILLUSTRATION, NO PAINTING, NO CGI-LOOK !!!' : '';

            // ANATOMY NEGATIVE PROMPT - Prevent character deformations (extra hands, distorted bodies)
            const anatomyNegativePrompt = `!!! CRITICAL ANATOMY RULES - STRICTLY ENFORCED !!!
- NEGATIVE: extra fingers, fused fingers, deformed hands, mutated hands, extra hands
- NEGATIVE: extra arms, extra legs, extra limbs, disconnected limbs, floating limbs
- NEGATIVE: malformed, disfigured, bad anatomy, distorted body, gross proportions
- NEGATIVE: duplicate body parts, clone, asymmetrical face, crossed eyes
- EACH CHARACTER MUST HAVE: exactly 2 arms, exactly 2 legs, exactly 5 fingers per hand
- POSE MUST BE: anatomically correct, naturally proportioned, physically possible`;


            // If Reasoning happened, it already built the style into the prompt. Don't override it brutally.
            const authoritativeStyle = reasonedContext
                ? "STYLE ADAPTATION: Follow the style described in the main prompt."
                : (baseImage || refinementPrompt)
                    ? "STYLE LOCK: MATCH SOURCE IMAGE."
                    : `AUTHORITATIVE STYLE: ${styleInstruction.toUpperCase()}. ${negativeStyle}`;

            // Shot Scale (Angle) is the ABSOLUTE PRIORITY for composition
            // If Reasoning happened, trust IT to set the angle (it knows if user asked for a change).
            // If no reasoning but we have baseImage, maintain lock.
            // Otherwise, use UI selection.
            const scaleCmd = reasonedContext
                ? "" // Let Reasoning control the angle
                : (baseImage ? "COMPOSITION LOCK: MATCH SOURCE IMAGE EXACTLY." : (anglePrompt ? `SHOT SCALE: ${anglePrompt.toUpperCase()}.` : 'CINEMATIC WIDE SHOT.'));

            // NO DRIFT GUARD: Prevent "Chibi" or distortion if style is realistic
            const noDriftGuard = isRealistic ? "!!! MANDATORY CONSISTENCY: Maintain realistic human/object dimensions. NO DISTORTIONS. !!!" : "";

            // SCALE LOCK: If it's a close-up, reference the previous shot's scale
            let scaleLockInstruction = '';
            if (anglePrompt.toUpperCase().includes('CLOSE UP') || anglePrompt.toUpperCase().includes('POV')) {
                scaleLockInstruction = '[SCALE LOCK]: Reference the object/subject dimensions from previous wide shots. Match texture and relative size exactly. ';
            }

            // GLOBAL ENVIRONMENT ANCHOR (To prevent drift within group)
            let groupEnvAnchor = '';
            let timeWeatherLock = '';
            if (sceneToUpdate.groupId) {
                const groupObj = currentState.sceneGroups?.find(g => g.id === sceneToUpdate.groupId);
                if (groupObj) {
                    // SPATIAL ANCHORING LOGIC
                    let spatialStr = `GLOBAL SETTING: ${groupObj.description.toUpperCase()}.`;

                    if (sceneToUpdate.facingDirection && groupObj.spatialAnchors) {
                        const dir = sceneToUpdate.facingDirection === 'custom'
                            ? sceneToUpdate.customFacingDirection
                            : sceneToUpdate.facingDirection;

                        if (dir && groupObj.spatialAnchors[dir]) {
                            spatialStr += ` [CAMERA FACING ${dir}]: Background MUST show: ${groupObj.spatialAnchors[dir]}.`;
                        } else {
                            // Relaxed anchor: Allow cinematic re-arrangement but keep style
                            spatialStr += ` [SET CONSISTENCY]: Maintain cohesive architectural style and materials. Allow dynamic composition suited for the shot angle.`;
                        }
                    } else {
                        // Relaxed anchor for general scenes
                        spatialStr += ` [SET CONSISTENCY]: Maintain defining landmarks but optimize layout for cinematic composition.`;
                    }

                    groupEnvAnchor = spatialStr;

                    // TIME & WEATHER CONSISTENCY LOCK
                    const timeParts: string[] = [];

                    // Time of Day
                    if (groupObj.timeOfDay) {
                        const timeStr = groupObj.timeOfDay === 'custom'
                            ? (groupObj.customTimeOfDay || '')
                            : groupObj.timeOfDay.toUpperCase();
                        if (timeStr) timeParts.push(`TIME: ${timeStr}`);
                    }

                    // Weather
                    if (groupObj.weather) {
                        const weatherStr = groupObj.weather === 'custom'
                            ? (groupObj.customWeather || '')
                            : groupObj.weather.toUpperCase();
                        if (weatherStr) timeParts.push(`WEATHER: ${weatherStr}`);
                    }

                    // Lighting Mood
                    if (groupObj.lightingMood) {
                        timeParts.push(`LIGHTING: ${groupObj.lightingMood.toUpperCase()}`);
                    }

                    if (timeParts.length > 0) {
                        timeWeatherLock = `[GLOBAL ATMOSPHERE LOCK]: ${timeParts.join(', ')}. MANDATORY: ALL scenes in this group MUST have IDENTICAL lighting direction, shadow intensity, sky color, and atmospheric mood. No variations allowed.`;
                    }
                }
            }

            // --- 2.5 CONTINUITY ANALYSIS (Action Mapping) ---
            let continuityLinkInstruction = '';
            if (currentSceneIndex > 0 && userApiKey && isContinuityMode) {
                const prevScene = (currentState.scenes || [])[currentSceneIndex - 1];
                // Only analyze if within same group or logically connected
                if (prevScene.groupId === sceneToUpdate.groupId) {
                    try {
                        const transition = await analyzeSceneContinuity(
                            userApiKey,
                            { description: sceneToUpdate.contextDescription, action: coreAction, shotType: anglePrompt },
                            {
                                description: prevScene.contextDescription,
                                action: prevScene.actionDescription || prevScene.contextDescription,
                                shotType: prevScene.cameraAngleOverride,
                                imageUrl: prevScene.generatedImage || undefined
                            }
                        );
                        if (transition) {
                            continuityLinkInstruction = `[VISUAL BRIDGE - PREVIOUS SHOT CONNECTION]: ${transition}. (Maintain flow from previous shot).`;
                            console.log('[ImageGen] 🔗 Continuity instruction added:', transition);
                        }
                    } catch (err) {
                        console.warn('[ImageGen] Continuity analysis failed, skipping.');
                    }
                }
            }

            // --- 2.6 CHARACTER STATE CONTINUITY (Option B: Action Continuity) ---
            // Extract character positions/props from previous scene to maintain animation sequence consistency
            let characterStateContinuity = '';
            if (currentSceneIndex > 0) {
                const prevScene = (currentState.scenes || [])[currentSceneIndex - 1];
                if (prevScene && prevScene.contextDescription) {
                    characterStateContinuity = extractCharacterState(prevScene.contextDescription);
                    if (characterStateContinuity) {
                        console.log('[ImageGen] 🎭 Character State Continuity:', characterStateContinuity);
                    }
                }
            }

            // --- 2.7 ENVIRONMENT LOCK FROM PREVIOUS FRAME ---
            // Maintain general location consistency but allow visual variation
            let environmentLockPrompt = '';
            if (currentSceneIndex > 0) {
                const prevScene = (currentState.scenes || [])[currentSceneIndex - 1];
                if (prevScene?.generatedImage && prevScene.groupId === sceneToUpdate.groupId) {
                    // SOFTENED: Instead of "IDENTICAL", allow variation while maintaining location type
                    environmentLockPrompt = `[LOCATION CONTINUITY]: Same general location type as previous shot (indoor/outdoor, same building/area). Maintain consistent time of day and weather. Allow dynamic composition changes based on the text prompt.`;
                    console.log('[ImageGen] 🏠 Environment continuity enabled (soft mode)');
                }
            }

            // --- 2.8 3D CAMERA PROGRESSION ---
            // Auto-compute dynamic camera movement based on shot type changes (ONLY within same group)
            let cameraProgressionPrompt = '';
            if (currentSceneIndex > 0) {
                const prevScene = (currentState.scenes || [])[currentSceneIndex - 1];
                // Only apply camera progression within SAME GROUP
                if (prevScene?.groupId === sceneToUpdate.groupId) {
                    const prevShot = (prevScene?.cameraAngleOverride || 'wide').toLowerCase();
                    const currentShot = anglePrompt.toLowerCase();

                    // Determine shot categories
                    const getPrevCategory = () => {
                        if (prevShot.includes('wide') || prevShot.includes('establish')) return 'wide';
                        if (prevShot.includes('close') || prevShot.includes('detail')) return 'close';
                        if (prevShot.includes('medium') || prevShot.includes('mid')) return 'medium';
                        if (prevShot.includes('pov') || prevShot.includes('subjective')) return 'pov';
                        return 'neutral';
                    };
                    const getCurrentCategory = () => {
                        if (currentShot.includes('wide') || currentShot.includes('establish')) return 'wide';
                        if (currentShot.includes('close') || currentShot.includes('detail')) return 'close';
                        if (currentShot.includes('medium') || currentShot.includes('mid')) return 'medium';
                        if (currentShot.includes('pov') || currentShot.includes('subjective')) return 'pov';
                        return 'neutral';
                    };

                    const prevCat = getPrevCategory();
                    const currCat = getCurrentCategory();

                    // Camera transition map for 3D feel
                    const cameraTransitions: Record<string, string> = {
                        'wide_wide': 'Maintain wide framing with subtle 5-10° horizontal drift for visual variety.',
                        'wide_medium': 'Camera pushes in smoothly, rotating 20° to reveal subject detail.',
                        'wide_close': 'Camera pushes forward significantly, orbiting 30° for dramatic 3/4 profile angle.',
                        'wide_pov': 'Camera transitions to over-the-shoulder or first-person perspective.',
                        'medium_wide': 'Camera pulls back 45°, revealing environmental context.',
                        'medium_medium': 'Subtle camera orbit (15°) for dynamic feel while maintaining distance.',
                        'medium_close': 'Camera moves closer with 25° rotation for intimate detail.',
                        'close_wide': 'Camera pulls back dramatically, establishing new spatial relationship.',
                        'close_close': 'Shift angle 30-45° to show subject from different perspective.',
                        'close_medium': 'Camera pulls back slightly with horizontal pan.',
                        'pov_wide': 'Transition from subjective to objective wide shot.',
                        'pov_medium': 'Camera moves from behind character to frontal view.',
                        'pov_close': 'Camera moves from behind character to frontal close-up.',
                        'neutral_neutral': 'Camera orbits 20° for visual dynamism while maintaining subject focus.',
                    };

                    const transitionKey = `${prevCat}_${currCat}`;
                    const transitionDesc = cameraTransitions[transitionKey] || cameraTransitions['neutral_neutral'];

                    // === SPATIAL CONTEXT AWARENESS ===
                    // When camera changes from POV/OTS to frontal, the BACKGROUND must change!
                    // POV looking at kitchen → Frontal means we now see what character WAS looking at (living room, etc.)
                    let spatialBackgroundInstruction = '';

                    if (prevCat === 'pov' && (currCat === 'medium' || currCat === 'close' || currCat === 'wide')) {
                        spatialBackgroundInstruction = `
⚠️ CRITICAL SPATIAL RULE - BACKGROUND MUST CHANGE:
The previous shot was POV/Over-the-shoulder. Now the camera is FACING the character.
This means:
1. The BACKGROUND behind the character is NOW what we SAW in the previous POV shot
2. If POV showed kitchen → Now we see character with kitchen BEHIND them
3. The character's FRONT is now visible, their BACK was in the previous shot
4. DO NOT keep the same background from POV - logically REVERSE the perspective

Example: POV over shoulder looking at kitchen → Frontal shot should show character with dining room/living room/hallway BEHIND them (opposite direction)`;
                        console.log('[ImageGen] 🔄 SPATIAL REVERSAL: POV → Frontal, background must change!');
                    }

                    // Reverse case: going FROM frontal TO POV
                    if ((prevCat === 'medium' || prevCat === 'close' || prevCat === 'wide') && currCat === 'pov') {
                        spatialBackgroundInstruction = `
⚠️ CRITICAL SPATIAL RULE - POV PERSPECTIVE:
Camera is moving BEHIND the character to show their POV.
This means:
1. We now SEE what the character is LOOKING AT
2. The character's back/shoulder may be in frame
3. Background shows the direction the character FACES
4. This is the OPPOSITE direction from where the camera was before`;
                        console.log('[ImageGen] 🔄 SPATIAL SHIFT: Frontal → POV, showing character\'s view!');
                    }

                    cameraProgressionPrompt = `[CAMERA]: ${transitionDesc} ${spatialBackgroundInstruction}`.trim();
                    console.log('[ImageGen] 🎥 Camera Progression:', `${prevCat} → ${currCat}`);
                }
            }

            // --- DIRECTOR DNA INJECTION ---
            let directorDNAPrompt = '';

            // Re-fetch director for logic use
            const allDirectors = Object.values(DIRECTOR_PRESETS).flat();
            const customDirectors = currentState.customDirectors || [];
            const activeDirector = [...allDirectors, ...customDirectors].find(d => d.id === currentState.activeDirectorId);

            // --- 6. DIRECTOR FILTERING (Allow Director to modify base prompt) ---
            // Director Presets can enforce their own negative prompts
            const directorNegative = activeDirector?.negativePrompt || '';

            // --- 7. DOP SMART RETRY INJECTION (Highest Priority) ---
            let dopCorrectionPrompt = '';
            let cameraAngleOverrideFromDOP = ''; // CRITICAL: Override UI camera when DOP requests angle fix
            if (retryContext) {
                dopCorrectionPrompt = getCorrectionPrompt(retryContext);
                console.log(`[ImageGen] 🔧 DOP Correction Injected: ${dopCorrectionPrompt}`);

                // CRITICAL FIX: If correction is for camera angle, OVERRIDE the UI cinematography settings
                if (retryContext.reason === 'wrong_angle' && retryContext.userNote) {
                    cameraAngleOverrideFromDOP = retryContext.userNote.toUpperCase();
                    console.log(`[ImageGen] 📷 CAMERA OVERRIDE FROM DOP: ${cameraAngleOverrideFromDOP} (replacing UI settings)`);
                }

                if (addProductionLog) {
                    addProductionLog('dop', `🔧 Applying Correction: ${retryContext.reason}`, 'info', 'retry_correction');
                }
            }

            if (activeDirector) {
                // Auto-detect Camera Only mode:
                // 1. If explicitly enabled via directorCameraOnlyMode
                // 2. OR if user has custom Meta Tokens (they want their own color grading)
                const hasCustomMetaTokens = currentState.customMetaTokens && currentState.customMetaTokens.trim().length > 0;
                const useCameraOnlyMode = currentState.directorCameraOnlyMode || hasCustomMetaTokens;

                if (useCameraOnlyMode) {
                    // Camera Only Mode: Only inject camera techniques, skip color DNA
                    if (activeDirector.signatureCameraStyle) {
                        directorDNAPrompt = `[DIRECTOR CAMERA - ${activeDirector.name.toUpperCase()}]: Apply this director's CAMERA TECHNIQUES and FRAMING STYLE: ${activeDirector.signatureCameraStyle}. COLOR GRADING follows user's Meta Tokens/Style settings, NOT this director's color palette.`;
                        console.log('[ImageGen] 🎬 Director CAMERA ONLY injected (auto-detect: customMetaTokens=' + hasCustomMetaTokens + '):', activeDirector.name, '| Camera:', activeDirector.signatureCameraStyle);
                    }
                } else {
                    // Full DNA Mode (default): Inject both color and camera
                    const cameraStyle = activeDirector.signatureCameraStyle
                        ? `SIGNATURE CAMERA: ${activeDirector.signatureCameraStyle}.`
                        : '';
                    directorDNAPrompt = `[DIRECTORIAL VISION - ${activeDirector.name.toUpperCase()}]: MANDATORY CINEMATIC STYLE. Visual DNA: ${activeDirector.dna}. ${cameraStyle} ${activeDirector.description}. ALL visual elements and camera work must reflect this director's signature style.`;
                    console.log('[ImageGen] 🎬 Director FULL DNA injected:', activeDirector.name, '| DNA:', activeDirector.dna, '| Camera:', activeDirector.signatureCameraStyle);
                }
            }

            // --- DOP RESEARCH NOTES INJECTION (Session Memory) ---
            let dopResearchPrompt = '';
            if (currentState.researchNotes?.dop) {
                dopResearchPrompt = `[USER DOP NOTES - MANDATORY CINEMATOGRAPHY GUIDE]: ${currentState.researchNotes.dop}. Apply these lighting, camera angle, and transition guidelines to this scene.`;
                console.log('[ImageGen] 📹 DOP Research Notes injected:', currentState.researchNotes?.dop?.substring(0, 50) + '...');
            }

            // --- GLOBAL STORY CONTEXT INJECTION (World Building) ---
            let globalStoryPrompt = '';
            if (currentState.researchNotes?.story) {
                globalStoryPrompt = `[GLOBAL STORY CONTEXT - MANDATORY WORLD SETTING]: ${currentState.researchNotes.story}. The scene must strictly exist within this specific world/universe. Align all architecture, technology, and atmosphere with this context.`;
                console.log('[ImageGen] 🌍 Global Story Context injected:', currentState.researchNotes?.story?.substring(0, 50) + '...');
            }

            // --- ANTI-COLLAGE INSTRUCTION ---
            const antiCollagePromptFull = `!!! CRITICAL OUTPUT CONSTRAINT !!! Generate EXACTLY ONE single continuous scene/frame. ABSOLUTELY NO: split frames, collages, storyboards, multiple panels, side-by-side images, grid layouts, before/after comparisons, or any form of image division. The output MUST be ONE unified visual with ONE continuous composition. If the prompt implies multiple moments, choose the MOST IMPORTANT SINGLE MOMENT and render only that.`;
            const antiCollagePromptShort = `!!! SINGLE IMAGE ONLY - NO COLLAGES/GRIDS !!!`;

            // === DETERMINE PROVIDER FOR PROMPT OPTIMIZATION ===
            const selectedModel = IMAGE_MODELS.find(m => m.value === currentState.imageModel);
            const promptProvider = selectedModel?.provider || 'gemini';

            let finalImagePrompt: string;

            if (promptProvider === 'gommo') {
                // ═══════════════════════════════════════════════════════════════
                // GOMMO PROMPT: Style-first, concise, prioritize early tokens
                // Many Gommo models truncate or prioritize beginning of prompt
                // ═══════════════════════════════════════════════════════════════
                // GOMMO PROMPT: Subject-first, prioritize Visual Content
                // Re-ordered to put Action and Characters before Style to fix logic/consistency
                // ═══════════════════════════════════════════════════════════════
                finalImagePrompt = `${dopCorrectionPrompt ? `!!! DOP CORRECTION: ${dopCorrectionPrompt} !!! ` : ''}${antiCollagePromptShort} SUBJECT & ACTION: ${coreActionPrompt} ${cleanedContext}. CHARACTERS: ${charPrompt}. ENVIRONMENT: ${groupEnvAnchor} ${timeWeatherLock}. STYLE: ${authoritativeStyle} ${directorDNAPrompt} ${metaTokens}. CAMERA: ${cinematographyPrompt || 'Auto'}.`.trim();
                console.log('[ImageGen] 🟡 GOMMO prompt (subject-first optimized)');
            } else {
                // ═══════════════════════════════════════════════════════════════
                // GEMINI PROMPT: Context-First Architecture
                // Structure: [Rules] -> [Visual Core (Who/What/Action)] -> [Where] -> [How (Style/Cam)]
                // Fixes "Logic not correct" by prioritizing Action/Context over Style headers.
                // ═══════════════════════════════════════════════════════════════

                // CRITICAL: If DOP correction specified a camera angle, use THAT instead of UI settings
                const effectiveCameraPrompt = cameraAngleOverrideFromDOP || cinematographyPrompt || 'High Quality';
                const cameraOverrideNote = cameraAngleOverrideFromDOP
                    ? `!!! CAMERA ANGLE OVERRIDE FROM DOP CORRECTION: ${cameraAngleOverrideFromDOP} - IGNORE ALL OTHER CAMERA SETTINGS !!!`
                    : '';

                finalImagePrompt = `
${dopCorrectionPrompt ? `!!! DOP CORRECTION: ${dopCorrectionPrompt} !!!` : ''}
${cameraOverrideNote}
${mandatoryPosePrompt}
${antiCollagePromptFull}
${anatomyNegativePrompt}

[VISUAL CORE - SUBJECT & ACTION]:
${continuityLinkInstruction}
${characterStateContinuity}
${environmentLockPrompt}
${cameraProgressionPrompt}
${coreActionPrompt}
FULL SCENE ACTION: ${cleanedContext}

[CHARACTERS & APPEARANCE]:
${charPrompt}

[ENVIRONMENT & ATMOSPHERE]:
${groupEnvAnchor}
${timeWeatherLock}
${globalStoryPrompt}

[CINEMATOGRAPHY & STYLE]:
${directorDNAPrompt}
${dopResearchPrompt}
${authoritativeStyle}
${cameraAngleOverrideFromDOP ? `FORCED CAMERA: ${cameraAngleOverrideFromDOP} (DOP OVERRIDE - MUST USE THIS EXACT ANGLE)` : scaleCmd} ${scaleLockInstruction} ${noDriftGuard}
STYLE DETAILS: ${metaTokens}
TECHNICAL CAMERA: ${effectiveCameraPrompt}`.trim().replace(/\n+/g, ' '); // Flatten to single line for API stability
                console.log('[ImageGen] 🔵 GEMINI prompt (Context-First Re-ordered)');
            }

            console.log('[ImageGen] 📝 Prompt Preview (first 300 chars):', finalImagePrompt?.substring(0, 300) || '(empty prompt)');

            // PROP ANCHOR TEXT INJECTION (High Priority)
            if (sceneToUpdate.referenceImage && sceneToUpdate.referenceImageDescription) {
                finalImagePrompt = `!!! MANDATORY OBJECT LOCK: ${sceneToUpdate.referenceImageDescription.toUpperCase()} !!! Draw the following objects EXACTLY as shown in the [AUTHORITATIVE_VISUAL_REFERENCE] image: ${sceneToUpdate.referenceImageDescription.toUpperCase()}. Match design, material, and color. ${finalImagePrompt}`;
            }

            // AUTO-DETECT OBJECT INSERTION FROM CONTEXT
            const objectInsertionMatch = cleanedContext.match(/(?:sits|placed|lying|resting)\s+(?:a|the)\s+([a-zA-Z\s]+?)\s+(?:on|in|at)\s+(?:the|a)\s+([a-zA-Z\s]+)/i);
            if (objectInsertionMatch) {
                const [_, objName, locName] = objectInsertionMatch;
                finalImagePrompt = `!!! PRIORITY EDIT: COMPOSITE A ${objName.toUpperCase()} ONTOP OF THE EXISTING ${locName.toUpperCase()} !!! 
                1. RENDER the ${objName} clearly.
                2. KEEP the ${locName} VISIBLE underneath the ${objName}.
                3. DO NOT REMOVE or REPLACE the ${locName}. 
                ${finalImagePrompt}`;
            }

            if (refinementPrompt) {
                finalImagePrompt = `REFINEMENT: ${refinementPrompt}. BASE PROMPT: ${finalImagePrompt}`;
            }

            if (negativePrompt) {
                finalImagePrompt = `${finalImagePrompt} NEGATIVE CONSTRAINTS (AVOID THESE): ${negativePrompt}`;
            }

            // --- 5. CONTINUITY & MULTI-IMAGE REFERENCES ---
            const parts: any[] = [];

            // 5.0.0 BASE IMAGE (CANVAS) - MUST BE FIRST FOR EDITING
            // Placing the base image first tells the model this is the "Subject" to modify.
            if (baseImage) {
                const baseImgData = await safeGetImageData(baseImage);
                if (baseImgData) {
                    console.log('[ImageGen] 🖼️ Base Image Editing Mode: Injecting as PRIMARY input.');
                    parts.push(createInlineData(baseImgData.data, baseImgData.mimeType));
                    parts.push({ text: `Using the provided image as the base scene, please EDIT it according to the instructions. Retain the original composition, lighting, and subject pose unless explicitly asked to change them.` });
                }
            }
            let continuityInstruction = '';
            const isPro = currentState.imageModel === 'gemini-3-pro-image-preview';

            // 5.0 DNA REFERENCE IMAGE INJECTION (From Director Chat - SYNC/REGENERATE)
            // This is a VERY HIGH PRIORITY reference - the user explicitly asked to match this scene
            if (referenceImage) {
                const dnaImgData = await safeGetImageData(referenceImage);
                if (dnaImgData) {
                    // Check if this is COMPOSITE mode (has object description) or STYLE mode
                    const objectToExtract = sceneToUpdate.referenceImageDescription;

                    if (objectToExtract) {
                        // COMPOSITE MODE: Extract specific object from reference
                        const refLabel = 'OBJECT_SOURCE_IMAGE';
                        parts.push({
                            text: `[${refLabel}]: !!! EXTRACT OBJECT FROM THIS IMAGE !!!
Look at this reference image and FIND the object: "${objectToExtract}".
COPY the EXACT appearance of "${objectToExtract}" (color, texture, shape, details) from THIS image.
ADD this object to the BASE scene (the first image) in a natural position.
DO NOT copy the background or other elements from this reference - ONLY the specified object.`
                        });
                        parts.push(createInlineData(dnaImgData.data, dnaImgData.mimeType));
                        continuityInstruction += `(COMPOSITE: Add "${objectToExtract}" from reference) `;
                        console.log('[ImageGen] 🎯 COMPOSITE Mode: Extracting object:', objectToExtract);
                    } else {
                        // STYLE MODE: Match visual DNA/style - SOFTENED to allow scene variation
                        const refLabel = 'STYLE_REFERENCE';
                        parts.push({
                            text: `[${refLabel}]: STYLE REFERENCE (NOT A COPY TARGET)
This image shows the VISUAL STYLE for this project. Use it as a LOOSE guide for:
- General color temperature (warm/cool)
- Lighting mood (soft/harsh)
- Overall render aesthetic

⚠️ CRITICAL RULES:
1. TEXT PROMPT IS PRIMARY - Follow the text description for WHAT to create
2. CREATE A NEW SCENE - Do NOT recreate or copy this reference image
3. DIFFERENT CONTENT EXPECTED - The text prompt describes a DIFFERENT scene/action/location
4. STYLE ONLY - Only carry over the general visual "feel", not the actual content

The text prompt below describes the ACTUAL scene you must create.` });
                        parts.push(createInlineData(dnaImgData.data, dnaImgData.mimeType));
                        continuityInstruction += '(STYLE REF) ';
                        console.log('[ImageGen] 🧬 DNA Reference Image injected (SOFT mode for variation)');
                    }
                }
            }

            // 5.0.1 BASE IMAGE INJECTION (For Img2Img / Editing)
            // If baseImage is provided, this is an EDIT operation, not a generation from scratch.


            // 5a. CHARACTER FACE ID ANCHOR (ABSOLUTE FIRST - Before Style!)
            // Using Google's recommended pattern: "Use supplied image as reference for how [name] should look"

            // DEBUG: Log character reference status
            if (selectedChars.length > 0) {
                console.log('[ImageGen] 🎭 CHARACTER REFERENCE CHECK:');
                selectedChars.forEach(c => {
                    console.log(`  - ${c.name}: faceImage=${c.faceImage ? '✅' : '❌'}, bodyImage=${c.bodyImage ? '✅' : '❌'}, masterImage=${c.masterImage ? '✅' : '❌'}`);
                });
            }

            for (const char of selectedChars) {
                // PRIMARY ANCHOR: Face ID (most important)
                const isAnimal = /horse|snake|dog|cat|wolf|bird|lion|tiger|dragon|animal|creature|bear|eagle|fish|shark|whale/i.test(char.name) ||
                    /horse|snake|dog|cat|wolf|bird|lion|tiger|dragon|animal|creature|bear|eagle|fish|shark|whale/i.test(char.description);

                if (char.faceImage) {
                    const imgData = await safeGetImageData(char.faceImage);
                    if (imgData) {
                        const refLabel = `IDENTITY_${char.name.toUpperCase().replace(/\s+/g, '_')}`;

                        if (isAnimal) {
                            // ANIMAL/CREATURE LOGIC: Softer lock, focus on species/texture, NO face structure mapping
                            parts.push({ text: `[${refLabel}]: VISUAL REFERENCE for ${char.name}. Use this image as a guide for the creature's appearance (species, color, pattern, size). Do NOT treat this as a human face. Blend it naturally into the scene.` });
                            console.log(`[ImageGen] 🐾 Injected CREATURE reference for ${char.name}`);
                        } else {
                            // HUMAN LOGIC: Strict Face Lock
                            parts.push({ text: `[${refLabel}]: !!! MANDATORY IDENTITY LOCK !!! Use this supplied image as the ONLY AUTHORITATIVE reference for how ${char.name} should look. Match face structure, features, and identity 100%. ABSOLUTELY NO VARIATION in facial structure allowed. ${char.description}` });
                            console.log(`[ImageGen] 👤 Injected FACE reference for ${char.name}`);
                        }

                        parts.push(createInlineData(imgData.data, imgData.mimeType));
                        continuityInstruction += `(STRICT IDENTITY LOCK: ${char.name}) `;
                    } else {
                        console.warn(`[ImageGen] ⚠️ Failed to load FACE image for ${char.name}`);
                    }
                } else if (char.masterImage) {
                    // Fallback to Master Image if Face Image is missing
                    const imgData = await safeGetImageData(char.masterImage);
                    if (imgData) {
                        const refLabel = `IDENTITY_${char.name.toUpperCase().replace(/\s+/g, '_')}`;
                        parts.push({ text: `[${refLabel}]: !!! MANDATORY IDENTITY LOCK (MASTER) !!! Use this supplied image as the ONLY AUTHORITATIVE reference for ${char.name}. Focus on the face and identity from this image. ${char.description}` });
                        parts.push(createInlineData(imgData.data, imgData.mimeType));
                        continuityInstruction += `(STRICT IDENTITY LOCK (MASTER): ${char.name}) `;
                        console.log(`[ImageGen] 👤 Injected MASTER reference (as Face fallback) for ${char.name}`);
                    }
                }

                // SECONDARY ANCHOR: Body Image (full body/costume reference)
                // Priority: bodyImage (AI-generated) > masterImage (fallback)
                const bodyRef = char.bodyImage || char.masterImage;
                if (bodyRef && bodyRef !== char.faceImage) {
                    const imgData = await safeGetImageData(bodyRef);
                    if (imgData) {
                        const refLabel = `FULLBODY_${char.name.toUpperCase()}`;
                        // STRONGER COSTUME LOCK
                        parts.push({ text: `[${refLabel}]: MANDATORY COSTUME REFERENCE for ${char.name}. Match clothing, colors, uniform, and textures 100%. If character has clothes in this image, they MUST HAVE CLOTHES in the output.` });
                        parts.push(createInlineData(imgData.data, imgData.mimeType));
                        console.log(`[ImageGen] 👕 Injected BODY reference for ${char.name} (source: ${char.bodyImage ? 'bodyImage' : 'masterImage fallback'})`);
                    }
                }
            }
            // 5b. STYLE REFERENCE IMAGE
            // Google pattern: "Apply style of [ref2] to subject in [ref1] while maintaining facial features"
            // FIX: Use effectiveStylePrompt for consistency with earlier logic
            console.log('[ImageGen] 🖼️ Style Image Check:', {
                effectiveStylePrompt,
                hasCustomStyleImage: !!currentState.customStyleImage,
                customStyleImagePreview: currentState.customStyleImage?.substring(0, 50) + '...'
            });
            if (effectiveStylePrompt === 'custom' && currentState.customStyleImage) {
                const imgData = await safeGetImageData(currentState.customStyleImage);
                const charNames = selectedChars.map(c => c.name).join(', ');
                if (imgData) {
                    parts.push({ text: `[STYLE_REFERENCE]: Apply ONLY the artistic rendering style of this image (shading, colors, texture) while RIGIDLY MAINTAINING the facial identity from ${charNames ? `IDENTITY references for ${charNames}` : 'above'}. DO NOT let this image influence the person's face structure or identity.` });
                    parts.push(createInlineData(imgData.data, imgData.mimeType));
                    continuityInstruction += `(STYLE ISOLATION: APPLY STYLE TO ENVIRONMENT/RENDER ONLY) `;
                    console.log('[ImageGen] ✅ Style Image INJECTED into prompt');
                } else {
                    console.warn('[ImageGen] ⚠️ Style Image could not be loaded');
                }
            }

            // 5c. FACE OVERRIDE (Immediately after style to prevent face contamination)
            // This re-establishes character identity after AI has seen the style image
            for (const char of selectedChars) {
                if (char.faceImage) {
                    const imgData = await safeGetImageData(char.faceImage);
                    if (imgData) {
                        const refLabel = `FACE_OVERRIDE: ${char.name.toUpperCase()}`;
                        parts.push({ text: `[${refLabel}]: !!! IDENTITY GUARD !!! ABSOLUTELY REJECT any facial variations introduced by style. RE-ESTABLISH this exact person. This face is the ONLY valid person for ${char.name}.` });
                        parts.push(createInlineData(imgData.data, imgData.mimeType));
                    }
                }
            }


            // 5d. ABSOLUTE SET LOCK (Master Anchor + Continuity Anchor)
            if (sceneToUpdate.groupId) {
                const groupObj = currentState.sceneGroups?.find(g => g.id === sceneToUpdate.groupId);

                // SAME LOCATION LOCK: All scenes in this group share the same physical environment
                if (groupObj) {
                    const sameLocationLock = `!!! SAME LOCATION LOCK !!! This scene is part of location group "${groupObj.name}". 
ALL SCENES IN THIS GROUP SHARE THE SAME PHYSICAL ENVIRONMENT: ${groupObj.description}.
YOU MUST MAINTAIN:
- Same architectural style, room layout, wall colors, and ceiling height
- Same furniture positions (tables, chairs, counters remain fixed)
- Same window/door placements
- Same lighting sources and color temperature
- Same time of day: ${groupObj.timeOfDay || 'consistent with group'}
DO NOT invent new environments or change the location. This is NOT a different place.`;
                    continuityInstruction += sameLocationLock;
                }

                // CONCEPT IMAGE ANCHOR: Use for ALL scenes in group (CRITICAL - not just after first)
                // Priority: Location Library > Group's own conceptImage
                const effectiveConceptImage = (() => {
                    // Check Location Library first
                    if (groupObj?.locationId && currentState.locations) {
                        const location = currentState.locations.find(l => l.id === groupObj.locationId);
                        if (location?.conceptImage) {
                            console.log(`[ImageGen] 📍 Using shared Location concept: ${location.name}`);
                            return location.conceptImage;
                        }
                    }
                    // Fallback to group's own concept
                    return groupObj?.conceptImage;
                })();

                if (effectiveConceptImage) {
                    const imgData = await safeGetImageData(effectiveConceptImage);
                    if (imgData) {
                        const refLabel = `MANDATORY_LOCATION_TEMPLATE`;
                        parts.push({ text: `[${refLabel}]: !!! CRITICAL ENVIRONMENT ANCHOR !!! This concept image defines the EXACT environment for ALL scenes in this location group. EVERY shot must exist within this space. Match: architectural style, layout, color palette, lighting, textures, and geometry. CHARACTER APPEARANCE comes from separate IDENTITY references - only use this for ENVIRONMENT. This location must be IDENTICAL across all scenes in the group.` });
                        parts.push(createInlineData(imgData.data, imgData.mimeType));
                        continuityInstruction += `(CONCEPT ENVIRONMENT ENFORCED) `;
                    }
                } else if (groupObj) {
                    // WARN: No concept image - add stronger text-based instruction
                    console.warn(`[ImageGen] ⚠️ Group "${groupObj.name}" has no concept image. Environment may vary.`);
                    continuityInstruction += `[NO CONCEPT IMAGE]: Strictly infer environment from "${groupObj.description}". Do NOT hallucinate different locations. `;
                }

                // FIRST SCENE BACKUP: If no concept image but first scene exists, use it as environment template
                const firstSceneInGroup = (currentState.scenes || [])
                    .filter(s => s.groupId === sceneToUpdate.groupId && s.generatedImage && s.id !== sceneToUpdate.id)
                    .sort((a, b) => parseInt(a.scene_number) - parseInt(b.scene_number))[0];

                if (firstSceneInGroup?.generatedImage && !groupObj?.conceptImage) {
                    const imgData = await safeGetImageData(firstSceneInGroup.generatedImage);
                    if (imgData) {
                        const refLabel = `ENVIRONMENT_ONLY_LOCK`;
                        parts.push({ text: `[${refLabel}]: Use this as the RIGID template for architecture and lighting ONLY. Match: layout, wall textures, room geometry, furniture placement, and lighting source. ABSOLUTELY IGNORE characters, clothing, and small props. This is a background-only consistency anchor.` });
                        parts.push(createInlineData(imgData.data, imgData.mimeType));
                        continuityInstruction += `(BACKGROUND LOCK FROM MASTER SCENE) `;
                    }
                }

                if (continuityInstruction) {
                    continuityInstruction = `ENVIRONMENT REFERENCE: Background elements only. Character appearance from IDENTITY references. ${continuityInstruction}`;
                }
            }


            // 5c. CHARACTER REFERENCES - FACE ID FIRST (Gemini weights early references more)
            let referencePreamble = '';

            // Track characters from the previous scene for re-entry logic
            const prevScene = currentSceneIndex > 0 ? (currentState.scenes || [])[currentSceneIndex - 1] : null;
            const prevSceneCharIds = prevScene?.characterIds || [];

            // STEP 1: Inject ALL Face IDs FIRST (highest priority for identity)
            for (const char of selectedChars) {
                if (char.faceImage) {
                    const faceData = await safeGetImageData(char.faceImage);
                    if (faceData) {
                        const isReentry = !prevSceneCharIds.includes(char.id);

                        // STRONGEST possible Face ID instruction
                        parts.push({
                            text: `🔒 [FACE ID LOCK - ${char.name.toUpperCase()}]: 
!!! CRITICAL IDENTITY REQUIREMENT !!! 
This is the ONLY acceptable face for character "${char.name}".
COPY EXACTLY:
- Facial bone structure (forehead, cheekbones, jaw)
- Eye shape and spacing
- Nose bridge and tip shape  
- Mouth shape and lip fullness
- Skin tone and texture
${isReentry ? '⚠️ CHARACTER RE-ENTERING - Reset to this exact face!' : ''}
DO NOT generate a different face. DO NOT create a "similar" face. This EXACT face only.`
                        });
                        parts.push(createInlineData(faceData.data, faceData.mimeType));
                        console.log(`[ImageGen] 🔒 FACE ID injected FIRST for ${char.name}`);
                    }
                }
            }

            // STEP 2: Then add body/outfit references
            // PRIORITY: Use AI-generated bodyImage and faceImage sheets ONLY
            // Do NOT use masterImage (user upload) as character reference
            for (const char of selectedChars) {
                const bodyRefs: { type: string, img: string }[] = [];

                // PRIORITY 1: AI-generated bodyImage (from character sheet generation)
                if (char.bodyImage) {
                    bodyRefs.push({ type: 'FULL BODY', img: char.bodyImage });
                    console.log(`[ImageGen] ✅ Using AI-generated bodyImage for ${char.name}`);
                }

                // PRIORITY 2: Additional angle views (only if Pro model)
                if (isPro) {
                    if (char.sideImage) bodyRefs.push({ type: 'SIDE VIEW', img: char.sideImage });
                    if (char.backImage) bodyRefs.push({ type: 'BACK VIEW', img: char.backImage });
                }

                // FALLBACK: Only if NO bodyImage AND NO faceImage, skip this character entirely
                // masterImage is NOT used for character identity - only for initial sheet generation
                if (bodyRefs.length === 0 && !char.faceImage) {
                    console.warn(`[ImageGen] ⚠️ Character ${char.name} has no faceImage or bodyImage - skipping character reference`);
                    continue; // Skip this character - no valid AI-generated references
                }

                // PARALLEL loading of body reference images
                const refDataArray = await Promise.all(
                    bodyRefs.map(ref => safeGetImageData(ref.img).then(data => ({ ref, data })))
                );

                for (const { ref, data: imgData } of refDataArray) {
                    if (imgData) {
                        parts.push({ text: `[${char.name.toUpperCase()} ${ref.type}]: Use for OUTFIT and POSE only. Face from FACE ID LOCK above. Description: ${char.description}` });
                        parts.push(createInlineData(imgData.data, imgData.mimeType));
                        referencePreamble += `(${char.name} ${ref.type}) `;
                    }
                }
            }

            const selectedProducts = (currentState.products || []).filter(p => (sceneToUpdate.productIds || []).includes(p.id));
            for (const prod of selectedProducts) {
                const prodRefs: { type: string, img: string }[] = [];
                if (prod.views?.front) prodRefs.push({ type: 'FRONT VIEW', img: prod.views.front });

                // Add more views if using Pro
                if (isPro) {
                    const sideImg = prod.views?.left || prod.views?.right;
                    if (sideImg) prodRefs.push({ type: 'SIDE VIEW', img: sideImg });
                    if (prod.views?.back) prodRefs.push({ type: 'BACK VIEW', img: prod.views.back });
                    if (prod.views?.top) prodRefs.push({ type: 'TOP VIEW', img: prod.views.top });
                } else {
                    const sideImg = prod.views?.left || prod.views?.right;
                    if (sideImg) prodRefs.push({ type: 'SIDE VIEW', img: sideImg });
                }

                // Fallback to master if no specific views
                if (prodRefs.length === 0 && prod.masterImage) {
                    prodRefs.push({ type: 'PRIMARY', img: prod.masterImage });
                }

                // PARALLEL loading of all product reference images
                const refDataArray = await Promise.all(
                    prodRefs.map(ref => safeGetImageData(ref.img).then(data => ({ ref, data })))
                );

                for (const { ref, data: imgData } of refDataArray) {
                    if (imgData) {
                        const refLabel = `MASTER VISUAL: ${prod.name.toUpperCase()} ${ref.type}`;
                        // STRONGER RACCORD FOR PROPS
                        parts.push({ text: `[${refLabel}]: AUTHORITATIVE visual anchor for ${prod.name} (PROP RACCORD). Match the design, colors, material, and branding from this image EXACTLY. Maintain consistent scale relative to the character.` });
                        parts.push(createInlineData(imgData.data, imgData.mimeType));
                        referencePreamble += `(PROP CONTINUITY: Match ${refLabel}) `;
                    }
                }
            }

            // 5e. CONTINUITY ANCHOR FROM PREVIOUS SHOT (Stronger Logic)
            // Use if isContinuityMode is ON and we are in the same group (or no group but sequential)
            // SKIP dopFailed scenes - use last GOOD scene as reference
            if (isContinuityMode && currentSceneIndex > 0 && !sceneToUpdate.referenceImage) {
                // Find previous scene that has image AND is not marked as dopFailed
                const prevSceneWithImage = (currentState.scenes || [])
                    .slice(0, currentSceneIndex)
                    .reverse()
                    .find(s => s.generatedImage && !(s as any).dopFailed);

                // Only use as anchor if it belongs to the same Scene Group (strong continuity) or is the immediate predecessor
                const isSameGroup = prevSceneWithImage && prevSceneWithImage.groupId === sceneToUpdate.groupId;
                const isImmediate = prevSceneWithImage && (parseInt(sceneToUpdate.sceneNumber) - parseInt(prevSceneWithImage.sceneNumber) <= 2); // Allow gap of 1 (failed scene)

                if (prevSceneWithImage?.generatedImage && (isSameGroup || isImmediate)) {
                    const imgData = await safeGetImageData(prevSceneWithImage.generatedImage);
                    if (imgData) {
                        // RE-ENTRY SAFE INSTRUCTION: If previous shot was empty, warn AI not to suppress characters
                        const wasPrevShotEmpty = (prevSceneWithImage.characterIds?.length || 0) === 0;
                        const charReturnWarning = wasPrevShotEmpty ? "!!! NOTICE !!! The previous shot was a background-only view. The current shot contains characters; do NOT let this reference suppress their appearance or identity." : "";

                        // Detect if we are zooming in (Wide -> Close Up)
                        const isZoomingIn = (anglePrompt.includes('CLOSE') || anglePrompt.includes('CU')) && !prevSceneWithImage.cameraAngleOverride?.includes('CLOSE');

                        const anchorLabel = isZoomingIn ? "ZOOM_IN_ANCHOR" : "CONTINUITY_ANCHOR";

                        // Note if we skipped a failed scene
                        const skippedFailedNote = currentSceneIndex - currentState.scenes.indexOf(prevSceneWithImage) > 1
                            ? `(Skipped failed scene - using Scene ${prevSceneWithImage.sceneNumber} as reference instead)`
                            : '';

                        parts.push({
                            text: `[${anchorLabel}]: CONTINUITY REFERENCE (SELECTIVE). ${skippedFailedNote} Use previous frame for consistency. ${charReturnWarning}
INHERIT THESE:
1. PHYSICAL LIGHTING: Match actual light source direction and shadow placement
2. ENVIRONMENT: Fixed positions of furniture, architecture, and landmarks
3. SUBJECTS: Character appearance (clothing, pose, physical features)

!!! DO NOT INHERIT - CAMERA-SPECIFIC EFFECTS !!!:
- Camera filters (CCTV, night vision, security camera, surveillance overlays)
- Vignettes, scan lines, recording artifacts, grain patterns
- Color grading specific to surveillance/special camera POV
- Text overlays, timestamps, HUD elements, date stamps
- Fish-eye distortion or lens artifacts from special cameras

The NEW scene has its OWN camera style as specified in the current prompt. DO NOT apply previous scene's camera treatment.` });

                        parts.push(createInlineData(imgData.data, imgData.mimeType));

                        if (skippedFailedNote) {
                            console.log(`[ImageGen] ⚠️ Skipped failed scene, using Scene ${prevSceneWithImage.sceneNumber} as continuity ref`);
                        }
                    }
                } else if (!prevSceneWithImage) {
                    // No good previous scene found - this is like a new group
                    console.log('[ImageGen] 📍 No valid previous scene - generating as new group (character/environment refs only)');
                }
            }

            // 5e. EXPLICIT PRODUCT/PROP REFERENCE (User-defined Override)
            if (sceneToUpdate.referenceImage) {
                const imgData = await safeGetImageData(sceneToUpdate.referenceImage);
                if (imgData) {
                    const focus = sceneToUpdate.referenceImageDescription || 'props and environment';
                    parts.push({
                        text: `[AUTHORITATIVE_VISUAL_REFERENCE]: 
STEP 1: ANALYZE this image deeply. Identify the key visual attributes of the ${focus} (Material, Texture, Color Palette, Lighting Style, Design details).
STEP 2: GENERATE the new scene by strictly applying these identified attributes.
Match the ${focus} EXACTLY as shown in this reference.
IGNORE any prior text descriptions if they conflict with this visual DNA.` });
                    parts.push(createInlineData(imgData.data, imgData.mimeType));
                    // Add to top of parts if it's really important? No, index-wise handles it.
                }
            }

            // 5f. IDENTITY REINFORCEMENT - DISABLED (Was Sandwich Pattern)
            // Sandwich was sending face/body TWICE which doubled reference count
            // Research: Gemini weighs FIRST references most, duplicates waste tokens
            // 2 chars: 8 refs → 4 refs (50% reduction)
            // Speed improvement: ~10-15s per generation
            console.log(`[ImageGen] ✅ Sandwich disabled - using single-pass references only`);

            // (Base Image moved to start)
            if (continuityInstruction) {
                finalImagePrompt = `${continuityInstruction.trim()} ${finalImagePrompt}`;
            }

            // --- REFERENCE LIMIT VALIDATION (Gemini 3 Pro: Max 14 images) ---
            const refImageCount = parts.filter((p: any) => p.inlineData).length;
            if (refImageCount > 14) {
                console.warn(`[ImageGen] ⚠️ WARNING: ${refImageCount} reference images detected. Gemini 3 Pro supports max 14. Performance may degrade.`);
                if (addProductionLog) {
                    addProductionLog('dop', `⚠️ ${refImageCount} reference images (max 14)`, 'warning', 'ref_warning');
                }
            } else if (refImageCount > 0) {
                console.log(`[ImageGen] 📷 Using ${refImageCount} reference image(s)`);
                if (addProductionLog) {
                    addProductionLog('dop', `📷 Using ${refImageCount} reference image(s)`, 'info', 'ref_count');
                }
            }

            // --- LOG REFERENCE DETAILS TO DOP CHAT ---
            if (addProductionLog) {
                // Log previous scene reference
                if (currentState.scenes && currentState.scenes.length > 0) {
                    const prevSceneWithImage = (currentState.scenes || [])
                        .filter((s: any) => s.id !== sceneToUpdate.id && s.generatedImage)
                        .slice(-1)[0];
                    if (prevSceneWithImage) {
                        addProductionLog('dop', `🔗 Continuity from Scene ${prevSceneWithImage.sceneNumber || '?'}`, 'info', 'continuity_ref');
                    }
                }

                // Log character references
                if (sceneToUpdate.characterIds && sceneToUpdate.characterIds.length > 0) {
                    const charNames = sceneToUpdate.characterIds
                        .map((cid: string) => (currentState.characters || []).find((c: any) => c.id === cid)?.name || cid.slice(0, 6))
                        .join(', ');
                    addProductionLog('dop', `👤 Characters: ${charNames}`, 'info', 'char_ref');
                }

                // Log explicit reference image
                if (sceneToUpdate.referenceImage) {
                    addProductionLog('dop', `🖼️ Reference image attached`, 'info', 'explicit_ref');
                }
            }

            // --- 6. PROMPT NORMALIZATION (DOP Layer) ---
            // Optimize prompt for the specific model being used
            // Includes auto-translation from Vietnamese to English for non-Gemini models
            const modelToUse = currentState.imageModel || 'gemini-3-pro-image-preview';
            let promptToSend = finalImagePrompt;

            // TIMING: Log prep phase duration with breakdown
            const prepTime = Date.now() - startTime;
            const refCount = parts.filter((p: any) => p.inlineData).length;
            console.log(`[ImageGen] ⏱️ PREP completed in ${prepTime}ms (${refCount} refs loaded)`);
            console.log(`[ImageGen] ⏱️ Breakdown: If PREP > 5000ms, check console for '[ImageCache] 📥' fetches`);

            // --- DOP LEARNING: Apply suggested keywords from successful patterns ---
            // This runs in parallel and doesn't block (fire and forget with timeout)
            try {
                const suggestedKeywords = await Promise.race([
                    getSuggestedKeywords(modelToUse, 'scene'),
                    new Promise<string[]>((_, reject) => setTimeout(() => reject('timeout'), 500))
                ]).catch(() => [] as string[]);

                if (suggestedKeywords.length > 0) {
                    // Add keywords that aren't already in prompt
                    const promptLower = promptToSend.toLowerCase();
                    const newKeywords = suggestedKeywords.filter(kw =>
                        !promptLower.includes(kw.toLowerCase())
                    ).slice(0, 3); // Max 3 new keywords

                    if (newKeywords.length > 0) {
                        promptToSend = `${promptToSend} (${newKeywords.join(', ')})`;
                        console.log('[DOP Learning] 🧠 Applied keywords:', newKeywords);
                    }
                }
            } catch (e) {
                // Silent fail - learning is optional
            }

            // Debug: Check if model is correctly detected as gemini type
            const shouldNormalize = needsNormalization(modelToUse);
            console.log('[ImageGen] Model check:', modelToUse, '| Needs normalization:', shouldNormalize);

            if (!shouldNormalize && addProductionLog) {
                addProductionLog('dop', `🟢 ${modelToUse} hỗ trợ tiếng Việt - không cần dịch`, 'info', 'skip_normalize');
            }

            if (shouldNormalize) {
                // Check if Vietnamese is actually present
                const hasVietnamese = containsVietnamese(finalImagePrompt);

                if (hasVietnamese) {
                    // Vietnamese detected + model doesn't support it → need translation
                    // Use async AI translation for proper Vietnamese → English
                    if (userApiKey) {
                        console.log('[ImageGen] 🌐 Vietnamese detected, translating for', modelToUse);
                        const normalized = await normalizePromptAsync(finalImagePrompt, modelToUse, userApiKey, currentState.aspectRatio);
                        promptToSend = normalized.normalized;
                        console.log('[ImageGen] ✅ Translated:', normalized?.normalized?.substring(0, 100) + '...');
                    } else {
                        // No API key, use sync fallback (basic, may not translate well)
                        const normalized = normalizePrompt(finalImagePrompt, modelToUse, currentState.aspectRatio);
                        promptToSend = normalized.normalized;
                    }
                } else {
                    // No Vietnamese - prompt is already English, skip translation
                    console.log('[ImageGen] 🔵 Prompt already English, skip translation');
                    // promptToSend is already set to finalImagePrompt
                }
            } else {
                // Gemini native - Vietnamese supported, use full prompt
                console.log('[ImageGen] 🔵 Gemini prompt ready:', finalImagePrompt?.length || 0, 'chars');
            }

            // Record prompt in DOP Learning System - NON-BLOCKING (fire and forget)
            // This was causing 10-20s delay because generateEmbedding calls Gemini API
            let dopRecordId: string | null = null;
            const capturedSceneId = sceneId; // Capture for async callback
            if (userId && userApiKey) {
                // Fire and forget - don't await, don't block image generation
                recordPrompt(
                    userId,
                    finalImagePrompt,
                    promptToSend,
                    modelToUse,
                    'scene',
                    currentState.aspectRatio,
                    userApiKey
                ).then(id => {
                    if (id) {
                        console.log('[ImageGen] ✅ DOP recorded (async):', id);
                        // Store globally for fallback
                        (window as any).__lastDopRecordId = id;

                        // Update scene with dopRecordId so rating buttons work
                        updateStateAndRecord(s => ({
                            ...s,
                            scenes: s.scenes.map(sc => sc.id === capturedSceneId ? {
                                ...sc,
                                dopRecordId: id
                            } : sc)
                        }));
                        console.log('[ImageGen] 📊 Scene updated with dopRecordId for rating');
                    }
                }).catch(e => {
                    console.error('[ImageGen] ❌ DOP recording failed (async):', e);
                });

                console.log('[ImageGen] 🔄 DOP recording started (non-blocking)');
            } else {
                console.warn('[ImageGen] ⚠️ DOP skipped - missing userId:', !!userId, 'or apiKey:', !!userApiKey);
            }

            // --- LOG REFERENCE SUMMARY TO DOP CHAT (right before generation) ---
            // refImageCount already declared above at line 1007
            if (addProductionLog && refImageCount > 0) {
                addProductionLog('dop', `📷 Using ${refImageCount} reference image(s) for generation`, 'info', 'ref_summary');

                // Log character names if any
                if (sceneToUpdate.characterIds && sceneToUpdate.characterIds.length > 0) {
                    const allCharacters = currentState.characters || [];
                    const charNames = sceneToUpdate.characterIds
                        .map((cid: string) => allCharacters.find((c: any) => c.id === cid)?.name || 'Unknown')
                        .filter((n: string) => n !== 'Unknown')
                        .join(', ');
                    if (charNames) {
                        addProductionLog('dop', `👤 Characters: ${charNames}`, 'info', 'char_summary');
                    }
                }
            }

            // TIMING: Start API call
            const apiStartTime = Date.now();

            const { imageUrl: rawImageUrl, mediaId } = await callAIImageAPI(
                promptToSend,
                userApiKey,
                modelToUse,
                currentState.aspectRatio,
                isHighRes ? parts : [],
                currentState.resolution || '1K',
                { domain: currentState.gommoDomain || '', accessToken: currentState.gommoAccessToken || '' }
            );

            let imageUrl = rawImageUrl;
            let variants: string[] = [];

            // [MJ FIX] Detect Midjourney grid and split into 4 images
            if (isGridModel(modelToUse) && (rawImageUrl.startsWith('data:image') || rawImageUrl.startsWith('blob:'))) {
                try {
                    console.log('[ImageGen] 🧩 Midjourney grid detected, splitting...');
                    variants = await splitImageGrid(rawImageUrl);
                    if (variants.length === 4) {
                        imageUrl = variants[0]; // Use first one as default
                        console.log('[ImageGen] ✅ Grid split successful. Using variant 1.');
                    }
                } catch (e) {
                    console.error('[ImageGen] ❌ Failed to split Midjourney grid:', e);
                }
            }

            // TIMING: Log API call duration
            const apiTime = Date.now() - apiStartTime;
            const totalTime = Date.now() - startTime;
            console.log(`[ImageGen] ⏱️ API call: ${apiTime}ms | TOTAL: ${totalTime}ms`);

            // Calculate estimated prompt tokens (rough: ~4 chars per token)
            const estimatedTokens = Math.ceil(promptToSend.length / 4);
            console.log(`[ImageGen] 📊 Stats: Provider=${promptProvider}, EstTokens=${estimatedTokens}, Prompt=${promptToSend.length} chars`);

            // Auto-approve in DOP Learning if generation succeeded (NON-BLOCKING)
            // DISABLED: Only learn from explicit user rating/keeping.
            // If we auto-approve everything, we learn garbage.
            /* 
            if (dopRecordId && imageUrl) {
                // Fire and forget - don't block on DOP approval
                approvePrompt(dopRecordId, {
                    overall: 0.8, // Assume good quality if generation succeeded
                    match: 0.8
                }).then(() => {
                    console.log('[ImageGen] ✅ DOP approved (async):', dopRecordId);
                }).catch(e => {
                    console.warn('[ImageGen] DOP approval failed (async):', e);
                });
            }
            */

            updateStateAndRecord(s => {
                const duration = Date.now() - startTime;
                const resolutionKey = (currentState.resolution || '1K') as '1K' | '2K' | '4K';
                const currentStats = s.usageStats || { '1K': 0, '2K': 0, '4K': 0, total: 0 };
                const newCount = (currentStats[resolutionKey] || 0) + 1;

                const updatedStats = {
                    ...currentStats,
                    [resolutionKey]: newCount,
                    total: (currentStats.total || 0) + 1,
                    scenes: (currentStats.scenes || 0) + 1,
                    // Provider breakdown
                    geminiImages: (currentStats.geminiImages || 0) + (promptProvider === 'gemini' ? 1 : 0),
                    gommoImages: (currentStats.gommoImages || 0) + (promptProvider === 'gommo' ? 1 : 0),
                    estimatedPromptTokens: (currentStats.estimatedPromptTokens || 0) + estimatedTokens,
                    lastGeneratedAt: new Date().toISOString()
                };

                // Sync to Supabase if userId is present
                if (userId) {
                    syncUserStatsToCloud(userId, updatedStats);

                    // Track in GLOBAL stats (persists across projects)
                    incrementGlobalStats(userId, {
                        images: 1,
                        scenes: 1,
                        gemini: promptProvider === 'gemini' ? 1 : 0,
                        gommo: promptProvider === 'gommo' ? 1 : 0,
                        resolution1K: resolutionKey === '1K' ? 1 : 0,
                        resolution2K: resolutionKey === '2K' ? 1 : 0,
                        resolution4K: resolutionKey === '4K' ? 1 : 0,
                    });

                    // Record image to history
                    recordGeneratedImage(userId, {
                        projectId: currentState.projectName || 'unknown',
                        imageUrl: imageUrl,
                        generationType: 'scene',
                        sceneId: sceneId,
                        prompt: promptToSend,
                        modelId: modelToUse,
                        modelType: promptProvider,
                        aspectRatio: currentState.aspectRatio,
                        resolution: resolutionKey,
                    });
                }

                return {
                    ...s,
                    totalGenerationTime: (s.totalGenerationTime || 0) + duration,
                    scenes: s.scenes.map(sc => sc.id === sceneId ? {
                        ...sc,
                        generationDuration: duration,
                        generationStartTime: undefined,
                        ...(fromManual ? { endFrameImage: imageUrl } : { generatedImage: imageUrl }),
                        generatedByModel: currentState.imageModel, // Track which model generated this
                        mediaId: fromManual ? sc.mediaId : (mediaId || sc.mediaId),
                        isGenerating: false,
                        error: null,
                        // Store all 4 variants in editHistory for easy swapping
                        editHistory: variants.length > 0 ? [
                            ... (sc.editHistory || []),
                            ...variants.map((v, idx) => ({
                                id: `variant_${Date.now()}_${idx}`,
                                image: v,
                                prompt: `Midjourney Variant ${idx + 1}: ${finalImagePrompt}`
                            }))
                        ] : sc.editHistory,
                        // Use local dopRecordId or fallback to global (async DOP recording updates global)
                        dopRecordId: dopRecordId || (window as any).__lastDopRecordId || sc.dopRecordId
                    } : sc),
                    usageStats: updatedStats
                };
            });

            // Add to session gallery
            if (addToGallery) {
                if (variants.length > 0) {
                    // Add all variants to gallery so user can pick
                    variants.forEach((v, idx) => {
                        addToGallery(v, fromManual ? 'end-frame' : 'scene', `[Variant ${idx + 1}] ${finalImagePrompt}`, sceneId);
                    });
                } else {
                    addToGallery(imageUrl, fromManual ? 'end-frame' : 'scene', finalImagePrompt, sceneId);
                }
            }

            // === DIRECTOR BRAIN LEARNING ===
            // Record this generation for the evolving director memory
            try {
                const directorMemory = loadDirectorMemory();
                const activeDirectorId = currentState.activeDirectorId || 'default';
                const activeDirectorName = (() => {
                    const allDirectors = Object.values(DIRECTOR_PRESETS).flat();
                    const customDirectors = currentState.customDirectors || [];
                    const found = [...allDirectors, ...customDirectors].find(d => d.id === activeDirectorId);
                    return found?.name || 'Custom';
                })();

                const updatedMemory = recordDirectorGeneration(
                    directorMemory,
                    sceneId,
                    sceneToUpdate.contextDescription || '',
                    activeDirectorId,
                    activeDirectorName,
                    currentState.globalStylePrompt || '',
                    currentState.customMetaTokens || ''
                );
                saveDirectorMemory(updatedMemory, userId);
                console.log('[DirectorBrain] 🎬 Recorded generation. Total:', updatedMemory.totalGenerations);
            } catch (brainErr) {
                console.warn('[DirectorBrain] Failed to record generation:', brainErr);
            }

        } catch (error: any) {
            console.error("Image generation failed:", error);
            console.error("Full Error Details:", JSON.stringify(error, Object.getOwnPropertyNames(error)));

            // [Fix] STOP batch if we hit a rate limit, fatal credential error, or auth failure
            const errorMessage = error.message || "";
            const errorLower = errorMessage.toLowerCase();

            const isRateLimit = errorMessage.includes("429") ||
                errorLower.includes("quota") ||
                errorLower.includes("exhausted") ||
                errorLower.includes("limit");

            const isFatalAuth = errorLower.includes("api key") ||
                errorLower.includes("credentials") ||
                errorLower.includes("invalid") ||
                errorLower.includes("not found") ||
                errorLower.includes("permission");

            const isGommoError = errorLower.includes("gommo error");

            if (isRateLimit || isFatalAuth || isGommoError) {
                console.warn("[ImageGen] 🛑 Fatal API or Auth error detected. Stopping batch generation.");
                stopRef.current = true;
                setIsStopping(true);
            }

            updateStateAndRecord(s => ({
                ...s,
                scenes: s.scenes.map(sc => sc.id === sceneId ? {
                    ...sc,
                    isGenerating: false,
                    generationStartTime: undefined,
                    error: isRateLimit ? "Tạm thời hết hạn mức (Rate Limit). Vui lòng thử lại sau hoặc đổi API Key." : (error as Error).message
                } : sc)
            }));
        }
    }, [stateRef, userApiKey, updateStateAndRecord, setApiKeyModalOpen, userId]);

    const generateGroupConcept = useCallback(async (groupName: string, groupDescription: string, styleOverride?: string, customStyleOverride?: string) => {
        const currentState = stateRef.current;
        const apiKey = userApiKey || (process.env as any).API_KEY;

        if (!apiKey) {
            setApiKeyModalOpen(true);
            return null;
        }

        try {
            let styleInstruction = '';
            const effectiveStylePrompt = styleOverride || currentState.stylePrompt;
            const effectiveCustomStyle = styleOverride ? customStyleOverride : currentState.customStyleInstruction;

            if (effectiveStylePrompt === 'custom') {
                styleInstruction = effectiveCustomStyle || '';
            } else {
                const selectedStyle = GLOBAL_STYLES.find(s => s.value === effectiveStylePrompt);
                styleInstruction = selectedStyle ? selectedStyle.prompt : '';
            }

            const activePreset = getPresetById(currentState.activeScriptPreset, currentState.customScriptPresets);
            const metaTokens = currentState.customMetaTokens || DEFAULT_META_TOKENS[activePreset?.category || 'custom'] || DEFAULT_META_TOKENS['custom'];

            // Enhanced concept art prompt with specific artistic keywords
            const conceptPrompt = `PROFESSIONAL ENVIRONMENT CONCEPT ART: Location "${groupName}". 
            DESCRIPTION: ${groupDescription}. 
            STYLE: ${styleInstruction} ${metaTokens}. 
            COMPOSITION: Master shot, architectural visualization, cinematic wide angle, high-level set design, matte painting, Unreal Engine 5 render style. 
            MANDATORY: Focus on spatial layout, atmospheric lighting, and materials (wood, stone, metal). 
            !!! ABSOLUTELY NO PEOPLE, NO HUMANS, NO CHARACTERS, NO FACES !!! focus purely on the empty world and set design.`.trim();

            const { imageUrl } = await callAIImageAPI(
                conceptPrompt,
                userApiKey,
                currentState.imageModel || 'gemini-3-pro-image-preview',
                currentState.aspectRatio,
                [], // No parts for concept art
                currentState.resolution || '1K',
                { domain: currentState.gommoDomain || '', accessToken: currentState.gommoAccessToken || '' }
            );

            if (imageUrl) {
                // Increment Usage Stats
                updateStateAndRecord(s => {
                    const resolutionKey = (currentState.resolution || '1K') as '1K' | '2K' | '4K';
                    const currentStats = s.usageStats || { '1K': 0, '2K': 0, '4K': 0, total: 0 };

                    const updatedStats = {
                        ...currentStats,
                        [resolutionKey]: (currentStats[resolutionKey] || 0) + 1,
                        total: (currentStats.total || 0) + 1,
                        concepts: (currentStats.concepts || 0) + 1,
                        lastGeneratedAt: new Date().toISOString()
                    };

                    if (userId) {
                        syncUserStatsToCloud(userId, updatedStats);
                    }

                    return {
                        ...s,
                        usageStats: updatedStats
                    };
                });

                if (addToGallery) {
                    addToGallery(imageUrl, 'concept', conceptPrompt, groupName);
                }
            }

            return imageUrl;
        } catch (error) {
            console.error("Concept generation failed:", error);
            return null;
        }
    }, [stateRef, userApiKey, setApiKeyModalOpen, userId]);

    // specificSceneIds: Optional list of specific IDs to regenerate
    // referenceMap: Optional mapping of sceneId -> sourceImageURL for DNA syncing
    // baseImageMap: Optional mapping of sceneId -> baseImageURL for Img2Img editing from a specific source
    const handleGenerateAllImages = useCallback(async (specificSceneIds?: string[], referenceMap?: { [key: string]: string }, baseImageMap?: { [key: string]: string }) => {
        console.log('[BatchGen] handleGenerateAllImages called', { specificSceneIds, hasReferenceMap: !!referenceMap, hasBaseImageMap: !!baseImageMap });

        const allScenesToGenerate = specificSceneIds
            ? stateRef.current.scenes.filter(s => specificSceneIds.includes(s.id))
            : stateRef.current.scenes.filter(s => !s.generatedImage && s.contextDescription);

        // Generation Lock: Filter out scenes that are already being generated
        const scenesToGenerate = allScenesToGenerate.filter(scene => {
            if (generatingSceneIdsRef.current.has(scene.id)) {
                console.warn(`[BatchGen] ⏸️ Scene ${scene.sceneNumber} (${scene.id}) already generating, skipping duplicate request`);
                return false;
            }
            return true;
        });

        // Mark all scenes as generating
        scenesToGenerate.forEach(scene => generatingSceneIdsRef.current.add(scene.id));

        console.log('[BatchGen] Scenes to generate:', scenesToGenerate.length, '(filtered from', allScenesToGenerate.length, ')');

        if (scenesToGenerate.length === 0) {
            console.log('[BatchGen] No scenes to generate (all duplicates or empty), returning');
            return; // Don't show alert if we filtered out duplicates
        }

        // PRE-WARM CACHE: Load all character/product reference images upfront
        // This significantly speeds up first image generation
        const currentState = stateRef.current;
        const allRefImages: string[] = [];

        // Collect character images
        (currentState.characters || []).forEach(char => {
            if (char.masterImage) allRefImages.push(char.masterImage);
            if (char.faceImage) allRefImages.push(char.faceImage);
            if (char.bodyImage && char.bodyImage !== char.masterImage) allRefImages.push(char.bodyImage);
        });

        // Collect product images
        (currentState.products || []).forEach(prod => {
            if (prod.image) allRefImages.push(prod.image);
        });

        // Collect custom style and DNA images
        if (currentState.customStyleImage) allRefImages.push(currentState.customStyleImage);

        // Collect group concept images
        currentState.sceneGroups?.forEach(g => {
            if (g.conceptImage) allRefImages.push(g.conceptImage);
        });

        // Pre-warm in background (don't await, just start loading)
        if (allRefImages.length > 0) {
            console.log(`[BatchGen] 🔥 Pre-warming cache with ${allRefImages.length} reference images...`);
            preWarmImageCache(allRefImages).then(count => {
                console.log(`[BatchGen] ✅ Cache pre-warmed: ${count} images ready`);
            });
        }

        setIsBatchGenerating(true);
        setIsStopping(false);
        stopRef.current = false;

        console.log('[BatchGen] Starting batch generation...');
        const batchStartTime = Date.now();
        setAgentState('director', 'thinking', 'Đang lập kế hoạch sản xuất cho các phân cảnh...');
        setAgentState('dop', 'idle', '');

        try {
            // KEY FRAME STRATEGY: Generate Key Frames FIRST within each group
            // This ensures hero shots are available as references for other scenes
            const sortedScenes = [...scenesToGenerate].sort((a, b) => {
                // Key frames first
                if (a.isKeyFrame && !b.isKeyFrame) return -1;
                if (!a.isKeyFrame && b.isKeyFrame) return 1;
                // Then by scene number
                return parseInt(a.sceneNumber) - parseInt(b.sceneNumber);
            });

            const keyFrameCount = sortedScenes.filter(s => s.isKeyFrame).length;
            if (keyFrameCount > 0) {
                console.log(`[BatchGen] ⭐ Key Frame Strategy: ${keyFrameCount} key frames will be generated first`);
            }

            for (let i = 0; i < sortedScenes.length; i++) {
                const scene = sortedScenes[i];
                if (stopRef.current) break;

                setAgentState('director', 'speaking', `Đang chỉ đạo Phân cảnh ${scene.sceneNumber}...`);

                // STORYBOARD MODE: Find cascade reference from same group for visual consistency
                const cascadeRef = findCascadeReference(scene, stateRef.current);

                // Check if this scene has a specific DNA reference image (from Reference Map OR Scene Attributes)
                // Priority: explicit referenceMap > scene.referenceImage > cascadeReference
                const dnaReference = (referenceMap && referenceMap[scene.id]) || scene.referenceImage || cascadeRef || undefined;

                // Check if scene ALREADY has an image -> Treat as Base Image for Editing
                // PRIORITIZE explicitly passed baseImageMap
                const existingBaseImage = (baseImageMap && baseImageMap[scene.id]) || scene.generatedImage || undefined;

                const result = await performImageGeneration(scene.id, undefined, false, dnaReference, existingBaseImage);

                if (result === 'critical_error') {
                    console.warn(`[BatchGen] ⚠️ CRITICAL DOP ERROR in Scene ${scene.sceneNumber}. Marking as unfixable but CONTINUING batch.`);
                    // We do NOT break here anymore, per user request.
                    // The scene is already marked as error in state by performImageGeneration.
                }

                setAgentState('director', 'success', `Đã xử lý xong Phân cảnh ${scene.sceneNumber}.`);


                // Get the newly generated image
                const updatedState = stateRef.current;
                const updatedScene = updatedState.scenes.find(s => s.id === scene.id);
                const currentImage = updatedScene?.generatedImage;

                // DOP Vision Validation - Re-enabled for raccord checking
                // Validates visual continuity with previous scene
                // User toggle: isDOPEnabled from state
                if (isDOPEnabled && validateRaccordWithVision && currentImage && userApiKey) {
                    const currentSceneIndex = updatedState.scenes.findIndex(s => s.id === scene.id);
                    const prevScene = currentSceneIndex > 0 ? updatedState.scenes[currentSceneIndex - 1] : null;

                    if (prevScene?.generatedImage) {
                        setAgentState('dop', 'thinking', 'Đang kiểm tra tính nhất quán (Raccord) với cảnh trước...');
                        console.log('[DOP] Validating raccord between scenes...');


                        // [DOP UI FEEDBACK] Show validation in progress
                        updateStateAndRecord(s => ({
                            ...s,
                            scenes: s.scenes.map(sc => sc.id === scene.id ? {
                                ...sc,
                                error: '🎬 DOP đang kiểm tra...'
                            } : sc)
                        }));

                        // Max 1 retry: If still wrong, show error message for user review
                        let MAX_DOP_RETRIES = 1;
                        let retryCount = 0;
                        let lastValidation = await validateRaccordWithVision(
                            currentImage,
                            prevScene.generatedImage,
                            updatedScene!,
                            prevScene,
                            userApiKey
                        );

                        // DEBUG: Log full validation result
                        console.log('[DOP] Validation result:', {
                            isValid: lastValidation.isValid,
                            errorCount: lastValidation.errors?.length || 0,
                            errors: lastValidation.errors,
                            decision: lastValidation.decision
                        });

                        // Filter for critical errors (warrant regen)
                        // character: face/identity wrong
                        // prop: items missing/wrong
                        // spatial: background/environment wrong
                        const criticalErrors = lastValidation.errors.filter(e =>
                            e.type === 'character' || e.type === 'prop' || e.type === 'spatial'
                        );

                        console.log('[DOP] Critical errors:', criticalErrors.length, criticalErrors);

                        // FIX: If validation passed OR no critical errors, clear the checking status immediately
                        if (lastValidation.isValid || criticalErrors.length === 0) {
                            updateStateAndRecord(s => ({
                                ...s,
                                scenes: s.scenes.map(sc => sc.id === scene.id ? {
                                    ...sc,
                                    error: lastValidation.isValid ? null : `ℹ️ Minor issues (non-critical): ${lastValidation.errors.map(e => e.description).join('; ')}`
                                } : sc)
                            }));

                            if (lastValidation.isValid) {
                                console.log('[DOP] Raccord validation PASSED - clearing status');
                                setAgentState('dop', 'success', `Cảnh ${scene.sceneNumber} khớp raccord hoàn hảo!`);
                            } else {
                                console.log('[DOP] Only minor issues found - continuing without retry');
                                setAgentState('dop', 'idle', '');
                            }
                        }

                        // Use Decision Agent if available, otherwise use simple retry logic
                        if (!lastValidation.isValid && criticalErrors.length > 0) {
                            console.log(`[DOP] RACCORD ERROR DETECTED:`, criticalErrors);

                            // Get original prompt for decision agent
                            const originalPrompt = updatedScene?.contextDescription || '';

                            // Ask Decision Agent if we should retry
                            let shouldRetry = true;
                            let enhancedCorrection = lastValidation.correctionPrompt;

                            if (makeRetryDecision && currentImage) {
                                setAgentState('dop', 'speaking', 'Phát hiện lỗi Raccord! Đang phân tích khả năng sửa đổi...');
                                console.log('[DOP Agent] Analyzing if retry will succeed...');


                                // [DOP UI FEEDBACK] Show decision agent thinking
                                updateStateAndRecord(s => ({
                                    ...s,
                                    scenes: s.scenes.map(sc => sc.id === scene.id ? {
                                        ...sc,
                                        error: '🧠 DOP Agent đang phân tích lỗi...'
                                    } : sc)
                                }));

                                const decision = await makeRetryDecision(
                                    currentImage,
                                    prevScene.generatedImage,
                                    originalPrompt,
                                    criticalErrors,
                                    userApiKey
                                );

                                console.log('[DOP Agent] Decision:', decision);

                                // ALWAYS TRY ONCE before giving up
                                // Decision Agent now only affects enhancement prompt, not skip decision
                                if (decision.action === 'skip' && retryCount === 0) {
                                    console.log('[DOP Agent] Would skip, but forcing 1 retry first');
                                    // Still try once with enhanced correction
                                    if (decision.enhancedPrompt) {
                                        enhancedCorrection = decision.enhancedPrompt;
                                    }
                                    // Mark that this is a "last chance" retry
                                    MAX_DOP_RETRIES = 1;
                                } else if (decision.action === 'skip' && retryCount >= 1) {
                                    // Already retried once, now truly skip
                                    console.log('[DOP Agent] SKIP after 1 retry - errors are unfixable');
                                    shouldRetry = false;

                                    // FIX: Clear checking status and show clear unfixable message
                                    const unfixableMsg = decision.reason.includes('face') || decision.reason.includes('identity')
                                        ? `🚫 UNFIXABLE: Nhân vật khác (AI không thể sửa - cần chọn reference khác)`
                                        : `⚠️ DOP: Đã retry 1 lần nhưng vẫn lỗi - ${decision.reason}`;

                                    updateStateAndRecord(s => ({
                                        ...s,
                                        scenes: s.scenes.map(sc => sc.id === scene.id ? {
                                            ...sc,
                                            error: unfixableMsg,
                                            dopFailed: true
                                        } : sc)
                                    }));

                                    setAgentState('dop', 'error', 'Lỗi không thể sửa sau 1 retry');
                                    if (addProductionLog) {
                                        addProductionLog('dop', unfixableMsg, 'warning');
                                    }
                                } else if (decision.action === 'try_once') {
                                    MAX_DOP_RETRIES = 1;
                                    if (decision.enhancedPrompt) {
                                        enhancedCorrection = decision.enhancedPrompt;
                                    }
                                } else if (decision.enhancedPrompt) {
                                    enhancedCorrection = decision.enhancedPrompt;
                                }
                            }

                            // Only retry if Decision Agent approves
                            while (shouldRetry && !lastValidation.isValid && retryCount < MAX_DOP_RETRIES) {
                                // [Fix] Check stop signal inside retry loop
                                if (stopRef.current) {
                                    console.log('[DOP] Batch stopped during retry.');
                                    break;
                                }

                                console.log(`[DOP] Retrying with enhanced correction (attempt ${retryCount + 1}/${MAX_DOP_RETRIES})`);

                                // Clear the bad image and regenerate with correction
                                updateStateAndRecord(s => ({
                                    ...s,
                                    scenes: s.scenes.map(sc => sc.id === scene.id ? {
                                        ...sc,
                                        generatedImage: null,
                                        error: `DOP Retry ${retryCount + 1}: ${lastValidation.errors.filter(e => e.type === 'character' || e.type === 'prop').map(e => e.description).join('; ')}`
                                    } : sc)
                                }));

                                // Wait a bit then regenerate with enhanced correction prompt
                                await new Promise(r => setTimeout(r, 500));

                                console.log('[DOP] Auto-regenerating with correction:', enhancedCorrection);

                                // Construct Negative Prompt based on specific errors
                                const negativeConstraints: string[] = [];
                                let retryBoost = '';

                                lastValidation.errors.forEach(e => {
                                    const desc = e.description.toLowerCase();
                                    if (e.type === 'character' || desc.includes('face') || desc.includes('person')) {
                                        negativeConstraints.push('wrong person', 'different face', 'extra people', 'ugly face', 'distorted face');
                                        // STRONG IDENTITY FIX
                                        retryBoost += ' !!! CRITICAL IDENTITY LOCK !!! Match the EXACT face from Face ID reference. Copy facial bone structure, eye shape, nose, mouth PRECISELY. Do NOT create a new person. ';
                                    }
                                    if (e.type === 'prop' || desc.includes('missing')) {
                                        negativeConstraints.push('missing object', 'floating objects', 'bad hands', 'mutated');
                                        retryBoost += ' Ensure ALL props from the scene are VISIBLE and correctly positioned. ';
                                    }
                                    if (e.type === 'lighting') {
                                        negativeConstraints.push('bad lighting', 'wrong exposure', 'dark image');
                                    }
                                    if (e.type === 'spatial' || desc.includes('scale') || desc.includes('perspective') || desc.includes('floating')) {
                                        negativeConstraints.push('same background', 'floating furniture', 'double exposure', 'collage', 'surreal', 'bad perspective');
                                    }
                                    if (desc.includes('static background') || desc.includes('identical') || desc.includes('wallpaper')) {
                                        negativeConstraints.push('static background', 'identical composition', 'same pixels', 'exact match', 'repetitive');
                                        // JITTER FIX: Force camera movement
                                        retryBoost += ' (CAMERA MOVEMENT: Shift angle slightly! Dynamic perspective change! Do not reuse exact background pixels!) ';
                                    }
                                    if (desc.includes('outfit') || desc.includes('clothing') || desc.includes('costume')) {
                                        retryBoost += ' OUTFIT LOCK: Character MUST wear the EXACT same clothes as in the reference. Copy colors, patterns, accessories. ';
                                    }
                                });

                                const negativePrompt = negativeConstraints.length > 0
                                    ? `(${[...new Set(negativeConstraints)].join(', ')})`
                                    : undefined;

                                // Construct enhanced retry prompt with corrections
                                const retryPrompt = `${retryBoost}${enhancedCorrection || ''}`.trim() || undefined;

                                console.log('[DOP] Retry with identity boost:', retryBoost?.substring(0, 100) || '');

                                // Pass previous scene image as reference for continuity
                                await performImageGeneration(scene.id, retryPrompt, false, prevScene.generatedImage, undefined, negativePrompt);

                                // Re-validate
                                const reUpdatedState = stateRef.current;
                                const reUpdatedScene = reUpdatedState.scenes.find(s => s.id === scene.id);
                                const newImage = reUpdatedScene?.generatedImage;

                                if (newImage) {
                                    lastValidation = await validateRaccordWithVision(
                                        newImage,
                                        prevScene.generatedImage,
                                        reUpdatedScene!,
                                        prevScene,
                                        userApiKey
                                    );

                                    // [Fix] Re-evaluate critical errors to determine if we should continue retrying
                                    const currentCriticalErrors = lastValidation.errors.filter(e =>
                                        e.type === 'character' || e.type === 'prop'
                                    );

                                    // If no critical errors remain (only minor ones), stop retrying
                                    if (currentCriticalErrors.length === 0) {
                                        console.log('[DOP] Critical errors resolved. Stopping retries.');
                                        break;
                                    }
                                } else {
                                    // If generation failed (no image), stick with previous validation result or break
                                    console.warn('[DOP] Retry generation failed to produce image.');
                                    break;
                                }

                                retryCount++;
                            }
                        }

                        if (retryCount >= MAX_DOP_RETRIES && !lastValidation.isValid) {
                            console.warn('[DOP] Max retries reached. Marking scene as FAILED but CONTINUING batch.');
                            if (addProductionLog) {
                                addProductionLog('dop', `⚠️ Cảnh ${scene.sceneNumber} lỗi raccord - đã bỏ qua. Tiếp tục cảnh tiếp theo.`, 'warning');
                            }

                            // Mark scene as failed with clear error message
                            updateStateAndRecord(s => ({
                                ...s,
                                scenes: s.scenes.map(sc => sc.id === scene.id ? {
                                    ...sc,
                                    // Keep the generated image but mark as needs review
                                    error: `⚠️ DOP FAILED: ${lastValidation.errors.map(e => e.description).join('; ')} - Cần review thủ công`,
                                    dopFailed: true // Flag for next scene to skip this as reference
                                } : sc)
                            }));

                            setAgentState('dop', 'error', `Cảnh ${scene.sceneNumber} lỗi - tiếp tục cảnh sau`);

                            // DO NOT RETURN - Continue to next scene
                            // Next scene will check dopFailed flag and use last GOOD scene as reference
                        } else if (lastValidation.isValid) {
                            console.log('[DOP] Raccord validation PASSED');
                            if (addProductionLog) {
                                addProductionLog('dop', `Cảnh ${scene.sceneNumber} khớp raccord hoàn hảo. Tiếp tục sản xuất.`, 'success');
                            }
                            // [DOP UI FEEDBACK] Clear status on success
                            updateStateAndRecord(s => ({
                                ...s,
                                scenes: s.scenes.map(sc => sc.id === scene.id ? {
                                    ...sc,
                                    error: null, // Clear the status indicator
                                    dopFailed: false // This is a GOOD reference for future scenes
                                } : sc)
                            }));

                            setAgentState('dop', 'success', `Cảnh ${scene.sceneNumber} khớp raccord hoàn hảo!`);
                        }

                    }
                }

                const imageDelay = state.generationConfig?.imageDelay || 500;
                await new Promise(r => setTimeout(r, imageDelay));
            }
        } catch (e) {
            console.error('[BatchGen] Generation interrupted:', e);
            setAgentState('director', 'error', 'Có lỗi xảy ra khi tạo ảnh.');
        } finally {
            // Generation Lock Cleanup: Remove all scene IDs that were being generated
            scenesToGenerate.forEach(scene => generatingSceneIdsRef.current.delete(scene.id));
            console.log('[BatchGen] Cleaned up generation lock for', scenesToGenerate.length, 'scenes');

            setIsBatchGenerating(false);
            setIsStopping(false);
            setAgentState('dop', 'idle', '');

            if (!stopRef.current) {
                const batchDuration = Date.now() - batchStartTime;
                const seconds = Math.floor(batchDuration / 1000);
                const timeStr = seconds > 60 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${seconds}s`;

                setAgentState('director', 'success', `Đã hoàn thành! Tổng thời gian: ${timeStr}`);
                if (addProductionLog) {
                    addProductionLog('director', `Production hoàn tất. Thời gian thực thi: ${timeStr}`, 'success');
                }
            } else {
                setAgentState('director', 'idle', 'Đã dừng production.');
            }
        }
    }, [state.scenes, performImageGeneration, isDOPEnabled, validateRaccordWithVision, makeRetryDecision, userApiKey, stateRef, updateStateAndRecord, setAgentState]);


    return {
        isBatchGenerating,
        isStopping,
        performImageGeneration,
        generateGroupConcept,
        handleGenerateAllImages,
        stopBatchGeneration
    };
}
