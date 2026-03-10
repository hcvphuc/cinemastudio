/**
 * useScriptAnalysis Hook
 * 
 * Analyzes imported voice-over scripts using AI to:
 * 1. Detect chapter headers
 * 2. Identify characters
 * 3. Suggest scene breakdown
 * 4. Generate visual prompts with Director + Character Style
 */

import { useState, useCallback } from 'react';
import { GoogleGenAI } from "@google/genai";
import { Scene, SceneGroup, Character, CharacterStyleDefinition } from '../types';
import { DirectorPreset, DIRECTOR_PRESETS } from '../constants/directors';
import { resolveStyleWithInheritance } from '../constants/characterStyles';

// Analysis result types
export interface ChapterAnalysis {
    id: string;
    title: string;
    startIndex: number;
    endIndex: number;
    estimatedDuration: number; // seconds
    suggestedTimeOfDay?: string;
    suggestedWeather?: string;
    locationAnchor?: string; // PHASE 2: Fixed location description for all scenes in chapter
}

export interface CharacterAnalysis {
    name: string;
    mentions: number;
    suggestedDescription: string;
    outfitByChapter: Record<string, string>; // chapterId -> outfit description
    isMain: boolean;
}

export interface SceneAnalysis {
    voiceOverText: string;      // Narration/commentary (off-screen narrator)
    dialogueText?: string;       // Character dialogue (spoken on-screen)
    dialogueSpeaker?: string;    // Who is speaking the dialogue
    visualPrompt: string;
    chapterId: string;
    characterNames: string[];
    estimatedDuration: number;
    zone?: 'video' | 'static';  // Video Zone (short VO, ~8s clip) or Static Zone (image frame)
    needsExpansion: boolean; // If VO is long and needs multiple visual scenes
    expansionScenes?: {
        visualPrompt: string;
        isBRoll: boolean;
    }[];
    _isGapFill?: boolean; // Internal marker for post-processing gap-fill scenes
}

// NEW: Location Detection for shared concept art
export interface LocationAnalysis {
    id: string;
    name: string;                    // "Casino Interior"
    description: string;             // "Dark luxurious gambling hall with roulette tables..."
    keywords: string[];              // ["casino", "gambling", "luxury"]
    chapterIds: string[];            // Which chapters use this location
    sceneRanges: { start: number; end: number }[]; // Scene number ranges
    conceptPrompt: string;           // Full prompt for generating concept art
    isInterior: boolean;             // Interior vs Exterior
    timeOfDay?: string;              // Suggested time
    mood?: string;                   // Atmospheric mood
}

export interface ScriptAnalysisResult {
    totalWords: number;
    estimatedDuration: number; // total seconds
    chapters: ChapterAnalysis[];
    characters: CharacterAnalysis[];
    locations: LocationAnalysis[]; // NEW: Detected unique locations
    suggestedSceneCount: number;
    scenes: SceneAnalysis[];
    globalContext?: string; // World setting, era, tone summary from AI
}

// Words per minute for duration estimation
const WPM_SLOW = 120;
const WPM_MEDIUM = 150;
const WPM_FAST = 180;

/**
 * Retry helper for API calls with custom backoff strategy:
 * Attempts 1-3: fast backoff (2s, 4s, 8s)
 * Attempts 4-7: slow backoff (15s each) — wait for API overload to clear
 * Total: 7 attempts before giving up
 */
async function withAnalysisRetry<T>(
    fn: () => Promise<T>,
    label: string,
    onRetry?: (attempt: number, maxAttempts: number, waitMs: number) => void
): Promise<T> {
    const MAX_ATTEMPTS = 7;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        try {
            return await fn();
        } catch (error: any) {
            const errMsg = error?.message || String(error);
            const isRetryable = errMsg.includes('503') || errMsg.includes('429') ||
                errMsg.includes('UNAVAILABLE') || errMsg.includes('overloaded') ||
                errMsg.includes('RESOURCE_EXHAUSTED') || errMsg.includes('quota') ||
                errMsg.includes('500') || errMsg.includes('502');

            if (!isRetryable || attempt >= MAX_ATTEMPTS) {
                throw error; // Non-retryable or exhausted all attempts
            }

            // Backoff: attempts 1-3 → 2s/4s/8s, attempts 4-7 → 15s each
            const waitMs = attempt <= 3 ? Math.pow(2, attempt) * 1000 : 15000;
            console.warn(`[${label}] ⚠️ Attempt ${attempt}/${MAX_ATTEMPTS} failed (${errMsg.substring(0, 80)}). Retrying in ${waitMs / 1000}s...`);

            if (onRetry) onRetry(attempt, MAX_ATTEMPTS, waitMs);
            await new Promise(r => setTimeout(r, waitMs));
        }
    }
    throw new Error(`[${label}] All ${MAX_ATTEMPTS} attempts failed`);
}

/**
 * Pre-process script to detect and mark dialogue patterns
 * Returns both the marked script and extracted dialogue hints
 */
interface DialogueHint {
    speaker: string;
    text: string;
    originalLine: string;
}

function preProcessDialogue(script: string): { markedScript: string; dialogueHints: DialogueHint[]; stats: { totalDialogues: number; totalVOLines: number } } {
    const hints: DialogueHint[] = [];
    let markedScript = script;

    // Pattern 1: "Dialogue in quotes" with optional speaker before
    // E.g., John said: "Hello world"
    const quotePattern = /(?:([A-Za-zÀ-ỹ\s]+)(?:said|says|shouted|whispered|asked|replied|nói|hét|hỏi|trả lời|thì thầm)?[:\s]*)?[""]([^""]+)[""]/gi;

    // Pattern 2: SPEAKER: dialogue (screenplay format)
    const speakerPattern = /^([A-ZÀ-Ỹ][A-Za-zÀ-ỹ\s]*):[\s]*(.+)$/gm;

    // Pattern 3: 'Single quotes dialogue'
    const singleQuotePattern = /['']([^'']+)['']/gi;

    // Extract Pattern 2 first (most reliable)
    let match;
    while ((match = speakerPattern.exec(script)) !== null) {
        hints.push({
            speaker: match[1].trim(),
            text: match[2].trim(),
            originalLine: match[0]
        });
    }

    // Extract Pattern 1 (quotes with optional speaker)
    const quoteRegex = /(?:([A-Za-zÀ-ỹ\s]+)(?:said|says|shouted|whispered|asked|replied|nói|hét|hỏi|trả lời|thì thầm)?[:\s]*)?[""]([^""]+)[""]/gi;
    while ((match = quoteRegex.exec(script)) !== null) {
        const speaker = match[1]?.trim() || 'Unknown';
        const text = match[2]?.trim() || '';
        if (text && text.length > 2) {
            // Avoid duplicates
            const exists = hints.some(h => h.text === text);
            if (!exists) {
                hints.push({ speaker, text, originalLine: match[0] });
            }
        }
    }

    // Mark script with dialogue indicators for AI
    markedScript = script.replace(/[""]([^""]+)[""]/g, '[DIALOGUE]"$1"[/DIALOGUE]');

    // Count stats
    const lines = script.split('\n').filter(l => l.trim());
    const dialogueLines = hints.length;
    const voLines = lines.length - dialogueLines;

    return {
        markedScript,
        dialogueHints: hints,
        stats: { totalDialogues: dialogueLines, totalVOLines: Math.max(0, voLines) }
    };
}

/**
 * Post-process to validate dialogue/VO separation was done correctly
 */
function validateDialogueSeparation(scenes: SceneAnalysis[]): { warnings: string[]; autoFixes: number } {
    const warnings: string[] = [];
    let autoFixes = 0;

    for (const scene of scenes) {
        // Check if VO contains quotes (possible missed dialogue)
        if (scene.voiceOverText && (scene.voiceOverText.includes('"') || scene.voiceOverText.includes('"'))) {
            if (!scene.dialogueText) {
                warnings.push(`Scene may have missed dialogue: "${scene.voiceOverText.substring(0, 50)}..."`);
            }
        }

        // Check if dialogue exists but no speaker
        if (scene.dialogueText && !scene.dialogueSpeaker) {
            scene.dialogueSpeaker = 'Unknown';
            autoFixes++;
        }
    }

    return { warnings, autoFixes };
}

export type AnalysisStage = 'idle' | 'preparing' | 'dialogue-detection' | 'connecting' | 'clustering' | 'thinking' | 'post-processing' | 'validating' | 'finalizing';

