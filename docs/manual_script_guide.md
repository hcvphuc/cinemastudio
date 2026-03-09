# 🎬 Manual Script Integration Guide — CinemaStudio

> Đúc kết toàn diện tính năng **Manual Script Import** (nhập kịch bản thủ công) để replicate nhanh sang version khác.
> Bao gồm: UI flow, AI pipeline, data types, prompt engineering, và post-processing.

---

## 📐 Kiến Trúc Tổng Quan

```mermaid
graph TD
    A[User paste/upload Script] --> B[ManualScriptModal.tsx]
    B -->|preprocessMarkdownScript| C[Cleaned Script]
    C -->|handleAnalyze| D[useScriptAnalysis.ts]
    
    D --> D1[Pre-process: Dialogue Detection]
    D --> D2[Pre-process: Chapter Header Detection]
    D1 --> E[STEP 1: Visual Clustering<br/>Director's Thinking - Free-form text]
    D2 --> E
    E --> F[STEP 2: JSON Generation<br/>DOP's Execution - Structured JSON]
    F --> G[Post-Processing Pipeline]
    G --> G1[Scene Count Enforcement]
    G --> G2[Chapter Assignment Override]
    G --> G3[Clean Silent Visual Notes]
    G --> H[ScriptAnalysisResult]
    
    H -->|User confirms| I[generateSceneMap]
    I --> J[Scene[] + SceneGroup[] + Character[]]
    J --> K[App.tsx receives scenes]
    
    B -->|Export VO| L[ElevenLabs Formatter]
    L --> M[ZIP with per-PART .txt files]
    
    style D fill:#4a90d9,stroke:#333
    style E fill:#f9d71c,stroke:#333
    style F fill:#f9d71c,stroke:#333
    style I fill:#27ae60,stroke:#333
```

**4 tầng chính:**

| Tầng | File(s) | Vai trò |
|------|---------|---------|
| **1. UI Modal** | `components/modals/ManualScriptModal.tsx` | Input script, chọn style/director/model, confirm |
| **2. Script Preprocessor** | `preprocessMarkdownScript()` trong Modal | Strip metadata, convert PART headers, clean markdown |
| **3. AI Analysis Hook** | `hooks/useScriptAnalysis.ts` | 2-step AI pipeline + post-processing |
| **4. Scene Map Generator** | `generateSceneMap()` trong hook | Convert AI result → Scene[] + SceneGroup[] |
| **5. VO Exporter** | `utils/elevenLabsFormatter.ts` | Export script → ElevenLabs TTS format (ZIP) |

---

## 1️⃣ UI Modal — ManualScriptModal.tsx

