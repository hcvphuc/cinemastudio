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
import { getAIProvider } from '../utils/aiProvider';
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
    needsExpansion: boolean; // If VO is long and needs multiple visual scenes
    isVideoZone?: boolean; // True = first N scenes for video generation, false = static image
    expansionScenes?: {
        visualPrompt: string;
        isBRoll: boolean;
    }[];
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
        videoZoneConfig?: { enabled: boolean; videoScenes: number; staticScenes: number } // Video/Static Zone split
    ): Promise<ScriptAnalysisResult | null> => {
        if (!userApiKey) {
            setAnalysisError('API key required');
            return null;
        }

        setIsAnalyzing(true);
        setAnalysisStage('preparing');
        setAnalysisError(null);

        try {
            const provider = getAIProvider(userApiKey);
            console.log(`[ScriptAnalysis] 🔑 Provider: ${provider.type}, Key: ${userApiKey?.substring(0, 10)}..., userApiKey length: ${userApiKey?.length || 0}`);
            const wpm = readingSpeed === 'slow' ? WPM_SLOW : readingSpeed === 'fast' ? WPM_FAST : WPM_MEDIUM;
            const wordCount = scriptText.split(/\s+/).length;
            const estimatedTotalDuration = Math.ceil((wordCount / wpm) * 60);

            // ═══════════════════════════════════════════════════════════════
            // PRE-PROCESSING: Dialogue Detection with Regex
            // ═══════════════════════════════════════════════════════════════
            setAnalysisStage('dialogue-detection');
            const { markedScript, dialogueHints, stats } = preProcessDialogue(scriptText);
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
                contextInstructions += `\n- For characters, provide a HIGHLY DETAILED VISUAL DESCRIPTION (Age, Ethnicity, Hair, Face, Body, Initial Outfit).`;
            }

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

            // Video Zone / Static Zone config
            const isVideoZone = videoZoneConfig?.enabled && videoZoneConfig.videoScenes > 0;
            const videoScenes = videoZoneConfig?.videoScenes || 0;
            const staticScenes = videoZoneConfig?.staticScenes || 35;
            const totalZoneScenes = isVideoZone ? (videoScenes + staticScenes) : expectedSceneCount;
            // Words per second at reading speed (~2.5 words/sec)
            const wordsPerVideoScene = Math.round(2.5 * 8); // 8 seconds of VO ≈ 20 words
            const videoZoneWords = isVideoZone ? (videoScenes * wordsPerVideoScene) : 0;
            const staticZoneWords = isVideoZone ? Math.max(1, wordCount - videoZoneWords) : wordCount;
            const wordsPerStaticScene = isVideoZone ? Math.ceil(staticZoneWords / staticScenes) : 0;

            if (isVideoZone) {
                console.log(`[ScriptAnalysis] 🎬 VIDEO ZONE: ${videoScenes} scenes × 8s (${videoZoneWords} words) → STATIC ZONE: ${staticScenes} scenes (${staticZoneWords} words, ~${wordsPerStaticScene} words/scene)`);
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
            // STEP 1: VISUAL CLUSTERING (The "Director's Thinking" Phase)
            // ═══════════════════════════════════════════════════════════════
            setAnalysisStage('clustering'); // New Stage

            const clusteringSystemPrompt = `
*** CRITICAL ROLE: VISUAL DIRECTOR ***
You are NOT a text splitter. You are a CINEMATIC ADAPTER.
Your job is to read the raw input and restructure it into VISUAL BLOCKS (Shots).

*** BEAT DETECTION (CRITICAL - DO NOT SKIP IMPORTANT ACTIONS) ***
Each of these patterns MUST become its OWN separate shot:

1. **NUMBER + ACTION**: Any sentence with a significant number AND an action verb.
   - "60 đặc vụ liên bang bao vây trung tâm giam giữ" → SEPARATE SHOT (important action!)
   - "400,000 euros trước khi casino cấm" → SEPARATE SHOT (dramatic number!)

2. **DRAMATIC VERBS**: These verbs ALWAYS create a new visual beat:
   - Vietnamese: bao vây, tấn công, nổ súng, chết, giết, đấm, đá, chạy, bắt, trốn, cháy
   - English: surround, attack, shoot, die, kill, punch, kick, run, arrest, escape, burn

3. **ESTABLISHING vs ACTION**: Time/Location MUST be SEPARATE from the action that follows.
   - "Tháng 3 năm 2013, Baltimore." → Shot 1: Establishing (city/date)
   - "60 đặc vụ bao vây trung tâm giam giữ." → Shot 2: Action (agents surrounding)
   - These are TWO shots, NOT one!

4. **CHAPTER BOUNDARY DETECTION (CRITICAL FOR GROUPING)**:
   Any explicit [PART ...] bracket, or standalone lines with LOCATION + TIME/YEAR indicate a NEW CHAPTER (different group/location):
   - "[PART A: HOOK — The Table Flip]" → NEW CHAPTER (Chapter: part_a_hook)
   - "Marseille, November 2019" → NEW CHAPTER (Chapter: marseille_2019)
   - "Rouen, France 1820s" → NEW CHAPTER (Chapter: rouen_1820s)
   - "Casino de Monte-Carlo, May 2019" → NEW CHAPTER (Chapter: montecarlo_2019)
   - "Two Years Later" → NEW CHAPTER (time jump)
   
   When you detect these headers, you MUST:
   - Mark them as belonging to a NEW chapter_id
   - Use a descriptive chapter_id like "marseille_2019" or "rouen_1820s"
   - ALL subsequent scenes belong to this chapter until the NEXT header
   - Do NOT merge scenes from different chapters into same group!

   *** EXPLICIT EXAMPLE ***:
   "Marseille, November 2019" → chapter: marseille_2019
   "An abandoned warehouse..." → chapter: marseille_2019
   "The man lies face down..." → chapter: marseille_2019
   "He kneels down. Grips the edge of the mask." → chapter: marseille_2019 (STILL SAME!)
   "A gunshot echoes through the warehouse." → chapter: marseille_2019 (STILL SAME!)
   "Rouen, France 1820s" → chapter: rouen_1820s (NEW CHAPTER STARTS HERE!)
   "Pierre Dugal..." → chapter: rouen_1820s

*** ALGORITHM (THE GOLDEN RULES) ***
1. **SCAN**: Read the input text.
2. **DETECT BEATS**: Identify each distinct visual moment using rules above.
3. **MERGE ONLY DESCRIPTIONS**: Only merge adjectives/materials with their subject.
   - "A mask. White ceramic. Long beak." → ONE shot (describing same object)
   - "A mask. He picks it up." → TWO shots (describing, then action!)
4. **VO TRACKING**: You MUST keep track of which part of the text corresponds to which visual.

If a sentence contains DRAMATIC content (violence, numbers, key actions), it MUST have its own visual.

*** DYNAMIC VISUAL INFERENCE ENGINE (METAPHOR SYSTEM) ***
For every scene, you MUST analyze the Voice Over/Context and assign a [CREATIVE INTENSITY] tag [C1], [C2], or [C3].

*** USER OVERRIDE RULE ***
If the input script contains explicit tags like [C1], [C2], or [C3], you MUST respect them and override your own analysis.
- Input: "He stood in the rain [C3]." -> You MUST treat this as METAPHORIC (e.g. focus on raindrops/mood), even if the text looks literal.
- Input: "The system crashed [C1]." -> You MUST treat this as LITERAL (show a computer screen error), even if the text looks abstract.

*** SILENT VISUAL INSTRUCTIONS (PARENTHESES PROTOCOL) ***
If the script contains text inside parentheses '...', you MUST treat it as explicit VISUAL DIRECTION.
- **Rule 1 (Guidance):** Use the content inside '...' to describe the scene, character action, or camera angle.
- **Rule 2 (Silence):** Do NOT include the content inside '...' in the 'voiceOverText' or 'dialogueText'. It is for YOUR EYES ONLY (to generate the image).
- Example Input: "A man sits alone. (Close up on his trembling hands). Not because of overtime."
- Output Visual: "Close up shot of a man's hands trembling on the desk."
- Output VO: "A man sits alone. Not because of overtime."

[C1] LITERAL (The Witness):
- Trigger: VO mentions specific physical actions, objects, names, locations.
- Logic: "Draw exactly what is described."
- Example: "He picks up the gun." → Show man picking up gun.

[C2] SUGGESTIVE (The Storyteller):
- Trigger: VO mentions immediate consequences, rising tension, or preparations.
- Logic: Show the *implication* or *environment* related to the thought.
- Example: "He knew there was no way out." → High angle shot of him surrounded by warehouse shelving (a maze).

[C3] METAPHORIC (The Artist):
- Trigger: VO mentions internal states, emotions (fear, regret, chaos), system concepts (data loss), time, or abstract ideas.
- Logic: Use **CINEMATIC LANGUAGE (Light, Shadow, Angle)** or **PHYSICS** to represent the feeling.
- **CONSTRAINT**: You must ONLY use objects that exist in the defined 'locationAnchor'. DO NOT hallucinate random objects (no hourglasses in space, no random animals).

*** METAPHOR RULES (LOCATION ANCHOR CONSTRAINT) ***
- If Location is "Warehouse": Use peeling paint, rust, dust motes, shadows from beams. (NOT a clock floating in air).
- If Location is "Office": Use screen reflections, blinking server lights, cold glass surfaces. (NOT a labyrinth of stone).
- If Location is "Nature": Use wind, rain, wilting flowers, storms.

*** CINEMATIC BRIDGE (For [C3] Metaphors) ***
- **Isolation/Loneliness**: Extreme Wide Shot + Negative Space.
- **Danger/Threat**: Low-key lighting + Hard Shadows (Chiaroscuro).
- **Instability**: Dutch Angle (Tilted camera) + Handheld shake.
- **Overwhelmed**: Extreme Close-up (ECU) on sweating skin or dilated pupils.

*** FEW-SHOT EXAMPLES (LEARN FROM THESE) ***
Input VO: "He was lost in his own thoughts." (Location: Smoking Room)
[C3] Output: "EXTREME CLOSE-UP of a cigarette burning in the ashtray. Smoke rises in a twisted, complex pattern. Low-key lighting."

Input VO: "The system is collapsing." (Location: City at Night)
[C3] Output: "HIGH ANGLE drone shot. City zones go dark one by one like falling dominoes. Cold blue color grading."

Input VO: "He felt the eyes of everyone on him." (Location: Dark Alley)
[C3] Output: "High angle looking down. Multiple CCTV cameras visible on the walls, their red recording lights glowing in the shadows, all pointing at the subject."
Do NOT hide important actions inside B-rolls. They need to be MAIN scenes.
            `;

            // Build Video Zone prompt injection
            const videoZonePrompt = isVideoZone ? `
*** 🎬 CRITICAL: VIDEO ZONE / STATIC ZONE SPLIT ***
The final video has TWO distinct zones:

🎥 VIDEO ZONE (First ${videoScenes} shots): 
- These shots will be converted to 8-second AI video clips
- Each shot MUST cover ONLY ~${wordsPerVideoScene} words (~8 seconds of narration)
- Split the BEGINNING of the script into very granular, detailed shots
- Focus on: dramatic moments, character introductions, establishing shots
- These should be the first ~${videoZoneWords} words of the script
- EVERY sentence with action, emotion, or visual change = SEPARATE shot

🖼️ STATIC ZONE (Remaining ${staticScenes} shots):
- These shots will be static image frames shown longer
- Each shot covers ~${wordsPerStaticScene} words of narration
- Group multiple sentences into ONE shot when they share the same visual
- Summarize longer passages into single compelling frames

⚠️ TOTAL SHOTS: EXACTLY ${totalZoneScenes} (${videoScenes} video + ${staticScenes} static)
Label each shot: [VIDEO] Shot 1, [VIDEO] Shot 2, ... [STATIC] Shot ${videoScenes + 1}, ...
` : '';

            const clusteringUserPrompt = `
Analyze and REWRITE the following voice-over script into a list of "VISUAL SHOTS".
Don't worry about JSON format yet. Just simple text blocks.

${isVideoZone ? videoZonePrompt : `*** HARD CONSTRAINT - TARGET SCENE COUNT: EXACTLY ${expectedSceneCount} shots (±10%) ***
${sceneCountEstimate ? `⚠️ The user has EXPLICITLY requested ${sceneCountEstimate} scenes. This is NOT a suggestion — it is a HARD REQUIREMENT. You MUST produce between ${Math.floor(sceneCountEstimate * 0.9)} and ${Math.ceil(sceneCountEstimate * 1.1)} shots.` : `Auto-estimated target: ~${expectedSceneCount} shots based on word count and reading speed.`}`}

RULES FOR HITTING THE TARGET:
${isVideoZone ? `- First ${videoScenes} shots: MICRO-SHOTS (~${wordsPerVideoScene} words each) from the BEGINNING of the script
- Remaining ${staticScenes} shots: LARGER shots (~${wordsPerStaticScene} words each) for the REST` : `- If you have MORE shots than target: MERGE similar/adjacent shots into one (combine their descriptions)
- If you have FEWER shots than target: SPLIT long/complex shots into multiple angles
- Each shot should cover roughly ${Math.ceil(wordCount / expectedSceneCount)} words of the script`}
- Do NOT create micro-shots for single sentences unless dramatically important
- Prioritize QUALITY over QUANTITY — each shot must be cinematically meaningful

INPUT SCRIPT:
"""
${scriptText}
"""

OUTPUT FORMAT:
${isVideoZone ? `- [VIDEO] Shot 1: [Visual Description] (Covers text: "...")
- [VIDEO] Shot 2: [Visual Description] (Covers text: "...")
...
- [STATIC] Shot ${videoScenes + 1}: [Visual Description] (Covers text: "...")
...` : `- Shot 1: [Visual Description] (Covers text: "...")
- Shot 2: [Visual Description] (Covers text: "...")
...`}
FINAL CHECK: Count your shots. ${isVideoZone ? `You MUST have EXACTLY ${videoScenes} [VIDEO] shots and ${staticScenes} [STATIC] shots = ${totalZoneScenes} total.` : `If total is more than ${Math.ceil(expectedSceneCount * 1.1)}, MERGE shots until within range.`}
            `;

            // Call Step 1 (Clustering)
            // Use gemini-2.5-flash for speed if not generating JSON
            const clusteringResult = await provider.generateText(
                clusteringSystemPrompt + "\n\n" + clusteringUserPrompt,
                { model: 'gemini-2.5-flash' }
            );
            const visualPlan = clusteringResult.text || '';
            console.log('[ScriptAnalysis] 🧠 Visual Plan:', visualPlan);


            // ═══════════════════════════════════════════════════════════════
            // STEP 2: JSON GENERATION (The "DOP's Execution" Phase)
            // ═══════════════════════════════════════════════════════════════
            setAnalysisStage('thinking'); // Transition to JSON generation

            const prompt = `Analyze this voice-over script and the Director's Visual Plan to generate the final Production Script JSON.

=== ORIGINAL SCRIPT ===
"""
${scriptText}
"""

=== DIRECTOR'S VISUAL PLAN (Follow this segmentation) ===
"""
${visualPlan}
"""

*** MANDATORY SCENE COUNT CONSTRAINT ***
${isVideoZone ? `🎬 VIDEO/STATIC ZONE MODE ACTIVE:
- Total target: ${totalZoneScenes} scenes (${videoScenes} video zone + ${staticScenes} static zone)
- First ${videoScenes} scenes = VIDEO ZONE (very short, ~${wordsPerVideoScene} words each, ~8s of narration)
- Remaining ${staticScenes} scenes = STATIC ZONE (longer, ~${wordsPerStaticScene} words each)
- The video zone covers the FIRST ~${videoZoneWords} words of the script
- The static zone covers the REST (~${staticZoneWords} words)
- Mark each scene with "isVideoZone": true or false in the JSON` : `TARGET: ${expectedSceneCount} main scenes (±10%). Maximum allowed: ${Math.ceil(expectedSceneCount * 1.1)}.
${sceneCountEstimate ? `The user explicitly requested ${sceneCountEstimate} scenes. You MUST respect this. Do NOT exceed ${Math.ceil(sceneCountEstimate * 1.1)} scenes in your "scenes" array.` : ''}`}
- If the Visual Plan has more shots than target, MERGE adjacent shots with similar location/action into one scene
- If you exceed the target, your response will be REJECTED. Merge scenes before outputting.
- B-Roll expansionScenes do NOT count toward this limit, but keep them minimal (max 1-2 per main scene)

TASK:
1. Use the "Director's Visual Plan" as the SOURCE TRUTH for scene segmentation.
2. Map the original script text (Voice Over) to these visual scenes.
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
- NEVER repeat the same shot type.

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
      "dialogueText": null,
      "dialogueSpeaker": null,
      "visualPrompt": "WIDE SHOT. Rain-soaked street. A silhouette...",
      "chapterId": "chapter_1",
      "characterNames": ["The Man"],
      "needsExpansion": false,
      "isVideoZone": true
    },
    {
      "voiceOverText": "The officer approached and spoke.",
      "dialogueText": "Stop right there! Show me your hands!",
      "dialogueSpeaker": "Officer",
      "visualPrompt": "MEDIUM SHOT. Officer pointing...",
      "chapterId": "chapter_1",
      "characterNames": ["Officer", "The Man"],
      "needsExpansion": false,
      "isVideoZone": false
    }
  ]
}${isVideoZone ? `\n\n⚠️ CRITICAL: The first ${videoScenes} scenes MUST have "isVideoZone": true. The rest MUST have "isVideoZone": false.` : ''}`;


            setAnalysisStage('connecting');
            const jsonResult = await provider.generateText(prompt, {
                model: modelName,
                temperature: 0.3,
                responseMimeType: 'application/json',
                maxOutputTokens: 65536,
                ...(thinkingBudget ? { thinkingConfig: { thinkingBudget } } : {})
            });

            setAnalysisStage('post-processing');
            const text = jsonResult.text || '';
            const jsonMatch = text.match(/\{[\s\S]*\}/);
            if (!jsonMatch) throw new Error('No JSON in response');

            const parsed = JSON.parse(jsonMatch[0]);

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
                characters: parsed.characters || [],
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

            setAnalysisStage('finalizing');
            setAnalysisResult(result);
            console.log('[ScriptAnalysis] ✅ Analysis complete:', result);
            return result;

        } catch (error: any) {
            console.error('[ScriptAnalysis] ❌ Error:', error);
            console.error('[ScriptAnalysis] ❌ Provider info:', {
                userApiKeyPrefix: userApiKey?.substring(0, 10),
                userApiKeyLength: userApiKey?.length,
                errorName: error?.name,
                errorMessage: error?.message,
                errorStack: error?.stack?.substring(0, 200)
            });
            const debugInfo = `[Provider: ${userApiKey?.startsWith('vai-') ? 'vertex-key' : 'gemini'}, Key: ${userApiKey?.substring(0, 8)}..., Length: ${userApiKey?.length || 0}]`;
            setAnalysisError(`${error.message || 'Analysis failed'} ${debugInfo}`);
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
        const existingNames = new Set(existingCharacters.map(c => c.name.toLowerCase()));
        const newCharacters = analysis.characters
            .filter(c => !existingNames.has(c.name.toLowerCase()))
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
        analyzeScript,
        generateSceneMap,
        setAnalysisResult
    };
}