export function useScriptAnalysis(userApiKey: string | null) {
    const [isAnalyzing, setIsAnalyzing] = useState(false);
    const [analysisStage, setAnalysisStage] = useState<AnalysisStage>('idle');
    const [analysisResult, setAnalysisResult] = useState<ScriptAnalysisResult | null>(null);
    const [analysisError, setAnalysisError] = useState<string | null>(null);
    const [analysisLogs, setAnalysisLogs] = useState<{ time: string; msg: string; type: 'info' | 'success' | 'warn' | 'error' }[]>([]);

    const addLog = useCallback((msg: string, type: 'info' | 'success' | 'warn' | 'error' = 'info') => {
        const time = new Date().toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        setAnalysisLogs(prev => [...prev, { time, msg, type }]);
    }, []);

    /**
     * Analyze script text using AI
     */
    const analyzeScript = useCallback(async (
        scriptText: string,
        readingSpeed: 'slow' | 'medium' | 'fast' = 'medium',
        modelSelector: string = 'gemini-2.5-flash|none', // format: model|thinkingLevel
        characterStyle?: CharacterStyleDefinition | null,
        director?: DirectorPreset | null,
        researchNotes?: { director?: string; dop?: string; story?: string } | null,
        activeCharacters: { id: string; name: string; description?: string }[] = [], // New Param for auto-assignment
        sceneCountEstimate?: number, // User's desired scene count (optional)
        videoZoneConfig?: { enabled: boolean; videoScenes: number; staticScenes: number }, // Video Zone split config
        enableBRoll: boolean = false // B-Roll expansion (OFF by default to prevent output truncation)
    ): Promise<ScriptAnalysisResult | null> => {
        if (!userApiKey) {
            setAnalysisError('API key required');
            return null;
        }

        setIsAnalyzing(true);
        setAnalysisStage('preparing');
        setAnalysisError(null);
        setAnalysisLogs([]);

        try {
            const ai = new GoogleGenAI({ apiKey: userApiKey });
            const wpm = readingSpeed === 'slow' ? WPM_SLOW : readingSpeed === 'fast' ? WPM_FAST : WPM_MEDIUM;
            const wordCount = scriptText.split(/\s+/).length;
            const estimatedTotalDuration = Math.ceil((wordCount / wpm) * 60);
            addLog(`📝 Kịch bản: ${wordCount} từ, ~${Math.ceil(estimatedTotalDuration / 60)} phút`);
            addLog(`🤖 Model: ${modelSelector.split('|')[0]}`);

            // ═══════════════════════════════════════════════════════════════
            // PRE-PROCESSING: Dialogue Detection with Regex
            // ═══════════════════════════════════════════════════════════════
            setAnalysisStage('dialogue-detection');
            const { markedScript, dialogueHints, stats } = preProcessDialogue(scriptText);
            addLog(`🔍 Dialogue Detection: ${stats.totalDialogues} thoại, ${stats.totalVOLines} VO`);
            console.log(`[Dialogue Detection] Found ${stats.totalDialogues} dialogues, ${stats.totalVOLines} VO lines`);

            // Build dialogue hints for AI
            const dialogueHintsForAI = dialogueHints.length > 0
                ? `\n[PRE-DETECTED DIALOGUES - USE THESE AS HINTS]:\n${dialogueHints.map(h => `- Speaker: "${h.speaker}" | Dialogue: "${h.text}"`).join('\n')}\n`
                : '';

            // ═══════════════════════════════════════════════════════════════
            // PRE-PROCESSING: Chapter Header Detection (CRITICAL FOR GROUPING)
            // ═══════════════════════════════════════════════════════════════
            // Detect chapter headers using regex patterns for "Location, Date/Year" format
            // This MUST happen before AI analysis to ensure correct scene grouping
            interface ChapterMarker {
                lineNumber: number;
                header: string;
                chapterId: string;
            }

            const chapterMarkers: ChapterMarker[] = [];
            const lines = scriptText.split('\n');

            // Regex patterns for chapter headers:
            // PRIORITY 1: Explicit bracket format [Chapter Title] - 100% reliable
            // FALLBACK: Other patterns for non-bracketed scripts
            const chapterPatterns = [
                // PRIORITY: Bracket format [Chapter Title] - MOST RELIABLE
                // Matches: [Marseille, November 2019], [The Mask], [PART A: HOOK — The Table Flip]
                /^\[(.+)\]$/,

                // PART headers (non-bracketed): "PART A: HOOK", "PART 1: Setup"
                /^PART\s+[A-Z0-9]+[\s:—\-–]+.+$/i,

                // Pattern 1: "Place, Month Year" (e.g., "Marseille, November 2019", "Casino de Monte-Carlo, May 2019")
                /^([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ\s\-']+),?\s*(January|February|March|April|May|June|July|August|September|October|November|December)\s*(\d{4}s?)$/i,

                // Pattern 2: "Place, Country Year" (e.g., "Rouen, France 1820s") 
                /^([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ\s\-']+),?\s*([A-Za-zÀ-ÿ]+)\s+(\d{4}s?|\d{3}0s)$/i,

                // Pattern 3: Time jump phrases (e.g., "Two Years Later", "January 2022")
                /^(Two|Three|Four|Five|Six|Seven|Eight|Nine|Ten|\d+)\s+(Years?|Months?|Weeks?|Days?|Hours?)\s+(Later|Earlier|Before|After|Ago)$/i,
                /^(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{4}$/i,

                // Pattern 4: Section titles (e.g., "The Mask", "The Investigation", "The Warehouse")
                // Match "The [Word]" or single/two capitalized words on their own line
                /^The\s+[A-Z][a-zA-Z]+$/,

                // Pattern 5: Short standalone location headers (e.g., just a place name as chapter marker)
                // Only match if it's a short line (< 40 chars) and starts with capital
                /^[A-Z][a-zA-ZÀ-ÿ\s\-',]+$/,
            ];

            lines.forEach((line, index) => {
                const trimmedLine = line.trim();

                // PRIORITY: Check for bracket format first - no length/word restrictions
                if (/^\[.+\]$/.test(trimmedLine)) {
                    // Extract text between brackets for chapterId
                    const headerText = trimmedLine.slice(1, -1).trim();
                    const chapterId = headerText
                        .toLowerCase()
                        .replace(/[^a-z0-9\s]/g, '')
                        .replace(/\s+/g, '_')
                        .substring(0, 30);

                    chapterMarkers.push({
                        lineNumber: index + 1,
                        header: headerText, // Store without brackets for display
                        chapterId: chapterId
                    });
                    console.log(`[Chapter Detection] 📍 Found chapter (bracket): "${headerText}" → ${chapterId}`);
                    return; // Skip other patterns for this line
                }
            });

            // IMPORTANT: Only use fallback patterns if NO bracket chapters were found
            // When bracket chapters exist (e.g. [PART A: ...]), they are the SOLE chapter boundaries
            const hasBracketChapters = chapterMarkers.length > 0;

            if (!hasBracketChapters) {
                lines.forEach((line, index) => {
                    const trimmedLine = line.trim();
                    // Skip empty lines, lines > 50 chars, or lines that look like sentences
                    if (!trimmedLine || trimmedLine.length > 50 || /[.!?]\s+[A-Z]/.test(trimmedLine)) return;

                    // Also skip lines that are clearly not headers (too many words = likely a sentence)
                    const wordCount = trimmedLine.split(/\s+/).length;
                    if (wordCount > 6) return;

                    for (const pattern of chapterPatterns) {
                        if (pattern.test(trimmedLine)) {
                            const chapterId = trimmedLine
                                .toLowerCase()
                                .replace(/[^a-z0-9\s]/g, '')
                                .replace(/\s+/g, '_')
                                .substring(0, 30);

                            chapterMarkers.push({
                                lineNumber: index + 1,
                                header: trimmedLine,
                                chapterId: chapterId
                            });
                            console.log(`[Chapter Detection] 📍 Found chapter (fallback): "${trimmedLine}" → ${chapterId}`);
                            break;
                        }
                    }
                });
            } else {
                console.log(`[Chapter Detection] ✅ Using ${chapterMarkers.length} bracket chapters exclusively (fallback patterns DISABLED)`);
            }

            // Build chapter hints for AI
            const chapterHintsForAI = chapterMarkers.length > 0
                ? `\n[PRE-DETECTED CHAPTER BOUNDARIES — HARD LOCKED, DO NOT MODIFY]:\n${chapterMarkers.map((ch, i) => {
                    const nextChapter = chapterMarkers[i + 1];
                    const endNote = nextChapter
                        ? `(ALL scenes from line ${ch.lineNumber} to line ${nextChapter.lineNumber - 1} belong to this chapter ONLY)`
                        : `(ALL remaining scenes from line ${ch.lineNumber} to end belong to this chapter ONLY)`;
                    return `- Line ${ch.lineNumber}: "${ch.header}" → chapter_id: "${ch.chapterId}" ${endNote}`;
                }).join('\n')}\n⚠️ ABSOLUTE RULE: Use EXACTLY these chapter_ids. Do NOT invent, split, or merge chapters. The chapter boundaries above are FINAL and determined by the user's script structure. Each scene's chapterId MUST match one of these pre-detected chapter_ids.\n`
                : '';

            console.log(`[Chapter Detection] Found ${chapterMarkers.length} chapter boundaries`);

            // Parse model selector format: "model-name|thinking-level"
            const [modelName, thinkingLevel] = modelSelector.split('|');

            // Map thinking level to budget tokens
            const thinkingBudgets: Record<string, number | undefined> = {
                'high': 24576,
                'medium': 8192,
                'low': 2048,
                'minimal': 512,
                'none': undefined
            };

            // Only apply thinking config to models that support it
            // gemini-2.5-flash does NOT support thinkingConfig
            const supportsThinking = modelName.includes('2.5-pro') || modelName.includes('thinking');
            const thinkingBudget = supportsThinking ? (thinkingBudgets[thinkingLevel] ?? undefined) : undefined;

            if (!supportsThinking && thinkingLevel !== 'none') {
                console.warn(`[ScriptAnalysis] Model ${modelName} does not support thinking mode. Ignoring thinking level: ${thinkingLevel}`);
            }

            // Context Injection
            let contextInstructions = "";

            // [New] Global Story Context - INJECT FIRST
            if (researchNotes?.story) {
                contextInstructions += `\n[GLOBAL STORY CONTEXT - MANDATORY WORLD SETTING]:\n${researchNotes.story}\n- ALL visual descriptions MUST align with this world setting. Do not hallucinate settings that contradict this context.\n`;
            }

            if (characterStyle) {
                // Check if this is a mannequin style
                const isMannequinStyle = characterStyle.id?.includes('mannequin') || characterStyle.name?.toLowerCase().includes('mannequin');
                const mannequinPrefix = isMannequinStyle ? 'Faceless white mannequin, egg-shaped head. ' : '';

                contextInstructions += `\nVISUAL STYLE CONSTRAINT: The user selected the character style "${characterStyle.name}" (${characterStyle.promptInjection.global}).\n- You MUST generate "suggestedDescription" that aligns with this style.\n${isMannequinStyle ? `- MANDATORY MANNEQUIN PREFIX: Every character's suggestedDescription MUST start with: "${mannequinPrefix}"\n` : ''}- CRITICAL: You MUST extract the SPECIFIC OUTFIT (uniforms, period clothing, colors) from the script.\n- IF SCRIPT IS VAGUE: You MUST INFER appropriate period-accurate clothing in EXTREME DETAIL.\n- TEXTURE & MATERIAL LOCK: You MUST describe textures with MICROSCOPIC DETAIL (e.g. "cracked leather with oil stains", "coarse wool with pilling", "rusted brass buttons", "frayed cotton edges").\n- FORMAT: "${mannequinPrefix}WEARING: [Detailed Outfit Description with specific textures/materials] + [Accessories/Props] + [SHOES: specific footwear]."\n- Example: "Faceless white mannequin, egg-shaped head. WEARING: A heavy, cracked vintage bomber jacket (worn leather texture), coarse grey wool trousers with mud splatters, tarnished silver cufflinks. SHOES: Brown leather oxford shoes with scuff marks."\n- COMPLETE OUTFIT MANDATORY: Every character MUST have pants/skirt AND shoes specified.\n`;
            } else {
                contextInstructions += `\n- For characters, provide a HIGHLY DETAILED VISUAL DESCRIPTION (Age, Ethnicity, Hair, Face, Body, Initial Outfit).
- TEXTURE & MATERIAL LOCK: Describe clothing textures with SPECIFIC DETAIL (e.g. "faded soft cotton", "crisp ironed navy fabric", "worn leather").
- FORMAT: "[Name], [age], [role/occupation]. WEARING: [Detailed outfit with textures/materials]. SHOES: [specific footwear]."
- COMPLETE OUTFIT MANDATORY: Every character MUST have full outfit + shoes specified.\n`;
            }

            // ═══════════════════════════════════════════════════════════════
            // NARRATIVE ARCHETYPE VISUAL SYSTEM
            // AI must identify character roles and adjust appearance accordingly
            // ═══════════════════════════════════════════════════════════════
            contextInstructions += `
*** NARRATIVE ARCHETYPE — VISUAL STORYTELLING (CRITICAL FOR REALISTIC STYLE) ***
You MUST identify each character's NARRATIVE ROLE from the script and adjust their visual appearance to AMPLIFY that role for the viewer. The audience should FEEL the character's role at first glance.

🟢 VICTIM / UNDERDOG / PROTAGONIST who is OPPRESSED:
- POSTURE: Slightly hunched shoulders, head slightly lowered, tired posture
- FACE: Kind but weary eyes, worry lines, gentle expression, relatable features
- CLOTHING: Humble, worn, faded colors (muted grey, washed-out blue, off-white)
- TEXTURE: Soft cotton, slightly stretched fabric, worn-out stitching, faded prints
- SHOES: Beat-up sneakers, scuffed shoes, worn soles
- ACCESSORIES: Minimal — maybe a cheap watch, a crumpled paper, a worn bag
- OVERALL VIBE: "Someone you want to root for" — sympathetic, approachable, relatable
- Example: "Kevin Park, 31, software engineer. Kind tired eyes, slight stubble. Slightly hunched posture. WEARING: A faded, soft cotton t-shirt in muted grey, slightly stretched at the collar, well-worn denim jeans with subtle creases. SHOES: Scuffed beat-up canvas running shoes with worn rubber soles."

🔴 VILLAIN / AUTHORITY FIGURE / ANTAGONIST / CORRUPT POWER:
- POSTURE: Rigid upright stance, chin slightly raised, chest forward, commanding presence
- FACE: Sharp features, tight jaw, narrow calculating eyes, thin-lipped smile or permanent frown
- CLOTHING: Over-dressed for the occasion, crisp ironed fabrics, bold dark colors (navy, black, burgundy)
- TEXTURE: Polished brass buttons, starched collars, gleaming leather, laminated surfaces
- SHOES: Polished leather heels, pristine dress shoes — immaculate
- ACCESSORIES: Expensive but tasteless — gold watch, thick rings, laminated binder, expensive pen
- OVERALL VIBE: "Someone you instinctively distrust" — controlling, self-important, untouchable
- Example: "Barb Kimmel, 64, HOA treasurer. Sharp narrow eyes, tight thin-lipped expression, jaw always slightly clenched. Rigid upright posture with chin raised. WEARING: A crisp, ironed navy blue blazer with polished brass buttons, over a stark white blouse with a high collar. ACCESSORIES: A thick laminated binder with color-coded tabs, a gold watch on her left wrist. SHOES: Polished black leather low-heeled pumps."

🔵 HERO (after transformation) / STRATEGIC PROTAGONIST:
- POSTURE: Calm confidence, relaxed but alert, steady gaze
- FACE: Determined eyes, slight knowing smile, focused expression
- CLOTHING: Same humble clothes as before (continuity) but posture changes everything
- OVERALL VIBE: "Quiet competence" — the underdog who has a plan

🟡 ALLY / SUPPORTER:
- POSTURE: Open, warm, slightly leaning forward (engaged)
- FACE: Honest features, tired but willing eyes, empathetic expression
- CLOTHING: Casual, lived-in, practical — reflects their everyday life
- OVERALL VIBE: "Someone who shows up when it matters"

⚠️ RULES:
- Analyze the script to determine each character's archetype AUTOMATICALLY
- The suggestedDescription MUST reflect the archetype's visual traits
- Outfit textures should REINFORCE the narrative (villain = pristine/polished, victim = worn/faded)
- Do NOT make villains cartoonishly evil — make them REALISTICALLY unlikeable (bureaucratic, controlling, condescending)
- Do NOT make victims look pathetic — make them RELATABLE and SYMPATHETIC
`;


            // CHARACTER EXTRACTION RULES — prevent excessive minor characters
            contextInstructions += `\n\n*** CHARACTER EXTRACTION RULES (CRITICAL — REDUCE CLUTTER) ***\n- ONLY extract characters who are IMPORTANT to the story:\n  1. Named characters (proper names like "John", "Officer Zhang", "Étienne")\n  2. Characters who appear in ≥ 2 scenes\n  3. Characters who perform SIGNIFICANT ACTIONS (speak, fight, drive the plot)\n- DO NOT create character entries for:\n  × Anonymous crowd members ("people on the street", "bystanders")\n  × One-time mentions with no visual importance ("a waiter", "someone in the crowd")\n  × Generic group references ("the team", "soldiers", "police officers" as a group)\n  × Narrated historical figures who are NOT visually depicted\n- Set "isMain": true ONLY for protagonists/antagonists (max 3-5 main characters)\n- Set "mentions" accurately — count how many scenes this character appears in\n- When in doubt, DO NOT add the character. Fewer is better.\n`;

            if (director) {
                contextInstructions += `\nDIRECTOR VISION: ${director.name} (${director.description}).\n- Frame scenes according to this director's style.\n`;
            }

            // Inject Research Notes (User's custom research for this script)
            if (researchNotes?.director) {
                contextInstructions += `\n[USER DIRECTOR NOTES - MANDATORY CONTEXT]:\n${researchNotes.director}\n- Apply these storytelling guidelines to scene breakdown and character actions.\n`;
            }
            if (researchNotes?.dop) {
                contextInstructions += `\n[USER DOP NOTES - MANDATORY CAMERA/LIGHTING CONTEXT]:\n${researchNotes.dop}\n- Apply these cinematography guidelines to visual prompts.\n`;
            }

            // Expected Scene Count (Soft Target - can be overridden by user)
            const wordsPerScene = readingSpeed === 'slow' ? 8 : readingSpeed === 'fast' ? 12 : 10;
            const autoExpectedCount = Math.ceil(wordCount / wordsPerScene);
            const expectedSceneCount = sceneCountEstimate || autoExpectedCount;

            console.log(`[ScriptAnalysis] Scene count: auto=${autoExpectedCount}, user=${sceneCountEstimate || 'none'}, final=${expectedSceneCount}`);

            // ═══════════════════════════════════════════════════════════════
            // VIDEO ZONE SPLITTING INSTRUCTIONS
            // When enabled, AI must create short sentences for video scenes
            // ═══════════════════════════════════════════════════════════════
            let videoZoneInstructions = '';
            if (videoZoneConfig?.enabled) {
                const { videoScenes, staticScenes } = videoZoneConfig;
                const avgStaticWords = Math.ceil(wordCount / (videoScenes + staticScenes));
                videoZoneInstructions = `
*** VIDEO ZONE SPLIT — CRITICAL REQUIREMENT ***
The output must be divided into TWO zones:

🎥 VIDEO ZONE (first ${videoScenes} scenes):
- Each scene will be rendered as an ~8-second AI video clip.
- voiceOverText MUST be VERY SHORT: 15–20 words maximum (HARD LIMIT: 25 words).
- If a paragraph is long, SPLIT it into multiple short scenes.
- Each scene = 1 single short sentence or 1 action beat.
- Prefer punchy, dynamic sentences. NO compound sentences with commas.
- The visual prompt for video scenes should describe MOTION and CAMERA MOVEMENT.

🖼️ STATIC ZONE (remaining ${staticScenes} scenes) — FULL COVERAGE MANDATORY:
- These are standard static image frames with LONGER voiceOverText.
- Each static scene should contain approximately ${avgStaticWords}–${avgStaticWords + 30} words.
- CRITICAL: Static scenes MUST COVER ALL remaining script text that is NOT in Video Zone.
- Distribute text EVENLY across static scenes within each chapter.
- Do NOT skip, compress, or paraphrase text. EVERY sentence must appear in exactly ONE scene.
- The LAST static scene of each chapter may be slightly longer to include remaining text — this is OK.
- Visual prompts describe a single still frame.

⚠️ COVERAGE RULES (HIGHEST PRIORITY):
- Total scenes = ${videoScenes} (video) + ${staticScenes} (static) = ${videoScenes + staticScenes}
- The FIRST ${videoScenes} scenes in the "scenes" array are VIDEO ZONE.
- The REMAINING ${staticScenes} scenes are STATIC ZONE.
- Add a field "zone": "video" or "zone": "static" to each scene object.
- EVERY WORD of the original script MUST appear in EXACTLY ONE scene's voiceOverText.
- If you run out of video scenes, put remaining text into static scenes.
- Do NOT leave any text uncovered. Coverage must be 100%.
`;
            }

            // [New] Existing Character Library - Inject to avoid duplicates
            if (activeCharacters && activeCharacters.length > 0) {
                const charList = activeCharacters.map(c => `- ${c.name}: ${c.description || 'No description'}`).join('\n');
                contextInstructions += `\n[EXISTING CHARACTER LIBRARY - MANDATORY REUSE]:\n${charList}\n- CRITICAL: If the script refers to any of these characters (by name or context), you MUST reuse their exact name. Do NOT create new entries for them in the "characters" JSON array unless they are truly new characters not found in this list.\n`;
            }

            // [New] Inject pre-detected dialogue hints
            if (dialogueHintsForAI) {
                contextInstructions += dialogueHintsForAI;
                contextInstructions += `- IMPORTANT: These dialogues were pre-detected by regex. Use them as HINTS for your dialogueText/dialogueSpeaker fields.\n`;
            }

            // [New] Inject pre-detected chapter boundaries (CRITICAL FOR CORRECT GROUPING)
            if (chapterHintsForAI) {
                contextInstructions += chapterHintsForAI;
            }

            // ═══════════════════════════════════════════════════════════════
            // VISUAL DIRECTOR SYSTEM PROMPT (shared by batch and single-batch paths)
            // ═══════════════════════════════════════════════════════════════
            const clusteringSystemPrompt = `
*** CRITICAL ROLE: VISUAL DIRECTOR ***
You are NOT a text splitter. You are a CINEMATIC ADAPTER.
Your job is to read the raw input and restructure it into VISUAL BLOCKS (Shots).

VISUAL PROMPT FORMAT:
"[SHOT TYPE]. [Cinematic Purpose]. [Spatial View/Axis]. [Location from locationAnchor]. [Subject/Characters]. [Action]. [Mood]."
- SHOT TYPES: WIDE SHOT, MEDIUM SHOT, CLOSE-UP, EXTREME CLOSE-UP, POV
- SPATIAL ROTATION: For every scene, describe the view from a DIFFERENT AXIS or angle.

*** BEAT DETECTION (DO NOT SKIP IMPORTANT ACTIONS) ***
Each of these patterns MUST become its OWN separate shot:
1. NUMBER + ACTION with significant number AND action verb → SEPARATE SHOT
2. DRAMATIC VERBS (surround, attack, shoot, die, kill, arrest, escape, burn) → SEPARATE SHOT
3. ESTABLISHING vs ACTION: Time/Location headers MUST be SEPARATE from the action
4. CHAPTER BOUNDARY: Explicit [PART ...] brackets or location+time headers → NEW CHAPTER

*** SILENT VISUAL INSTRUCTIONS (PARENTHESES PROTOCOL) ***
Text inside '...' is VISUAL DIRECTION, NOT voice-over. Use it for the image, remove from VO.

Do NOT hide important actions inside B-rolls. They need to be MAIN scenes.`;

            // ═══════════════════════════════════════════════════════════════
            // AUTO-BATCH: Split long scripts into multiple API calls
            // ═══════════════════════════════════════════════════════════════
            // Video Zone generates many short scenes → big JSON → needs smaller batches
            const BATCH_THRESHOLD = videoZoneConfig?.enabled ? 1500 : 3500; // words
            const needsBatching = wordCount > BATCH_THRESHOLD && chapterMarkers.length >= 2;

            if (needsBatching) {
                console.log(`[ScriptAnalysis] 📦 AUTO-BATCH: Script ${wordCount} words > ${BATCH_THRESHOLD} threshold. Splitting at chapter boundaries...`);

                // Split script into batches at chapter boundaries
                // Strategy: group chapters so each batch has ~BATCH_THRESHOLD words
                interface BatchChunk {
                    scriptText: string;
                    chapters: typeof chapterMarkers;
                    wordCount: number;
                    batchIndex: number;
                }

                const batches: BatchChunk[] = [];
                let currentBatchChapters: typeof chapterMarkers = [];
                let currentBatchWords = 0;
                // Calculate target so batches are roughly equal
                const numBatches = Math.ceil(wordCount / BATCH_THRESHOLD);
                const targetBatchWords = Math.ceil(wordCount / numBatches);

                // Include pre-chapter text (lines before first chapter marker) in batch 1
                const firstChapterLine = chapterMarkers[0]?.lineNumber || 0;
                let preChapterText = '';
                if (firstChapterLine > 1) {
                    preChapterText = lines.slice(0, firstChapterLine - 1).join('\n');
                    const preWords = preChapterText.split(/\s+/).filter(Boolean).length;
                    currentBatchWords += preWords;
                    console.log(`[ScriptAnalysis] 📦 Including ${preWords} pre-chapter words in batch 1`);
                }

                for (let i = 0; i < chapterMarkers.length; i++) {
                    const marker = chapterMarkers[i];
                    const nextMarker = chapterMarkers[i + 1];
                    const startLine = marker.lineNumber - 1; // 0-indexed
                    const endLine = nextMarker ? nextMarker.lineNumber - 1 : lines.length;
                    const chapterText = lines.slice(startLine, endLine).join('\n');
                    const chapterWords = chapterText.split(/\s+/).filter(Boolean).length;

                    currentBatchChapters.push(marker);
                    currentBatchWords += chapterWords;

                    // Start new batch if current one is large enough (but not the last chapter)
                    const isLastChapter = i === chapterMarkers.length - 1;
                    if (currentBatchWords >= targetBatchWords && !isLastChapter) {
                        const batchStartLine = preChapterText && batches.length === 0
                            ? 0  // Include pre-chapter text in first batch
                            : currentBatchChapters[0].lineNumber - 1;
                        const batchEndLine = nextMarker ? nextMarker.lineNumber - 1 : lines.length;
                        batches.push({
                            scriptText: lines.slice(batchStartLine, batchEndLine).join('\n'),
                            chapters: [...currentBatchChapters],
                            wordCount: currentBatchWords,
                            batchIndex: batches.length
                        });
                        currentBatchChapters = [];
                        currentBatchWords = 0;
                    }
                }

                // Push remaining chapters as last batch
                if (currentBatchChapters.length > 0) {
                    const batchStartLine = preChapterText && batches.length === 0
                        ? 0  // Edge case: all chapters fit in one batch
                        : currentBatchChapters[0].lineNumber - 1;
                    batches.push({
                        scriptText: lines.slice(batchStartLine).join('\n'),
                        chapters: currentBatchChapters,
                        wordCount: currentBatchWords,
                        batchIndex: batches.length
                    });
                }

                console.log(`[ScriptAnalysis] 📦 Split into ${batches.length} batches:`, batches.map((b, i) => `Batch ${i + 1}: ${b.wordCount} words, ${b.chapters.length} chapters`));

                // Process each batch
                let mergedResult: ScriptAnalysisResult = {
                    totalWords: wordCount,
                    estimatedDuration: estimatedTotalDuration,
                    chapters: [],
                    characters: [],
                    locations: [],
                    suggestedSceneCount: 0,
                    scenes: [],
                    globalContext: ''
                };

                let knownCharacters: string[] = activeCharacters.map(c => c.name);
                let globalContextFromBatch1 = '';

                for (let batchIdx = 0; batchIdx < batches.length; batchIdx++) {
                    const batch = batches[batchIdx];
                    setAnalysisStage('connecting');
                    addLog(`📦 Gửi Batch ${batchIdx + 1}/${batches.length} (${batch.scriptText.split(/\s+/).length} từ)...`);
                    console.log(`[ScriptAnalysis] 📦 Processing batch ${batchIdx + 1}/${batches.length} (${batch.wordCount} words)...`);

                    // Calculate proportional scene count for this batch
                    const batchRatio = batch.wordCount / wordCount;
                    let batchExpectedScenes: number;
                    if (videoZoneConfig?.enabled) {
                        const totalScenes = (videoZoneConfig.videoScenes || 0) + (videoZoneConfig.staticScenes || 0);
                        batchExpectedScenes = Math.round(totalScenes * batchRatio);
                    } else {
                        batchExpectedScenes = Math.round(expectedSceneCount * batchRatio);
                    }

                    // Build batch-specific chapter hints
                    const batchChapterHints = batch.chapters.length > 0
                        ? `\n[PRE-DETECTED CHAPTER BOUNDARIES — HARD LOCKED]:\n${batch.chapters.map((ch, i) => {
                            const nextCh = batch.chapters[i + 1];
                            return `- "${ch.header}" → chapter_id: "${ch.chapterId}"`;
                        }).join('\n')}\n⚠️ Use EXACTLY these chapter_ids.\n`
                        : '';

                    // Build batch-specific Video Zone instructions
                    let batchVideoZoneInstructions = '';
                    if (videoZoneConfig?.enabled) {
                        const batchVideoScenes = Math.round((videoZoneConfig.videoScenes || 0) * batchRatio);
                        const batchStaticScenes = Math.max(1, batchExpectedScenes - batchVideoScenes);
                        batchVideoZoneInstructions = `
*** VIDEO ZONE SPLIT ***
🎥 VIDEO ZONE (first ${batchVideoScenes} scenes): Short sentences, 15-20 words max. "zone": "video"
🖼️ STATIC ZONE (remaining ${batchStaticScenes} scenes): Normal length. "zone": "static"
Total scenes for this batch: ~${batchExpectedScenes}
`;
                    }

                    // Build batch context (characters from previous batches)
                    let batchContextExtra = '';
                    if (batchIdx > 0 && globalContextFromBatch1) {
                        batchContextExtra += `\n[GLOBAL CONTEXT FROM PREVIOUS ANALYSIS]:\n${globalContextFromBatch1}\n`;
                    }
                    if (knownCharacters.length > 0) {
                        batchContextExtra += `\n[KNOWN CHARACTERS — REUSE THESE NAMES]:\n${knownCharacters.map(n => `- ${n}`).join('\n')}\n- CRITICAL: Reuse these exact names if they appear in this section.\n`;
                    }

                    const batchPrompt = `${clusteringSystemPrompt}

TARGET SCENE COUNT: ~${batchExpectedScenes} scenes for this section.
${batchVideoZoneInstructions}

${enableBRoll ? `B-ROLL EXPANSION enabled.` : `NO B-ROLL: Set "needsExpansion": false for ALL scenes.`}

${batchContextExtra}
${batchChapterHints}
${contextInstructions}

RESPOND WITH JSON ONLY:
{
  "globalContext": "Summary of this section's world/setting...",
  "locations": [{ "id": "loc_x", "name": "...", "description": "...", "keywords": [], "chapterIds": [], "isInterior": true, "timeOfDay": "night", "mood": "...", "conceptPrompt": "..." }],
  "chapters": [{ "id": "chapter_x", "title": "...", "suggestedTimeOfDay": "night", "suggestedWeather": "clear", "locationAnchor": "...", "locationId": "loc_x" }],
  "characters": [{ "name": "...", "mentions": 1, "suggestedDescription": "...", "outfitByChapter": {}, "isMain": false }],
  "scenes": [{ "voiceOverText": "...", "zone": "video", "dialogueText": null, "dialogueSpeaker": null, "visualPrompt": "...", "chapterId": "chapter_x", "characterNames": [], "needsExpansion": false }]
}

*** BATCH ${batchIdx + 1}/${batches.length} — ANALYZE THIS SECTION COMPLETELY ***
DO NOT skip or summarize any part. Cover EVERY sentence.

--- SCRIPT SECTION START ---
${batch.scriptText}
--- SCRIPT SECTION END ---`;

                    try {
                        const response = await withAnalysisRetry(
                            () => ai.models.generateContent({
                                model: modelName,
                                contents: [{ role: 'user', parts: [{ text: batchPrompt }] }],
                                config: {
                                    temperature: 0.3,
                                    responseMimeType: 'application/json',
                                    maxOutputTokens: 65536,
                                    ...(thinkingBudget && {
                                        thinkingConfig: { thinkingBudget }
                                    })
                                }
                            }),
                            `Batch ${batchIdx + 1}/${batches.length}`,
                            (attempt, max, waitMs) => {
                                setAnalysisStage(`retry-batch-${batchIdx + 1}`);
                                (mergedResult as any)._truncationWarning = `Batch ${batchIdx + 1}: Retry ${attempt}/${max} (chờ ${waitMs / 1000}s)...`;
                                addLog(`⚠️ Batch ${batchIdx + 1}: Retry ${attempt}/${max} — chờ ${waitMs / 1000}s...`, 'warn');
                            }
                        );

                        const batchText = response.text || '';
                        let batchJson = batchText;
                        batchJson = batchJson.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim();
                        const fb = batchJson.indexOf('{');
                        const lb = batchJson.lastIndexOf('}');
                        if (fb !== -1 && lb > fb) batchJson = batchJson.substring(fb, lb + 1);

                        // Repair JSON
                        let batchParsed: any;
                        try {
                            batchParsed = JSON.parse(batchJson);
                        } catch {
                            // Basic repair
                            let repaired = batchJson.replace(/,\s*([\]}])/g, '$1');
                            repaired = repaired.replace(/([{,]\s*)([a-zA-Z_][a-zA-Z0-9_]*)\s*:/g, '$1"$2":');
                            // Balance brackets
                            const ob = (repaired.match(/{/g) || []).length - (repaired.match(/}/g) || []).length;
                            const oq = (repaired.match(/\[/g) || []).length - (repaired.match(/]/g) || []).length;
                            repaired = repaired.replace(/,\s*"[^"]*$/, '').replace(/,\s*$/, '').replace(/:\s*"[^"]*$/, ': ""');
                            for (let i = 0; i < oq; i++) repaired += ']';
                            for (let i = 0; i < ob; i++) repaired += '}';
                            batchParsed = JSON.parse(repaired);
                        }

                        // Merge batch results
                        if (batchIdx === 0) {
                            globalContextFromBatch1 = batchParsed.globalContext || '';
                            mergedResult.globalContext = globalContextFromBatch1;
                        }

                        // Merge chapters (no duplicates)
                        const existingChapterIds = new Set(mergedResult.chapters.map((c: any) => c.id));
                        for (const ch of (batchParsed.chapters || [])) {
                            if (!existingChapterIds.has(ch.id)) {
                                mergedResult.chapters.push({ ...ch, startIndex: 0, endIndex: 0, estimatedDuration: 0 });
                                existingChapterIds.add(ch.id);
                            }
                        }

                        // Merge characters (deduplicate by name)
                        const existingCharNames = new Set(mergedResult.characters.map((c: any) => c.name.toLowerCase()));
                        for (const char of (batchParsed.characters || [])) {
                            if (!existingCharNames.has(char.name.toLowerCase())) {
                                // Importance filter: skip minor characters
                                const isImportant = char.isMain || (char.mentions || 0) >= 2
                                    || /^[A-ZÀ-ÿ][a-zà-ÿ]+\s+[A-ZÀ-ÿ]/.test((char.name || '').trim())
                                    || /^[A-ZÀ-ÿ][a-zà-ÿ]{2,}$/.test((char.name || '').trim());
                                if (!isImportant) {
                                    console.log(`[ScriptAnalysis] 🧹 Batch ${batchIdx + 1}: Filtered minor character "${char.name}" (mentions: ${char.mentions})`);
                                    continue;
                                }
                                mergedResult.characters.push(char);
                                existingCharNames.add(char.name.toLowerCase());
                                knownCharacters.push(char.name);
                            }
                        }

                        // Merge locations (deduplicate by id)
                        const existingLocIds = new Set(mergedResult.locations.map((l: any) => l.id));
                        for (const loc of (batchParsed.locations || [])) {
                            if (!existingLocIds.has(loc.id)) {
                                mergedResult.locations.push({ ...loc, sceneRanges: loc.sceneRanges || [] });
                                existingLocIds.add(loc.id);
                            }
                        }

                        // Append scenes (with duration calculation)
                        const batchScenes = (batchParsed.scenes || []).map((s: any) => ({
                            ...s,
                            estimatedDuration: Math.ceil(((s.voiceOverText || '').split(/\s+/).length / wpm) * 60)
                        }));
                        mergedResult.scenes.push(...batchScenes);

                        console.log(`[ScriptAnalysis] 📦 Batch ${batchIdx + 1} complete: ${batchScenes.length} scenes, ${(batchParsed.characters || []).length} characters`);
                        addLog(`✅ Batch ${batchIdx + 1}: ${batchScenes.length} scenes, ${(batchParsed.characters || []).length} nhân vật`, 'success');

                    } catch (batchError: any) {
                        console.error(`[ScriptAnalysis] ❌ Batch ${batchIdx + 1} failed:`, batchError.message);
                        addLog(`❌ Batch ${batchIdx + 1} thất bại: ${batchError.message?.substring(0, 100)}`, 'error');
                        // Continue with remaining batches even if one fails
                        (mergedResult as any)._truncationWarning = `Batch ${batchIdx + 1}/${batches.length} thất bại: ${batchError.message}. Kết quả có thể không đầy đủ.`;
                        (mergedResult as any)._truncationTip = 'Tip: Thử lại hoặc giảm số scene.';
                    }
                }

                // Finalize merged result
                mergedResult.suggestedSceneCount = mergedResult.scenes.length;
                mergedResult.estimatedDuration = estimatedTotalDuration;

                // Recalculate chapter durations
                mergedResult.chapters = mergedResult.chapters.map((ch: any) => ({
                    ...ch,
                    estimatedDuration: Math.ceil(estimatedTotalDuration / Math.max(1, mergedResult.chapters.length))
                }));

                // Enforce scene count on merged result (same as single-batch path)
                if (sceneCountEstimate && mergedResult.scenes.length > Math.ceil(sceneCountEstimate * 1.1)) {
                    const maxAllowed = Math.ceil(sceneCountEstimate * 1.1);
                    console.log(`[ScriptAnalysis] 📦 BATCH MERGE: ${mergedResult.scenes.length} scenes exceeds target ${sceneCountEstimate} (max ${maxAllowed}). Merging excess...`);

                    while (mergedResult.scenes.length > maxAllowed && mergedResult.scenes.length > 2) {
                        // Find the shortest STATIC scene (prefer merging static over video)
                        let shortestIdx = -1;
                        let shortestLen = Infinity;
                        for (let i = 1; i < mergedResult.scenes.length - 1; i++) {
                            const scene = mergedResult.scenes[i];
                            const isStatic = scene.zone !== 'video';
                            const len = (scene.voiceOverText || '').length;
                            // Prefer merging static scenes; only merge video as last resort
                            const priority = isStatic ? len : len + 100000;
                            if (priority < shortestLen) {
                                shortestLen = priority;
                                shortestIdx = i;
                            }
                        }
                        if (shortestIdx < 0) break;

                        const prev = mergedResult.scenes[shortestIdx - 1];
                        const curr = mergedResult.scenes[shortestIdx];
                        prev.voiceOverText = ((prev.voiceOverText || '') + ' ' + (curr.voiceOverText || '')).trim();
                        prev.visualPrompt = ((prev.visualPrompt || '') + ' | ' + (curr.visualPrompt || '')).trim();
                        const mChars = new Set([...(prev.characterNames || []), ...(curr.characterNames || [])]);
                        prev.characterNames = Array.from(mChars);
                        prev.estimatedDuration = Math.ceil(((prev.voiceOverText || '').split(/\s+/).length / wpm) * 60);
                        // If merging a static into a video, keep the video zone
                        if (prev.zone === 'video' || curr.zone === 'video') prev.zone = 'video';
                        mergedResult.scenes.splice(shortestIdx, 1);
                    }
                    mergedResult.suggestedSceneCount = mergedResult.scenes.length;
                    console.log(`[ScriptAnalysis] 📦 BATCH MERGE: Merged down to ${mergedResult.scenes.length} scenes`);
                }

                // Run truncation check on merged result
                const mergedAnalyzedWords = mergedResult.scenes.reduce((sum: number, s: any) =>
                    sum + ((s.voiceOverText || '').split(/\s+/).filter(Boolean).length), 0);
                const mergedCoverage = wordCount > 0 ? mergedAnalyzedWords / wordCount : 1;

                if (mergedCoverage < 0.7) {
                    console.warn(`[ScriptAnalysis] ⚠️ BATCH MERGE: Coverage only ${(mergedCoverage * 100).toFixed(0)}% after merging ${batches.length} batches`);

                    // --- Coverage Gap Fill for Batch Path ---
                    console.log('[ScriptAnalysis] 📦 Running coverage gap fill on merged result...');
                    const lineCoveredBatch = new Array(lines.length).fill(false);
                    const normBatch = (text: string) =>
                        text.toLowerCase().replace(/[^a-z0-9\sàáạảãăắằặẳẵâấầậẩẫđèéẹẻẽêếềệểễòóọỏõôốồộổỗơớờợởỡùúụủũưứừựửữỳýỵỷỹ]/g, '').replace(/\s+/g, ' ').trim();

                    for (const scene of mergedResult.scenes) {
                        const voText = scene.voiceOverText || '';
                        if (!voText || voText.length < 5) continue;
                        const sw = normBatch(voText).split(' ').filter((w: string) => w.length > 2);
                        if (sw.length < 2) continue;
                        const sp = sw.slice(0, Math.min(5, sw.length)).join(' ');
                        for (let i = 0; i < lines.length; i++) {
                            const ln = normBatch(lines[i]);
                            if (ln.includes(sp) || sp.includes(ln.substring(0, 20))) {
                                const le = Math.max(1, Math.ceil(sw.length / 10));
                                for (let j = i; j < Math.min(i + le, lines.length); j++) lineCoveredBatch[j] = true;
                                break;
                            }
                        }
                    }
                    for (let i = 0; i < lines.length; i++) {
                        const t = lines[i].trim();
                        if (!t || t.startsWith('[') || /^\s*$/.test(t)) lineCoveredBatch[i] = true;
                    }

                    // Find gaps
                    const batchGaps: { text: string; chapterId: string }[] = [];
                    let bGapStart = -1;
                    for (let i = 0; i < lines.length; i++) {
                        const isUncovered = !lineCoveredBatch[i] && lines[i].trim().length > 0;
                        if (isUncovered && bGapStart < 0) bGapStart = i;
                        else if (!isUncovered && bGapStart >= 0) {
                            const gt = lines.slice(bGapStart, i).map(l => l.trim()).filter(Boolean).join(' ');
                            if (gt.split(/\s+/).length >= 5) {
                                let cid = 'chapter_1';
                                for (let m = chapterMarkers.length - 1; m >= 0; m--) {
                                    if (bGapStart >= chapterMarkers[m].lineNumber) { cid = chapterMarkers[m].chapterId; break; }
                                }
                                batchGaps.push({ text: gt, chapterId: cid });
                            }
                            bGapStart = -1;
                        }
                    }
                    if (bGapStart >= 0) {
                        const gt = lines.slice(bGapStart).map(l => l.trim()).filter(Boolean).join(' ');
                        if (gt.split(/\s+/).length >= 5) {
                            let cid = 'chapter_1';
                            for (let m = chapterMarkers.length - 1; m >= 0; m--) {
                                if (bGapStart >= chapterMarkers[m].lineNumber) { cid = chapterMarkers[m].chapterId; break; }
                            }
                            batchGaps.push({ text: gt, chapterId: cid });
                        }
                    }

                    if (batchGaps.length > 0) {
                        const totalGapWords = batchGaps.reduce((s, g) => s + g.text.split(/\s+/).length, 0);
                        console.log(`[ScriptAnalysis] 📦 Found ${batchGaps.length} batch gaps (${totalGapWords} words)`);

                        // Group by chapter and create static scenes
                        const bgByChapter: Record<string, string[]> = {};
                        for (const g of batchGaps) {
                            if (!bgByChapter[g.chapterId]) bgByChapter[g.chapterId] = [];
                            bgByChapter[g.chapterId].push(g.text);
                        }

                        for (const [cid, texts] of Object.entries(bgByChapter)) {
                            const combined = texts.join(' ').split(/\s+/);
                            const target = 130;
                            const nScenes = Math.max(1, Math.ceil(combined.length / target));
                            const wps = Math.ceil(combined.length / nScenes);

                            for (let s = 0; s < nScenes; s++) {
                                const st = s * wps;
                                const en = Math.min((s + 1) * wps, combined.length);
                                const txt = combined.slice(st, en).join(' ');
                                if (txt.trim().length < 10) continue;

                                // Insert after last scene of this chapter
                                let insertIdx = mergedResult.scenes.length;
                                for (let i = mergedResult.scenes.length - 1; i >= 0; i--) {
                                    if (mergedResult.scenes[i].chapterId === cid) { insertIdx = i + 1; break; }
                                }
                                mergedResult.scenes.splice(insertIdx, 0, {
                                    voiceOverText: txt,
                                    visualPrompt: `MEDIUM SHOT. Scene depicting: ${txt.substring(0, 100)}...`,
                                    chapterId: cid,
                                    characterNames: [],
                                    zone: 'static',
                                    needsExpansion: false,
                                    estimatedDuration: Math.ceil((en - st) / wpm * 60),
                                    _isGapFill: true
                                });
                            }
                        }

                        // Re-enforce scene count
                        if (sceneCountEstimate && mergedResult.scenes.length > Math.ceil(sceneCountEstimate * 1.15)) {
                            const maxA = Math.ceil(sceneCountEstimate * 1.1);
                            while (mergedResult.scenes.length > maxA && mergedResult.scenes.length > 2) {
                                let sIdx = -1, sLen = Infinity;
                                for (let i = 1; i < mergedResult.scenes.length - 1; i++) {
                                    if (mergedResult.scenes[i].zone === 'video') continue;
                                    const l = (mergedResult.scenes[i].voiceOverText || '').length;
                                    const p = mergedResult.scenes[i]._isGapFill ? l : l + 50000;
                                    if (p < sLen) { sLen = p; sIdx = i; }
                                }
                                if (sIdx < 0) break;
                                let mt = sIdx - 1;
                                if (mt >= 0 && mergedResult.scenes[mt].zone === 'video') mt = sIdx + 1 < mergedResult.scenes.length ? sIdx + 1 : sIdx - 1;
                                if (mt < 0 || mt >= mergedResult.scenes.length) break;
                                const tgt = mergedResult.scenes[mt], src = mergedResult.scenes[sIdx];
                                tgt.voiceOverText = ((tgt.voiceOverText || '') + ' ' + (src.voiceOverText || '')).trim();
                                tgt.visualPrompt = ((tgt.visualPrompt || '') + ' | ' + (src.visualPrompt || '')).trim();
                                tgt.estimatedDuration = Math.ceil(((tgt.voiceOverText || '').split(/\s+/).length / wpm) * 60);
                                mergedResult.scenes.splice(sIdx, 1);
                            }
                            mergedResult.suggestedSceneCount = mergedResult.scenes.length;
                        }

                        console.log(`[ScriptAnalysis] 📦 After gap fill: ${mergedResult.scenes.length} scenes`);
                    }

                    // Update warning with new coverage
                    const newCovWords = mergedResult.scenes.reduce((s: number, sc: any) =>
                        s + ((sc.voiceOverText || '').split(/\s+/).filter(Boolean).length), 0);
                    const newCov = wordCount > 0 ? newCovWords / wordCount : 1;
                    if (newCov < 0.85) {
                        (mergedResult as any)._truncationWarning = `Auto-batch (${batches.length} phần): coverage ~${(newCov * 100).toFixed(0)}% (${newCovWords}/${wordCount} từ). Một số batch có thể bị cắt.`;
                        (mergedResult as any)._truncationTip = 'Tip: Thử giảm số scene trong Video Zone hoặc chia script thủ công.';
                    } else {
                        console.log(`[ScriptAnalysis] ✅ BATCH coverage improved to ${(newCov * 100).toFixed(0)}% after gap fill`);
                    }
                } else {
                    console.log(`[ScriptAnalysis] ✅ BATCH MERGE complete: ${mergedResult.scenes.length} scenes, coverage ${(mergedCoverage * 100).toFixed(0)}%`);
                }

                // ═══════════════════════════════════════════════════════
                // Deterministic Video/Static Zone Split (Batch Path)
                // Same logic as single-batch — ensures 100% coverage
                // ═══════════════════════════════════════════════════════
                if (videoZoneConfig?.enabled) {
                    console.log('[ScriptAnalysis] 🎬 [BATCH] Deterministic Video/Static Zone split...');
                    const { videoScenes: nVS, staticScenes: nSS } = videoZoneConfig;

                    // Clean narration text
                    const cLines = lines.filter(line => {
                        const t = line.trim();
                        if (!t) return false;
                        if (t.startsWith('#') || t.startsWith('---') || t.startsWith('>')) return false;
                        if (t.startsWith('**[') && t.endsWith(']**')) return false;
                        if (t.startsWith('**') && t.endsWith('**') && t.includes(':')) return false;
                        if (/^\*\*.*\*\*\s*$/.test(t) && t.length < 80) return false;
                        if (t.startsWith('[') && t.endsWith(']')) return false;
                        return true;
                    });
                    const cText = cLines.join(' ').replace(/\s+/g, ' ').trim();
                    const cSentences = cText.match(/[^.!?"]+(?:[.!?]+["']?\s*|$)/g) || [cText];
                    // Merge short fragments
                    const bSentences: string[] = [];
                    for (const s of cSentences) {
                        const tr = s.trim();
                        if (!tr) continue;
                        if (tr.split(/\s+/).length < 4 && bSentences.length > 0) {
                            bSentences[bSentences.length - 1] += ' ' + tr;
                        } else { bSentences.push(tr); }
                    }

                    // Video: from start, 1 sentence per scene
                    const bVideoScenes: string[] = [];
                    let bSIdx = 0;
                    while (bVideoScenes.length < nVS && bSIdx < bSentences.length) {
                        const sent = bSentences[bSIdx++]?.trim();
                        if (!sent || sent.length < 5) continue;
                        const wds = sent.split(/\s+/);
                        if (wds.length <= 25) { bVideoScenes.push(sent); }
                        else {
                            for (let k = 0; k < wds.length && bVideoScenes.length < nVS; k += 20) {
                                bVideoScenes.push(wds.slice(k, Math.min(k + 20, wds.length)).join(' '));
                            }
                        }
                    }

                    // Static: remaining text, split evenly
                    const bRemaining = bSentences.slice(bSIdx).join(' ').trim().split(/\s+/);
                    const bStaticScenes: string[] = [];
                    if (bRemaining.length > 0 && nSS > 0) {
                        const wps = Math.ceil(bRemaining.length / nSS);
                        for (let i = 0; i < nSS; i++) {
                            const st = i * wps;
                            if (st >= bRemaining.length) break;
                            const en = Math.min((i + 1) * wps, bRemaining.length);
                            const txt = bRemaining.slice(st, en).join(' ').trim();
                            if (txt.length > 5) bStaticScenes.push(txt);
                        }
                    }

                    // Chapter detection
                    const getChBatch = (text: string): string => {
                        const sw = text.toLowerCase().split(/\s+/).slice(0, 5).join(' ').substring(0, 20);
                        for (let i = 0; i < lines.length; i++) {
                            if (lines[i].toLowerCase().includes(sw)) {
                                for (let m = chapterMarkers.length - 1; m >= 0; m--) {
                                    if (i >= chapterMarkers[m].lineNumber - 1) return chapterMarkers[m].chapterId;
                                }
                                break;
                            }
                        }
                        return chapterMarkers[0]?.chapterId || 'chapter_1';
                    };

                    // AI scene matching
                    const findAIBatch = (text: string): any | null => {
                        const sw = text.toLowerCase().split(/\s+/).slice(0, 4).filter(w => w.length > 3).join(' ');
                        if (!sw) return null;
                        for (const s of mergedResult.scenes) {
                            const vo = (s.voiceOverText || '').toLowerCase();
                            if (vo.includes(sw)) return s;
                        }
                        return null;
                    };

                    // Build new scenes
                    const bNewScenes: any[] = [];
                    for (const vs of bVideoScenes) {
                        const ai = findAIBatch(vs);
                        bNewScenes.push({
                            voiceOverText: vs, zone: 'video',
                            dialogueText: ai?.dialogueText || null, dialogueSpeaker: ai?.dialogueSpeaker || null,
                            visualPrompt: ai?.visualPrompt || `CINEMATIC SHOT. ${vs.substring(0, 120)}`,
                            chapterId: getChBatch(vs), characterNames: ai?.characterNames || [],
                            needsExpansion: false, estimatedDuration: Math.ceil((vs.split(/\s+/).length / wpm) * 60)
                        });
                    }
                    for (const ss of bStaticScenes) {
                        const ai = findAIBatch(ss);
                        bNewScenes.push({
                            voiceOverText: ss, zone: 'static',
                            dialogueText: ai?.dialogueText || null, dialogueSpeaker: ai?.dialogueSpeaker || null,
                            visualPrompt: ai?.visualPrompt || `MEDIUM SHOT. Scene depicting: ${ss.substring(0, 120)}`,
                            chapterId: getChBatch(ss), characterNames: ai?.characterNames || [],
                            needsExpansion: false, estimatedDuration: Math.ceil((ss.split(/\s+/).length / wpm) * 60)
                        });
                    }

                    mergedResult.scenes = bNewScenes;
                    mergedResult.suggestedSceneCount = bNewScenes.length;
                    console.log(`[ScriptAnalysis] 🎬 [BATCH] Deterministic: ${bVideoScenes.length} video + ${bStaticScenes.length} static = ${bNewScenes.length} scenes`);

                    // CHARACTER ASSIGNMENT (Batch Path): Text Match + Carry Forward
                    const bAllChars = (mergedResult.characters || []).map((c: any) => ({
                        name: c.name as string,
                        nameLower: (c.name as string).toLowerCase(),
                        firstName: (c.name as string).split(/\s+/)[0]?.toLowerCase() || ''
                    }));
                    if (bAllChars.length > 0) {
                        // Pass 1: Text Match
                        for (const scene of bNewScenes) {
                            const voLower = (scene.voiceOverText || '').toLowerCase();
                            const matched: string[] = [];
                            for (const ch of bAllChars) {
                                if (voLower.includes(ch.nameLower) || voLower.includes(ch.firstName)) {
                                    matched.push(ch.name);
                                }
                            }
                            if (matched.length > 0) scene.characterNames = matched;
                        }
                        // Pass 2: Carry Forward (same chapter)
                        for (let i = 1; i < bNewScenes.length; i++) {
                            const curr = bNewScenes[i], prev = bNewScenes[i - 1];
                            if ((!curr.characterNames || curr.characterNames.length === 0) && prev.chapterId === curr.chapterId) {
                                curr.characterNames = [...(prev.characterNames || [])];
                            }
                        }
                        const bAssigned = bNewScenes.filter(s => s.characterNames && s.characterNames.length > 0).length;
                        console.log(`[ScriptAnalysis] 👤 [BATCH] Character assignment: ${bAssigned}/${bNewScenes.length} scenes have characters`);
                    }
                }

                // Clean VO text
                mergedResult.scenes = mergedResult.scenes.map((scene: any) => {
                    const cleanText = (text: string) => text ? text.replace(/\([^)]+\)/g, '').replace(/\s+/g, ' ').trim() : '';
                    return { ...scene, voiceOverText: cleanText(scene.voiceOverText || ''), dialogueText: cleanText(scene.dialogueText || '') };
                });

                setAnalysisStage('finalizing');
                setAnalysisResult(mergedResult);
                console.log(`[ScriptAnalysis] ✅ AUTO-BATCH complete: ${mergedResult.scenes.length} scenes from ${batches.length} batches`);
                return mergedResult;
            }

            // ═══════════════════════════════════════════════════════════════
            // SINGLE-BATCH PATH (original flow for shorter scripts)
            // ═══════════════════════════════════════════════════════════════

            // ═══════════════════════════════════════════════════════════════
            // STEP 1: VISUAL CLUSTERING (The "Director's Thinking" Phase)
            // ═══════════════════════════════════════════════════════════════
            setAnalysisStage('clustering'); // New Stage


            // clusteringSystemPrompt is declared above (shared with batch path)


            const clusteringUserPrompt = `
Analyze and REWRITE the following voice - over script into a list of "VISUAL SHOTS".
        Don't worry about JSON format yet. Just simple text blocks.

            *** HARD CONSTRAINT - TARGET SCENE COUNT: EXACTLY ${expectedSceneCount} shots(±10 %) ***
                ${sceneCountEstimate ? `⚠️ The user has EXPLICITLY requested ${sceneCountEstimate} scenes. This is NOT a suggestion — it is a HARD REQUIREMENT. You MUST produce between ${Math.floor(sceneCountEstimate * 0.9)} and ${Math.ceil(sceneCountEstimate * 1.1)} shots.` : `Auto-estimated target: ~${expectedSceneCount} shots based on word count and reading speed.`}

RULES FOR HITTING THE TARGET:
    - If you have MORE shots than target: MERGE similar / adjacent shots into one(combine their descriptions)
        - If you have FEWER shots than target: SPLIT long / complex shots into multiple angles
            - Each shot should cover roughly ${Math.ceil(wordCount / expectedSceneCount)} words of the script
                - Do NOT create micro - shots for single sentences unless dramatically important
                    - Prioritize QUALITY over QUANTITY — each shot must be cinematically meaningful

${videoZoneInstructions}

INPUT SCRIPT:
    """
${scriptText}
    """

OUTPUT FORMAT:
    - Shot 1: [Visual Description](Covers text: "...")
        - Shot 2: [Visual Description](Covers text: "...")
...
${videoZoneConfig?.enabled ? `⚠️ Remember: The FIRST ${videoZoneConfig.videoScenes} shots must have SHORT text (15-20 words max). Mark them as [VIDEO] shots.
The remaining ${videoZoneConfig.staticScenes} shots are [STATIC] with normal-length text.` : ''
                }
FINAL CHECK: Count your shots.If total is more than ${Math.ceil(expectedSceneCount * 1.1)}, MERGE shots until within range.
            `;

            // Call Step 1 (Clustering)
            // Use gemini-2.5-flash for speed if not generating JSON
            const clusteringResponse = await ai.models.generateContent({
                model: 'gemini-2.5-flash',
                contents: [{ role: 'user', parts: [{ text: clusteringSystemPrompt + "\n\n" + clusteringUserPrompt }] }]
            });
            const visualPlan = clusteringResponse.text || '';
            console.log('[ScriptAnalysis] 🧠 Visual Plan:', visualPlan);


            // ═══════════════════════════════════════════════════════════════
            // STEP 2: JSON GENERATION (The "DOP's Execution" Phase)
            // ═══════════════════════════════════════════════════════════════
            setAnalysisStage('thinking'); // Transition to JSON generation

            const prompt = `Analyze this voice - over script and the Director's Visual Plan to generate the final Production Script JSON.

        === ORIGINAL SCRIPT ===
            """
${scriptText}
    """

        === DIRECTOR'S VISUAL PLAN (Follow this segmentation) ===
    """
${visualPlan}
    """

        *** MANDATORY SCENE COUNT CONSTRAINT ***
            TARGET: ${expectedSceneCount} main scenes(±10 %).Maximum allowed: ${Math.ceil(expectedSceneCount * 1.1)}.

${videoZoneInstructions}
${sceneCountEstimate ? `The user explicitly requested ${sceneCountEstimate} scenes. You MUST respect this. Do NOT exceed ${Math.ceil(sceneCountEstimate * 1.1)} scenes in your "scenes" array.` : ''}
    - If the Visual Plan has more shots than target, MERGE adjacent shots with similar location / action into one scene
        - If you exceed the target, your response will be REJECTED.Merge scenes before outputting.
- B - Roll expansionScenes do NOT count toward this limit, but keep them minimal(max 1 - 2 per main scene)

    TASK:
    1. Use the "Director's Visual Plan" as the SOURCE TRUTH for scene segmentation.
2. Map the original script text(Voice Over) to these visual scenes.
   - CRITICAL: Every Main Scene MUST have \`voiceOverText\`.
   - The \`voiceOverText\` must be the EXACT segment of the original script that corresponds to this visual.
   - DO NOT LEAVE \`voiceOverText\` EMPTY.
3. Extract Characters, Locations, and Chapters as usual.
4. FINAL CHECK: Count your scenes array. If length > ${Math.ceil(expectedSceneCount * 1.1)}, go back and merge scenes.

CRITICAL - VOICE OVER vs DIALOGUE SEPARATION (YOUTUBE STORYTELLING STYLE):
You MUST correctly handle narration and dialogue:

**VOICE OVER (voiceOverText) - THE MASTER SCRIPT:**
- This is the ENTIRE script text for the scene, exactly as written, word-for-word.
- It MUST include EVERYTHING the narrator will say, INCLUDING character quotes!
- DO NOT STRIP or remove quotes from voiceOverText.
- Example: "He looked at her. 'I can't do this,' he whispered." -> All of this goes into voiceOverText!

**DIALOGUE (dialogueText + dialogueSpeaker) - OPTIONAL LIP-SYNC:**
- IF there is direct character speech in quotes that a character will lip-sync to on-screen, copy it into \`dialogueText\` AND specify the \`dialogueSpeaker\`.
- The quoted text STILL remains in the \`voiceOverText\` for the narrator.
- If NO dialogue in the scene → dialogueText: null, dialogueSpeaker: null

**RULES:**
1. voiceOverText is the MASTER SCRIPT for the scene. It contains BOTH narration descriptions AND inline cinematic quotes.
2. dialogueText is an OPTIONAL EXTRACTION of just the quotes for lip-syncing.
3. NEVER remove text from voiceOverText just because it's a quote.

CRITICAL - LOCATION ANCHOR RULE:
- Each chapter MUST define a "locationAnchor" - a DETAILED, FIXED environment description
- ALL scenes in that chapter MUST visually exist in this EXACT location
- Format: "Interior/Exterior, [specific place], [decade], [architectural style], [lighting], [key props]"

CRITICAL - CHAPTER GROUPING (LOCATION + TIME BOUNDARIES):
- Create a NEW chapter whenever LOCATION or TIME PERIOD changes in the script
- "Marseille, November 2019" and "Rouen, France 1820s" are DIFFERENT chapters with DIFFERENT chapter_ids
- "Casino de Monte-Carlo, May 2019" is a DIFFERENT chapter from "Marseille, November 2019"
- Each scene's chapterId MUST match the location/time header it falls under
- NEVER group scenes from different locations into the same chapter
- Use descriptive chapter_ids: "marseille_2019", "rouen_1820s", "montecarlo_may2019"

VISUAL PROMPT FORMAT:
"[SHOT TYPE]. [Cinematic Purpose]. [Spatial View/Axis]. [Location from locationAnchor]. [Subject/Characters]. [Action]. [Mood]."
- SHOT TYPES: WIDE SHOT, MEDIUM SHOT, CLOSE-UP, EXTREME CLOSE-UP, POV
- SPATIAL ROTATION: For every scene, describe the view from a DIFFERENT AXIS or angle.
${enableBRoll ? `
CRITICAL - DURATION & COVERAGE (B-ROLL LOGIC):
- Merged scenes may have long Voice-Over text.
- IF a scene's \`voiceOverText\` is > 15 words, you MAY generate \`expansionScenes\` (1-2 shots max).
- ⚠️ Keep expansion scenes MINIMAL to avoid inflating the total scene count beyond the target of ${expectedSceneCount}.

CRITICAL - VISUAL VARIETY (THE BBC 5-SHOT RULE):
When creating B-Rolls, you MUST strictly follow the "5-Shot Coverage" principle to ensure editable footage.
For every Main Shot, generate B-Rolls that are **DIFFERENT** types from this list:
  1. **CU HANDS/ACTION:** Close-up of what is being done (hands, mechanism, details).
  2. **CU FACE:** Close-up of the character's eyes/reaction.
  3. **WIDE SHOT:** Establishing where they are (Context).
  4. **OTS (Over The Shoulder):** Looking at what they see (Relational).
  5. **CREATIVE ANGLE:** Low angle, high angle, or unusual perspective.

CRITICAL - SUBJECT & TEMPORAL LOCK (The Key to Logical B-Rolls):
- **Problem:** AI often generates B-Rolls that drift into new actions.
- **Rule:** A B-Roll happens at the **EXACT SAME MOMENT** as the Main Scene.
- **SUBJECT LOCK:** If Main Scene is "Man looking at Mask", B-Roll MUST be "Close-up of Man's Eyes" or "Close-up of Mask details". It CANNOT be "Man walking away".
- **ACTION LOCK:** **NO NEW ACTIONS** in B-Rolls. Only *different views* of the *current action*.
- **Consistency:** B-Rolls are for *coverage*, not advancing the plot.

ALGORITHM for B-Rolls:
- If Main Scene is **WIDE SHOT/ESTABLISHING**, B-Roll MUST be **CU DETAILS** (Face/Hands/Object) to show what is important.
- If Main Scene is **CLOSE-UP/DETAIL**, B-Roll MUST be **WIDE SHOT** (Context) or **OTS** to show where it is happening.
- NEVER repeat the same shot type.` : `
NO B-ROLL EXPANSION:
- Set "needsExpansion": false for ALL scenes.
- Do NOT generate "expansionScenes" array.
- Focus on covering the ENTIRE script with main scenes only.
- This keeps the output compact and ensures full script coverage.`}

${contextInstructions}

RESPOND WITH JSON ONLY:
{
  "globalContext": "Detailed summary of world, era, setting...",
  "locations": [
    {
      "id": "loc_casino",
      "name": "Casino Interior",
      "description": "Dark luxurious 1940s gambling hall...",
      "keywords": ["casino", "gambling"],
      "chapterIds": ["chapter_1"],
      "isInterior": true,
      "timeOfDay": "night",
      "mood": "tense",
      "conceptPrompt": "WIDE SHOT establishing..."
    }
  ],
  "chapters": [
    {
      "id": "chapter_1",
      "title": "Chapter Title",
      "suggestedTimeOfDay": "night",
      "suggestedWeather": "clear",
      "locationAnchor": "Interior, 1940s Monte Carlo casino...",
      "locationId": "loc_casino"
    }
  ],
  "characters": [
    {
      "name": "Étienne Marchand",
      "mentions": 5,
      "suggestedDescription": "Faceless white mannequin...",
      "outfitByChapter": { "chapter_1": "suit..." },
      "isMain": true
    }
  ],
  "scenes": [
    {
      "voiceOverText": "March 2013, Baltimore. A man walks through the rain.",
      "zone": "video",
      "dialogueText": null,
      "dialogueSpeaker": null,
      "visualPrompt": "WIDE SHOT. Rain-soaked street. A silhouette...",
      "chapterId": "chapter_1",
      "characterNames": ["The Man"],
      "needsExpansion": false
    },
    {
      "voiceOverText": "The officer approached and spoke.",
      "zone": "static",
      "dialogueText": "Stop right there! Show me your hands!",
      "dialogueSpeaker": "Officer",
      "visualPrompt": "MEDIUM SHOT. Officer pointing...",
      "chapterId": "chapter_1",
      "characterNames": ["Officer", "The Man"],
      "needsExpansion": false
    }
  ]
}`;

            setAnalysisStage('connecting');
            const response = await withAnalysisRetry(
                () => ai.models.generateContent({
                    model: modelName,
                    contents: [{ role: 'user', parts: [{ text: prompt }] }],
                    config: {
                        temperature: 0.3,
                        responseMimeType: 'application/json',
                        maxOutputTokens: 65536,
                        ...(thinkingBudget && {
                            thinkingConfig: { thinkingBudget }
                        })
                    }
                }),
                'ScriptAnalysis',
                (attempt, max, waitMs) => {
                    setAnalysisStage(`retry-${attempt}`);
                    addLog(`⚠️ Retry ${attempt}/7 — chờ ${waitMs / 1000}s...`, 'warn');
                }
            );

            setAnalysisStage('post-processing');
            addLog('📋 Nhận kết quả từ AI, đang xử lý JSON...');
            const text = response.text || '';

            // Robust JSON extraction and repair
            let jsonStr = text;

            // Step 1: Strip markdown code fences if present
            jsonStr = jsonStr.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim();

            // Step 2: Extract JSON object (outermost { ... })
            const firstBrace = jsonStr.indexOf('{');
            const lastBrace = jsonStr.lastIndexOf('}');
            if (firstBrace === -1) throw new Error('No JSON found in response');

            if (lastBrace > firstBrace) {
                jsonStr = jsonStr.substring(firstBrace, lastBrace + 1);
            } else {
                // Response was truncated — no closing brace found
                jsonStr = jsonStr.substring(firstBrace);
                console.warn('[ScriptAnalysis] ⚠️ JSON appears truncated (no closing }). Attempting repair...');
            }

            // Step 3: Repair common JSON issues from LLM responses
            const repairJson = (raw: string): string => {
                let s = raw;
                // Fix trailing commas before } or ]
                s = s.replace(/,\s*([\]}])/g, '$1');
                // Fix unquoted property names (common LLM error)
                s = s.replace(/([{,]\s*)([a-zA-Z_][a-zA-Z0-9_]*)\s*:/g, '$1"$2":');
                // Fix single-quoted strings → double-quoted
                // (careful not to break apostrophes inside already-double-quoted strings)
                // Only fix obvious cases: keys like 'value' at start of value position
                s = s.replace(/:\s*'([^']*)'/g, ': "$1"');
                return s;
            };

            // Step 4: Try parsing, with repair fallback
            let parsed: any;
            try {
                parsed = JSON.parse(jsonStr);
            } catch (e1) {
                console.warn('[ScriptAnalysis] ⚠️ Initial JSON.parse failed, attempting repair...', (e1 as Error).message);
                try {
                    const repaired = repairJson(jsonStr);
                    parsed = JSON.parse(repaired);
                    console.log('[ScriptAnalysis] ✅ JSON repair succeeded');
                } catch (e2) {
                    // Last resort: try to close truncated JSON by balancing brackets
                    console.warn('[ScriptAnalysis] ⚠️ Repair failed, trying bracket-balancing...', (e2 as Error).message);
                    try {
                        let balanced = repairJson(jsonStr);
                        // Count open/close brackets
                        const openBraces = (balanced.match(/{/g) || []).length;
                        const closeBraces = (balanced.match(/}/g) || []).length;
                        const openBrackets = (balanced.match(/\[/g) || []).length;
                        const closeBrackets = (balanced.match(/]/g) || []).length;

                        // Remove any trailing incomplete string/value
                        balanced = balanced.replace(/,\s*"[^"]*$/, ''); // trailing incomplete key
                        balanced = balanced.replace(/,\s*$/, ''); // trailing comma
                        balanced = balanced.replace(/:\s*"[^"]*$/, ': ""'); // trailing incomplete value

                        // Close missing brackets/braces
                        for (let i = 0; i < openBrackets - closeBrackets; i++) balanced += ']';
                        for (let i = 0; i < openBraces - closeBraces; i++) balanced += '}';

                        parsed = JSON.parse(balanced);
                        console.log('[ScriptAnalysis] ✅ Bracket-balancing repair succeeded (response was truncated)');
                    } catch (e3) {
                        throw new Error(`Failed to parse AI response as JSON. The response may be too large. Try reducing script length or scene count. Error: ${(e1 as Error).message}`);
                    }
                }
            }

            // Calculate durations and finalize
            const result: ScriptAnalysisResult = {
                totalWords: wordCount,
                estimatedDuration: estimatedTotalDuration,
                chapters: (parsed.chapters || []).map((ch: any) => ({
                    ...ch,
                    startIndex: 0,
                    endIndex: 0,
                    estimatedDuration: Math.ceil(estimatedTotalDuration / (parsed.chapters?.length || 1))
                })),
                characters: (parsed.characters || []).filter((c: any) => {
                    // Keep character if: isMain=true, OR mentions >= 2, OR has a proper name (capitalized)
                    if (c.isMain) return true;
                    if ((c.mentions || 0) >= 2) return true;
                    // Keep named characters (first letter uppercase, not generic like "The Man")
                    const name = (c.name || '').trim();
                    const isProperName = /^[A-ZÀ-ÿ][a-zà-ÿ]+\s+[A-ZÀ-ÿ]/.test(name); // e.g. "John Doe"
                    if (isProperName) return true;
                    console.log(`[ScriptAnalysis] 🧹 Filtered out minor character: "${c.name}" (mentions: ${c.mentions}, isMain: ${c.isMain})`);
                    return false;
                }),
                locations: (parsed.locations || []).map((loc: any) => ({
                    ...loc,
                    sceneRanges: loc.sceneRanges || []
                })),
                suggestedSceneCount: parsed.scenes.length,
                scenes: parsed.scenes.map((s: any) => ({
                    ...s,
                    estimatedDuration: Math.ceil(((s.voiceOverText || '').split(/\s+/).length / wpm) * 60)
                })),
                globalContext: parsed.globalContext
            };

            // ═══════════════════════════════════════════════════════════════
            // POST-PROCESSING: Deterministic Video/Static Zone Text Split
            // Ensures 100% coverage: Video Zone from start (1 sentence/scene),
            // Static Zone covers ALL remaining text evenly within chapters
            // ═══════════════════════════════════════════════════════════════
            if (videoZoneConfig?.enabled) {
                console.log('[ScriptAnalysis] 🎬 Deterministic Video/Static Zone split starting...');

                const { videoScenes: numVideoScenes, staticScenes: numStaticScenes } = videoZoneConfig;

                // Step 1: Extract clean narration text (remove markdown headers, metadata, bracketed notes)
                const cleanLines = lines.filter(line => {
                    const trimmed = line.trim();
                    if (!trimmed) return false;
                    if (trimmed.startsWith('#')) return false; // Markdown headers
                    if (trimmed.startsWith('---')) return false; // Horizontal rules
                    if (trimmed.startsWith('>')) return false; // Block quotes
                    if (trimmed.startsWith('**[') && trimmed.endsWith(']**')) return false; // Bracketed notes like **[BREADCRUMB]**
                    if (trimmed.startsWith('**') && trimmed.endsWith('**') && trimmed.includes(':')) return false; // Bold metadata
                    if (/^\*\*.*\*\*\s*$/.test(trimmed) && trimmed.length < 80) return false; // Short bold labels
                    if (trimmed.startsWith('[') && trimmed.endsWith(']')) return false; // [CTA], [CLIFFHANGER]
                    return true;
                });
                const cleanText = cleanLines.join(' ').replace(/\s+/g, ' ').trim();

                // Step 2: Split into sentences
                const splitIntoSentences = (text: string): string[] => {
                    // Split on sentence-ending punctuation followed by space or end
                    const raw = text.match(/[^.!?"]+(?:[.!?]+["']?\s*|$)/g) || [text];
                    // Filter out very short fragments and merge them
                    const result: string[] = [];
                    for (const seg of raw) {
                        const trimmed = seg.trim();
                        if (!trimmed) continue;
                        const wordCount = trimmed.split(/\s+/).length;
                        if (wordCount < 4 && result.length > 0) {
                            // Merge short fragment with previous
                            result[result.length - 1] += ' ' + trimmed;
                        } else {
                            result.push(trimmed);
                        }
                    }
                    return result;
                };

                const allSentences = splitIntoSentences(cleanText);
                console.log(`[ScriptAnalysis] 🎬 Total sentences: ${allSentences.length}`);

                // Step 3: Video Zone — take sentences from the beginning, each ≤25 words
                const videoScenesArr: { text: string; index: number }[] = [];
                let sentenceIdx = 0;

                while (videoScenesArr.length < numVideoScenes && sentenceIdx < allSentences.length) {
                    const sentence = allSentences[sentenceIdx].trim();
                    sentenceIdx++;
                    if (!sentence || sentence.length < 5) continue;

                    const words = sentence.split(/\s+/);
                    if (words.length <= 25) {
                        // Short enough for one video scene
                        videoScenesArr.push({ text: sentence, index: videoScenesArr.length });
                    } else {
                        // Split long sentence into chunks of ~20 words
                        for (let i = 0; i < words.length && videoScenesArr.length < numVideoScenes; i += 20) {
                            const chunk = words.slice(i, Math.min(i + 20, words.length)).join(' ');
                            videoScenesArr.push({ text: chunk, index: videoScenesArr.length });
                        }
                    }
                }

                // Step 4: Static Zone — remaining text, split evenly
                const remainingText = allSentences.slice(sentenceIdx).join(' ').trim();
                const remainingWords = remainingText.split(/\s+/);
                const staticScenesArr: { text: string; index: number }[] = [];

                if (remainingWords.length > 0 && numStaticScenes > 0) {
                    const wordsPerStatic = Math.ceil(remainingWords.length / numStaticScenes);
                    for (let i = 0; i < numStaticScenes; i++) {
                        const start = i * wordsPerStatic;
                        const end = Math.min((i + 1) * wordsPerStatic, remainingWords.length);
                        if (start >= remainingWords.length) break;
                        const text = remainingWords.slice(start, end).join(' ').trim();
                        if (text.length > 5) {
                            staticScenesArr.push({ text, index: videoScenesArr.length + i });
                        }
                    }
                }

                const totalDetermScenes = videoScenesArr.length + staticScenesArr.length;
                const videoWordsCovered = videoScenesArr.reduce((s, v) => s + v.text.split(/\s+/).length, 0);
                const staticWordsCovered = staticScenesArr.reduce((s, v) => s + v.text.split(/\s+/).length, 0);
                console.log(`[ScriptAnalysis] 🎬 Deterministic split: ${videoScenesArr.length} video (${videoWordsCovered} words) + ${staticScenesArr.length} static (${staticWordsCovered} words) = ${totalDetermScenes} scenes`);

                // Step 5: Find chapter for each scene (by matching text position in original script)
                const getChapterForText = (text: string): string => {
                    const searchWords = text.toLowerCase().split(/\s+/).slice(0, 5).join(' ');
                    for (let i = 0; i < lines.length; i++) {
                        if (lines[i].toLowerCase().includes(searchWords.substring(0, 20))) {
                            // Found the line — now find which chapter
                            for (let m = chapterMarkers.length - 1; m >= 0; m--) {
                                if (i >= chapterMarkers[m].lineNumber - 1) {
                                    return chapterMarkers[m].chapterId;
                                }
                            }
                            break;
                        }
                    }
                    return chapterMarkers[0]?.chapterId || 'chapter_1';
                };

                // Step 6: Find matching AI scene for visual prompt inheritance
                const findAIScene = (text: string): any | null => {
                    const searchWords = text.toLowerCase().split(/\s+/).slice(0, 4).filter(w => w.length > 3).join(' ');
                    if (!searchWords) return null;
                    for (const aiScene of (parsed.scenes || [])) {
                        const aiVO = (aiScene.voiceOverText || '').toLowerCase();
                        if (aiVO.includes(searchWords) || searchWords.includes(aiVO.substring(0, 30).toLowerCase())) {
                            return aiScene;
                        }
                    }
                    return null;
                };

                // Step 7: Build new deterministic scenes array
                const newScenes: any[] = [];

                for (const vs of videoScenesArr) {
                    const aiMatch = findAIScene(vs.text);
                    const chapterId = getChapterForText(vs.text);
                    newScenes.push({
                        voiceOverText: vs.text,
                        zone: 'video',
                        dialogueText: aiMatch?.dialogueText || null,
                        dialogueSpeaker: aiMatch?.dialogueSpeaker || null,
                        visualPrompt: aiMatch?.visualPrompt || `CINEMATIC SHOT. ${vs.text.substring(0, 120)}`,
                        chapterId,
                        characterNames: aiMatch?.characterNames || [],
                        needsExpansion: false,
                        estimatedDuration: Math.ceil((vs.text.split(/\s+/).length / wpm) * 60)
                    });
                }

                for (const ss of staticScenesArr) {
                    const aiMatch = findAIScene(ss.text);
                    const chapterId = getChapterForText(ss.text);
                    newScenes.push({
                        voiceOverText: ss.text,
                        zone: 'static',
                        dialogueText: aiMatch?.dialogueText || null,
                        dialogueSpeaker: aiMatch?.dialogueSpeaker || null,
                        visualPrompt: aiMatch?.visualPrompt || `MEDIUM SHOT. Scene depicting: ${ss.text.substring(0, 120)}`,
                        chapterId,
                        characterNames: aiMatch?.characterNames || [],
                        needsExpansion: false,
                        estimatedDuration: Math.ceil((ss.text.split(/\s+/).length / wpm) * 60)
                    });
                }

                // ═══════════════════════════════════════════════════════
                // CHARACTER ASSIGNMENT: Text Match + Carry Forward
                // Assign characters to deterministic scenes without relying on AI matching
                // ═══════════════════════════════════════════════════════
                const allCharNames = (result.characters || []).map((c: any) => ({
                    name: c.name as string,
                    nameLower: (c.name as string).toLowerCase(),
                    // Also check first name only (e.g. "Kevin" from "Kevin Park")
                    firstName: (c.name as string).split(/\s+/)[0]?.toLowerCase() || ''
                }));

                if (allCharNames.length > 0) {
                    console.log(`[ScriptAnalysis] 👤 Assigning ${allCharNames.length} characters to ${newScenes.length} scenes...`);

                    // Pass 1: Text Match — scan each scene's text for character names
                    for (const scene of newScenes) {
                        const voLower = (scene.voiceOverText || '').toLowerCase();
                        const matched: string[] = [];
                        for (const ch of allCharNames) {
                            if (voLower.includes(ch.nameLower) || voLower.includes(ch.firstName)) {
                                matched.push(ch.name);
                            }
                        }
                        if (matched.length > 0) {
                            scene.characterNames = matched;
                        }
                    }

                    // Pass 2: Carry Forward — scenes with no characters inherit from previous scene (same chapter)
                    for (let i = 1; i < newScenes.length; i++) {
                        const curr = newScenes[i];
                        const prev = newScenes[i - 1];
                        if ((!curr.characterNames || curr.characterNames.length === 0) && prev.chapterId === curr.chapterId) {
                            curr.characterNames = [...(prev.characterNames || [])];
                        }
                    }

                    const assigned = newScenes.filter(s => s.characterNames && s.characterNames.length > 0).length;
                    console.log(`[ScriptAnalysis] 👤 Character assignment: ${assigned}/${newScenes.length} scenes have characters`);
                }

                // Replace AI's scenes with deterministic split
                result.scenes = newScenes;
                result.suggestedSceneCount = newScenes.length;
                console.log(`[ScriptAnalysis] 🎬 Deterministic split complete: ${newScenes.length} scenes (${videoScenesArr.length} video + ${staticScenesArr.length} static), total words: ${videoWordsCovered + staticWordsCovered}`);
                addLog(`🎬 Deterministic Split: ${newScenes.length} scenes (${videoScenesArr.length} video + ${staticScenesArr.length} static)`, 'success');
            }

            // ═══════════════════════════════════════════════════════════════
            // POST-PROCESSING: Enforce Scene Count (Safety Net)
            // If AI exceeded the user's target, merge shortest adjacent scenes
            // ═══════════════════════════════════════════════════════════════
            if (sceneCountEstimate && result.scenes.length > Math.ceil(sceneCountEstimate * 1.1)) {
                const maxAllowed = Math.ceil(sceneCountEstimate * 1.1);
                console.log(`[ScriptAnalysis] ⚠️ AI produced ${result.scenes.length} scenes but target is ${sceneCountEstimate} (max ${maxAllowed}). Merging excess...`);

                while (result.scenes.length > maxAllowed && result.scenes.length > 2) {
                    // Find the shortest scene (least voiceover text) that is NOT the first or last
                    let shortestIdx = 1;
                    let shortestLen = Infinity;
                    for (let i = 1; i < result.scenes.length - 1; i++) {
                        const len = (result.scenes[i].voiceOverText || '').length;
                        if (len < shortestLen) {
                            shortestLen = len;
                            shortestIdx = i;
                        }
                    }

                    // Merge with previous scene (combine voiceover text and visual prompt)
                    const prevScene = result.scenes[shortestIdx - 1];
                    const currScene = result.scenes[shortestIdx];

                    prevScene.voiceOverText = ((prevScene.voiceOverText || '') + ' ' + (currScene.voiceOverText || '')).trim();
                    prevScene.visualPrompt = ((prevScene.visualPrompt || '') + ' | ' + (currScene.visualPrompt || '')).trim();

                    // Merge character names
                    const mergedChars = new Set([...(prevScene.characterNames || []), ...(currScene.characterNames || [])]);
                    prevScene.characterNames = Array.from(mergedChars);

                    // Recalculate duration
                    prevScene.estimatedDuration = Math.ceil(((prevScene.voiceOverText || '').split(/\s+/).length / wpm) * 60);

                    // Remove merged scene
                    result.scenes.splice(shortestIdx, 1);
                }

                result.suggestedSceneCount = result.scenes.length;
                console.log(`[ScriptAnalysis] ✅ Merged down to ${result.scenes.length} scenes (target: ${sceneCountEstimate})`);
            }

            // ═══════════════════════════════════════════════════════════════
            // POST-PROCESSING: Coverage Gap Fill (100% Script Coverage)
            // Detect uncovered script text and fill gaps with static scenes
            // ═══════════════════════════════════════════════════════════════
            {
                console.log('[ScriptAnalysis] 🔍 Coverage gap detection starting...');

                // Build a map of which lines are covered by existing scenes
                const lineCovered = new Array(lines.length).fill(false);
                const normalizeForMatch = (text: string) =>
                    text.toLowerCase().replace(/[^a-z0-9\sàáạảãăắằặẳẵâấầậẩẫđèéẹẻẽêếềệểễòóọỏõôốồộổỗơớờợởỡùúụủũưứừựửữỳýỵỷỹ]/g, '').replace(/\s+/g, ' ').trim();

                // For each scene, find which lines of the original script it covers
                for (const scene of result.scenes) {
                    const voText = scene.voiceOverText || '';
                    if (!voText || voText.length < 5) continue;

                    // Try to match scene text against original script lines
                    const sceneWords = normalizeForMatch(voText).split(' ').filter((w: string) => w.length > 2);
                    if (sceneWords.length < 2) continue;

                    // Use first few words to find the start position
                    const searchPhrase = sceneWords.slice(0, Math.min(5, sceneWords.length)).join(' ');

                    for (let i = 0; i < lines.length; i++) {
                        const lineNorm = normalizeForMatch(lines[i]);
                        if (lineNorm.includes(searchPhrase) || searchPhrase.includes(lineNorm.substring(0, 20))) {
                            // Mark this line and nearby lines as covered
                            const wordsCovered = sceneWords.length;
                            const linesEstimate = Math.max(1, Math.ceil(wordsCovered / 10)); // ~10 words per line
                            for (let j = i; j < Math.min(i + linesEstimate, lines.length); j++) {
                                lineCovered[j] = true;
                            }
                            break;
                        }
                    }
                }

                // Also mark chapter headers and empty lines as covered
                for (let i = 0; i < lines.length; i++) {
                    const trimmed = lines[i].trim();
                    if (!trimmed || trimmed.startsWith('[') || /^\s*$/.test(trimmed)) {
                        lineCovered[i] = true;
                    }
                }

                // Find uncovered paragraphs (groups of consecutive uncovered non-empty lines)
                const gaps: { startLine: number; endLine: number; text: string; chapterId: string }[] = [];
                let gapStart = -1;

                for (let i = 0; i < lines.length; i++) {
                    const isUncovered = !lineCovered[i] && lines[i].trim().length > 0;
                    if (isUncovered && gapStart < 0) {
                        gapStart = i;
                    } else if (!isUncovered && gapStart >= 0) {
                        const gapText = lines.slice(gapStart, i).map(l => l.trim()).filter(Boolean).join(' ');
                        if (gapText.split(/\s+/).length >= 5) { // Only significant gaps (5+ words)
                            // Determine which chapter this gap belongs to
                            let gapChapterId = 'chapter_1';
                            if (chapterMarkers.length > 0) {
                                for (let m = chapterMarkers.length - 1; m >= 0; m--) {
                                    if (gapStart >= chapterMarkers[m].lineNumber) {
                                        gapChapterId = chapterMarkers[m].chapterId;
                                        break;
                                    }
                                }
                            }
                            gaps.push({ startLine: gapStart, endLine: i - 1, text: gapText, chapterId: gapChapterId });
                        }
                        gapStart = -1;
                    }
                }
                // Handle gap at end of file
                if (gapStart >= 0) {
                    const gapText = lines.slice(gapStart).map(l => l.trim()).filter(Boolean).join(' ');
                    if (gapText.split(/\s+/).length >= 5) {
                        let gapChapterId = 'chapter_1';
                        if (chapterMarkers.length > 0) {
                            for (let m = chapterMarkers.length - 1; m >= 0; m--) {
                                if (gapStart >= chapterMarkers[m].lineNumber) {
                                    gapChapterId = chapterMarkers[m].chapterId;
                                    break;
                                }
                            }
                        }
                        gaps.push({ startLine: gapStart, endLine: lines.length - 1, text: gapText, chapterId: gapChapterId });
                    }
                }

                if (gaps.length > 0) {
                    const totalGapWords = gaps.reduce((s, g) => s + g.text.split(/\s+/).length, 0);
                    console.log(`[ScriptAnalysis] 📊 Found ${gaps.length} coverage gaps (${totalGapWords} words uncovered)`);

                    // Create static scenes for each gap, distributing evenly within chapters
                    // Group gaps by chapter
                    const gapsByChapter: Record<string, typeof gaps> = {};
                    for (const gap of gaps) {
                        if (!gapsByChapter[gap.chapterId]) gapsByChapter[gap.chapterId] = [];
                        gapsByChapter[gap.chapterId].push(gap);
                    }

                    const newGapScenes: any[] = [];
                    for (const [chapterId, chapterGaps] of Object.entries(gapsByChapter)) {
                        // Combine all gap text in this chapter
                        const combinedText = chapterGaps.map(g => g.text).join(' ');
                        const combinedWords = combinedText.split(/\s+/);

                        // Split into scenes of ~100-160 words each
                        const targetWordsPerScene = 130;
                        const numGapScenes = Math.max(1, Math.ceil(combinedWords.length / targetWordsPerScene));

                        const wordsPerScene = Math.ceil(combinedWords.length / numGapScenes);

                        for (let s = 0; s < numGapScenes; s++) {
                            const start = s * wordsPerScene;
                            const end = Math.min((s + 1) * wordsPerScene, combinedWords.length);
                            const sceneText = combinedWords.slice(start, end).join(' ');

                            if (sceneText.trim().length < 10) continue;

                            newGapScenes.push({
                                voiceOverText: sceneText,
                                visualPrompt: `MEDIUM SHOT. Scene depicting: ${sceneText.substring(0, 100)}...`,
                                chapterId,
                                characterNames: [],
                                zone: 'static',
                                needsExpansion: false,
                                estimatedDuration: Math.ceil((end - start) / wpm * 60),
                                _isGapFill: true // Internal marker
                            });
                        }

                        console.log(`[ScriptAnalysis] 📊 Chapter "${chapterId}": ${chapterGaps.length} gaps → ${numGapScenes} new static scenes`);
                    }

                    if (newGapScenes.length > 0) {
                        // Insert gap scenes at the end of their respective chapters
                        for (const gapScene of newGapScenes) {
                            // Find the last scene of this chapter
                            let insertIdx = result.scenes.length; // Default: append at end
                            for (let i = result.scenes.length - 1; i >= 0; i--) {
                                if (result.scenes[i].chapterId === gapScene.chapterId) {
                                    insertIdx = i + 1;
                                    break;
                                }
                            }
                            result.scenes.splice(insertIdx, 0, gapScene);
                        }

                        console.log(`[ScriptAnalysis] ✅ Added ${newGapScenes.length} gap-fill scenes. Total: ${result.scenes.length}`);

                        // Re-enforce scene count if we added too many
                        if (sceneCountEstimate && result.scenes.length > Math.ceil(sceneCountEstimate * 1.15)) {
                            const maxAllowed = Math.ceil(sceneCountEstimate * 1.1);
                            console.log(`[ScriptAnalysis] ⚠️ Gap fill pushed count to ${result.scenes.length}, merging back to ${maxAllowed}...`);

                            while (result.scenes.length > maxAllowed && result.scenes.length > 2) {
                                // Find shortest STATIC scene to merge (prefer gap-fill scenes)
                                let shortestIdx = -1;
                                let shortestLen = Infinity;
                                for (let i = 1; i < result.scenes.length - 1; i++) {
                                    const sc = result.scenes[i];
                                    if (sc.zone === 'video') continue; // Never merge video scenes
                                    const len = (sc.voiceOverText || '').length;
                                    const priority = sc._isGapFill ? len : len + 50000; // Prefer merging gap-fills first
                                    if (priority < shortestLen) {
                                        shortestLen = priority;
                                        shortestIdx = i;
                                    }
                                }
                                if (shortestIdx < 0) break;

                                // Merge with nearest static neighbor (prefer same chapter)
                                let mergeTarget = shortestIdx - 1;
                                if (mergeTarget >= 0 && result.scenes[mergeTarget].zone === 'video') {
                                    mergeTarget = shortestIdx + 1 < result.scenes.length ? shortestIdx + 1 : shortestIdx - 1;
                                }
                                if (mergeTarget < 0 || mergeTarget >= result.scenes.length) break;

                                const target = result.scenes[mergeTarget];
                                const source = result.scenes[shortestIdx];
                                target.voiceOverText = ((target.voiceOverText || '') + ' ' + (source.voiceOverText || '')).trim();
                                target.visualPrompt = ((target.visualPrompt || '') + ' | ' + (source.visualPrompt || '')).trim();
                                const mc = new Set([...(target.characterNames || []), ...(source.characterNames || [])]);
                                target.characterNames = Array.from(mc);
                                target.estimatedDuration = Math.ceil(((target.voiceOverText || '').split(/\s+/).length / wpm) * 60);
                                result.scenes.splice(shortestIdx, 1);
                            }

                            result.suggestedSceneCount = result.scenes.length;
                            console.log(`[ScriptAnalysis] ✅ After gap-fill merge: ${result.scenes.length} scenes`);
                        }
                    }
                } else {
                    console.log('[ScriptAnalysis] ✅ No coverage gaps found — script fully covered!');
                }
            }

            // ═══════════════════════════════════════════════════════════════
            // POST-PROCESSING: Override chapterId based on voiceOverText position
            // This fixes AI's incorrect chapter assignments by finding where
            // each scene's text appears in the original script
            // ═══════════════════════════════════════════════════════════════
            if (chapterMarkers.length > 0) {
                console.log('[ScriptAnalysis] 🔧 POST-PROCESSING: Overriding chapter assignments...');

                // Build chapter ranges (start line to end line for each chapter)
                const chapterRanges = chapterMarkers.map((marker, i) => {
                    const nextMarker = chapterMarkers[i + 1];
                    return {
                        chapterId: marker.chapterId,
                        header: marker.header,
                        startLine: marker.lineNumber,
                        endLine: nextMarker ? nextMarker.lineNumber - 1 : lines.length
                    };
                });

                console.log('[Chapter Ranges]:', chapterRanges.map(r => `${r.header}: lines ${r.startLine}-${r.endLine}`).join(', '));

                // Helper function to find text in script
                const findTextInScript = (text: string): number => {
                    if (!text || text.length < 5) return -1;
                    const cleanText = text.toLowerCase().replace(/[^a-z0-9\s]/g, '');

                    // Try different search lengths (8, 6, 4, 3 words)
                    for (const wordLimit of [8, 6, 4, 3]) {
                        const searchWords = cleanText.split(/\s+/).slice(0, wordLimit).filter(w => w.length > 2);
                        if (searchWords.length < 2) continue;
                        const searchString = searchWords.join(' ');

                        for (let i = 0; i < lines.length; i++) {
                            const lineLower = lines[i].toLowerCase().replace(/[^a-z0-9\s]/g, '');
                            if (lineLower.includes(searchString)) {
                                return i + 1; // 1-indexed line number
                            }
                        }
                    }
                    return -1;
                };

                // Assign chapter based on line number
                const getChapterForLine = (lineNum: number): string => {
                    for (const range of chapterRanges) {
                        if (lineNum >= range.startLine && lineNum <= range.endLine) {
                            return range.chapterId;
                        }
                    }
                    return chapterMarkers[0]?.chapterId || '';
                };

                // Process each scene
                const totalScenes = result.scenes.length;
                result.scenes = result.scenes.map((scene: any, sceneIndex: number) => {
                    const voText = scene.voiceOverText || '';

                    // Try to find voiceOverText in original script
                    let foundLineNumber = findTextInScript(voText);

                    // Fallback: use scene index proportion to estimate line position
                    if (foundLineNumber === -1) {
                        // Estimate: scene 5 of 20 scenes → ~25% through script → line 25% of total lines
                        const proportion = sceneIndex / totalScenes;
                        foundLineNumber = Math.floor(proportion * lines.length) + 1;
                        console.log(`[Chapter Fallback] Scene ${sceneIndex + 1}: using proportion ${(proportion * 100).toFixed(0)}% → line ~${foundLineNumber}`);
                    }

                    const correctChapterId = getChapterForLine(foundLineNumber);

                    if (correctChapterId && correctChapterId !== scene.chapterId) {
                        console.log(`[Chapter Override] Scene ${sceneIndex + 1} "${voText.substring(0, 25)}..." (line ${foundLineNumber}): ${scene.chapterId || 'none'} → ${correctChapterId}`);
                    }

                    return { ...scene, chapterId: correctChapterId || scene.chapterId };
                });
            }

            // ═══════════════════════════════════════════════════════════════
            // POST-PROCESSING: Clean Silent Visual Notes (...) from VoiceOver
            // ═══════════════════════════════════════════════════════════════
            console.log('[ScriptAnalysis] 🧹 cleaning visual notes (...) from voice-over text...');
            result.scenes = result.scenes.map((scene: any) => {
                // Regex to remove content inside parentheses, handling nested or multiple per line
                const cleanText = (text: string) => {
                    if (!text) return '';
                    // Replace (...) with empty string, trimming extra spaces
                    return text.replace(/\([^)]+\)/g, '').replace(/\s+/g, ' ').trim();
                };

                const oldVO = scene.voiceOverText || '';
                const newVO = cleanText(oldVO);

                if (oldVO !== newVO) {
                    console.log(`[Clean Output] Removed notes from VO: "${oldVO}" -> "${newVO}"`);
                }

                // Also clean dialogue text if present
                const oldDiag = scene.dialogueText || '';
                const newDiag = cleanText(oldDiag);

                return {
                    ...scene,
                    voiceOverText: newVO,
                    dialogueText: newDiag
                };
            });

            if (result.locations.length > 0) {
                console.log(`[ScriptAnalysis] 📍 Detected ${result.locations.length} unique locations:`,
                    result.locations.map(l => l.name).join(', '));
            }

            // ═══════════════════════════════════════════════════════════════
            // TRUNCATION DETECTION: Warn if AI didn't cover the full script
            // ═══════════════════════════════════════════════════════════════
            const analyzedWords = result.scenes.reduce((sum: number, s: any) =>
                sum + ((s.voiceOverText || '').split(/\s+/).filter(Boolean).length), 0);
            const coverageRatio = wordCount > 0 ? analyzedWords / wordCount : 1;
            if (coverageRatio < 0.7) {
                console.warn(`[ScriptAnalysis] ⚠️ TRUNCATION DETECTED: Only ${(coverageRatio * 100).toFixed(0)}% of script covered (${analyzedWords}/${wordCount} words). Output may have been cut off.`);
                // Context-aware warning message
                const coveragePct = (coverageRatio * 100).toFixed(0);
                let warningMsg = `AI chỉ phân tích được ~${coveragePct}% kịch bản (${analyzedWords}/${wordCount} từ).`;
                let tipMsg = '';
                if (enableBRoll) {
                    warningMsg += ' Hãy thử tắt B-Roll hoặc giảm độ dài script.';
                    tipMsg = 'Tip: Tắt B-Roll Expansion trong settings để giảm output size.';
                } else {
                    warningMsg += ' Script quá dài cho 1 lần phân tích.';
                    tipMsg = 'Tip: Thử chia script thành 2-3 phần nhỏ hơn, hoặc giảm số scene trong Video Zone.';
                }
                (result as any)._truncationWarning = warningMsg;
                (result as any)._truncationTip = tipMsg;
            } else {
                console.log(`[ScriptAnalysis] ✅ Coverage: ${(coverageRatio * 100).toFixed(0)}% (${analyzedWords}/${wordCount} words)`);
            }

            setAnalysisStage('finalizing');
            setAnalysisResult(result);
            addLog(`🎉 Hoàn tất! ${result.scenes.length} scenes, ${result.characters.length} nhân vật, ${result.chapters.length} chapters`, 'success');
            console.log('[ScriptAnalysis] ✅ Analysis complete:', result);
            return result;

        } catch (error: any) {
            console.error('[ScriptAnalysis] ❌ Error:', error);
            addLog(`❌ Lỗi: ${error.message || 'Analysis failed'}`, 'error');
            setAnalysisError(error.message || 'Analysis failed');
            return null;
        } finally {
            setIsAnalyzing(false);
            setAnalysisStage('idle');
        }
    }, [userApiKey]);

    /**
     * Generate Scene Map from analysis result
     */
    const generateSceneMap = useCallback((
        analysis: ScriptAnalysisResult,
        director: DirectorPreset | null,
        characterStyle: CharacterStyleDefinition | null,
        existingCharacters: Character[] = []
    ): { scenes: Scene[]; groups: SceneGroup[]; newCharacters: { name: string; description: string }[]; sceneCharacterMap: Record<number, string[]> } => {

        // Create chapter ID -> locationAnchor map for quick lookup
        const chapterLocationMap: Record<string, string> = {};
        analysis.chapters.forEach(ch => {
            chapterLocationMap[ch.id] = ch.locationAnchor || '';
        });

        const groups: SceneGroup[] = analysis.chapters.map(ch => {
            const outfitOverrides: Record<string, string> = {};
            // Map character name -> outfit for this chapter
            analysis.characters.forEach(c => {
                // Ensure case-insensitive or exact name match? 
                // We will use the exact name here and rely on App.tsx to resolve IDs
                if (c.outfitByChapter?.[ch.id]) {
                    outfitOverrides[c.name] = c.outfitByChapter[ch.id];
                }
            });

            return {
                id: ch.id,
                name: ch.title,
                // PHASE 2: Store locationAnchor in description for concept image reference
                description: ch.locationAnchor || ch.title,
                timeOfDay: (ch.suggestedTimeOfDay as any) || 'day',
                weather: (ch.suggestedWeather as any) || 'clear',
                outfitOverrides
            };
        });

        const scenes: Scene[] = [];
        let sceneNumber = 1;

        // Resolve character style prompts
        const stylePrompt = characterStyle?.promptInjection.global || '';
        const directorDna = director?.dna || '';
        const directorCamera = director?.signatureCameraStyle || '';

        const sceneCharacterMap: Record<number, string[]> = {};

        // --- SCENE STATE MEMORY (Option A) ---
        // Track character positions/states across scenes for animation continuity
        interface CharacterState {
            name: string;
            position: string; // 'standing' | 'lying' | 'kneeling' | 'sitting'
            props: string[];
        }
        let sceneStateMemory: CharacterState[] = [];

        const extractStateFromVoiceOver = (voText: string): CharacterState[] => {
            const states: CharacterState[] = [];
            const text = voText.toLowerCase();

            // Position detection patterns - FIXED: use word boundaries and common subjects
            // Instead of capturing any word, look for specific subjects + action
            const positionPatterns = [
                // Specific subjects: "The man lies face down", "A person lies"
                { regex: /\b(the\s+man|a\s+man|the\s+person|the\s+suspect|the\s+victim|the\s+body)\s+(lies?|lying)\s+(face\s*down)/gi, position: 'lying face down' },
                { regex: /\b(the\s+man|a\s+man|the\s+person|the\s+suspect|he)\s+(lies?|lying)/gi, position: 'lying' },
                { regex: /\b(the\s+man|a\s+man|the\s+officer|he|she)\s+(kneels?|kneeling)/gi, position: 'kneeling' },
                { regex: /\b(the\s+man|a\s+man|the\s+officer|he|she)\s+(stands?|standing)/gi, position: 'standing' },
                { regex: /\b(the\s+man|a\s+man|the\s+officer|he|she)\s+(sits?|sitting)/gi, position: 'sitting' },
                // Capitalized proper names followed by action (e.g., "Rémy stands")
                { regex: /\b([A-Z][a-zà-ÿ]+)\s+(lies?|lying|kneels?|kneeling|stands?|standing|sits?|sitting)/g, position: 'dynamic' },
                // Props/state descriptors
                { regex: /hands?\s+cuffed/gi, position: 'hands cuffed behind back', name: 'the man' },
                { regex: /face\s*down\s+on\s+(concrete|floor|ground)/gi, position: 'lying face down', name: 'the man' },
            ];

            for (const patternDef of positionPatterns) {
                const { regex, position, name } = patternDef;
                regex.lastIndex = 0; // Reset regex state
                const match = regex.exec(text);
                if (match) {
                    let charName = name || 'the man';
                    let charPosition = position;

                    // For dynamic position patterns, extract both name and action
                    if (position === 'dynamic' && match[1] && match[2]) {
                        charName = match[1];
                        const action = match[2].toLowerCase();
                        if (action.includes('lie') || action.includes('lying')) charPosition = 'lying';
                        else if (action.includes('kneel')) charPosition = 'kneeling';
                        else if (action.includes('stand')) charPosition = 'standing';
                        else if (action.includes('sit')) charPosition = 'sitting';
                    } else if (match[1]) {
                        charName = match[1].trim();
                    }

                    // Avoid duplicates
                    if (!states.some(s => s.name === charName && s.position === charPosition)) {
                        states.push({
                            name: charName,
                            position: charPosition,
                            props: []
                        });
                    }
                }
            }

            return states;
        };

        const buildSceneStateSummary = (): string => {
            if (sceneStateMemory.length === 0) return '';
            const summary = sceneStateMemory.map(s => `${s.name}: ${s.position}`).join(', ');
            return `[SCENE STATE MEMORY - MAINTAIN THESE POSITIONS]: ${summary}`;
        };

        for (const sceneAnalysis of analysis.scenes) {
            // DEBUG: Log VO and Dialogue from AI response
            console.log(`[ScriptAnalysis] 📝 Scene ${sceneNumber} from AI:`, {
                voiceOverText: sceneAnalysis.voiceOverText?.substring(0, 50) || 'NULL',
                dialogueText: sceneAnalysis.dialogueText?.substring(0, 50) || 'NULL',
                dialogueSpeaker: sceneAnalysis.dialogueSpeaker || 'NULL'
            });

            // PHASE 2: Get locationAnchor for this scene's chapter
            const locationAnchor = chapterLocationMap[sceneAnalysis.chapterId] || '';

            // PHASE 3: CRITICAL - Reset scene state memory on GROUP BOUNDARY change
            // This prevents positions from Location A being carried to Location B
            const currentChapterId = sceneAnalysis.chapterId;
            const previousScene = scenes[scenes.length - 1]; // Get last added scene
            const previousChapterId = previousScene?.groupId;

            if (previousChapterId && currentChapterId !== previousChapterId) {
                // GROUP CHANGE DETECTED - Reset all state memory
                sceneStateMemory = [];
                console.log(`[ScriptAnalysis] 🔄 GROUP BOUNDARY: Reset state memory (${previousChapterId} → ${currentChapterId})`);
            }

            // PHASE 3: Build scene state summary for animation continuity (only within same group)
            const sceneStateSummary = buildSceneStateSummary();

            // Main scene with VO
            const mainScene: Scene = {
                id: `scene_${sceneNumber}`,
                sceneNumber: String(sceneNumber),
                groupId: sceneAnalysis.chapterId,

                // Dialogue - if AI detected dialogue, format it with speaker
                language1: sceneAnalysis.dialogueText
                    ? (sceneAnalysis.dialogueSpeaker
                        ? `${sceneAnalysis.dialogueSpeaker}: ${sceneAnalysis.dialogueText}`
                        : sceneAnalysis.dialogueText)
                    : '',
                vietnamese: '', // Secondary language empty by default

                promptName: `Scene ${sceneNumber}`,

                // VO fields - narration text
                voiceOverText: sceneAnalysis.voiceOverText,
                isVOScene: Boolean(sceneAnalysis.voiceOverText),
                isDialogueScene: Boolean(sceneAnalysis.dialogueText && sceneAnalysis.dialogueSpeaker),
                voSecondsEstimate: sceneAnalysis.estimatedDuration,

                // PHASE 2+3: Visual prompt with LOCATION ANCHOR + SCENE STATE MEMORY
                contextDescription: [
                    sceneStateSummary, // Inject previous scene states first (animation continuity)
                    locationAnchor ? `[LOCATION ANCHOR - MANDATORY]: ${locationAnchor}` : '',
                    stylePrompt ? `[CHARACTER STYLE]: ${stylePrompt}` : '',
                    directorDna ? `[DIRECTOR DNA]: ${directorDna}` : '',
                    directorCamera ? `[CAMERA STYLE]: ${directorCamera}` : '',
                    sceneAnalysis.visualPrompt
                ].filter(Boolean).join('\n\n'),

                characterIds: [], // Will be mapped after character creation
                productIds: [],
                generatedImage: null,
                veoPrompt: '',
                isGenerating: false,
                error: null
            };


            // Map characters to scene index (0-based)
            // Map characters to scene index (0-based)
            sceneCharacterMap[scenes.length] = sceneAnalysis.characterNames || [];

            // PHASE 3: Update scene state memory for next scene's continuity
            if (sceneAnalysis.voiceOverText) {
                const newStates = extractStateFromVoiceOver(sceneAnalysis.voiceOverText);
                if (newStates.length > 0) {
                    // Merge new states with existing (newer states override)
                    newStates.forEach(ns => {
                        const existing = sceneStateMemory.findIndex(s => s.name === ns.name);
                        if (existing >= 0) {
                            sceneStateMemory[existing] = ns;
                        } else {
                            sceneStateMemory.push(ns);
                        }
                    });
                    console.log(`[ScriptAnalysis] 🎭 Scene ${sceneNumber} state memory updated:`, sceneStateMemory);
                }
            }

            // AUTO-ASSIGN EXISTING CHARACTERS
            if (existingCharacters && existingCharacters.length > 0) {
                const foundIds: string[] = [];
                const namesInScene = (sceneAnalysis.characterNames || []).map((n: string) => n.toLowerCase());

                existingCharacters.forEach(char => {
                    const charName = char.name.toLowerCase();
                    // Check for full match or partial match (e.g. "John" in "John Doe")
                    const isMatch = namesInScene.some((n: string) =>
                        charName.includes(n) || n.includes(charName) ||
                        (char.description && char.description.toLowerCase().includes(n))
                    );
                    if (isMatch) {
                        foundIds.push(char.id);
                    }
                });
                mainScene.characterIds = foundIds;
            }

            scenes.push(mainScene);
            sceneNumber++;

            // Expansion scenes (B-roll)
            if (sceneAnalysis.needsExpansion && sceneAnalysis.expansionScenes) {
                for (const expansion of sceneAnalysis.expansionScenes) {
                    const bRollScene: Scene = {
                        id: `scene_${sceneNumber}`,
                        sceneNumber: String(sceneNumber),
                        groupId: sceneAnalysis.chapterId,
                        language1: '',
                        vietnamese: '',
                        promptName: `B-Roll ${sceneNumber}`,

                        // B-roll has no VO
                        voiceOverText: undefined,
                        isVOScene: false,
                        referenceSceneId: mainScene.id, // Reference the VO scene

                        // PHASE 3: B-roll inherits locationAnchor from parent scene
                        contextDescription: [
                            locationAnchor ? `[LOCATION ANCHOR - MANDATORY]: ${locationAnchor}` : '',
                            `[B-ROLL FOR SCENE ${sceneNumber - 1}]: Match environment from parent scene`,
                            stylePrompt ? `[CHARACTER STYLE]: ${stylePrompt}` : '',
                            directorDna ? `[DIRECTOR DNA]: ${directorDna}` : '',
                            expansion.visualPrompt
                        ].filter(Boolean).join('\n\n'),

                        characterIds: [],
                        productIds: [],
                        generatedImage: null,
                        veoPrompt: '',
                        isGenerating: false,
                        error: null
                    };

                    // B-roll inherits characters from main scene? Or none?
                    // Typically B-roll is about environment or specific details.
                    // If it's a character B-roll, visualPrompt should describe it.
                    // For now, we don't auto-assign characters to B-roll to avoid clutter
                    sceneCharacterMap[scenes.length] = [];

                    scenes.push(bRollScene);
                    sceneNumber++;
                }
            }
        }

        // Identify new characters not in existing list
        // Filter: only add characters that are important (isMain OR mentions >= 2 OR proper name)
        const existingNames = new Set(existingCharacters.map(c => c.name.toLowerCase()));
        const newCharacters = analysis.characters
            .filter(c => {
                if (existingNames.has(c.name.toLowerCase())) return false; // Already exists
                // Importance filter: keep main OR ≥2 mentions OR proper name
                if (c.isMain) return true;
                if ((c.mentions || 0) >= 2) return true;
                const isProperName = /^[A-ZÀ-ÿ][a-zà-ÿ]+\s+[A-ZÀ-ÿ]/.test((c.name || '').trim());
                if (isProperName) return true;
                // Single-word named characters (like "Rémy", "Pierre") — keep if capitalized
                const isSingleProperName = /^[A-ZÀ-ÿ][a-zà-ÿ]{2,}$/.test((c.name || '').trim());
                if (isSingleProperName) return true;
                console.log(`[SceneMap] 🧹 Skipped minor character: "${c.name}" (mentions: ${c.mentions})`);
                return false;
            })
            .map(c => ({
                name: c.name,
                description: c.suggestedDescription
            }));

        return { scenes, groups, newCharacters, sceneCharacterMap };
    }, []);

    return {
        isAnalyzing,
        analysisStage,
        analysisResult,
        analysisError,
        analysisLogs,
        analyzeScript,
        generateSceneMap,
        setAnalysisResult
    };
}
