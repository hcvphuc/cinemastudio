// Character Style System Types (defined here to avoid circular imports)
export type CharacterStyleCategory = 'faceless' | 'stylized' | 'realistic' | 'custom';

export interface StylePromptInjection {
  global: string;
  character: string;
  negative: string;
}

export interface CharacterStyleDefinition {
  id: string;
  name: string;
  category: CharacterStyleCategory;
  promptInjection: StylePromptInjection;
  referenceImages?: string[];
  extendsStyleId?: string;
  isBuiltIn: boolean;
  tags: string[];
  description: string;
  icon?: string;
}

export interface CharacterProp {
  id: string;
  name: string; // Tên vật phẩm (ví dụ: "Kiếm", "Búa") để AI nhận diện trong prompt
  image: string | null; // Base64
}

export interface Character {
  id: string;
  name: string;
  description: string;

  // Cấu trúc mới
  masterImage: string | null; // Ảnh gốc tổng thể (Reference)
  faceImage: string | null; // Slot 1: Face ID (Auto-generated or Manual)
  bodyImage: string | null; // Slot 2: Outfit/Turnaround (Auto-generated or Manual)
  sideImage: string | null; // Slot 3: Side Profile
  backImage: string | null; // Slot 4: Back View
  props: CharacterProp[]; // Deprecated UI section, kept for backward compat

  isDefault: boolean;
  isAnalyzing?: boolean;
  isGenerating?: boolean;
  generationStartTime?: number; // Timestamp for live timer
  generationStatus?: string; // DOP status message (normalizing, polling, etc.)
  generatedImage?: string | null;

  // Google Labs Workflow Polling (for async Face/Body generation)
  faceWorkflowId?: string;
  bodyWorkflowId?: string;
  workflowStatus?: 'pending' | 'active' | 'succeeded' | 'failed';

  // Model preference for Lora generation (Gemini or Gommo)
  preferredModel?: string; // 'gemini-3-pro-image-preview' | 'google_nano_banana_pro'
  preferredVisionModel?: string; // Model for image analysis: 'auto' | 'imperial' | 'gemini' | 'groq'

  // Character Sheet (Multi-View Reference)
  characterSheet: string | null; // Full multi-view character sheet grid (4×2)
  sheetGenMode?: 'legacy' | 'sheet'; // Track generation mode used

  // Separate Histories for different views
  masterEditHistory?: { id: string; image: string; prompt: string }[];
  faceEditHistory?: { id: string; image: string; prompt: string }[];
  bodyEditHistory?: { id: string; image: string; prompt: string }[];
  sideEditHistory?: { id: string; image: string; prompt: string }[];
  backEditHistory?: { id: string; image: string; prompt: string }[];

  editHistory?: { id: string; image: string; prompt: string }[]; // Deprecated, kept for compat

  // DOP Learning System
  dopRecordId?: string; // ID for quality rating and learning
}

export interface SceneDialogue {
  characterName: string;
  line: string;
}

export interface SceneGroup {
  id: string;
  name: string;
  description: string;
  continuityReferenceGroupId?: string; // ID of a previous group to reference for visual continuity
  stylePrompt?: string; // Optional: Override global style for this group
  customStyleInstruction?: string; // Optional: Custom style prompt for this group
  conceptImage?: string | null; // AI-generated reference image for the group's location (override)
  pacing?: 'slow' | 'medium' | 'fast'; // Narrative rhythm for the group

  // Location Library Integration (NEW)
  locationId?: string; // Link to shared Location - overrides local conceptImage

  // Time & Weather Consistency
  timeOfDay?: 'dawn' | 'morning' | 'noon' | 'afternoon' | 'sunset' | 'dusk' | 'night' | 'custom';
  customTimeOfDay?: string; // Custom time description
  weather?: 'clear' | 'cloudy' | 'overcast' | 'rainy' | 'snowy' | 'foggy' | 'stormy' | 'custom';
  customWeather?: string; // Custom weather description
  outfitOverrides?: Record<string, string>; // Character ID -> Outfit Description
  lightingMood?: string; // e.g., "warm golden hour", "harsh midday sun", "cold blue moonlight"