File: [components/modals/ManualScriptModal.tsx](file:///c:/Users/Administrator/.gemini/antigravity/playground/ionic-asteroid/components/modals/ManualScriptModal.tsx)

### 1.1 Props Interface

```typescript
interface ManualScriptModalProps {
    isOpen: boolean;
    onClose: () => void;
    onImport: (
        scenes: Scene[],
        groups: SceneGroup[],
        newCharacters: { name: string; description: string }[],
        styleId: string | undefined,
        directorId: string | undefined,
        sceneCharacterMap: Record<number, string[]>,
        researchNotes?: { director?: string; dop?: string; story?: string },
        locations?: LocationAnalysis[]
    ) => void;
    existingCharacters: Character[];
    userApiKey: string | null;
    userId: string | null;
    initialState?: {
        scriptText: string;
        readingSpeed: 'slow' | 'medium' | 'fast';
        selectedStyleId: string;
        selectedDirectorId: string;
        selectedModel: string;
        directorNotes: string;
        dopNotes: string;
        storyContext: string;
        analysisResult: any | null;
    };
    onStateChange?: (state: any) => void;
}
```

### 1.2 State Management

```typescript
// Script input
const [scriptText, setScriptText] = useState('');
const [readingSpeed, setReadingSpeed] = useState<'slow' | 'medium' | 'fast'>('medium');

// Style & Director
const [selectedStyleId, setSelectedStyleId] = useState('faceless-mannequin');
const [selectedDirectorId, setSelectedDirectorId] = useState('werner_herzog');
const [selectedModel, setSelectedModel] = useState(SCRIPT_MODELS[0].value);

// Scene Count Control
const [sceneCountEstimate, setSceneCountEstimate] = useState<number | null>(null);

// Video Zone / Static Zone split
const [videoZoneEnabled, setVideoZoneEnabled] = useState(false);
const [videoZoneScenes, setVideoZoneScenes] = useState(30);   // Video clips (~8s each)
const [staticZoneScenes, setStaticZoneScenes] = useState(35);  // Static image frames

// Research Notes (cloud-synced via useResearchPresets)
const [directorNotes, setDirectorNotes] = useState('');
const [dopNotes, setDopNotes] = useState('');
const [storyContext, setStoryContext] = useState('');

// Custom Director Search (AI-generated director profile)
const [customDirectorName, setCustomDirectorName] = useState('');
const [customDirector, setCustomDirector] = useState<DirectorPreset | null>(null);
```

### 1.3 Script Models (Model Selector)

```typescript
// constants/presets.ts
export const SCRIPT_MODELS = [
    { value: 'gemini-3-pro-preview|high', label: 'Gemini 3 Pro (High Reasoning)' },
    { value: 'gemini-3-pro-preview|low', label: 'Gemini 3 Pro (Low Latency)' },
    { value: 'gemini-2.5-flash|high', label: 'Gemini 3 Flash (Smart)' },
    { value: 'gemini-2.5-flash|medium', label: 'Gemini 3 Flash (Balanced)' },
    { value: 'gemini-2.5-flash|low', label: 'Gemini 3 Flash (Fast)' },
    { value: 'gemini-2.5-flash|minimal', label: 'Gemini 3 Flash (Minimal Thinking)' },
    { value: 'gemini-2.5-flash|none', label: 'Gemini 2.5 Flash (Legacy)' },
];
// Format: "model-name|thinking-level"
// Thinking levels: high=24576, medium=8192, low=2048, minimal=512, none=undefined
```

### 1.4 State Persistence

```typescript
// State tự động sync lên parent via onStateChange
// Khi user đóng/mở Modal, state được restore từ initialState
React.useEffect(() => {
    if (initialState?.analysisResult && !analysisResult && !userWentBack.current) {
        setAnalysisResult(initialState.analysisResult);
    }
}, []);
```

---

## 2️⃣ Script Preprocessor — preprocessMarkdownScript()

File: [ManualScriptModal.tsx:63-154](file:///c:/Users/Administrator/.gemini/antigravity/playground/ionic-asteroid/components/modals/ManualScriptModal.tsx#L63-L154)

### Xử lý gì?

| Input | Output | Mục đích |
|-------|--------|----------|
| `# Title`, `### Production Info`, `**Key**: Value` | (stripped) | Remove metadata block before `---` |
| `## PART A: HOOK — The Table Flip` | `[PART A: The Table Flip]` | Convert to bracket chapter notation |
| `**[CLIFFHANGER: dramatic text]**` | `dramatic text` | Extract content from YouTube script annotations |
| `**[CTA]: Subscribe now**` | `Subscribe now` | Convert CTA to voiceover |
| `**bold text**` | `bold text` | Strip markdown formatting |
| `## Section Header` | (stripped) | Remove non-PART headers |
| `---` | (stripped) | Remove horizontal rules |

### Key Logic

```typescript
function preprocessMarkdownScript(raw: string): string {
    // 1. Detect metadata block (first 10 lines)
    // 2. Skip until finding "---" separator
    // 3. Convert PART headers → [PART X: Title]
    // 4. Strip bracket annotations: [CLIFFHANGER], [CTA], [MICRO-CTA], [FLASHBACK], [PUNCHLINE]
    // 5. Skip standalone tags: [BEGINS], [ENDS], [DELIVERED], [PAYOFF]
    // 6. Strip bold formatting ** **
    // 7. Keep everything else as voiceover content
    return result.join('\n').trim();
}
```

> [!IMPORTANT]
> Preprocessor chạy khi user upload `.md` file. Script thuần text (paste) không qua preprocessor.

---

## 3️⃣ AI Analysis Pipeline — useScriptAnalysis.ts

File: [hooks/useScriptAnalysis.ts](file:///c:/Users/Administrator/.gemini/antigravity/playground/ionic-asteroid/hooks/useScriptAnalysis.ts)

### 3.1 Data Types

```typescript
interface ChapterAnalysis {
    id: string;                    // "marseille_2019", "rouen_1820s"
    title: string;
    startIndex: number;
    endIndex: number;
    estimatedDuration: number;     // seconds
    suggestedTimeOfDay?: string;
    suggestedWeather?: string;
    locationAnchor?: string;       // CRITICAL: fixed environment description
}

interface CharacterAnalysis {
    name: string;
    mentions: number;
    suggestedDescription: string;  // Follows character style (e.g. mannequin)
    outfitByChapter: Record<string, string>;  // { "chapter_1": "suit..." }
    isMain: boolean;
}

interface LocationAnalysis {
    id: string;                    // "loc_casino"
    name: string;
    description: string;
    keywords: string[];
    chapterIds: string[];
    sceneRanges: { start: number; end: number }[];
    conceptPrompt: string;         // For concept art generation
    isInterior: boolean;
    timeOfDay?: string;
    mood?: string;
}

interface SceneAnalysis {
    voiceOverText: string;         // EXACT script text (master)
    dialogueText?: string;         // Optional lip-sync extraction
    dialogueSpeaker?: string;      // Speaker name for lip-sync
    visualPrompt: string;          // Cinematic visual description
    chapterId: string;             // Maps to ChapterAnalysis.id
    characterNames: string[];
    estimatedDuration: number;     // seconds
    needsExpansion: boolean;       // Needs B-roll?
    isVideoZone?: boolean;         // For Video/Static zone split
    expansionScenes?: { visualPrompt: string; isBRoll: boolean }[];
}

interface ScriptAnalysisResult {
    totalWords: number;
    estimatedDuration: number;
    chapters: ChapterAnalysis[];
    characters: CharacterAnalysis[];
    locations: LocationAnalysis[];
    suggestedSceneCount: number;
    scenes: SceneAnalysis[];
    globalContext?: string;        // World/era summary
}
```

### 3.2 Analysis Stages (UI Progress)

```typescript
type AnalysisStage = 
    | 'idle'                // Not started
    | 'preparing'           // Setting up
    | 'dialogue-detection'  // Pre-process: regex dialogue detection
    | 'connecting'          // Calling AI API
    | 'clustering'          // STEP 1: Visual clustering (Director's thinking)
    | 'thinking'            // STEP 2: JSON generation (DOP's execution)
    | 'post-processing'     // Merging/fixing scenes
    | 'validating'          // Validating output
    | 'finalizing';         // Building result
```

### 3.3 Pre-Processing Pipeline

#### A. Dialogue Detection (Regex-based)

```typescript
function preProcessDialogue(script: string): {
    markedScript: string;
    dialogueHints: DialogueHint[];
    stats: { totalDialogues: number; totalVOLines: number }
}

// Detects patterns like:
// - "Speaker: 'dialogue text'"
// - "'dialogue text,' he said"
// - SPEAKER: "dialogue text"
// Returns hints for AI to use as dialogue/speaker extraction
```

#### B. Chapter Header Detection (Regex-based)

```typescript
// PRIORITY 1: Bracket format [Chapter Title] — 100% reliable
const bracketPattern = /^\[(.+)\]$/;

// FALLBACK patterns (only if NO brackets found):
const chapterPatterns = [
    /^PART\s+[A-Z0-9]+[\s:—\-–]+.+$/i,                    // PART A: HOOK
    /^([A-Za-zÀ-ÿ]+),?\s*(January|...|December)\s*(\d{4})$/i,  // Place, Month Year
    /^([A-Za-zÀ-ÿ]+),?\s*([A-Za-zÀ-ÿ]+)\s+(\d{4}s?)$/i,     // Place, Country Year
    /^(Two|Three|...|\\d+)\s+(Years?|Months?)\s+(Later|...)$/i,  // Time jumps
    /^The\s+[A-Z][a-zA-Z]+$/,                              // "The Mask" style
];
```

> [!CAUTION]
> Bracket chapters (`[PART A: ...]`) **DISABLE** all fallback patterns. When bracket chapters exist, ONLY they define chapter boundaries.

### 3.4 STEP 1: Visual Clustering (Director's Thinking)

This is the **creative brain** — it reads the script and outputs a free-form text describing visual shots.

**System Prompt Key Concepts:**

| Concept | Description |
|---------|-------------|
| **Beat Detection** | Each distinct visual moment = 1 shot. Numbers + actions = separate shot |
| **Dramatic Verbs** | bao vây, tấn công, nổ súng → ALWAYS new shot |
| **Establishing vs Action** | Location/time SEPARATE from action (2 shots, not 1) |
| **Chapter Boundary** | [PART ...] or Location+Year = NEW chapter |
| **Creative Intensity** | [C1] Literal, [C2] Suggestive, [C3] Metaphoric |
| **Silent Visual Notes** | `(...)` = visual direction for AI only, NOT in voiceOverText |
| **Metaphor Rules** | Location Anchor Constraint — [C3] must use objects IN the location |
| **Cinematic Bridge** | Isolation→Wide Shot, Danger→Chiaroscuro, Instability→Dutch Angle |

**Video Zone Mode:**

```
🎥 VIDEO ZONE (first N shots): ~20 words each, ~8s narration → AI video clips
🖼️ STATIC ZONE (remaining shots): longer shots → static image frames
```

**Output:** Free-form text list of shots (not JSON)

### 3.5 STEP 2: JSON Generation (DOP's Execution)

Takes the Visual Plan from Step 1 + original script → produces structured JSON.

**Critical Rules in Prompt:**

| Rule | Description |
|------|-------------|
| **Voice Over = Master Script** | Exact segment of original script, word-for-word, INCLUDING quotes |
| **Dialogue = Optional Extraction** | Only for lip-sync. The quote STILL remains in voiceOverText |
| **Location Anchor** | Each chapter has a FIXED detailed environment. ALL scenes must exist there |
| **Chapter Grouping** | Different location/time = DIFFERENT chapter with DIFFERENT chapter_id |
| **B-Roll (BBC 5-Shot)** | CU Hands, CU Face, Wide Shot, OTS, Creative Angle |
| **Subject Lock** | B-Roll = SAME MOMENT as main. NO new actions |
| **Scene Count** | Hard constraint: target ±10%. AI will be "REJECTED" if exceeded |

**JSON Response Schema:**

```json
{
    "globalContext": "Detailed summary...",
    "locations": [{ "id", "name", "description", "conceptPrompt", ... }],
    "chapters": [{ "id", "title", "locationAnchor", "locationId", ... }],
    "characters": [{ "name", "suggestedDescription", "outfitByChapter", ... }],
    "scenes": [{ "voiceOverText", "dialogueText", "dialogueSpeaker", "visualPrompt", "chapterId", ... }]
}
```

### 3.6 Provider + Fallback

```typescript
// Uses aiProvider.ts abstraction layer
const provider = getAIProvider(userApiKey);
// Provider auto-detects: vai-xxx → VertexKeyProvider, AIza... → GeminiProvider

const callWithFallback = async (provider, prompt, config) => {
    try {
        return await provider.generateText(prompt, config);
    } catch (primaryError) {
        // Auto-fallback to secondary provider
        const fallbackProvider = getFallbackProvider();
        return await fallbackProvider.generateText(prompt, config);
    }
};
```

### 3.7 Post-Processing Pipeline

#### A. Scene Count Enforcement

```typescript
if (result.scenes.length > Math.ceil(sceneCountEstimate * 1.1)) {
    while (scenes.length > maxAllowed) {
        // Find SHORTEST scene (not first/last)
        // Merge voiceOverText + visualPrompt with previous scene
        // Combine characterNames
        // Recalculate duration
        scenes.splice(shortestIdx, 1);
    }
}
```

#### B. Chapter Assignment Override (Critical)

```typescript
// AI often assigns wrong chapterId. This FIXES it by finding where
// each scene's voiceOverText appears in the original script.

const findTextInScript = (text) => {
    // Try 8, 6, 4, 3 word searches progressively
    // Match against original script lines
    // Return line number
};

const getChapterForLine = (lineNum) => {
    // Find which chapter range contains this line
    return chapterRanges.find(r => lineNum >= r.startLine && lineNum <= r.endLine);
};

// Override each scene's chapterId based on its voiceOverText position
result.scenes = result.scenes.map((scene, i) => {
    const foundLine = findTextInScript(scene.voiceOverText);
    const correctChapter = getChapterForLine(foundLine || estimatedLine);
    return { ...scene, chapterId: correctChapter };
});
```

#### C. Clean Silent Visual Notes

```typescript
// Remove (parenthesized content) from voiceOverText and dialogueText
// These are visual instructions for image generation only
const cleanText = (text) => text.replace(/\([^)]+\)/g, '').replace(/\s+/g, ' ').trim();
```

---

## 4️⃣ Scene Map Generator — generateSceneMap()

File: [hooks/useScriptAnalysis.ts:1009-1288](file:///c:/Users/Administrator/.gemini/antigravity/playground/ionic-asteroid/hooks/useScriptAnalysis.ts#L1009-L1288)

### Input → Output

```typescript
generateSceneMap(
    analysis: ScriptAnalysisResult,
    director: DirectorPreset | null,
    characterStyle: CharacterStyleDefinition | null,
    existingCharacters: Character[]
): {
    scenes: Scene[];
    groups: SceneGroup[];
    newCharacters: { name: string; description: string }[];
    sceneCharacterMap: Record<number, string[]>;
}
```

### Scene Construction

```typescript
const mainScene: Scene = {
    id: `scene_${sceneNumber}`,
    sceneNumber: String(sceneNumber),
    groupId: sceneAnalysis.chapterId,
    
    // Dialogue (formatted: "Speaker: text")
    language1: dialogueText ? `${speaker}: ${dialogueText}` : '',
    vietnamese: '',
    
    // Voice Over
    voiceOverText: sceneAnalysis.voiceOverText,
    isVOScene: Boolean(voiceOverText),
    isDialogueScene: Boolean(dialogueText && speaker),
    voSecondsEstimate: estimatedDuration,
    
    // Visual prompt with injected context
    contextDescription: [
        sceneStateSummary,           // Character position continuity
        `[LOCATION ANCHOR]: ...`,    // Fixed environment
        `[CHARACTER STYLE]: ...`,    // Style injection
        `[DIRECTOR DNA]: ...`,       // Director signature
        `[CAMERA STYLE]: ...`,       // Camera preferences
        sceneAnalysis.visualPrompt   // AI-generated visual
    ].filter(Boolean).join('\n\n'),
    
    characterIds: [],  // Auto-assigned from existing characters
    generatedImage: null,
};
```

### Scene State Memory (Animation Continuity)

```typescript
// Tracks character positions across scenes within same chapter
interface CharacterState {
    name: string;
    position: string;  // 'standing' | 'lying' | 'kneeling' | 'sitting'
    props: string[];
}

// RESETS on group/chapter boundary change
if (currentChapterId !== previousChapterId) {
    sceneStateMemory = [];
}

// Injects: [SCENE STATE MEMORY]: The Man: lying face down, Officer: kneeling
// This ensures next scene maintains visual continuity
```

### Auto Character Assignment

```typescript
// Match AI-detected character names against existing Character library
existingCharacters.forEach(char => {
    const isMatch = namesInScene.some(n =>
        charName.includes(n) || n.includes(charName) ||
        (char.description && char.description.includes(n))
    );
    if (isMatch) foundIds.push(char.id);
});
mainScene.characterIds = foundIds;
```

### B-Roll Generation

```typescript
if (sceneAnalysis.needsExpansion && sceneAnalysis.expansionScenes) {
    for (const expansion of expansionScenes) {
        const bRollScene: Scene = {
            id: `scene_${sceneNumber}`,
            groupId: sceneAnalysis.chapterId,
            voiceOverText: undefined,    // B-roll has NO voiceover
            isVOScene: false,
            referenceSceneId: mainScene.id,  // Points to parent VO scene
            contextDescription: [
                locationAnchor,
                `[B-ROLL FOR SCENE ${sceneNumber - 1}]`,
                stylePrompt,
                directorDna,
                expansion.visualPrompt
            ].filter(Boolean).join('\n\n'),
        };
    }
}
```

---

## 5️⃣ ElevenLabs VO Exporter

File: [utils/elevenLabsFormatter.ts](file:///c:/Users/Administrator/.gemini/antigravity/playground/ionic-asteroid/utils/elevenLabsFormatter.ts)

### Flow

```
Script Text → splitIntoParts() → [PART A content, PART B content, ...]
    → formatPartWithAI() or formatSimple() → per-part .txt files
    → JSZip → download ZIP
```

### Split by PARTs

```typescript
function splitIntoParts(preprocessedText: string): PartFile[] {
    // Detect [PART X: Title] brackets
    // Split script into sections
    // Each section → separate file
}
```

### AI Formatter (Rich Audio Tags)

```typescript
async function formatPartWithAI(provider, model, partLabel, content): Promise<string> {
    // AI adds ElevenLabs audio tags:
    // <break time="500ms"/>
    // <phoneme alphabet="ipa" ph="...">word</phoneme>
    // Emphasis markers, pace control, etc.
}
```

### Simple Formatter (Sentence-based)

```typescript
function formatSimple(text: string, partLabel: string): string {
    // Per-sentence breaks
    // Basic punctuation-based pauses
}
```

---

## 6️⃣ Context Injection System

### Injection Order in AI Prompt

```
1. [GLOBAL STORY CONTEXT]           ← researchNotes.story
2. [VISUAL STYLE CONSTRAINT]        ← characterStyle.promptInjection.global  
3. [DIRECTOR VISION]                ← director.name + director.description
4. [USER DIRECTOR NOTES]            ← researchNotes.director
5. [USER DOP NOTES]                 ← researchNotes.dop
6. [EXISTING CHARACTER LIBRARY]     ← activeCharacters list (avoid duplicates)
7. [PRE-DETECTED DIALOGUES]         ← regex-detected dialogue hints
8. [PRE-DETECTED CHAPTER BOUNDARIES] ← regex-detected chapter markers (HARD LOCKED)
```

### Character Style Integration

```typescript
if (characterStyle.id.includes('mannequin')) {
    // MANDATORY PREFIX: "Faceless white mannequin, egg-shaped head."
    // + WEARING: detailed outfit with textures/materials
    // + SHOES: specific footwear
    // + COMPLETE OUTFIT: pants/skirt + shoes required
}
```

### Director Integration

```typescript
// Director provides:
// - director.dna → overall style signature
// - director.signatureCameraStyle → camera preferences
// - director.description → role description
// These inject into EACH scene's contextDescription
```

---

## 7️⃣ Duration Estimation

```typescript
// Words Per Minute by reading speed
const WPM_SLOW = 120;
const WPM_MEDIUM = 150;
const WPM_FAST = 180;

// Scene duration = (wordCount / WPM) * 60 seconds
// Total duration = (totalWords / WPM) * 60 seconds

// Scene count estimation:
const wordsPerScene = readingSpeed === 'slow' ? 8 : readingSpeed === 'fast' ? 12 : 10;
const autoExpectedCount = Math.ceil(wordCount / wordsPerScene);
// User can override with sceneCountEstimate
```

---

## 8️⃣ Video Zone / Static Zone Split

```typescript
// VIDEO ZONE: First N scenes → 8-second AI video clips
// STATIC ZONE: Remaining scenes → static image frames

const wordsPerVideoScene = Math.round(2.5 * 8);  // ~20 words per 8s
const videoZoneWords = videoScenes * wordsPerVideoScene;
const staticZoneWords = totalWords - videoZoneWords;
const wordsPerStaticScene = Math.ceil(staticZoneWords / staticScenes);

// AI marks each scene: "isVideoZone": true/false
// UI renders differently based on zone type
```

---

## ✅ Checklist Tích Hợp Nhanh

```
□ 1. Copy types: ScriptAnalysisResult, ChapterAnalysis, CharacterAnalysis,
      LocationAnalysis, SceneAnalysis (useScriptAnalysis.ts:19-77)
□ 2. Copy preprocessMarkdownScript() (ManualScriptModal.tsx:63-154)
□ 3. Copy preProcessDialogue() (useScriptAnalysis.ts:94-145)
□ 4. Copy chapter detection logic (useScriptAnalysis.ts:222-334)
□ 5. Copy STEP 1 Visual Clustering prompt (useScriptAnalysis.ts:433-593)
□ 6. Copy STEP 2 JSON Generation prompt (useScriptAnalysis.ts:630-796)
□ 7. Copy post-processing pipeline (useScriptAnalysis.ts:828-976):
      - Scene count enforcement
      - Chapter assignment override
      - Clean silent visual notes
□ 8. Copy generateSceneMap() (useScriptAnalysis.ts:1009-1288):
      - Scene construction with context injection
      - Scene state memory
      - Character auto-assignment
      - B-roll generation
□ 9. Copy SCRIPT_MODELS (constants/presets.ts:354-362)
□ 10. Copy ManualScriptModal UI + state management (1276 lines)
□ 11. Copy elevenLabsFormatter.ts (334 lines) for VO export
□ 12. Ensure aiProvider.ts is configured (Gemini Direct + Vertex Key proxy)
```

---

## 📁 File Map — Dependencies

```
hooks/useScriptAnalysis.ts        ← AI pipeline (1300 lines)
components/modals/ManualScriptModal.tsx ← UI modal (1276 lines)
utils/aiProvider.ts               ← AI provider abstraction
utils/elevenLabsFormatter.ts      ← ElevenLabs TTS export (334 lines)
constants/presets.ts              ← SCRIPT_MODELS, ASPECT_RATIOS
constants/directors.ts            ← Director presets (DirectorPreset type)
constants/characterStyles.ts      ← Character style definitions
types.ts                          ← Scene, SceneGroup, Character types
```

---

## ⚠️ Những Bẫy Thường Gặp

| Bẫy | Giải pháp |
|-----|-----------|
| AI gán sai chapterId cho scenes | Post-processing: findTextInScript() + chapter range override |
| Scene count vượt target | Post-processing: merge shortest adjacent scenes |
| Dialogue bị strip khỏi voiceOverText | Prompt rule: voiceOverText = MASTER, dialogueText = OPTIONAL copy |
| (Visual notes) lọt vào VO text | Post-processing: regex clean `(...)` from voiceOverText |
| Character position drift across chapters | Scene State Memory resets on group boundary change |
| Bracket annotations thành chapter markers | preprocessMarkdownScript strips [CLIFFHANGER], [CTA], etc. |
| B-roll tạo action mới | Subject Lock + Action Lock rules in prompt |
| Gemini 2.5 Flash + thinkingConfig | thinkingConfig only for models with `2.5-pro` or `thinking` in name |
| State mất khi đóng/mở Modal | initialState prop + onStateChange callback for persistence |
| Markdown file không được preprocess | preprocessMarkdownScript() chỉ chạy khi user upload .md file |
