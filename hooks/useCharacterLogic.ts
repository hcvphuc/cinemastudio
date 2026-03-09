import { useCallback } from 'react';
import { ProjectState, Character } from '../types';
import { generateId } from '../utils/helpers';
import { GLOBAL_STYLES, CHARACTER_STYLES } from '../constants/presets';
import { getCharacterStyleById } from '../constants/characterStyles';
import { callGeminiAPI, callCharacterImageAPI, callGeminiVisionReasoning } from '../utils/geminiUtils';
import { uploadImageToSupabase, syncUserStatsToCloud } from '../utils/storageUtils';
import { normalizePromptAsync, needsNormalization, containsVietnamese, formatNormalizationLog } from '../utils/promptNormalizer';
import { recordPrompt, approvePrompt, searchSimilarPrompts } from '../utils/dopLearning';
import { performQualityCheck, shouldAutoRetry, generateRefinedPrompt } from '../utils/qualityScoring';
import { analyzeAndEnhance, predictSuccess, getInsights } from '../utils/dopIntelligence';
import { incrementGlobalStats, recordGeneratedImage } from '../utils/userGlobalStats';

export function useCharacterLogic(
    state: ProjectState,
    updateStateAndRecord: (updater: (prevState: ProjectState) => ProjectState) => void,
    userApiKey: string | null,
    setApiKeyModalOpen: (open: boolean) => void,
    userId?: string,
    addToGallery?: (image: string, type: string, prompt?: string, sourceId?: string) => void,
    setAgentState?: (agent: 'director' | 'dop', status: any, message?: string, stage?: string) => void

) {
    const updateCharacter = useCallback((id: string, updates: Partial<Character>) => {
        updateStateAndRecord(s => ({
            ...s,
            characters: s.characters.map(c => c.id === id ? { ...c, ...updates } : c)
        }));
    }, [updateStateAndRecord]);

    const addCharacter = useCallback(() => {
        const newChar: Character = {
            id: generateId(),
            name: '',
            description: '',
            masterImage: null,
            faceImage: null,
            bodyImage: null,
            sideImage: null,
            backImage: null,
            characterSheet: null,
            props: [
                { id: generateId(), name: '', image: null },
                { id: generateId(), name: '', image: null },
                { id: generateId(), name: '', image: null },
            ],
            isDefault: false,
            isAnalyzing: false,
        };
        updateStateAndRecord(s => ({
            ...s,
            characters: [...s.characters, newChar]
        }));
    }, [updateStateAndRecord]);

    const deleteCharacter = useCallback((id: string) => {
        if (state.characters.length <= 1) {
            alert("Bạn cần ít nhất 1 nhân vật.");
            return;
        }
        setTimeout(() => {
            if (confirm("Bạn có chắc muốn xóa nhân vật này?")) {
                updateStateAndRecord(s => ({
                    ...s,
                    characters: s.characters.filter(c => c.id !== id)
                }));
            }
        }, 100);
    }, [state.characters.length, updateStateAndRecord]);

    const setDefaultCharacter = useCallback((id: string) => {
        updateStateAndRecord(s => ({
            ...s,
            characters: s.characters.map(c => ({
                ...c,
                isDefault: c.id === id
            }))
        }));
    }, [updateStateAndRecord]);

    const analyzeCharacterImage = useCallback(async (id: string, image: string) => {
        const rawApiKey = userApiKey || (process.env as any).API_KEY;
        const apiKey = typeof rawApiKey === 'string' ? rawApiKey.trim() : rawApiKey;
        updateCharacter(id, { isAnalyzing: true, generationStartTime: Date.now() });

        try {
            let data: string;
            let mimeType: string = 'image/jpeg';
            let finalMasterUrl = image;

            if (image.startsWith('data:')) {
                const [header, base64Data] = image.split(',');
                data = base64Data;
                mimeType = header.match(/:(.*?);/)?.[1] || 'image/jpeg';

                if (userId) {
                    try {
                        finalMasterUrl = await uploadImageToSupabase(image, 'project-assets', `${userId}/characters/${id}_master_${Date.now()}.jpg`);
                    } catch (e) {
                        console.error("Cloud upload failed for master image", e);
                    }
                }
            } else if (image.startsWith('blob:')) {
                const blobRes = await fetch(image);
                const blob = await blobRes.blob();
                mimeType = blob.type || 'image/jpeg';
                data = await new Promise<string>((resolve, reject) => {
                    const reader = new FileReader();
                    reader.onloadend = () => resolve((reader.result as string).split(',')[1]);
                    reader.onerror = reject;
                    reader.readAsDataURL(blob);
                });
                finalMasterUrl = image;
            } else if (image.startsWith('http')) {
                const imgRes = await fetch(image);
                if (!imgRes.ok) throw new Error(`Fetch failed`);
                const blob = await imgRes.blob();
                mimeType = blob.type || 'image/jpeg';
                data = await new Promise<string>((resolve, reject) => {
                    const reader = new FileReader();
                    reader.onloadend = () => resolve((reader.result as string).split(',')[1]);
                    reader.onerror = reject;
                    reader.readAsDataURL(blob);
                });
                finalMasterUrl = image;
            } else {
                throw new Error("Invalid image format");
            }

            const analyzePrompt = `You are a character analysis AI. Return ONLY a JSON object, no markdown. Analyze this character: {"name": "Short English name", "description": "Vietnamese description of key physical traits, clothing, and overall vibe (2-3 sentences)"}. RESPOND WITH JSON ONLY.`;

            // Smart routing: Imperial Vertex → Gemini Direct (no hardcoded GoogleGenAI)
            console.log('[Analyze] 🔍 Using smart vision routing (Imperial → Gemini)');
            const analysisText = await callGeminiVisionReasoning(apiKey || '', analyzePrompt, [{ data, mimeType }]);

            let json = { name: "", description: "" };
            try {
                json = JSON.parse(analysisText.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim());
            } catch (e) {
                try {
                    const jsonMatch = analysisText.match(/\{[\s\S]*?"name"[\s\S]*?"description"[\s\S]*?\}/);
                    if (jsonMatch) {
                        json = JSON.parse(jsonMatch[0]);
                    } else {
                        const nameMatch = analysisText.match(/"name"\s*:\s*"([^"]+)"/);
                        const descMatch = analysisText.match(/"description"\s*:\s*"([^"]+)"/);
                        if (nameMatch || descMatch) {
                            json = { name: nameMatch?.[1] || "", description: descMatch?.[1] || "" };
                        }
                    }
                } catch (e2) {
                    console.error("[Analyze] ❌ JSON extraction failed", e2);
                }
            }

            updateCharacter(id, {
                masterImage: finalMasterUrl,
                name: json.name || "Unnamed Character",
                description: json.description || "",
                isAnalyzing: false
            });

        } catch (error: any) {
            console.error("Analysis Failed", error);
            updateCharacter(id, { isAnalyzing: false });
        }
    }, [userApiKey, updateCharacter, userId]);

    // Combined function: Analyze + Generate Face ID & Body in one step
    const analyzeAndGenerateSheets = useCallback(async (id: string, image: string, options?: { skipMetadata?: boolean }) => {
        const rawApiKey = userApiKey || (process.env as any).API_KEY;
        const apiKey = typeof rawApiKey === 'string' ? rawApiKey.trim() : rawApiKey;

        updateCharacter(id, { isAnalyzing: true, generationStartTime: Date.now() });

        try {
            let data: string;
            let mimeType: string = 'image/jpeg';
            let finalMasterUrl = image;

            console.log('[Lora Gen] Starting image processing with smart routing...', {
                isBase64: image.startsWith('data:'),
                isUrl: image.startsWith('http')
            });

            // Convert image to base64 if needed
            if (image.startsWith('data:')) {
                const [header, base64Data] = image.split(',');
                data = base64Data;
                mimeType = header.match(/:(.*?);/)?.[1] || 'image/jpeg';

                if (userId) {
                    try {
                        finalMasterUrl = await uploadImageToSupabase(image, 'project-assets', `${userId}/characters/${id}_master_${Date.now()}.jpg`);
                    } catch (e) {
                        console.error("[Lora Gen] Cloud upload failed for master image", e);
                    }
                }
            } else if (image.startsWith('blob:')) {
                const blobRes = await fetch(image);
                const blob = await blobRes.blob();
                mimeType = blob.type || 'image/jpeg';
                data = await new Promise<string>((resolve, reject) => {
                    const reader = new FileReader();
                    reader.onloadend = () => resolve((reader.result as string).split(',')[1]);
                    reader.onerror = reject;
                    reader.readAsDataURL(blob);
                });
                finalMasterUrl = image;
            } else if (image.startsWith('http')) {
                try {
                    const imgRes = await fetch(image, { mode: 'cors' });
                    if (!imgRes.ok) throw new Error(`Fetch failed: ${imgRes.status}`);
                    const blob = await imgRes.blob();
                    mimeType = blob.type || 'image/jpeg';
                    data = await new Promise<string>((resolve, reject) => {
                        const reader = new FileReader();
                        reader.onloadend = () => resolve((reader.result as string).split(',')[1]);
                        reader.onerror = reject;
                        reader.readAsDataURL(blob);
                    });
                    finalMasterUrl = image;
                } catch (fetchError: any) {
                    throw new Error(`Cannot fetch image from URL: ${fetchError.message}`);
                }
            } else {
                throw new Error("Invalid image format");
            }

            // Step 1: Analyze the character with Smart Vision (Imperial → Gemini)
            const analyzePrompt = `You are a character analysis AI. Analyze this character image and return ONLY a JSON object. No markdown, no explanation, no code blocks — PURE JSON ONLY.

{
    "name": "Short English name (1-2 words)",
    "description": "Vietnamese description with SPECIFIC physical traits: face shape, skin tone, hair color/style, eye shape, clothing/costume details, accessories",
    "art_style": "Accurate style description in English. Examples: 'Digital painting with warm tones', 'Anime cel-shaded', 'Semi-realistic illustration'",
    "is_illustration": true or false
}

RULES:
- name: SHORT, MEMORABLE English name (1-2 words max)
- description: Write in Vietnamese, be VERY SPECIFIC about costume details, colors, patterns
- is_illustration: true if NOT photorealistic

RESPOND WITH JSON ONLY. No other text.`;

            // Smart routing: Imperial Vertex → Gemini Direct (no hardcoded GoogleGenAI)
            const currentChar = state.characters.find(c => c.id === id);
            console.log('[Lora Gen] 🔍 Using smart vision routing (Imperial → Gemini)');
            const analysisText = await callGeminiVisionReasoning(apiKey || '', analyzePrompt, [{ data, mimeType }]);

            let json = { name: "", description: "", art_style: "", is_illustration: false };
            try {
                const cleaned = analysisText.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
                json = JSON.parse(cleaned);
            } catch (e) {
                console.warn("[Lora Gen] Direct JSON parse failed, trying extraction...");
                try {
                    const jsonMatch = analysisText.match(/\{[\s\S]*?"name"[\s\S]*?"description"[\s\S]*?\}/);
                    if (jsonMatch) {
                        json = JSON.parse(jsonMatch[0]);
                    } else {
                        const nameMatch = analysisText.match(/"name"\s*:\s*"([^"]+)"/);
                        const descMatch = analysisText.match(/"description"\s*:\s*"([^"]+)"/);
                        const styleMatch = analysisText.match(/"art_style"\s*:\s*"([^"]+)"/);
                        const illustMatch = analysisText.match(/"is_illustration"\s*:\s*(true|false)/);
                        if (nameMatch || descMatch) {
                            json = {
                                name: nameMatch?.[1] || "",
                                description: descMatch?.[1] || "",
                                art_style: styleMatch?.[1] || "",
                                is_illustration: illustMatch?.[1] === 'true'
                            };
                        }
                    }
                } catch (e2) {
                    console.error("[Lora Gen] ❌ All JSON extraction attempts failed", e2);
                }
            }

            const charName = json.name || "Unnamed Character";
            const charDescription = json.description || "Character";
            let detectedStyle = json.art_style || "Digital illustration style";

            if (json.is_illustration) {
                detectedStyle = `ILLUSTRATION/PAINTED STYLE: ${detectedStyle}. This is NOT photorealistic.`;
            }

            const finalName = options?.skipMetadata ? (currentChar?.name || charName) : charName;
            const finalDescription = options?.skipMetadata ? (currentChar?.description || charDescription) : charDescription;

            updateCharacter(id, {
                masterImage: finalMasterUrl,
                name: finalName,
                description: finalDescription
            });

            // Step 2: Generate Character Sheet (single image with multiple views)
            let characterStyleInstruction = '';
            if (state.globalCharacterStyleId) {
                const charStyle = getCharacterStyleById(state.globalCharacterStyleId, state.customCharacterStyles || []);
                if (charStyle) {
                    characterStyleInstruction = `\nCharacter style: ${charStyle.promptInjection.global}\n`;
                    console.log('[Character Gen] Using character style preset:', charStyle.name);
                }
            }

            const sheetPrompt = `Character reference sheet. 4 columns × 2 rows grid layout. 8 panels total separated by thin borders on plain gray background.

TOP ROW — 4 full-body standing poses (head to toe):
[Front view] [Left profile] [Right profile] [Back view]

BOTTOM ROW — 4 close-up head-and-shoulders portraits matching the angles above:
[Front portrait] [Left portrait] [Right portrait] [Back-of-head portrait]

Character: ${finalDescription}.
Copy the exact same character from the reference image — same design, colors, outfit, proportions in all 8 panels.
${characterStyleInstruction}Photorealistic, DSLR, muted tones. No text.`.trim();

            // Model priority: character's preferred → global image model → default
            const model = currentChar?.preferredModel || state.imageModel || 'gemini-3-pro-image-preview';

            const gommoCredentials = state.gommoDomain && state.gommoAccessToken
                ? { domain: state.gommoDomain, accessToken: state.gommoAccessToken }
                : undefined;

            console.log(`[CharSheet] 🎨 Generating character sheet for ${finalName}`);
            console.log(`  ├─ Model: ${model}`);
            console.log(`  └─ Style: ${detectedStyle}`);
            let sheetUrl = await callCharacterImageAPI(apiKey, sheetPrompt, "16:9", model, image, gommoCredentials);

            if (!sheetUrl) {
                throw new Error('Character sheet generation returned no image');
            }

            // Upload sheet to cloud if available
            let cloudSheetUrl = sheetUrl;
            if (userId && sheetUrl.startsWith('data:')) {
                try {
                    cloudSheetUrl = await uploadImageToSupabase(sheetUrl, 'project-assets', `${userId}/characters/${id}_sheet_${Date.now()}.jpg`);
                } catch (e) {
                    console.warn('[CharSheet] Cloud upload failed for sheet, using local data');
                }
            }

            console.log(`[CharSheet] ✅ Character sheet ready for ${finalName} — 1 image, all angles`);

            updateCharacter(id, {
                characterSheet: cloudSheetUrl,
                sheetGenMode: 'sheet',
                isAnalyzing: false
            });

        } catch (error: any) {
            console.error("[Lora Gen] ❌ Analyze and Generate Failed", error);
            updateCharacter(id, { isAnalyzing: false });
        }
    }, [userApiKey, updateCharacter, userId, state.imageModel, state.characters, state.globalCharacterStyleId, state.customCharacterStyles, state.gommoDomain, state.gommoAccessToken]);

    const generateCharacterSheets = useCallback(async (id: string) => {
        const char = state.characters.find(c => c.id === id);
        if (!char || !char.masterImage) return;

        updateCharacter(id, { isAnalyzing: true, generationStartTime: Date.now() });

        try {
            const rawApiKey = userApiKey || (process.env as any).API_KEY;
            const apiKey = typeof rawApiKey === 'string' ? rawApiKey.trim() : rawApiKey;
            const currentStyle = GLOBAL_STYLES.find(s => s.value === state.stylePrompt)?.prompt || "Cinematic photorealistic, 8k, high quality";

            const consistencyInstruction = `
            **MANDATORY CONSISTENCY:** 
            - BACKGROUND: MUST be a Pure Solid White Studio Background. 
            - CHARACTER: The character's face, hair, and clothing MUST be exactly as seen in the reference.
            - MASTER REFERENCE STYLE: You must strictly adhere to the following artistic style for all character details: "${currentStyle}".
            - LIGHTING: Professional studio lighting with rim lights for clear character silhouette.
            - QUALITY: 8K resolution, hyper-detailed, clean sharp focus.
            `.trim();

            const description = char.description || "Character";
            const facePrompt = `${consistencyInstruction}\n\n(STRICT CAMERA: EXTREME CLOSE-UP - FACE ID ON WHITE BACKGROUND) Generate a highly detailed Face ID close-up of this character: ${description}. Focus on capturing the exact facial features and expression from the reference. The background must be pure solid white.`;

            // OPTIMIZATION: Skip body generation - masterImage is already full body
            // This saves 1 API credit per character generation
            console.log('[CharGen] 💰 Skipping body generation - using masterImage as body reference');

            if (!apiKey) {
                updateCharacter(id, { isAnalyzing: false });
                setApiKeyModalOpen(true);
                return;
            }

            const model = state.imageModel || 'gemini-3-pro-image-preview';

            // Prepare Gommo credentials from state
            const gommoCredentials = state.gommoDomain && state.gommoAccessToken
                ? { domain: state.gommoDomain, accessToken: state.gommoAccessToken }
                : undefined;

            // Only generate Face ID - Body uses masterImage directly
            let faceUrl = await callCharacterImageAPI(apiKey, facePrompt, "1:1", model, char.masterImage, gommoCredentials);

            if (userId) {
                if (faceUrl?.startsWith('data:')) {
                    faceUrl = await uploadImageToSupabase(faceUrl, 'project-assets', `${userId}/characters/${id}_face_${Date.now()}.jpg`);
                }
            }

            updateCharacter(id, {
                faceImage: faceUrl || undefined,
                bodyImage: char.masterImage, // Use masterImage as body reference (already full body)
                isAnalyzing: false
            });

        } catch (e) {
            console.error("Generation Sheets Failed", e);
            updateCharacter(id, { isAnalyzing: false });
        }
    }, [userApiKey, state.imageModel, state.stylePrompt, updateCharacter, state.characters, userId]);

    const generateCharacterImage = useCallback(async (
        charId: string,
        params: {
            prompt: string,
            style: string,
            customStyle?: string,
            aspectRatio: string,
            resolution: string,
            model: string
        }
    ) => {
        const { prompt, style, customStyle, aspectRatio, model } = params;
        updateCharacter(charId, {
            isGenerating: true,
            generationStartTime: Date.now(),
            generationStatus: '🚀 Starting generation...'
        });

        try {
            const styleConfig = CHARACTER_STYLES.find(s => s.value === style);
            const stylePrompt = style === 'custom' ? customStyle : (styleConfig?.prompt || styleConfig?.label || style);

            const fullPrompt = `
!!! CRITICAL OUTPUT CONSTRAINT - SINGLE CHARACTER ONLY !!!
Generate EXACTLY ONE image containing EXACTLY ONE PERSON. ABSOLUTELY NO:
- TWO OR MORE CHARACTERS (even if identical or same person from different angles)
- Front and back views together
- Multiple angles or poses of the same character
- Duplicates or clones of the character
- Inset boxes showing face close-ups or detail views
- Character sheets with multiple views
- Text labels, titles, or captions
- Grid layouts or collages
The output MUST be ONE SINGLE PERSON in ONE SINGLE POSE with NO duplicates.

CHARACTER DESIGN TASK:
Create a professional character reference showing EXACTLY ONE PERSON:

STYLE PRESET:
${stylePrompt}

CHARACTER DESCRIPTION:
${prompt}

MANDATORY REQUIREMENTS:
- SUBJECT COUNT: EXACTLY 1 PERSON. NOT 2, NOT 3. ONLY 1.
- Background: Pure Solid White Studio Background (RGB 255, 255, 255). No shadows on background, no textures.
- Framing: FULL BODY HEAD-TO-TOE, clear silhouette, MUST INCLUDE FEET.
- Pose: Standard A-Pose or T-Pose (Fixed Reference Pose). ONE POSE ONLY.
- Lighting: Professional studio softbox lighting, high contrast, rim light for separation.
- Quality: 8K, Ultra-Sharp focus, Hyper-detailed texture, Ray-tracing style.
- Face: EXTREMELY SHARP and DETAILED facial features (Eyes, Nose, Mouth must be perfect). NO BLURRED FACES.
- OUTPUT: ONE SINGLE PERSON. No duplicates, no multiple views.

COMPLETE OUTFIT CHECKLIST (ALL ITEMS MANDATORY):
1. ✅ HEAD: Hair/headwear as described
2. ✅ UPPER BODY: Shirt/jacket/top with visible details (buttons, collar, texture)
3. ✅ LOWER BODY: Pants/skirt/dress - MUST BE VISIBLE, not cropped
4. ✅ FEET: Shoes/boots/footwear - ABSOLUTELY MANDATORY, NO BARE FEET unless specified
5. ✅ ACCESSORIES: Belt, watch, jewelry, bags as mentioned in description

If any clothing item is not specified in the description, ADD APPROPRIATE DEFAULT:
- No pants specified → Add dark trousers
- No shoes specified → Add brown leather shoes
- No top specified → Add a neutral colored shirt

FAILURE CONDITIONS (will be REJECTED):
1. MORE THAN ONE CHARACTER IN THE IMAGE (biggest failure!)
2. Character missing ANY clothing item (especially pants or shoes)
3. Multiple images/panels/insets in the output
4. Any text or labels in the image

CRITICAL: ONE SINGLE FULL-BODY IMAGE on solid white background. Face must be recognizable and sharp.
            `.trim();

            const apiKey = (userApiKey || (process.env as any).API_KEY)?.trim();

            // Prepare Gommo credentials from state
            const gommoCredentials = state.gommoDomain && state.gommoAccessToken
                ? { domain: state.gommoDomain, accessToken: state.gommoAccessToken }
                : undefined;

            // --- DOP INTELLIGENCE: Analyze and predict ---
            let dopDecision = null;
            if (userId && apiKey) {
                try {
                    updateCharacter(charId, { generationStatus: '🧠 DOP analyzing...' });
                    if (setAgentState) {
                        setAgentState('dop', 'working', '🧠 Analyzing with learned patterns...', 'analyzing');
                    }

                    dopDecision = await analyzeAndEnhance(prompt, model, 'character', aspectRatio, apiKey, userId);

                    console.log('[CharacterGen] 🧠 DOP Intelligence:', {
                        predictedQuality: dopDecision.enhancement.predictedQuality,
                        addedKeywords: dopDecision.enhancement.addedKeywords,
                        similarPrompts: dopDecision.enhancement.similarPrompts.length,
                        suggestedAR: dopDecision.enhancement.suggestedAspectRatio,
                        reasoning: dopDecision.enhancement.reasoning
                    });

                    // Show prediction in chat
                    const predictionEmoji = dopDecision.enhancement.predictedQuality >= 0.8 ? '🟢' :
                        dopDecision.enhancement.predictedQuality >= 0.6 ? '🟡' : '🔴';
                    const predictionMsg = `${predictionEmoji} Dự đoán: ${Math.round(dopDecision.enhancement.predictedQuality * 100)}% chất lượng`;
                    updateCharacter(charId, { generationStatus: predictionMsg });

                    if (setAgentState) {
                        setAgentState('dop', 'working', predictionMsg, 'prediction');
                    }

                    // Show similar prompts found
                    if (dopDecision.enhancement.similarPrompts.length > 0 && setAgentState) {
                        const similarCount = dopDecision.enhancement.similarPrompts.length;
                        const bestSimilar = dopDecision.enhancement.similarPrompts[0];
                        setAgentState('dop', 'working',
                            `📚 Tìm thấy ${similarCount} prompts tương tự (${Math.round(bestSimilar.similarity * 100)}% match)`,
                            'similar_found'
                        );
                    }

                    // Show added keywords
                    if (dopDecision.enhancement.addedKeywords.length > 0 && setAgentState) {
                        setAgentState('dop', 'working',
                            `🎯 Thêm keywords đã học: ${dopDecision.enhancement.addedKeywords.slice(0, 3).join(', ')}`,
                            'keywords_added'
                        );
                    }

                    // Show reasoning
                    if (dopDecision.enhancement.reasoning && setAgentState) {
                        setAgentState('dop', 'working',
                            `💡 ${dopDecision.enhancement.reasoning.substring(0, 100)}`,
                            'reasoning'
                        );
                    }

                    // Show warnings
                    if (dopDecision.warnings.length > 0 && setAgentState) {
                        for (const warning of dopDecision.warnings) {
                            setAgentState('dop', 'working', warning, 'warning');
                        }
                    }

                    // Show suggestions
                    if (dopDecision.suggestions.length > 0 && setAgentState) {
                        for (const suggestion of dopDecision.suggestions) {
                            setAgentState('dop', 'working', suggestion, 'suggestion');
                        }
                    }
                } catch (e) {
                    console.warn('[CharacterGen] DOP Intelligence failed:', e);
                }
            }

            // --- PROMPT NORMALIZATION FOR NON-GEMINI MODELS ---
            let promptToSend = fullPrompt;

            // Apply DOP learned keywords for Gemini models too
            if (dopDecision && dopDecision.enhancement.addedKeywords.length > 0) {
                // Add learned keywords even for Gemini
                const learnedKeywords = dopDecision.enhancement.addedKeywords.join(', ');
                promptToSend = `${fullPrompt}\n\n[DOP LEARNED]: ${learnedKeywords}`;
                console.log('[CharacterGen] 🧠 Added learned keywords:', learnedKeywords);
            }

            // Check if normalization is needed (only for non-Google models)
            const requiresNormalization = needsNormalization(model);
            console.log('[CharacterGen] Model:', model, '| Needs normalization:', requiresNormalization);

            if (!requiresNormalization) {
                // Google/Gemini models - Vietnamese OK, no translation needed
                if (setAgentState) {
                    setAgentState('dop', 'working', `🟢 ${model} hỗ trợ tiếng Việt - không cần dịch`, 'skip_normalize');
                }
            }

            if (requiresNormalization) {
                console.log('[CharacterGen] 🔧 Normalizing prompt for model:', model);

                // DOP Status: Normalizing
                updateCharacter(charId, { generationStatus: `🔧 Optimizing prompt for ${model}...` });
                if (setAgentState) {
                    setAgentState('dop', 'working', `🔧 Optimizing prompt for ${model}...`, 'normalizing');
                }

                try {
                    // Use 'character' mode for proper white background, sharp details, posing
                    const normalized = await normalizePromptAsync(fullPrompt, model, apiKey, aspectRatio, 'character');
                    promptToSend = normalized.normalized;

                    // DOP Status: Normalized
                    const translateMsg = normalized.translated ? '🌐 Translated VI→EN. ' : '';
                    const statusMsg = `${translateMsg}✅ Prompt optimized (${normalized.normalized.length} chars)`;
                    updateCharacter(charId, { generationStatus: statusMsg });
                    if (setAgentState) {
                        setAgentState('dop', 'working', statusMsg, 'prompt_ready');
                    }

                    console.log('[CharacterGen] ✅ Normalized:', {
                        model: normalized.modelType,
                        translated: normalized.translated,
                        originalLen: normalized.original.length,
                        normalizedLen: normalized.normalized.length,
                        changes: normalized.changes
                    });
                } catch (normErr) {
                    console.warn('[CharacterGen] Normalization failed, using original prompt:', normErr);
                    updateCharacter(charId, { generationStatus: '⚠️ Using original prompt' });
                    if (setAgentState) {
                        setAgentState('dop', 'working', '⚠️ Normalization skipped, using original', 'fallback');
                    }
                }
            } else {
                // Gemini - no normalization needed
                updateCharacter(charId, { generationStatus: '🔵 Gemini mode - full prompt' });
                if (setAgentState) {
                    setAgentState('dop', 'working', `🔵 Gemini mode - using full prompt`, 'prompt_ready');
                }
            }

            // DOP Status: Generating
            updateCharacter(charId, { generationStatus: `🎨 Generating with ${model}...` });
            if (setAgentState) {
                setAgentState('dop', 'working', `🎨 Generating with ${model}...`, 'generating');
            }

            // Record prompt in DOP Learning System - NON-BLOCKING
            let dopRecordId: string | null = null;
            if (userId && apiKey) {
                // Fire and forget - don't block character generation
                recordPrompt(
                    userId,
                    prompt,
                    promptToSend,
                    model,
                    'character',
                    aspectRatio,
                    apiKey
                ).then(id => {
                    if (id) {
                        console.log('[CharacterGen] ✅ DOP recorded (async):', id);
                        (window as any).__lastDopRecordId = id;
                    }
                }).catch(e => {
                    console.error('[CharacterGen] ❌ DOP recording failed (async):', e);
                });

                console.log('[CharacterGen] 🔄 DOP recording started (non-blocking)');
            } else {
                console.warn('[CharacterGen] ⚠️ DOP skipped - missing userId or apiKey');
            }

            // Use callCharacterImageAPI for proper Gemini/Gommo routing
            const imageUrl = await callCharacterImageAPI(
                apiKey,
                promptToSend,
                aspectRatio,
                model,
                null, // no reference image for character creation
                gommoCredentials
            );

            if (imageUrl) {
                let finalUrl = imageUrl;
                if (userId && imageUrl.startsWith('data:')) {
                    try {
                        finalUrl = await uploadImageToSupabase(imageUrl, 'project-assets', `${userId}/characters/${charId}_gen_${Date.now()}.jpg`);
                    } catch (e) {
                        console.error("Cloud storage upload failed", e);
                    }
                }

                // Quality check for non-Gemini models
                let qualityResult = null;
                if (needsNormalization(model) && apiKey) {
                    updateCharacter(charId, { generationStatus: '🔍 Checking quality...' });
                    if (setAgentState) {
                        setAgentState('dop', 'working', '🔍 Analyzing image quality...', 'quality_check');
                    }

                    qualityResult = await performQualityCheck(imageUrl, prompt, 'character', apiKey);
                    console.log('[CharacterGen] Quality score:', qualityResult.score.overall);

                    // Approve in DOP Learning if quality is good
                    if (dopRecordId && qualityResult.score.overall >= 0.7) {
                        await approvePrompt(dopRecordId, {
                            overall: qualityResult.score.overall,
                            fullBody: qualityResult.score.fullBodyVisible,
                            background: qualityResult.score.backgroundClean,
                            faceClarity: qualityResult.score.faceClarity,
                            match: qualityResult.score.matchesDescription
                        });
                    }

                    // Show quality feedback
                    const qualityEmoji = qualityResult.score.overall >= 0.8 ? '✅' :
                        qualityResult.score.overall >= 0.6 ? '⚠️' : '❌';
                    const qualityMsg = `${qualityEmoji} Quality: ${Math.round(qualityResult.score.overall * 100)}%`;
                    updateCharacter(charId, { generationStatus: qualityMsg });
                }

                updateCharacter(charId, {
                    generatedImage: finalUrl,
                    isGenerating: false,
                    generationStartTime: undefined,
                    dopRecordId: dopRecordId || undefined // Store for UI rating
                });
                if (addToGallery) addToGallery(finalUrl, 'character', prompt, charId);

                // Sync usage stats to Supabase
                updateStateAndRecord(s => {
                    const currentStats = s.usageStats || { '1K': 0, '2K': 0, '4K': 0, total: 0 };
                    const updatedStats = {
                        ...currentStats,
                        total: (currentStats.total || 0) + 1,
                        characters: (currentStats.characters || 0) + 1,
                        lastGeneratedAt: new Date().toISOString()
                    };
                    if (userId) {
                        syncUserStatsToCloud(userId, updatedStats);

                        // Track in GLOBAL stats (persists across projects)
                        const providerType = model.includes('gemini') ? 'gemini' : 'gommo';
                        incrementGlobalStats(userId, {
                            images: 1,
                            characters: 1,
                            gemini: providerType === 'gemini' ? 1 : 0,
                            gommo: providerType === 'gommo' ? 1 : 0,
                        });

                        // Record image to history
                        recordGeneratedImage(userId, {
                            projectId: s.projectName || 'unknown',
                            imageUrl: finalUrl,
                            generationType: 'character',
                            characterId: charId,
                            prompt: promptToSend,
                            modelId: model,
                            modelType: providerType,
                            aspectRatio: aspectRatio,
                            resolution: '1K',
                        });
                    }
                    return { ...s, usageStats: updatedStats };
                });
            } else {
                throw new Error("AI không trả về ảnh.");
            }

        } catch (err: any) {
            console.error("Background Gen Error:", err);
            updateCharacter(charId, { isGenerating: false, generationStartTime: undefined });
            alert(`❌ Lỗi tạo ảnh: ${err.message}`);
        }
    }, [userApiKey, updateCharacter, userId, state.gommoDomain, state.gommoAccessToken]);

    return {
        updateCharacter,
        addCharacter,
        deleteCharacter,
        setDefaultCharacter,
        analyzeCharacterImage,
        analyzeAndGenerateSheets,
        generateCharacterSheets,
        generateCharacterImage
    };
}