  // Spatial Anchoring (Environment Mapping)
  spatialAnchors?: Record<string, string>; // Compass mapping: "NORTH": "Window wall", "SOUTH": "Door wall"
}

// NEW: Location entity for shared concept art across scene groups
export interface Location {
  id: string;
  name: string;
  description: string;
  conceptImage?: string | null;
  conceptPrompt?: string; // Prompt used to generate visual concept
  keywords: string[];
  isInterior?: boolean;
  timeOfDay?: string;
  mood?: string;
  createdAt: string;
  usageCount?: number;
  dopRecordId?: string; // For tracking concept generation
  isGenerating?: boolean;
  error?: string | null;
  rating?: 'good' | 'bad' | null;
  editHistory?: any[];
}


export interface Scene {
  id: string;
  sceneNumber: string;
  groupId?: string; // ID of the SceneGroup this scene belongs to

  // Legacy fields (backward compatibility)
  language1: string;
  vietnamese: string;

  // Structured Script Output Fields (New)
  voiceover?: string; // Narration/voiceover text
  dialogues?: SceneDialogue[]; // Array of character dialogues
  cameraAngle?: string; // Camera position and movement (AI-generated)
  visualDescription?: string; // Visual/environment description

  // Cinematography Overrides (User can customize per-scene)
  cameraAngleOverride?: string; // User override for camera angle
  lensOverride?: string; // User override for lens selection
  customLensOverride?: string; // Custom lens text
  customCameraAngle?: string; // Custom shot type text
  transitionType?: string; // Transition to next scene
  customTransitionType?: string; // Custom transition text

  // Generation metadata
  promptName: string;
  contextDescription: string;
  characterIds: string[];
  productIds: string[]; // Referenced Products/Props in this scene
  generatedImage: string | null;
  editHistory?: { id: string; image: string; prompt: string }[];

  // Video generation - Veo 3.1
  mediaId?: string; // Google Labs Media ID for Video Gen
  generatedVideo?: string; // URL of generated video
  videoOperationName?: string; // Operation Name for Polling
  videoStatus?: string; // Status: 'active', 'succeeded', 'failed'
  veoPrompt: string; // Prompt tối ưu cho Google Veo

  veoPreset?: string; // Preset style for Veo prompt
  veoMode?: 'image-to-video' | 'start-end-frame'; // Manual mode selection
  veoCameraMotion?: string; // Camera motion for Veo (e.g., 'orbit-left', 'dolly-in', 'pan-right')
  imageRole?: 'single' | 'start-frame' | 'end-frame'; // Role of generatedImage
  endFrameImage?: string | null; // End frame for Start/End Frame mode

  // Prop & Vision Reference (User-defined or copy from other scenes)
  referenceImage?: string | null; // Base64 or URL
  referenceImageDescription?: string; // What to focus on in this reference (e.g. "Cái chảo")

  // Manual Script Import - Voice Over (NEW)
  voiceOverText?: string; // Original VO script text (READONLY after import)
  isVOScene?: boolean; // True if this scene has voice-over attached
  isDialogueScene?: boolean; // True if this scene has actual character dialogue (not narration)
  voSecondsEstimate?: number; // Estimated VO duration in seconds
  referenceSceneId?: string; // For B-roll: ID of the VO scene this expands

  // Key Frame Strategy
  isKeyFrame?: boolean; // Mark as hero shot - becomes reference anchor for nearby scenes

  // Advanced Continuity (Accumulative State & Spatial)
  characterVisualStates?: Record<string, string>; // CharID -> "muddy, bleeding"
  facingDirection?: 'NORTH' | 'SOUTH' | 'EAST' | 'WEST' | 'custom';
  customFacingDirection?: string;

