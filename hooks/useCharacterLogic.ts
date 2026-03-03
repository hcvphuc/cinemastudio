import { useCallback } from 'react';
import { GoogleGenAI } from "@google/genai";
import { ProjectState, Character } from '../types';
import { generateId } from '../utils/helpers';
import { GLOBAL_STYLES, CHARACTER_STYLES } from '../constants/presets';
import { getCharacterStyleById } from '../constants/characterStyles';
import { callGeminiAPI, callCharacterImageAPI } from '../utils/geminiUtils';
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

        if (!apiKey) {
            updateCharacter(id, { isAnalyzing: false });
            setApiKeyModalOpen(true);
            return;
        }

        try {
            const ai = new GoogleGenAI({ apiKey });
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
                // Handle Blob URLs (from base64ToBlobUrl memory optimization)
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
                // Handle URL images
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

            const analyzePrompt = `Analyze this character's main features. Return JSON: {"name": "Suggest a concise name", "description": "Short Vietnamese description (2-3 sentences) of key physical traits, clothing, and overall vibe. Focus on what makes them unique."}`;
            const analysisRes = await ai.models.generateContent({
                model: 'gemini-2.5-flash',
                contents: { parts: [{ inlineData: { data, mimeType } }, { text: analyzePrompt }] },
                config: {
                    responseMimeType: "application/json"
                }
            });

            let json = { name: "", description: "" };
            try {
                const text = (analysisRes as any).text();
                json = JSON.parse(text.replace(/```json/g, '').replace(/```/g, '').trim());
            } catch (e) {
                try {
                    const text = (analysisRes as any).text || "";
                    json = JSON.parse(text.replace(/```json/g, '').replace(/```/g, '').trim());
                } catch (e2) {
                    console.error("JSON parse error", e2);
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
    }, [userApiKey, updateCharacter, setApiKeyModalOpen, userId]);

    // Combined function: Analyze + Generate Face ID & Body in one step
    const analyzeAndGenerateSheets = useCallback(async (id: string, image: string, options?: { skipMetadata?: boolean }) => {
        const rawApiKey = userApiKey || (process.env as any).API_KEY;
        const apiKey = typeof rawApiKey === 'string' ? rawApiKey.trim() : rawApiKey;

        if (!apiKey) {
            setApiKeyModalOpen(true);
            return;
        }

        updateCharacter(id, { isAnalyzing: true, generationStartTime: Date.now() });

        try {
            const ai = new GoogleGenAI({ apiKey });
            let data: string;
            let mimeType: string = 'image/jpeg';
            let finalMasterUrl = image;

            console.log('[Lora Gen] Starting image processing...', {
                isBase64: image.startsWith('data:'),
                isUrl: image.startsWith('http'),
                imagePreview: image.substring(0, 50) + '...'
            });

            // Convert image to base64 if needed
            if (image.startsWith('data:')) {
                console.log('[Lora Gen] Processing base64 image...');
                const [header, base64Data] = image.split(',');
                data = base64Data;
                mimeType = header.match(/:(.*?);/)?.[1] || 'image/jpeg';
                console.log('[Lora Gen] ✅ Base64 extracted:', { mimeType, dataLength: data.length });

                if (userId) {
                    try {
                        finalMasterUrl = await uploadImageToSupabase(image, 'project-assets', `${userId}/characters/${id}_master_${Date.now()}.jpg`);
                        console.log('[Lora Gen] ✅ Uploaded to Supabase:', finalMasterUrl);
                    } catch (e) {
                        console.error("[Lora Gen] Cloud upload failed for master image", e);
                    }
                }
            } else if (image.startsWith('blob:')) {
                // Handle Blob URLs (from base64ToBlobUrl memory optimization)
                console.log('[Lora Gen] Processing blob URL image...');
                const blobRes = await fetch(image);
                const blob = await blobRes.blob();
                mimeType = blob.type || 'image/jpeg';
                data = await new Promise<string>((resolve, reject) => {
                    const reader = new FileReader();
                    reader.onloadend = () => {
                        const result = (reader.result as string).split(',')[1];
                        console.log('[Lora Gen] ✅ Blob converted to base64:', result.length, 'chars');
                        resolve(result);
                    };
                    reader.onerror = reject;
                    reader.readAsDataURL(blob);
                });
                finalMasterUrl = image;
            } else if (image.startsWith('http')) {
                console.log('[Lora Gen] Fetching URL image...', image);
                try {
                    const imgRes = await fetch(image, { mode: 'cors' });
                    if (!imgRes.ok) {
                        console.error('[Lora Gen] ❌ Fetch failed:', imgRes.status, imgRes.statusText);
                        throw new Error(`Fetch failed: ${imgRes.status}`);
                    }
                    const blob = await imgRes.blob();
                    mimeType = blob.type || 'image/jpeg';
                    console.log('[Lora Gen] ✅ Fetched blob:', { size: blob.size, type: mimeType });

                    data = await new Promise<string>((resolve, reject) => {
                        const reader = new FileReader();
                        reader.onloadend = () => {
                            const result = (reader.result as string).split(',')[1];
                            console.log('[Lora Gen] ✅ Converted to base64:', result.length, 'chars');
                            resolve(result);
                        };
                        reader.onerror = (e) => {
                            console.error('[Lora Gen] ❌ FileReader error:', e);
                            reject(e);
                        };
                        reader.readAsDataURL(blob);
                    });
                    finalMasterUrl = image;
                } catch (fetchError: any) {
                    console.error('[Lora Gen] ❌ Failed to fetch URL image:', fetchError.message);
                    // If CORS fails, try to use the URL directly in the API call
                    throw new Error(`Cannot fetch image from URL. CORS error: ${fetchError.message}`);
                }
            } else {
                console.error('[Lora Gen] ❌ Invalid image format:', image.substring(0, 30));
                throw new Error("Invalid image format");
            }

            // Step 1: Analyze the character AND detect art style with HIGH PRECISION
            const analyzePrompt = `Analyze this character image carefully and provide accurate details.

**NAME RULES:**
- Suggest a SHORT, MEMORABLE English name (1-2 words max)
- Examples: "Leo", "Storm", "Captain Kai", "Luna", "The Hunter"
- If the character looks Asian, you can use short Asian-Western fusion names like "Rei", "Jin", "Yuki"

**DESCRIPTION RULES:**
- Write in Vietnamese
- Be SPECIFIC about physical traits: face shape, skin tone, hair color/style, eye shape
- Describe clothing/costume in detail: materials, colors, patterns
- Maximum 2-3 sentences, focus on VISUAL DISTINGUISHING features only

**ART STYLE DETECTION:**
- PHOTOREALISTIC: Real photo or ultra-realistic 3D render
- DIGITAL PAINTING: Painted look, brushstrokes, stylized
- ANIME: Japanese style, large eyes, cel-shaded
- CARTOON: Western animation, simplified features
- The image is NOT photorealistic if it has painted textures, stylized lighting, or non-realistic skin

Return JSON:
{
    "name": "Short English name (1-2 words)",
    "description": "Vietnamese description của đặc điểm nhận dạng: khuôn mặt, màu da, kiểu tóc màu tóc, trang phục chi tiết.",
    "art_style": "Accurate style description in English. Examples: 'Digital painting with warm tones', 'Anime cel-shaded', 'Semi-realistic illustration'",
    "is_illustration": true/false
}`;


            const analysisRes = await ai.models.generateContent({
                model: 'gemini-2.5-flash',
                contents: { parts: [{ inlineData: { data, mimeType } }, { text: analyzePrompt }] },
                config: {
                    responseMimeType: "application/json"
                }
            });

            let json = { name: "", description: "", art_style: "", is_illustration: false };
            try {
                // Handle response text extraction safely
                const text = (analysisRes as any).text ||
                    (analysisRes.candidates?.[0]?.content?.parts?.[0]?.text) ||
                    '';

                if (!text) throw new Error("Empty response text");

                json = JSON.parse(text.replace(/```json/g, '').replace(/```/g, '').trim());
            } catch (e) {
                console.error("JSON parse error", e);
            }

            const charName = json.name || "Unnamed Character";
            const charDescription = json.description || "Character";
            let detectedStyle = json.art_style || "Digital illustration style";

            // If detected as illustration, reinforce it
            if (json.is_illustration) {
                detectedStyle = `ILLUSTRATION/PAINTED STYLE: ${detectedStyle}. This is NOT photorealistic.`;
            }

            console.log('[Character Analysis] Detected style:', detectedStyle);


            // Update character with analysis results
            // If skipMetadata is true, we ONLY update the masterImage (if changed)
            // and we rely on existing name/description for the subsequent prompt generation
            const currentChar = state.characters.find(c => c.id === id);
            const finalName = options?.skipMetadata ? (currentChar?.name || charName) : charName;
            const finalDescription = options?.skipMetadata ? (currentChar?.description || charDescription) : charDescription;

            updateCharacter(id, {
                masterImage: finalMasterUrl,
                name: finalName,
                description: finalDescription
            });

            // Step 2: Generate Face ID and Body using ONLY the detected style from the reference image
            // Note: We use finalDescription here which might be the user's custom one
            const styleInstruction = `
**CRITICAL STYLE ENFORCEMENT - DO NOT DEVIATE:**
You are generating images that MUST match the EXACT artistic style of the reference image provided.

DETECTED STYLE FROM REFERENCE: "${detectedStyle}"

ABSOLUTE RULES:
1. COPY the exact art style from the reference image. If it's anime, generate anime. If photorealistic, generate photorealistic.
2. MATCH the same color palette, shading technique, and line work as the reference.
3. IGNORE any other style instructions. The reference image is the ONLY style guide.
4. DO NOT apply any "cinematic", "8k", or "photorealistic" styles unless the reference is actually photorealistic.
5. KEEP the character's exact appearance: face, hair color/style, clothing, accessories.

TECHNICAL REQUIREMENTS:
- BACKGROUND: Pure solid white (#FFFFFF) studio background only.
- LIGHTING: Clean studio lighting that matches the reference's lighting style.
- QUALITY: Sharp, clean, no artifacts.
            `.trim();

            // Inject Character Style Preset (e.g., Mannequin) if set globally
            let characterStyleInstruction = '';
            if (state.globalCharacterStyleId) {
                const charStyle = getCharacterStyleById(state.globalCharacterStyleId, state.customCharacterStyles || []);
                if (charStyle) {
                    characterStyleInstruction = `
**CHARACTER STYLE PRESET - ABSOLUTE OVERRIDE:**
${charStyle.promptInjection.global}

PER-CHARACTER REQUIREMENT:
${charStyle.promptInjection.character}

NEGATIVE CONSTRAINTS:
${charStyle.promptInjection.negative}
`;
                    console.log('[Character Gen] Using character style preset:', charStyle.name);
                }
            }

            const facePrompt = `${characterStyleInstruction}${styleInstruction}\n\n[TASK: FACE ID]\nGenerate an EXTREME CLOSE-UP portrait of this character's face on a pure white background.\nCharacter: ${finalDescription}\nSTYLE: Match the reference exactly - "${detectedStyle}"`;

            const bodyPrompt = `${characterStyleInstruction}${styleInstruction}\n\n[TASK: FULL BODY]\nGenerate a FULL BODY view (head to toe, feet visible) of this character on a pure white background.\nPose: T-Pose or A-Pose, front view.\nCharacter: ${finalDescription}\nCOMPLETE OUTFIT MANDATORY: The character must be FULLY CLOTHED including SHOES. If shoes are not specified, add appropriate footwear.\nSTYLE: Match the reference exactly - "${detectedStyle}"`;

            const model = 'gemini-3-pro-image-preview'; // Use best model for style matching

            console.log('[Lora Gen] 🎨 Starting Face & Body generation...', {
                model,
                referenceImage: image.substring(0, 50) + '...',
                hasCharStylePreset: !!characterStyleInstruction
            });

            // Prepare Gommo credentials from state
            const gommoCredentials = state.gommoDomain && state.gommoAccessToken
                ? { domain: state.gommoDomain, accessToken: state.gommoAccessToken }
                : undefined;

            let [faceUrl, bodyUrl] = await Promise.all([
                callCharacterImageAPI(apiKey, facePrompt, "1:1", model, image, gommoCredentials),
                callCharacterImageAPI(apiKey, bodyPrompt, "9:16", model, image, gommoCredentials),
            ]);

            console.log('[Lora Gen] Generation results:', {
                faceGenerated: !!faceUrl,
                bodyGenerated: !!bodyUrl,
                faceLength: faceUrl?.length || 0,
                bodyLength: bodyUrl?.length || 0
            });

            if (userId) {
                if (faceUrl?.startsWith('data:')) {
                    faceUrl = await uploadImageToSupabase(faceUrl, 'project-assets', `${userId}/characters/${id}_face_${Date.now()}.jpg`);
                    console.log('[Lora Gen] ✅ Face uploaded:', faceUrl);
                }
                if (bodyUrl?.startsWith('data:')) {
                    bodyUrl = await uploadImageToSupabase(bodyUrl, 'project-assets', `${userId}/characters/${id}_body_${Date.now()}.jpg`);
                    console.log('[Lora Gen] ✅ Body uploaded:', bodyUrl);
                }
            }

            updateCharacter(id, {
                faceImage: faceUrl || undefined,
                bodyImage: bodyUrl || undefined,
                isAnalyzing: false
            });

            console.log('[Lora Gen] ✅ Lora generation complete!');

        } catch (error: any) {
            console.error("[Lora Gen] ❌ Analyze and Generate Failed", error);
            updateCharacter(id, { isAnalyzing: false });
        }
    }, [userApiKey, updateCharacter, setApiKeyModalOpen, userId, state.imageModel, state.characters]);

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
