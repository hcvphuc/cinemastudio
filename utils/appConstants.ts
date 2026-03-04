/**
 * Application Constants
 * Centralized configuration for styles, camera settings, and defaults
 */

import type { ProjectState, Character, CharacterProp } from '../types';

// --- App Metadata ---
export const APP_NAME = "Khung Ứng Dụng";
export const PRIMARY_GRADIENT = "from-orange-600 to-red-600";
export const PRIMARY_GRADIENT_HOVER = "from-orange-500 to-red-500";

// --- Helper Functions ---
export const slugify = (text: string): string => {
    return text
        .toString()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .trim()
        .replace(/\s+/g, '-')
        .replace(/[^\w-]+/g, '')
        .replace(/--+/g, '-');
};

export const generateId = () => `id_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

// --- DEFINED GLOBAL STYLES ---
export const GLOBAL_STYLES = [
    {
        value: 'cinematic-realistic',
        label: 'Cinematic Realistic (Phim điện ảnh)',
        prompt: 'Cinematic movie screengrab, shot on Arri Alexa, photorealistic, 8k, highly detailed texture, dramatic lighting, shallow depth of field, color graded, film grain.'
    },
    {
        value: '3d-pixar',
        label: '3D Animation (Pixar/Disney)',
        prompt: '3D render style, Pixar animation style, octane render, unreal engine 5, cute, vibrant lighting, soft smooth textures, expressive, volumetric lighting, masterpiece.'
    },
    {
        value: 'anime-makoto',
        label: 'Anime (Makoto Shinkai Style)',
        prompt: 'Anime style, Makoto Shinkai art style, high quality 2D animation, beautiful sky, detailed background, vibrant colors, emotional atmosphere, cell shading.'
    },
    {
        value: 'vintage-film',
        label: 'Vintage 1980s Film (Retro)',
        prompt: '1980s vintage movie look, film grain, retro aesthetic, warm tones, soft focus, kodak portra 400, nostalgia atmosphere.'
    },
    {
        value: 'cyberpunk',
        label: 'Cyberpunk / Sci-Fi',
        prompt: 'Cyberpunk aesthetic, neon lighting, dark atmosphere, futuristic, high contrast, wet streets, technological details, blade runner style.'
    },
    {
        value: 'watercolor',
        label: 'Watercolor / Artistic',
        prompt: 'Watercolor painting style, soft edges, artistic, painterly, dreamy atmosphere, paper texture, pastel colors.'
    },
    {
        value: 'dark-fantasy',
        label: 'Dark Fantasy (Game Style)',
        prompt: 'Dark fantasy art, elden ring style, gritty, atmospheric, ominous lighting, detailed armor and textures, epic scale, oil painting aesthetic.'
    }
];

// ========== CINEMATOGRAPHY OPTIONS ==========
export const CAMERA_MODELS = [
    { value: '', label: 'Auto (AI chọn)', prompt: '' },
    { value: 'arri-alexa-35', label: 'ARRI Alexa 35', prompt: 'Shot on ARRI Alexa 35, rich cinematic colors, natural skin tones, wide dynamic range' },
    { value: 'red-v-raptor', label: 'RED V-Raptor', prompt: 'Shot on RED V-Raptor 8K, high contrast, razor sharp details, vivid colors' },
    { value: 'sony-venice-2', label: 'Sony Venice 2', prompt: 'Shot on Sony Venice 2, natural color science, beautiful skin tones, filmic look' },
    { value: 'blackmagic-ursa', label: 'Blackmagic URSA', prompt: 'Shot on Blackmagic URSA, organic film-like texture, Blackmagic color science' },
    { value: 'canon-c70', label: 'Canon C70', prompt: 'Shot on Canon C70, documentary style, natural colors, versatile look' },
    { value: 'panasonic-s1h', label: 'Panasonic S1H', prompt: 'Shot on Panasonic S1H, natural tones, subtle film grain, professional video look' },
];

export const LENS_OPTIONS = [
    { value: '', label: 'Auto (AI chọn)', prompt: '', useCase: 'AI decides based on scene' },
    { value: '16mm', label: '16mm Ultra Wide', prompt: '16mm ultra wide angle lens, expansive field of view, dramatic perspective', useCase: 'Epic landscapes, architecture' },
    { value: '24mm', label: '24mm Wide', prompt: '24mm wide angle lens, environmental context, slight distortion', useCase: 'Establishing shots, interiors' },
    { value: '35mm', label: '35mm Standard Wide', prompt: '35mm lens, natural perspective, slight wide angle', useCase: 'Walking shots, dialogue scenes' },
    { value: '50mm', label: '50mm Standard', prompt: '50mm lens, natural human perspective, minimal distortion', useCase: 'Dialogue, interviews, portraits' },
    { value: '85mm', label: '85mm Portrait', prompt: '85mm portrait lens, shallow depth of field, beautiful bokeh, flattering compression', useCase: 'Close-ups, beauty shots' },
    { value: '135mm', label: '135mm Telephoto', prompt: '135mm telephoto lens, compressed background, intimate feel, creamy bokeh', useCase: 'Emotional moments, isolation' },
    { value: '200mm', label: '200mm Long Tele', prompt: '200mm telephoto lens, extreme background compression, voyeuristic feel', useCase: 'Surveillance, nature' },
    { value: 'anamorphic', label: 'Anamorphic 2.39:1', prompt: 'anamorphic lens, horizontal lens flares, oval bokeh, cinematic widescreen 2.39:1 aspect ratio', useCase: 'Cinematic epic look' },
    { value: 'macro', label: 'Macro Lens', prompt: 'macro lens, extreme close-up, sharp details, shallow depth of field', useCase: 'Product details, textures' },
];

export const CAMERA_ANGLES = [
    { value: '', label: 'Auto (AI chọn)' },
    { value: 'wide-shot', label: 'Wide Shot (WS)' },
    { value: 'medium-shot', label: 'Medium Shot (MS)' },
    { value: 'close-up', label: 'Close-Up (CU)' },
    { value: 'extreme-cu', label: 'Extreme Close-Up (ECU)' },
    { value: 'ots', label: 'Over-the-Shoulder (OTS)' },
    { value: 'low-angle', label: 'Low Angle (Hero Shot)' },
    { value: 'high-angle', label: 'High Angle (Vulnerable)' },
    { value: 'dutch-angle', label: 'Dutch Angle (Tension)' },
    { value: 'pov', label: 'POV (First Person)' },
    { value: 'establishing', label: 'Establishing Shot' },
    { value: 'two-shot', label: 'Two Shot' },
    { value: 'insert', label: 'Insert / Detail Shot' },
];

export const DEFAULT_META_TOKENS: Record<string, string> = {
    'film': 'cinematic lighting, depth of field, film grain, anamorphic lens flare, color graded, atmospheric haze',
    'documentary': 'natural light, handheld camera feel, raw authentic look, observational style, candid moments',
    'commercial': 'product hero lighting, clean studio aesthetics, vibrant colors, high production value, aspirational mood',
    'music-video': 'dramatic lighting, high contrast, stylized color palette, dynamic angles, music video aesthetic',
    'custom': 'professional photography, detailed textures, balanced composition, thoughtful lighting'
};

export const TRANSITION_TYPES = [
    { value: '', label: 'Auto', hint: 'AI decides transition' },
    { value: 'cut', label: 'Cut', hint: 'Direct cut - instant change' },
    { value: 'match-cut', label: 'Match Cut', hint: 'Visual similarity between scenes' },
    { value: 'dissolve', label: 'Dissolve', hint: 'Gradual blend between scenes' },
    { value: 'fade-black', label: 'Fade to Black', hint: 'Scene ends with black' },
    { value: 'fade-white', label: 'Fade to White', hint: 'Scene ends with white' },
    { value: 'wipe', label: 'Wipe', hint: 'Directional reveal' },
    { value: 'jump-cut', label: 'Jump Cut', hint: 'Jarring time skip' },
    { value: 'smash-cut', label: 'Smash Cut', hint: 'Sudden dramatic contrast' },
    { value: 'l-cut', label: 'L-Cut', hint: 'Audio continues over next scene' },
    { value: 'j-cut', label: 'J-Cut', hint: 'Audio precedes visual' },
];

export const IMAGE_PROVIDERS = [
    { value: 'gemini', label: 'Gemini (Google AI Studio)', description: 'Direct API - requires Gemini API key' },
    { value: 'gommo', label: 'Gommo AI', description: 'Proxy API - requires Gommo credentials' },
];

// IMAGE_MODELS - All available models with provider info
// User can select any model regardless of imageProvider setting
// The hook will automatically use the correct provider based on model.provider
export const IMAGE_MODELS = [
    // ═══════════════════════════════════════════════════════════════════════════
    // 🖌️ EDIT MODELS - Support image editing, reference images, face/body ID
    // ═══════════════════════════════════════════════════════════════════════════
    { value: '__header_edit__', label: '─── 🖌️ EDIT MODELS ───', provider: 'header', description: 'Supports editing, references, Face ID', isHeader: true },

    // Gemini Direct
    { value: 'gemini-3.1-flash-image-preview', label: '🔵 Gemini 3.1 Flash Image', provider: 'gemini', description: 'Gemini Direct - Latest image gen model', supportsEdit: true, supportsSubject: true, group: 'edit' },
    { value: 'gemini-3-pro-image-preview', label: '🔵 Nano Banana Pro', provider: 'gemini', description: 'Gemini Direct - Via Google AI Studio API', supportsEdit: true, supportsSubject: true, group: 'edit' },
    { value: 'gemini-2.5-flash-image', label: '🔵 Gemini 2.5 Flash Image', provider: 'gemini', description: 'Gemini Direct - Fast image gen', supportsEdit: true, supportsSubject: true, group: 'edit' },

    // Vertex Key (Imperial) — via proxy, supports auto-failover
    { value: 'gemini-image-2k', label: '🟣 Gemini Image 2K (Vertex)', provider: 'imperial', description: 'Vertex Key - 2K resolution, auto-failover', supportsEdit: true, supportsSubject: true, group: 'edit' },
    { value: 'gemini-image-4k', label: '🟣 Gemini Image 4K (Vertex)', provider: 'imperial', description: 'Vertex Key - 4K best quality', supportsEdit: true, supportsSubject: true, group: 'edit' },
    { value: 'gemini-image-1k', label: '🟣 Gemini Image 1K (Vertex)', provider: 'imperial', description: 'Vertex Key - 1K fast, best for edit', supportsEdit: true, supportsSubject: true, group: 'edit' },
    { value: 'gem/gemini-3.1-flash-image-2k', label: '🟣 Flash Image 2K (Legacy)', provider: 'imperial', description: 'Vertex Key - Legacy prefix model', supportsEdit: true, supportsSubject: true, group: 'edit' },
    { value: 'gemini-3.1-flash-image-1k', label: '🔵 Gemini 3.1 Flash Image 1K', provider: 'gemini', description: '1408×768 • $0.40/req (Vertex Key)', supportsEdit: true, supportsSubject: true, group: 'edit' },
    { value: 'gemini-3.1-flash-image-2k', label: '🔵 Gemini 3.1 Flash Image 2K', provider: 'gemini', description: '2816×1536 • $0.55/req (Vertex Key)', supportsEdit: true, supportsSubject: true, group: 'edit' },
    { value: 'gemini-3.1-flash-image-4k', label: '🔵 Gemini 3.1 Flash Image 4K', provider: 'gemini', description: '5632×3072 • $0.70/req (Vertex Key)', supportsEdit: true, supportsSubject: true, group: 'edit' },

    // Google Imagen via Gommo (EDIT)
    { value: 'google_image_gen_banana_pro', label: '🟡 Nano Banana Pro', provider: 'gommo', description: 'Google - 1k/2k/4k - 300 credits', supportsEdit: true, supportsSubject: true, group: 'edit' },
    { value: 'google_image_gen_banana_pro_cheap', label: '🟡 Nano Banana Pro Cheap', provider: 'gommo', description: 'Google - Budget - 150 credits', supportsEdit: true, supportsSubject: true, group: 'edit' },
    { value: 'google_image_gen_banana_pro_reason', label: '🟡 Nano Banana Pro Reason', provider: 'gommo', description: 'Google + AI Reasoning - 150 credits', supportsEdit: true, supportsSubject: true, group: 'edit' },
    { value: 'google_image_gen_banana', label: '🟡 Nano Banana', provider: 'gommo', description: 'Google - Best for Edit - 150 credits', supportsEdit: true, supportsSubject: true, group: 'edit' },
    { value: 'google_image_gen_4_5', label: '🟡 Imagen 4.5', provider: 'gommo', description: 'Google - Smart & Fast - FREE', supportsEdit: true, supportsSubject: true, group: 'edit' },
    { value: 'google_image_gen_3_5', label: '🟡 Imagen 4', provider: 'gommo', description: 'Google - Best Quality - 50 credits', supportsEdit: true, supportsSubject: true, group: 'edit' },
    { value: 'google_image_gen_3_1', label: '🟡 Imagen 3', provider: 'gommo', description: 'Google - 50 credits', supportsEdit: true, supportsSubject: true, group: 'edit' },

    // ByteDance Seedream (EDIT)
    { value: 'seedream_4_5', label: '🟡 Seedream 4.5', provider: 'gommo', description: 'ByteDance - 2k/4k - 250 credits', supportsEdit: true, supportsSubject: true, group: 'edit' },
    { value: 'seedream_4_0', label: '🟡 Seedream 4.0', provider: 'gommo', description: 'ByteDance - Best for Edit - FREE', supportsEdit: true, supportsSubject: true, group: 'edit' },

    // Kling AI (EDIT)
    { value: 'o1', label: '🟡 IMAGE O1', provider: 'gommo', description: 'Kling - High consistency - 150 credits', supportsEdit: true, supportsSubject: true, group: 'edit' },
    { value: 'kling_colors_2_1', label: '🟡 COLORS 2.1', provider: 'gommo', description: 'Kling - 100 credits', supportsEdit: true, supportsSubject: false, group: 'edit' },
    { value: 'kling_colors_2_0', label: '🟡 COLORS 2.0', provider: 'gommo', description: 'Kling - Style/Scene - 100 credits', supportsEdit: true, supportsSubject: true, group: 'edit' },
    { value: 'kling_colors_1_5', label: '🟡 COLORS 1.5', provider: 'gommo', description: 'Kling - Face support - 100 credits', supportsEdit: true, supportsSubject: false, group: 'edit' },

    // Other Edit Models
    { value: 'z_image', label: '🟡 Z-Image', provider: 'gommo', description: 'Alibaba - Fast & Cheap - 100 credits', supportsEdit: true, supportsSubject: false, group: 'edit' },
    { value: 'dreamina_3_1', label: '🟡 Dreamina 3.1', provider: 'gommo', description: 'ByteDance - 150 credits', supportsEdit: true, supportsSubject: false, group: 'edit' },
    { value: 'hailuo_image_1', label: '🟡 Image-01', provider: 'gommo', description: 'Hailuo - 50 credits', supportsEdit: true, supportsSubject: true, group: 'edit' },

    // ═══════════════════════════════════════════════════════════════════════════
    // 🎨 TEXT-TO-IMAGE ONLY - No editing, pure generation from text
    // ═══════════════════════════════════════════════════════════════════════════
    { value: '__header_noedit__', label: '─── 🎨 TEXT-TO-IMAGE ONLY ───', provider: 'header', description: 'Text prompt only, no editing support', isHeader: true },

    // Midjourney
    { value: 'midjourney_7_0', label: '🟡 Midjourney 7.0', provider: 'gommo', description: '4 images/request - 400 credits', supportsEdit: false, supportsSubject: false, group: 'noedit' },
    { value: 'midjourney_6_1', label: '🟡 Midjourney 6.1', provider: 'gommo', description: 'Previous version - 300 credits', supportsEdit: false, supportsSubject: false, group: 'noedit' },

    // FLUX
    { value: 'flux_1_1_ultra', label: '🟡 FLUX 1.1 Ultra', provider: 'gommo', description: 'Black Forest - Premium - 200 credits', supportsEdit: false, supportsSubject: false, group: 'noedit' },
    { value: 'flux_1_1_pro', label: '🟡 FLUX 1.1 Pro', provider: 'gommo', description: 'Black Forest - 150 credits', supportsEdit: false, supportsSubject: false, group: 'noedit' },
    { value: 'flux_dev', label: '🟡 FLUX Dev', provider: 'gommo', description: 'Black Forest - Open Source - 50 credits', supportsEdit: false, supportsSubject: false, group: 'noedit' },
    { value: 'flux_schnell', label: '🟡 FLUX Schnell', provider: 'gommo', description: 'Black Forest - Fast - FREE', supportsEdit: false, supportsSubject: false, group: 'noedit' },

    // Ideogram
    { value: 'ideogram_v3', label: '🟡 Ideogram V3', provider: 'gommo', description: 'Best for text in images - 150 credits', supportsEdit: false, supportsSubject: false, group: 'noedit' },
    { value: 'ideogram_v2_turbo', label: '🟡 Ideogram V2 Turbo', provider: 'gommo', description: 'Fast - 100 credits', supportsEdit: false, supportsSubject: false, group: 'noedit' },

    // Recraft
    { value: 'recraft_v3', label: '🟡 Recraft V3', provider: 'gommo', description: 'Vector & illustrations - 150 credits', supportsEdit: false, supportsSubject: false, group: 'noedit' },

    // Stable Diffusion
    { value: 'sd_3_5_large', label: '🟡 SD 3.5 Large', provider: 'gommo', description: 'Stability AI - 100 credits', supportsEdit: false, supportsSubject: false, group: 'noedit' },
    { value: 'sd_3_5_medium', label: '🟡 SD 3.5 Medium', provider: 'gommo', description: 'Stability AI - 50 credits', supportsEdit: false, supportsSubject: false, group: 'noedit' },

    // Other
    { value: 'dalle_3', label: '🟡 DALL-E 3', provider: 'gommo', description: 'OpenAI - 200 credits', supportsEdit: false, supportsSubject: false, group: 'noedit' },
    { value: 'playground_v3', label: '🟡 Playground V3', provider: 'gommo', description: 'Creative - 100 credits', supportsEdit: false, supportsSubject: false, group: 'noedit' },
];

// CHARACTER_MODELS - Models for character/lora generation
// Used in CharacterDetailModal for Face ID and body sheet generation
// Only models with supportsSubject: true are suitable
export const CHARACTER_MODELS = [
    // Gemini Direct
    { value: 'gemini-3-pro-image-preview', label: '🔵 Nano Banana Pro', provider: 'gemini', supportsLora: true },

    // Gommo - Models that support subjects (withSubject: true)
    { value: 'google_image_gen_banana_pro', label: '🟡 Nano Banana Pro', provider: 'gommo', supportsLora: true },
    { value: 'google_image_gen_banana_pro_reason', label: '🟡 Nano Banana Pro Reason', provider: 'gommo', supportsLora: true },
    { value: 'seedream_4_5', label: '🟡 Seedream 4.5', provider: 'gommo', supportsLora: true },
    { value: 'seedream_4_0', label: '🟡 Seedream 4.0 - FREE', provider: 'gommo', supportsLora: true },
    { value: 'o1', label: '🟡 IMAGE O1', provider: 'gommo', supportsLora: true },
    { value: 'google_image_gen_4_5', label: '🟡 Imagen 4.5 - FREE', provider: 'gommo', supportsLora: true },
];

// EDIT_MODELS - Models that support image editing (mask, upscale, expand)
// Used in AdvancedImageEditor
export const EDIT_MODELS = IMAGE_MODELS.filter(m => m.supportsEdit && !m.isHeader);

// NOEDIT_MODELS - Text-to-image only models
export const NOEDIT_MODELS = IMAGE_MODELS.filter(m => !m.supportsEdit && !m.isHeader);

// Get selectable models (exclude headers)
export const SELECTABLE_IMAGE_MODELS = IMAGE_MODELS.filter(m => !m.isHeader);

export const SCRIPT_MODELS = [
    { value: 'gemini-3-pro-high', label: 'Gemini 3 Pro (High)' },
    { value: 'gemini-3-pro-low', label: 'Gemini 3 Pro (Low)' },
    { value: 'gemini-2.5-flash', label: 'Gemini 3 Flash (New)' },
    { value: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash (Default)' },
];

export const ASPECT_RATIOS = [
    { value: '16:9', label: '16:9 (Landscape - Cinematic)' },
    { value: '9:16', label: '9:16 (Portrait - Mobile/Reels)' },
    { value: '1:1', label: '1:1 (Square - Social)' },
    { value: '4:3', label: '4:3 (Classic TV)' },
    { value: '3:4', label: '3:4 (Portrait)' },
];

export const CHARACTER_STYLES = [
    {
        value: 'pixar',
        label: '3D Animation (Pixar/Disney Style)',
        prompt: 'STRICT STYLE: 3D rendered character in Pixar/Disney animation style. MUST have: soft rounded features, smooth gradient shading, large expressive eyes with glossy reflections, exaggerated proportions (big head, small body for cute characters), vibrant saturated colors, soft ambient lighting with rim lights, no hard edges, clean subsurface scattering on skin. Art style: Toy Story, Inside Out, Zootopia aesthetic. Render engine style: Arnold/RenderMan quality.'
    },
    {
        value: 'anime',
        label: 'Anime / Manga',
        prompt: 'STRICT STYLE: Japanese anime/manga illustration. MUST have: large detailed eyes with highlights and sparkles, sharp clean lineart, cel-shaded coloring with minimal gradients, vibrant hair colors with chunky highlights, sharp angular shadows, exaggerated facial expressions, simplified nose (small dots or lines), detailed clothing folds. Art style: Studio Ghibli, Makoto Shinkai, modern anime aesthetic. NO realistic shading, NO western cartoon style.'
    },
    {
        value: 'cinematic',
        label: 'Realistic Cinematic',
        prompt: 'STRICT STYLE: Photorealistic cinematic rendering. MUST have: realistic skin texture with pores and subsurface scattering, accurate anatomy and proportions, natural hair strands with physics, realistic fabric materials with wrinkles, professional studio lighting (key light + fill + rim), shallow depth of field, film grain texture, color grading like Hollywood movies. Photography style: 85mm portrait lens, f/2.8 aperture, cinematic color palette. NO cartoon features, NO stylization.'
    },
    {
        value: 'comic',
        label: 'American Comic Book',
        prompt: 'STRICT STYLE: American comic book illustration. MUST have: bold black ink outlines (thick outer lines, thinner inner details), strong contrast with dramatic shadows, halftone dot shading, dynamic poses with motion lines, exaggerated anatomy (muscular heroes, curvy females), vibrant primary colors (red, blue, yellow dominance), Ben-Day dots texture. Art style: Marvel/DC comics, Jack Kirby, Jim Lee aesthetic. NO soft gradients, NO realistic rendering.'
    },
    {
        value: 'fantasy',
        label: 'Digital Fantasy Art',
        prompt: 'STRICT STYLE: Epic fantasy digital painting. MUST have: painterly brush strokes visible, rich atmospheric lighting (magical glows, dramatic backlighting), detailed costume design with ornate patterns, fantasy elements (armor, robes, magical effects), semi-realistic proportions with idealized features, rich color palette with jewel tones, ethereal atmosphere with particles/mist. Art style: concept art for games like World of Warcraft, League of Legends, Magic: The Gathering. Medium: digital painting with visible brush work.'
    },
    {
        value: 'clay',
        label: 'Claymation / Stop Motion',
        prompt: 'STRICT STYLE: Claymation/stop-motion puppet style. MUST have: visible fingerprint textures on clay surface, slightly lumpy handmade appearance, matte finish with no glossy shine, simple geometric shapes, visible wire armature bumps, exaggerated simplified features, chunky proportions, soft pastel or earthy colors, slight imperfections showing handcrafted quality. Art style: Wallace & Gromit, Coraline, Kubo aesthetic. NO smooth 3D rendering, NO clean digital look.'
    },
];

// --- Helper: Create Initial State ---
export const createInitialState = (): ProjectState => ({
    projectName: '',
    stylePrompt: 'cinematic-realistic',
    imageModel: 'gemini-3-pro-image-preview',
    scriptModel: 'gemini-2.5-flash',
    aspectRatio: '16:9',
    genyuToken: '',
    resolution: '1K',
    scriptLanguage: 'vietnamese',
    activeScriptPreset: 'film-animation',
    customScriptPresets: [],
    characters: Array.from({ length: 3 }).map(() => ({
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
    })),
    products: [],
    scenes: [],
});

// --- Helper: Download Image ---
export const downloadImage = (base64Image: string, filename: string) => {
    if (!base64Image) return;
    const link = document.createElement('a');
    link.href = base64Image;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
};