  // Stats
  generationDuration?: number; // Time taken to generate this image (ms)
  generationStartTime?: number; // Timestamp when generation started (for realtime timer)
  generatedByModel?: string; // Which AI model generated this image (e.g., 'midjourney_7_0', 'gemini-3-pro-image-preview')

  // UI state
  isGenerating: boolean;
  error: string | null;

  // DOP Learning System
  dopRecordId?: string; // ID for quality rating and learning
}

// Script Preset System
export type ScriptCategory = 'film' | 'documentary' | 'commercial' | 'music-video' | 'custom';
export type SceneStructure = 'traditional' | 'documentary' | 'commercial' | 'montage' | 'custom';

export interface OutputFormat {
  hasDialogue: boolean;
  hasNarration: boolean;
  hasCameraAngles: boolean;
  sceneStructure: SceneStructure;
}

export interface ScriptPreset {
  id: string;
  name: string;
  category: ScriptCategory;
  description: string;
  icon: string;

  // AI Configuration
  systemPrompt: string;
  outputFormat: OutputFormat;

  // Guidelines
  toneKeywords: string[];
  sceneGuidelines: string;
  exampleOutput: string;

  // Metadata
  isDefault: boolean;
  isCustom: boolean;
  createdAt: string;
}

// Director Preset System
export interface DirectorPreset {
  id: string;
  name: string;
  origin: 'Âu' | 'Á';
  description: string;
  dna: string;
  quote?: string;
  isCustom?: boolean;
}

// Advanced Image Editor
export interface DetectedObject {
  id: string;
  name: string;
  description: string;
  position: string; // "left", "center", "right", "top", "bottom", etc.
  selected?: boolean;
}

export interface EditHistory {
  id: string;
  image: string; // base64
  timestamp: number;
  operation: string; // "Original", "Removed person", "Style transfer", etc.
}

export interface GalleryAsset {
  id: string;
  image: string;
  type: string; // 'scene', 'character', 'product', 'edit'
  timestamp: number;
  prompt?: string;
  sourceId?: string; // id of scene/char/product it came from
}

export type EditingMode = 'remove' | 'add' | 'style' | 'inpaint' | 'text-edit';

export interface ProjectState {
  projectName: string;
  detailedScript?: string;
  customScriptInstruction?: string; // Custom meta tokens for script generation
  stylePrompt: string;
  imageModel: string; // Selected Image Gen Model
  genyuToken?: string; // Token for Genyu API access

  // Gommo AI Provider (Alternative to Gemini)
  imageProvider?: 'gemini' | 'gommo'; // Which provider to use for image gen
  gommoDomain?: string; // Gommo API domain
  gommoAccessToken?: string; // Gommo API access token
  gommoCredits?: number; // Cached credit balance

  aspectRatio: string; // "16:9" | "9:16" | "1:1" | "4:3" | "3:4"
  imageOutputFormat?: 'jpeg' | 'png'; // Output format: jpeg (compressed, ~400KB) or png (lossless, ~3-5MB). Default: jpeg

  resolution: string;
  scriptModel?: string; // Selected Script Gen Model (Gemini 3 series)
  scriptLanguage: string; // 'vietnamese' | 'language1' | 'custom'
  customScriptLanguage?: string; // User input for custom language

  // Script Preset System
  activeScriptPreset: string; // ID of currently selected preset
  customScriptPresets: ScriptPreset[]; // User-created presets

  // Cinematography Settings (NEW)
  cameraModel?: string; // Global camera body selection
  customCameraModel?: string; // Custom camera body input
  defaultLens?: string; // Default lens for all scenes
  customDefaultLens?: string; // Custom lens input
  customMetaTokens?: string; // Custom creative tokens (if empty, AI generates)
  customStyleInstruction?: string; // Custom full style prompt when Global Style is 'custom'
  customStyleImage?: string; // Custom style reference IMAGE for exact visual style matching

  // Director System (NEW)
  activeDirectorId?: string;
  directorCameraOnlyMode?: boolean; // When true, Director only injects camera style, not color grading
  customDirectors?: DirectorPreset[];

  // Character Style System (NEW - Extensible)
  globalCharacterStyleId?: string; // ID of active style (e.g., 'faceless-mannequin')
  customCharacterStyles?: CharacterStyleDefinition[]; // User-created styles

  characters: Character[];
  products: Product[]; // List of Products/Props
  scenes: Scene[];
  sceneGroups?: SceneGroup[]; // Optional: List of SceneGroups (Scenes Group feature)
  locations?: Location[]; // NEW: Shared location concepts for multiple groups
  assetGallery?: GalleryAsset[]; // Session gallery

  // Research Notes (Session memory for Director/DOP guidance)
  researchNotes?: {
    director?: string;  // Director's storytelling/emotional notes
    dop?: string;       // DOP's cinematography/lighting notes
    story?: string;     // [New] Global Story Context / World Setting (e.g. "Casino in Monte Carlo, 2019")
    materialKit?: string; // [New] Persistent technical DNA tokens for consistency
  };


  // Manual Script Analysis State (persist to avoid re-analyzing)
  manualScriptState?: {
    scriptText: string;
    readingSpeed: 'slow' | 'medium' | 'fast';
    selectedStyleId: string;
    selectedDirectorId: string;
    selectedModel: string;
    directorNotes: string;
    dopNotes: string;
    storyContext: string;
    analysisResult: any | null; // ScriptAnalysisResult - use any to avoid circular import
  };

  // Agent Thinking State
  agents?: {
    director: AgentState;
    dop: AgentState;
  };

  productionLogs?: ProductionLogEntry[];

  // Usage Statistics (Persisted)
  totalGenerationTime?: number; // Total accumulative generation time (ms)
  usageStats?: {
    '1K': number;
    '2K': number;
    '4K': number;
    total: number;
    // Per-type counters
    scenes?: number;
    characters?: number;
    products?: number;
    concepts?: number;
    // Provider breakdown
    geminiImages?: number;  // Images generated via Gemini Direct
    gommoImages?: number;   // Images generated via Gommo Proxy
    estimatedPromptTokens?: number; // Cumulative estimated prompt tokens
    // Token usage
    textTokens?: number;     // Total text tokens used
    promptTokens?: number;   // Input tokens
    candidateTokens?: number; // Output tokens
    textCalls?: number;      // Number of text API calls
    lastGeneratedAt?: string;
  };

  // Generation Configuration (NEW)

  generationConfig?: GenerationConfig;
}

export interface GenerationConfig {
  imageDelay: number;
  veoDelay: number;
  insertAngleDelay: number;
  concurrencyLimit: number;
}


export type AgentStatus = 'idle' | 'thinking' | 'speaking' | 'success' | 'error';

export interface AgentState {
  status: AgentStatus;
  message?: string;
  thought?: string; // Internal internal thought
  lastAction?: number;
  currentStage?: string; // NEW: Granular stage for loading indicators (e.g. "Analyzing Visual DNA")
}

export interface ProductionLogEntry {
  id: string;
  timestamp: number;
  sender: 'director' | 'dop' | 'user' | 'system';
  message: string;
  type: 'info' | 'success' | 'warning' | 'error' | 'directive';
  stage?: string;
}



export interface Product {
  id: string;
  name: string;
  description: string;
  masterImage: string | null;
  views: {
    front: string | null;
    back: string | null;
    left: string | null;
    right: string | null;
    top: string | null;
  };
  isAnalyzing: boolean;
  editHistory?: { id: string; image: string; prompt: string }[];
  viewEditHistories?: Record<string, { id: string; image: string; prompt: string }[]>;
}