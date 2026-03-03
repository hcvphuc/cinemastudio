/**
 * ManualScriptModal
 * 
 * Modal for importing voice-over scripts manually.
 * Paste script → AI analyzes → User confirms → Generate scene map
 */

import React, { useState, useCallback } from 'react';
import { X, FileText, Upload, Users, Layers, Clock, Play, Film, Palette, AlertTriangle, Check, ChevronDown, ChevronUp, Save, FolderOpen, Trash2, MapPin } from 'lucide-react';
import { Character, SceneGroup, Scene, ProjectState, CharacterStyleDefinition } from '../../types';
import { DirectorPreset, DIRECTOR_PRESETS, DirectorCategory } from '../../constants/directors';
import { BUILT_IN_CHARACTER_STYLES, getStylesByCategory } from '../../constants/characterStyles';
import { SCRIPT_MODELS } from '../../constants/presets';
import { useScriptAnalysis, ScriptAnalysisResult } from '../../hooks/useScriptAnalysis';
import { useResearchPresets, ResearchPreset } from '../../hooks/useResearchPresets';
import { GoogleGenAI } from "@google/genai";
import { generateId } from '../../utils/helpers';
import { processScriptToParts, processScriptToPartsSync, getElevenLabsZipFilename } from '../../utils/elevenLabsFormatter';

declare const JSZip: any;

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
        detectedLocations?: { id: string; name: string; description: string; keywords: string[]; chapterIds: string[]; conceptPrompt: string; isInterior: boolean; timeOfDay?: string; mood?: string }[]
    ) => void;
    existingCharacters: Character[];
    userApiKey: string | null;
    userId: string | null;
    // [NEW] Persistence props
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
    onStateChange?: (state: {
        scriptText: string;
        readingSpeed: 'slow' | 'medium' | 'fast';
        selectedStyleId: string;
        selectedDirectorId: string;
        selectedModel: string;
        directorNotes: string;
        dopNotes: string;
        storyContext: string;
        analysisResult: any | null;
    }) => void;
}

/**
 * Pre-process a Markdown (.md) script file:
 * - Strip metadata block (title, production info before ---)
 * - Convert PART headers → [bracket] chapter notation for chapter detection
 * - Convert **[CLIFFHANGER: ...]** → narrator transition markers
 * - Convert [CTA]: → voiceover content  
 * - Strip bold markdown formatting ** **
 * - Remove remaining markdown headers (##, ###)
 * - Preserve voiceover content and inline dialogue as-is
 */
function preprocessMarkdownScript(raw: string): string {
    const lines = raw.split('\n');
    const result: string[] = [];
    let pastMetadata = false;
    let hasMetadataBlock = false;

    // Check if file starts with metadata (# Title or ### Production)
    for (const line of lines.slice(0, 10)) {
        const t = line.trim();
        if (t.startsWith('# ') || t.startsWith('### Production') || t.match(/^\*\*\w+\*\*\s*:/)) {
            hasMetadataBlock = true;
            break;
        }
    }

    // If no metadata block detected, start processing immediately
    if (!hasMetadataBlock) pastMetadata = true;

    for (const line of lines) {
        const trimmed = line.trim();

        // Skip metadata block (# Title, ### Production Info, **Key**: Value, ---)
        if (!pastMetadata) {
            if (trimmed === '---') { pastMetadata = true; continue; }
            if (trimmed.startsWith('#') || trimmed.startsWith('**') || !trimmed) continue;
            // If we reach a non-metadata line without finding ---, start processing
            pastMetadata = true;
        }

        // Convert PART headers → [bracket] chapter notation (ONLY these become chapters)
        // Matches: "## PART A: HOOK — The Table Flip", "PART B: THE BACKSTORY", "# PART 1: Setup"
        const partMatch = trimmed.match(/^#{0,3}\s*PART\s+([A-Z0-9]+)[\s:—\-–]+(.+)$/i);
        if (partMatch) {
            result.push(`[PART ${partMatch[1].toUpperCase()}: ${partMatch[2].trim()}]`);
            continue;
        }

        // Strip ALL bracket-formatted script annotations to prevent them from becoming chapter markers
        // These are YouTube script conventions: [CLIFFHANGER: ...], [CTA], [MICRO-CTA], [FLASHBACK ...], [PUNCHLINE ...], etc.
        // Convert to plain narrator text (extract the content after the keyword)
        const bracketAnnotation = trimmed.match(/^\*{0,2}\[(CLIFFHANGER|CTA|MICRO-CTA|FLASHBACK[^:]*|PUNCHLINE[^:]*|FINAL CTA|FINAL STATISTICS)[:\s—\-–]*(.*)?\]\*{0,2}[:\s]*(.*)$/i);
        if (bracketAnnotation) {
            // Combine inner text + any text after the bracket
            const innerText = (bracketAnnotation[2] || '').trim();
            const afterText = (bracketAnnotation[3] || '').trim();
            const combined = [innerText, afterText].filter(Boolean).join(' ');
            if (combined) {
                // Strip any remaining ** bold formatting
                result.push(combined.replace(/\*\*/g, ''));
            }
            continue;
        }

        // Also catch standalone bracket tags like **[PUNCHLINE MID — DELIVERED]** or **[FLASHBACK 1 — BEGINS]**
        // These have no text content to extract, just skip them
        const standaloneTag = trimmed.match(/^\*{0,2}\[.+?(BEGINS|ENDS|DELIVERED|PAYOFF|EPILOGUE)[^]]*\]\*{0,2}$/i);
        if (standaloneTag) {
            continue; // Skip structural tags
        }

        // Skip remaining markdown headers that aren't PART headers
        if (/^#{1,3}\s/.test(trimmed)) continue;

        // Skip horizontal rules
        if (/^---+$/.test(trimmed)) continue;

        // Strip bold markdown formatting: **text** → text
        let processed = line.replace(/\*\*(.+?)\*\*/g, '$1');

        // Strip any remaining [BRACKET TAGS] that weren't caught above (safety net)
        // But preserve [PART ...] brackets
        processed = processed.replace(/\*{0,2}\[(?!PART\s)([^\]]+)\]\*{0,2}/g, (match, content) => {
            // Return just the content without brackets
            return content;
        });

        // Keep everything else as voiceover content (including inline dialogue in quotes)
        result.push(processed);
    }

    return result.join('\n').trim();
}

export const ManualScriptModal: React.FC<ManualScriptModalProps> = ({
    isOpen,
    onClose,
    onImport,
    existingCharacters,
    userApiKey,
    userId,
    initialState,
    onStateChange
}) => {
    // Script input
    const [scriptText, setScriptText] = useState(initialState?.scriptText || '');
    const [readingSpeed, setReadingSpeed] = useState<'slow' | 'medium' | 'fast'>(initialState?.readingSpeed || 'medium');

    // Style & Director selection
    const [selectedStyleId, setSelectedStyleId] = useState<string>(initialState?.selectedStyleId || 'faceless-mannequin');
    const [selectedDirectorId, setSelectedDirectorId] = useState<string>(initialState?.selectedDirectorId || 'werner_herzog');
    const [selectedModel, setSelectedModel] = useState<string>(initialState?.selectedModel || SCRIPT_MODELS[0].value);

    // UI state
    const [showStylePicker, setShowStylePicker] = useState(false);
    const [showDirectorPicker, setShowDirectorPicker] = useState(false);
    const [sceneCountEstimate, setSceneCountEstimate] = useState<number | null>(null); // User-adjustable scene count

    // Video Zone / Static Zone config
    const [videoZoneEnabled, setVideoZoneEnabled] = useState(false);
    const [videoZoneScenes, setVideoZoneScenes] = useState(30); // Number of scenes for video (8s each)
    const [staticZoneScenes, setStaticZoneScenes] = useState(35); // Number of scenes for static images

    // Research Notes state
    const [showResearchNotes, setShowResearchNotes] = useState(false);
    const [directorNotes, setDirectorNotes] = useState(initialState?.directorNotes || '');
    const [dopNotes, setDopNotes] = useState(initialState?.dopNotes || '');
    const [storyContext, setStoryContext] = useState(initialState?.storyContext || '');
    const [showPresetPicker, setShowPresetPicker] = useState(false);
    const [presetName, setPresetName] = useState('');
    const [isSavingPreset, setIsSavingPreset] = useState(false);

    // Custom Director Search state (NEW)
    const [customDirectorName, setCustomDirectorName] = useState('');
    const [isSearchingDirector, setIsSearchingDirector] = useState(false);
    const [customDirector, setCustomDirector] = useState<DirectorPreset | null>(null);

    // Research Presets hook (cloud sync)
    const { presets, isLoading: presetsLoading, savePreset, deletePreset } = useResearchPresets(userId);

    // Analysis hook
    const { isAnalyzing, analysisStage, analysisResult, analysisError, analyzeScript, generateSceneMap, setAnalysisResult } = useScriptAnalysis(userApiKey);

    // Track if user manually went back (to prevent auto-restore)
    const userWentBack = React.useRef(false);

    // [NEW] Restore analysis result from initial state (only on first mount)
    React.useEffect(() => {
        if (initialState?.analysisResult && !analysisResult && !userWentBack.current) {
            setAnalysisResult(initialState.analysisResult);
        }
    }, [initialState?.analysisResult, analysisResult, setAnalysisResult]);

    // Handler for "Back to Edit" button
    const handleBackToEdit = useCallback(() => {
        userWentBack.current = true;
        setAnalysisResult(null);
    }, [setAnalysisResult]);

    // Handler for importing .md/.txt script file
    const handleImportMdFile = useCallback(() => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.md,.txt,.markdown';
        input.onchange = (e) => {
            const file = (e.target as HTMLInputElement).files?.[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = (ev) => {
                const raw = ev.target?.result as string;
                const processed = preprocessMarkdownScript(raw);
                setScriptText(processed);
                console.log(`[ManualScript] Imported .md file: ${file.name} (${raw.length} → ${processed.length} chars)`);
            };
            reader.readAsText(file);
        };
        input.click();
    }, []);

    // State for ElevenLabs export loading
    const [isExportingVO, setIsExportingVO] = useState(false);
    const [exportProgress, setExportProgress] = useState('');

    // Handler for exporting ElevenLabs-ready voiceover as ZIP (1 file per PART)
    const handleExportElevenLabsVO = useCallback(async () => {
        if (!scriptText.trim()) return;
        setIsExportingVO(true);
        setExportProgress('Splitting script...');
        try {
            let partFiles;
            if (userApiKey) {
                console.log('[ManualScript] Exporting ElevenLabs VO with AI (per-PART)...');
                partFiles = await processScriptToParts(scriptText, {
                    useAI: true,
                    apiKey: userApiKey,
                    stripAfterEnd: true,
                });
            } else {
                console.log('[ManualScript] Exporting ElevenLabs VO (simple mode)...');
                partFiles = processScriptToPartsSync(scriptText);
            }

            setExportProgress(`Packaging ${partFiles.length} files...`);

            // Package into ZIP
            if (typeof JSZip === 'undefined' || !JSZip) {
                // Fallback: download individual files
                for (const pf of partFiles) {
                    const blob = new Blob([pf.content], { type: 'text/plain;charset=utf-8' });
                    const url = URL.createObjectURL(blob);
                    const link = document.createElement('a');
                    link.href = url;
                    link.download = pf.filename;
                    document.body.appendChild(link);
                    link.click();
                    document.body.removeChild(link);
                    URL.revokeObjectURL(url);
                }
            } else {
                const zip = new JSZip();
                for (const pf of partFiles) {
                    zip.file(pf.filename, pf.content);
                }
                const zipBlob = await zip.generateAsync({ type: 'blob' });
                const url = URL.createObjectURL(zipBlob);
                const link = document.createElement('a');
                link.href = url;
                link.download = getElevenLabsZipFilename();
                document.body.appendChild(link);
                link.click();
                document.body.removeChild(link);
                URL.revokeObjectURL(url);
            }

            console.log(`[ManualScript] Exported ${partFiles.length} ElevenLabs VO files`);
        } catch (err) {
            console.error('[ManualScript] ElevenLabs export error:', err);
            // Fallback to sync simple
            const partFiles = processScriptToPartsSync(scriptText);
            for (const pf of partFiles) {
                const blob = new Blob([pf.content], { type: 'text/plain;charset=utf-8' });
                const url = URL.createObjectURL(blob);
                const link = document.createElement('a');
                link.href = url;
                link.download = pf.filename;
                document.body.appendChild(link);
                link.click();
                document.body.removeChild(link);
                URL.revokeObjectURL(url);
            }
        } finally {
            setIsExportingVO(false);
            setExportProgress('');
        }
    }, [scriptText, userApiKey]);

    // [NEW] Notify parent of state changes for persistence
    React.useEffect(() => {
        if (onStateChange && isOpen) {
            onStateChange({
                scriptText,
                readingSpeed,
                selectedStyleId,
                selectedDirectorId,
                selectedModel,
                directorNotes,
                dopNotes,
                storyContext,
                analysisResult
            });
        }
    }, [scriptText, readingSpeed, selectedStyleId, selectedDirectorId, selectedModel, directorNotes, dopNotes, storyContext, analysisResult, onStateChange, isOpen]);

    // [New] Auto-fill Global Context from analysis
    React.useEffect(() => {
        if (analysisResult?.globalContext) {
            setStoryContext(analysisResult.globalContext);
            // Auto-expand research notes if context is found, to show user
            setShowResearchNotes(true);
        }
    }, [analysisResult]);

    // Get selected items
    const selectedStyle = BUILT_IN_CHARACTER_STYLES.find(s => s.id === selectedStyleId);
    const allDirectors = Object.values(DIRECTOR_PRESETS).flat();
    const selectedDirector = customDirector || allDirectors.find(d => d.id === selectedDirectorId);
    const stylesByCategory = getStylesByCategory([]);

    // Handle analyze
    const handleAnalyze = useCallback(async () => {
        if (!scriptText.trim()) return;
        userWentBack.current = false; // Reset flag when starting new analysis
        await analyzeScript(
            scriptText,
            readingSpeed,
            selectedModel,
            selectedStyle || null,
            selectedDirector || null,
            // Pass Research Notes for AI context injection
            (directorNotes || dopNotes || storyContext) ? {
                director: directorNotes || undefined,
                dop: dopNotes || undefined,
                story: storyContext || undefined // [New]
            } : null,
            existingCharacters, // [Fixed] Check against existing characters
            videoZoneEnabled ? (videoZoneScenes + staticZoneScenes) : (sceneCountEstimate || undefined), // Total scene count
            videoZoneEnabled ? { enabled: true, videoScenes: videoZoneScenes, staticScenes: staticZoneScenes } : undefined
        );
    }, [scriptText, readingSpeed, selectedModel, analyzeScript, selectedStyle, selectedDirector, directorNotes, dopNotes, storyContext, sceneCountEstimate, videoZoneEnabled, videoZoneScenes, staticZoneScenes]);

    // Handle import
    const handleImport = useCallback(() => {
        if (!analysisResult) return;

        const { scenes, groups, newCharacters, sceneCharacterMap } = generateSceneMap(
            analysisResult,
            selectedDirector || null,
            selectedStyle || null,
            existingCharacters
        );

        // Pass research notes for storage in ProjectState
        const notes = (directorNotes || dopNotes || storyContext) ? {
            director: directorNotes || undefined,
            dop: dopNotes || undefined,
            story: storyContext || undefined
        } : undefined;

        // Pass detected locations for Location Library
        const locations = analysisResult.locations || [];

        onImport(scenes, groups, newCharacters, selectedStyleId, selectedDirectorId, sceneCharacterMap, notes, locations);
        onClose();
    }, [analysisResult, selectedDirector, selectedStyle, existingCharacters, onImport, onClose, generateSceneMap, selectedStyleId, selectedDirectorId, directorNotes, dopNotes, storyContext]);

    if (!isOpen) return null;

    // Custom Director Search Handler (NEW)
    const handleSearchCustomDirector = async () => {
        if (!customDirectorName.trim()) return;
        const currentApiKey = userApiKey || (process.env as any).API_KEY;
        if (!currentApiKey) return alert("Vui lòng nhập API Key để sử dụng tính năng tìm kiếm.");

        setIsSearchingDirector(true);
        try {
            const ai = new GoogleGenAI({ apiKey: currentApiKey });
            const prompt = `Analyze the cinematic and storytelling style of the director "${customDirectorName}". 
            Return a JSON object with:
            {
                "description": "Short 1-sentence bio/style summary in Vietnamese",
                "dna": "Comma-separated visual/technical keywords in English",
                "quote": "A famous quote about their art in original language/English",
                "signatureCameraStyle": "Their signature camera technique in English"
            }`;

            const response = await ai.models.generateContent({
                model: "gemini-2.5-flash",
                contents: [{ role: 'user', parts: [{ text: prompt }] }],
                config: { responseMimeType: "application/json" }
            });

            const responseText = response.text || '{}';
            const data = JSON.parse(responseText);

            const newCustomDirector: DirectorPreset = {
                id: `custom-${generateId()}`,
                name: customDirectorName,
                origin: 'Âu',
                description: data.description || `Phong cách của ${customDirectorName}`,
                dna: data.dna || 'Cinematic',
                quote: data.quote || '',
                signatureCameraStyle: data.signatureCameraStyle || '',
                isCustom: true
            };

            setCustomDirector(newCustomDirector);
            setSelectedDirectorId(newCustomDirector.id);
            setCustomDirectorName('');
            setShowDirectorPicker(false);
        } catch (error) {
            console.error("Director search failed:", error);
            alert("Không tìm thấy thông tin đạo diễn. Vui lòng tự mô tả phong cách.");
        } finally {
            setIsSearchingDirector(false);
        }
    };

    return (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-md z-50 flex items-center justify-center p-4">
            <style>{`
                .custom-scrollbar::-webkit-scrollbar {
                    width: 4px;
                }
                .custom-scrollbar::-webkit-scrollbar-track {
                    background: transparent;
                }
                .custom-scrollbar::-webkit-scrollbar-thumb {
                    background: #52525b;
                    border-radius: 4px;
                }
                .custom-scrollbar::-webkit-scrollbar-thumb:hover {
                    background: #71717a;
                }
            `}</style>
            <div className="bg-gradient-to-br from-zinc-900 via-zinc-900 to-zinc-800 rounded-3xl w-full max-w-5xl max-h-[90vh] overflow-hidden flex flex-col shadow-2xl shadow-violet-500/10 border border-zinc-700/50">
                {/* Header - Glassmorphism */}
                <div className="flex items-center justify-between px-8 py-5 border-b border-zinc-700/50 bg-zinc-800/30 backdrop-blur-sm">
                    <div className="flex items-center gap-4">
                        <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-violet-500 to-fuchsia-600 flex items-center justify-center shadow-lg shadow-violet-500/30">
                            <FileText className="w-6 h-6 text-white" />
                        </div>
                        <div>
                            <h2 className="text-2xl font-bold text-white tracking-tight">Import Voice-Over Script</h2>
                            <p className="text-sm text-zinc-400 mt-0.5">AI-powered scene breakdown from your script</p>
                        </div>
                    </div>
                    <button onClick={onClose} className="p-2.5 hover:bg-zinc-700/50 rounded-xl transition-all hover:scale-105">
                        <X className="w-5 h-5 text-zinc-400" />
                    </button>
                </div>

                {/* Content */}
                <div className="flex-1 px-8 py-6 overflow-y-auto custom-scrollbar relative">
                    {/* Detailed Loading Overlay (NEW) */}
                    {isAnalyzing && (
                        <div className="absolute inset-0 bg-zinc-900/80 backdrop-blur-md z-40 flex flex-col items-center justify-center p-8 text-center animate-fade-in">
                            <div className="w-16 h-16 border-4 border-violet-500/20 border-t-violet-500 rounded-full animate-spin mb-6" />
                            <h3 className="text-xl font-bold text-white mb-2">Đang phân tích kịch bản</h3>
                            <div className="text-zinc-400 text-sm max-w-sm mb-6 h-10">
                                {(() => {
                                    switch (analysisStage) {
                                        case 'preparing': return 'Đang chuẩn bị bối cảnh và phân tích độ dài kịch bản...';
                                        case 'dialogue-detection': return '🔍 Đang phát hiện thoại nhân vật (Dialogue Detection)...';
                                        case 'connecting': return 'Đang kết nối với hệ thống Gemini 3 Deep Thinking...';
                                        case 'clustering': return 'AI Director đang gom cụm chi tiết hình ảnh (Visual Clustering)...';
                                        case 'thinking': return 'AI Director đang chuyển giao scene list cho DOP để đóng gói JSON...';
                                        case 'post-processing': return 'Đang xử lý dữ liệu AI và xây dựng cấu trúc Storyboard...';
                                        case 'validating': return '✅ Đang kiểm tra phân tách Voice-Over / Dialogue...';
                                        case 'finalizing': return 'Đang hoàn tất các bước cuối cùng...';
                                        default: return 'Đang xử lý...';
                                    }
                                })()}
                            </div>

                            {/* Simple Progress Indicator */}
                            <div className="w-64 h-1.5 bg-zinc-800 rounded-full overflow-hidden">
                                <div
                                    className="h-full bg-gradient-to-r from-violet-500 to-fuchsia-500 transition-all duration-500"
                                    style={{
                                        width: analysisStage === 'preparing' ? '5%' :
                                            analysisStage === 'dialogue-detection' ? '15%' :
                                                analysisStage === 'connecting' ? '25%' :
                                                    analysisStage === 'clustering' ? '45%' :
                                                        analysisStage === 'thinking' ? '65%' :
                                                            analysisStage === 'post-processing' ? '80%' :
                                                                analysisStage === 'validating' ? '92%' :
                                                                    analysisStage === 'finalizing' ? '98%' : '0%'
                                    }}
                                />
                            </div>
                            <p className="text-[10px] text-zinc-500 mt-4 uppercase tracking-widest">Giai đoạn: {analysisStage}</p>
                        </div>
                    )}
                    {!analysisResult ? (
                        // Step 1: Input Script - Premium 2-Column Layout
                        <div className="grid grid-cols-1 lg:grid-cols-5 gap-6 h-full">
                            {/* Left Column - Script Input (3/5) */}
                            <div className="lg:col-span-3 flex flex-col">
                                <div className="flex items-center gap-2 mb-3">
                                    <div className="w-2 h-2 rounded-full bg-violet-500 animate-pulse" />
                                    <label className="text-sm font-semibold text-white uppercase tracking-wider">
                                        Voice-Over Script
                                    </label>
                                    <div className="ml-auto flex items-center gap-2">
                                        <button
                                            onClick={handleImportMdFile}
                                            className="flex items-center gap-1.5 px-3 py-1.5 bg-violet-600/20 border border-violet-500/30 text-violet-300 rounded-lg text-xs font-medium hover:bg-violet-600/40 hover:border-violet-500/50 transition-all"
                                            title="Import from .md or .txt file"
                                        >
                                            <Upload size={12} />
                                            Import .md
                                        </button>
                                        {scriptText.trim() && (
                                            <button
                                                onClick={handleExportElevenLabsVO}
                                                disabled={isExportingVO}
                                                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${isExportingVO
                                                    ? 'bg-emerald-600/10 border border-emerald-500/20 text-emerald-400/60 cursor-wait'
                                                    : 'bg-emerald-600/20 border border-emerald-500/30 text-emerald-300 hover:bg-emerald-600/40 hover:border-emerald-500/50'
                                                    }`}
                                                title="Export voiceover text optimized for ElevenLabs TTS (AI-enhanced)"
                                            >
                                                {isExportingVO ? (
                                                    <>
                                                        <div className="w-3 h-3 border-2 border-emerald-400/30 border-t-emerald-400 rounded-full animate-spin" />
                                                        {exportProgress || 'Processing...'}
                                                    </>
                                                ) : (
                                                    <>📥 Export VO</>
                                                )}
                                            </button>
                                        )}
                                    </div>
                                </div>
                                <div className="relative flex-1">
                                    <textarea
                                        value={scriptText}
                                        onChange={(e) => setScriptText(e.target.value)}
                                        placeholder="Paste your voice-over script here...

Example:
Monte Carlo, March 2019. The casino is buzzing with high rollers...
John enters the room, wearing a tailored Armani suit..."
                                        className="w-full h-80 bg-zinc-800/50 border-2 border-zinc-700/50 rounded-2xl p-5 text-white placeholder-zinc-600 resize-none focus:outline-none focus:border-violet-500/50 focus:ring-4 focus:ring-violet-500/10 transition-all duration-300 text-[15px] leading-relaxed"
                                    />
                                    <div className="absolute bottom-4 left-5 right-5 flex justify-between items-center">
                                        <div className="flex items-center gap-4">
                                            <span className="text-xs text-zinc-500 bg-zinc-800 px-2 py-1 rounded-md">
                                                📝 {scriptText.split(/\s+/).filter(Boolean).length} words
                                            </span>
                                            <span className="text-xs text-zinc-500 bg-zinc-800 px-2 py-1 rounded-md">
                                                ⏱️ ~{Math.ceil(scriptText.split(/\s+/).filter(Boolean).length / 150)} min
                                            </span>
                                        </div>
                                    </div>
                                </div>

                                {/* Research Notes - Collapsible */}
                                <div className="mt-4 border border-zinc-700/50 rounded-2xl overflow-hidden">
                                    <button
                                        onClick={() => setShowResearchNotes(!showResearchNotes)}
                                        className="w-full flex items-center justify-between px-4 py-3 bg-zinc-800/50 hover:bg-zinc-800/70 transition-colors"
                                    >
                                        <div className="flex items-center gap-2">
                                            <span className="text-lg">📚</span>
                                            <span className="text-sm font-semibold text-white">Research Notes & Global Context</span>
                                            <span className="text-xs text-zinc-500">(World Setting, Themes, Camera)</span>
                                        </div>
                                        {showResearchNotes ? (
                                            <ChevronUp className="w-4 h-4 text-zinc-400" />
                                        ) : (
                                            <ChevronDown className="w-4 h-4 text-zinc-400" />
                                        )}
                                    </button>

                                    {showResearchNotes && (
                                        <div className="p-4 space-y-4 bg-zinc-900/30">

                                            {/* [New] Global Story Context */}
                                            <div>
                                                <label className="flex items-center gap-2 text-xs font-medium text-emerald-400 mb-2">
                                                    <AlertTriangle className="w-3.5 h-3.5" />
                                                    Global Story Context (Thiết lập bối cảnh chung - BẮT BUỘC)
                                                </label>
                                                <textarea
                                                    value={storyContext}
                                                    onChange={(e) => setStoryContext(e.target.value)}
                                                    placeholder="VD: Thế giới Cyberpunk 2077. Nhân vật chính là thám tử tư. Bối cảnh diễn ra tại Night City, khu phố ổ chuột..."
                                                    className="w-full h-20 bg-zinc-800/50 border border-emerald-500/30 rounded-xl p-3 text-sm text-white placeholder-zinc-600 resize-none focus:outline-none focus:border-emerald-500/50 focus:ring-2 focus:ring-emerald-500/10"
                                                />
                                            </div>

                                            {/* Director Notes */}
                                            <div>
                                                <label className="flex items-center gap-2 text-xs font-medium text-amber-400 mb-2">
                                                    <Film className="w-3.5 h-3.5" />
                                                    Director Notes (Câu chuyện, cảm xúc, nhịp điệu)
                                                </label>
                                                <textarea
                                                    value={directorNotes}
                                                    onChange={(e) => setDirectorNotes(e.target.value)}
                                                    placeholder="VD: Thể loại Intellectual Crime - Không dùng action, tập trung căng thẳng ngầm. Nhân vật chính luôn bình tĩnh..."
                                                    className="w-full h-24 bg-zinc-800/50 border border-amber-500/30 rounded-xl p-3 text-sm text-white placeholder-zinc-600 resize-none focus:outline-none focus:border-amber-500/50 focus:ring-2 focus:ring-amber-500/10"
                                                />
                                            </div>

                                            {/* DOP Notes */}
                                            <div>
                                                <label className="flex items-center gap-2 text-xs font-medium text-cyan-400 mb-2">
                                                    <Layers className="w-3.5 h-3.5" />
                                                    DOP Notes (Góc máy, ánh sáng, chuyển cảnh)
                                                </label>
                                                <textarea
                                                    value={dopNotes}
                                                    onChange={(e) => setDopNotes(e.target.value)}
                                                    placeholder="VD: Dùng Low-key lighting, contrast cao. Góc quay thấp làm nhân vật tỏ ra quyền lực. Match-cut cho chuyển cảnh mượt..."
                                                    className="w-full h-24 bg-zinc-800/50 border border-cyan-500/30 rounded-xl p-3 text-sm text-white placeholder-zinc-600 resize-none focus:outline-none focus:border-cyan-500/50 focus:ring-2 focus:ring-cyan-500/10"
                                                />
                                            </div>

                                            {/* Preset buttons - Connected to Supabase */}
                                            <div className="pt-3 border-t border-zinc-700/30 space-y-3">
                                                {/* Save Preset Row */}
                                                {isSavingPreset ? (
                                                    <div className="flex items-center gap-2">
                                                        <input
                                                            type="text"
                                                            value={presetName}
                                                            onChange={(e) => setPresetName(e.target.value)}
                                                            placeholder="Tên preset..."
                                                            className="flex-1 bg-zinc-800 border border-zinc-600 rounded-lg px-3 py-1.5 text-xs text-white placeholder-zinc-500 focus:outline-none focus:border-violet-500"
                                                            autoFocus
                                                        />
                                                        <button
                                                            onClick={async () => {
                                                                if (!presetName.trim()) return alert('Vui lòng nhập tên preset');
                                                                const result = await savePreset(presetName, directorNotes, dopNotes);
                                                                if (result) {
                                                                    setIsSavingPreset(false);
                                                                    setPresetName('');
                                                                    alert('✅ Đã lưu preset!');
                                                                }
                                                            }}
                                                            disabled={presetsLoading}
                                                            className="px-3 py-1.5 text-xs font-medium text-white bg-violet-600 rounded-lg hover:bg-violet-500 transition-colors disabled:opacity-50"
                                                        >
                                                            {presetsLoading ? '...' : 'Lưu'}
                                                        </button>
                                                        <button
                                                            onClick={() => { setIsSavingPreset(false); setPresetName(''); }}
                                                            className="px-2 py-1.5 text-xs text-zinc-400 hover:text-white transition-colors"
                                                        >
                                                            Hủy
                                                        </button>
                                                    </div>
                                                ) : (
                                                    <div className="flex items-center gap-2">
                                                        <button
                                                            onClick={() => setIsSavingPreset(true)}
                                                            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-zinc-400 bg-zinc-800 rounded-lg hover:bg-zinc-700 hover:text-white transition-colors"
                                                        >
                                                            <Save className="w-3.5 h-3.5" />
                                                            Save Preset
                                                        </button>
                                                        <button
                                                            onClick={() => setShowPresetPicker(!showPresetPicker)}
                                                            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-zinc-400 bg-zinc-800 rounded-lg hover:bg-zinc-700 hover:text-white transition-colors"
                                                        >
                                                            <FolderOpen className="w-3.5 h-3.5" />
                                                            Load Preset ({presets.length})
                                                        </button>
                                                    </div>
                                                )}

                                                {/* Preset Picker Dropdown */}
                                                {showPresetPicker && presets.length > 0 && (
                                                    <div className="bg-zinc-800/80 border border-zinc-600 rounded-xl p-2 max-h-40 overflow-y-auto">
                                                        {presets.map((preset) => (
                                                            <div
                                                                key={preset.id}
                                                                className="flex items-center justify-between p-2 hover:bg-zinc-700/50 rounded-lg cursor-pointer group"
                                                            >
                                                                <div
                                                                    onClick={() => {
                                                                        setDirectorNotes(preset.director_notes);
                                                                        setDopNotes(preset.dop_notes);
                                                                        setShowPresetPicker(false);
                                                                    }}
                                                                    className="flex-1"
                                                                >
                                                                    <div className="text-xs font-medium text-white">{preset.name}</div>
                                                                    <div className="text-[10px] text-zinc-500 truncate max-w-[200px]">
                                                                        {preset.director_notes?.substring(0, 50)}...
                                                                    </div>
                                                                </div>
                                                                <button
                                                                    onClick={(e) => {
                                                                        e.stopPropagation();
                                                                        if (confirm('Xóa preset này?')) {
                                                                            deletePreset(preset.id);
                                                                        }
                                                                    }}
                                                                    className="opacity-0 group-hover:opacity-100 p-1 text-red-400 hover:text-red-300 transition-all"
                                                                >
                                                                    <Trash2 className="w-3.5 h-3.5" />
                                                                </button>
                                                            </div>
                                                        ))}
                                                    </div>
                                                )}
                                                {showPresetPicker && presets.length === 0 && (
                                                    <div className="text-xs text-zinc-500 text-center py-2">
                                                        Chưa có preset nào. Hãy tạo preset mới!
                                                    </div>
                                                )}
                                            </div>
                                        </div>
                                    )}
                                </div>

                                {/* Error */}
                                {analysisError && (
                                    <div className="flex items-center gap-3 p-4 mt-4 bg-red-500/10 border border-red-500/30 rounded-xl text-red-400">
                                        <AlertTriangle className="w-5 h-5 flex-shrink-0" />
                                        <span className="text-sm">{analysisError}</span>
                                    </div>
                                )}
                            </div>

                            {/* Right Column - Settings (2/5) - Scrollable */}
                            <div className="lg:col-span-2 overflow-y-auto max-h-[70vh] space-y-4 pr-1 custom-scrollbar" style={{ scrollbarWidth: 'thin', scrollbarColor: '#52525b #27272a' }}>
                                {/* AI Settings Card - Compact */}
                                <div className="bg-zinc-800/30 rounded-2xl p-4 border border-zinc-700/30 backdrop-blur-sm">
                                    <div className="flex items-center gap-2 mb-4">
                                        <span className="text-lg">🤖</span>
                                        <span className="text-sm font-bold text-white uppercase tracking-wider">AI</span>
                                    </div>

                                    <div className="grid grid-cols-2 gap-3">
                                        {/* Model Selector */}
                                        <div>
                                            <label className="block text-xs font-medium text-zinc-400 mb-1.5">Model</label>
                                            <select
                                                value={selectedModel}
                                                onChange={(e) => setSelectedModel(e.target.value)}
                                                className="w-full bg-zinc-900/80 border border-zinc-700 rounded-xl px-4 py-2.5 text-sm text-white focus:outline-none focus:border-violet-500 transition-colors cursor-pointer"
                                            >
                                                {SCRIPT_MODELS.map(m => (
                                                    <option key={m.value} value={m.value}>{m.label}</option>
                                                ))}
                                            </select>
                                        </div>

                                        {/* Reading Speed */}
                                        <div>
                                            <label className="block text-xs font-medium text-zinc-400 mb-1.5">Reading Speed</label>
                                            <div className="grid grid-cols-3 gap-2">
                                                {[
                                                    { value: 'slow', label: 'Slow', desc: '120 WPM', icon: '🐢' },
                                                    { value: 'medium', label: 'Medium', desc: '150 WPM', icon: '⚡' },
                                                    { value: 'fast', label: 'Fast', desc: '180 WPM', icon: '🚀' }
                                                ].map(speed => (
                                                    <button
                                                        key={speed.value}
                                                        onClick={() => setReadingSpeed(speed.value as any)}
                                                        className={`p-2.5 rounded-xl text-center transition-all ${readingSpeed === speed.value
                                                            ? 'bg-violet-500/20 border-2 border-violet-500 text-white'
                                                            : 'bg-zinc-900/50 border border-zinc-700 text-zinc-400 hover:border-zinc-600'
                                                            }`}
                                                    >
                                                        <div className="text-lg mb-0.5">{speed.icon}</div>
                                                        <div className="text-[10px] font-bold">{speed.label}</div>
                                                    </button>
                                                ))}
                                            </div>
                                        </div>
                                    </div>
                                </div>

                                {/* Scene Count Estimate */}
                                <div className="bg-zinc-800/30 rounded-2xl p-4 border border-zinc-700/30 backdrop-blur-sm">
                                    <div className="flex items-center gap-2 mb-3">
                                        <Layers className="w-4 h-4 text-emerald-400" />
                                        <span className="text-sm font-bold text-white uppercase tracking-wider">Estimated Scenes</span>
                                    </div>
                                    <p className="text-xs text-zinc-500 mb-3">Số phân cảnh ước lượng. AI sẽ dùng con số này làm mục tiêu.</p>
                                    <div className="flex items-center gap-3">
                                        <button
                                            onClick={() => setSceneCountEstimate(Math.max(5, (sceneCountEstimate || Math.ceil(scriptText.split(/\s+/).filter(Boolean).length / 10)) - 5))}
                                            className="w-8 h-8 rounded-lg bg-zinc-900/80 border border-zinc-700 hover:border-emerald-500/50 text-white font-bold flex items-center justify-center transition-colors"
                                        >
                                            −
                                        </button>
                                        <div className="flex-1">
                                            <input
                                                type="number"
                                                min={5}
                                                max={500}
                                                value={sceneCountEstimate || Math.ceil(scriptText.split(/\s+/).filter(Boolean).length / 10)}
                                                onChange={(e) => setSceneCountEstimate(Math.max(5, Math.min(500, parseInt(e.target.value) || 10)))}
                                                className="w-full bg-zinc-900/80 border border-zinc-700 rounded-xl px-4 py-2.5 text-center text-lg font-bold text-emerald-400 focus:outline-none focus:border-emerald-500 transition-colors"
                                            />
                                        </div>
                                        <button
                                            onClick={() => setSceneCountEstimate(Math.min(500, (sceneCountEstimate || Math.ceil(scriptText.split(/\s+/).filter(Boolean).length / 10)) + 5))}
                                            className="w-8 h-8 rounded-lg bg-zinc-900/80 border border-zinc-700 hover:border-emerald-500/50 text-white font-bold flex items-center justify-center transition-colors"
                                        >
                                            +
                                        </button>
                                    </div>
                                    <div className="mt-2 text-xs text-zinc-500 text-center">
                                        ~{Math.ceil(scriptText.split(/\s+/).filter(Boolean).length / (sceneCountEstimate || Math.ceil(scriptText.split(/\s+/).filter(Boolean).length / 10)))} words/scene
                                    </div>
                                </div>

                                {/* Video Zone / Static Zone Config */}
                                <div className={`rounded-2xl p-4 border backdrop-blur-sm transition-all ${videoZoneEnabled ? 'bg-gradient-to-br from-blue-900/20 to-purple-900/20 border-blue-500/40' : 'bg-zinc-800/30 border-zinc-700/30'}`}>
                                    <div className="flex items-center justify-between mb-3">
                                        <div className="flex items-center gap-2">
                                            <Film className={`w-4 h-4 ${videoZoneEnabled ? 'text-blue-400' : 'text-zinc-500'}`} />
                                            <span className="text-sm font-bold text-white uppercase tracking-wider">Video Zone</span>
                                        </div>
                                        <button
                                            onClick={() => setVideoZoneEnabled(!videoZoneEnabled)}
                                            className={`relative w-10 h-5 rounded-full transition-all ${videoZoneEnabled ? 'bg-blue-500' : 'bg-zinc-600'}`}
                                        >
                                            <div className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-all ${videoZoneEnabled ? 'left-5.5' : 'left-0.5'}`}
                                                style={{ left: videoZoneEnabled ? '22px' : '2px' }} />
                                        </button>
                                    </div>
                                    <p className="text-xs text-zinc-500 mb-3">
                                        Chia nhỏ đầu script cho video AI (8s/scene), phần còn lại cho ảnh tĩnh.
                                    </p>

                                    {videoZoneEnabled && (
                                        <div className="space-y-3 animate-fadeIn">
                                            {/* Video Scenes */}
                                            <div className="bg-blue-500/10 rounded-xl p-3 border border-blue-500/20">
                                                <div className="flex items-center gap-2 mb-2">
                                                    <span className="text-[10px] font-bold text-blue-300 uppercase tracking-wider">🎥 Video Scenes (8s/cảnh)</span>
                                                </div>
                                                <div className="flex items-center gap-2">
                                                    <button
                                                        onClick={() => setVideoZoneScenes(Math.max(5, videoZoneScenes - 5))}
                                                        className="w-7 h-7 rounded-lg bg-zinc-900/80 border border-blue-500/30 hover:border-blue-400 text-white font-bold flex items-center justify-center text-sm transition-colors"
                                                    >−</button>
                                                    <input
                                                        type="number" min={5} max={100}
                                                        value={videoZoneScenes}
                                                        onChange={(e) => setVideoZoneScenes(Math.max(5, Math.min(100, parseInt(e.target.value) || 30)))}
                                                        className="flex-1 bg-zinc-900/80 border border-blue-500/30 rounded-lg px-3 py-1.5 text-center text-sm font-bold text-blue-400 focus:outline-none focus:border-blue-400 transition-colors"
                                                    />
                                                    <button
                                                        onClick={() => setVideoZoneScenes(Math.min(100, videoZoneScenes + 5))}
                                                        className="w-7 h-7 rounded-lg bg-zinc-900/80 border border-blue-500/30 hover:border-blue-400 text-white font-bold flex items-center justify-center text-sm transition-colors"
                                                    >+</button>
                                                </div>
                                                <div className="mt-1 text-[10px] text-blue-400/60 text-center">
                                                    ≈ {Math.round(videoZoneScenes * 8 / 60)} phút video ({videoZoneScenes} × 8s)
                                                </div>
                                            </div>

                                            {/* Static Scenes */}
                                            <div className="bg-purple-500/10 rounded-xl p-3 border border-purple-500/20">
                                                <div className="flex items-center gap-2 mb-2">
                                                    <span className="text-[10px] font-bold text-purple-300 uppercase tracking-wider">🖼️ Static Scenes (ảnh tĩnh)</span>
                                                </div>
                                                <div className="flex items-center gap-2">
                                                    <button
                                                        onClick={() => setStaticZoneScenes(Math.max(5, staticZoneScenes - 5))}
                                                        className="w-7 h-7 rounded-lg bg-zinc-900/80 border border-purple-500/30 hover:border-purple-400 text-white font-bold flex items-center justify-center text-sm transition-colors"
                                                    >−</button>
                                                    <input
                                                        type="number" min={5} max={200}
                                                        value={staticZoneScenes}
                                                        onChange={(e) => setStaticZoneScenes(Math.max(5, Math.min(200, parseInt(e.target.value) || 35)))}
                                                        className="flex-1 bg-zinc-900/80 border border-purple-500/30 rounded-lg px-3 py-1.5 text-center text-sm font-bold text-purple-400 focus:outline-none focus:border-purple-400 transition-colors"
                                                    />
                                                    <button
                                                        onClick={() => setStaticZoneScenes(Math.min(200, staticZoneScenes + 5))}
                                                        className="w-7 h-7 rounded-lg bg-zinc-900/80 border border-purple-500/30 hover:border-purple-400 text-white font-bold flex items-center justify-center text-sm transition-colors"
                                                    >+</button>
                                                </div>
                                                <div className="mt-1 text-[10px] text-purple-400/60 text-center">
                                                    ~{Math.ceil((scriptText.split(/\s+/).filter(Boolean).length - videoZoneScenes * 20) / Math.max(1, staticZoneScenes))} words/scene
                                                </div>
                                            </div>

                                            {/* Summary */}
                                            <div className="bg-zinc-900/50 rounded-lg p-2 text-center">
                                                <span className="text-xs text-zinc-400">
                                                    Tổng: <span className="text-blue-400 font-bold">{videoZoneScenes}</span> video + <span className="text-purple-400 font-bold">{staticZoneScenes}</span> static = <span className="text-emerald-400 font-bold">{videoZoneScenes + staticZoneScenes}</span> scenes
                                                </span>
                                            </div>
                                        </div>
                                    )}
                                </div>

                                {/* Character Style Card - Compact */}
                                <div className="bg-zinc-800/30 rounded-2xl p-4 border border-zinc-700/30 backdrop-blur-sm">
                                    <div className="flex items-center justify-between mb-3">
                                        <div className="flex items-center gap-2">
                                            <Palette className="w-4 h-4 text-fuchsia-400" />
                                            <span className="text-sm font-bold text-white uppercase tracking-wider">Style</span>
                                        </div>
                                        <button
                                            onClick={() => setShowStylePicker(!showStylePicker)}
                                            className="text-[10px] text-violet-400 hover:text-violet-300 transition-colors"
                                        >
                                            {showStylePicker ? 'Less' : 'More →'}
                                        </button>
                                    </div>

                                    <div className="grid grid-cols-2 gap-2 max-h-60 overflow-y-auto pr-1 custom-scrollbar" style={{ scrollbarWidth: 'thin', scrollbarColor: '#52525b #27272a' }}>
                                        {(showStylePicker ? BUILT_IN_CHARACTER_STYLES : BUILT_IN_CHARACTER_STYLES.slice(0, 4)).map(style => (
                                            <button
                                                key={style.id}
                                                onClick={() => setSelectedStyleId(style.id)}
                                                className={`p-2.5 rounded-xl text-left transition-all ${selectedStyleId === style.id
                                                    ? 'bg-gradient-to-br from-violet-500/20 to-fuchsia-500/20 border-2 border-violet-500/50'
                                                    : 'bg-zinc-900/50 border border-zinc-700 hover:border-zinc-600'
                                                    }`}
                                            >
                                                <div className="flex items-center gap-2">
                                                    <span className="text-lg">{style.icon}</span>
                                                    <span className="text-[10px] font-semibold text-white truncate">{style.name}</span>
                                                </div>
                                            </button>
                                        ))}
                                    </div>
                                </div>

                                {/* Director Card - Compact */}
                                <div className="bg-zinc-800/30 rounded-2xl p-4 border border-zinc-700/30 backdrop-blur-sm relative">
                                    <div className="flex items-center justify-between mb-3">
                                        <div className="flex items-center gap-2">
                                            <Film className="w-4 h-4 text-amber-400" />
                                            <span className="text-sm font-bold text-white uppercase tracking-wider">Director</span>
                                        </div>
                                    </div>

                                    {/* Selected Director Preview */}
                                    {selectedDirector && (
                                        <div className="bg-gradient-to-br from-amber-500/10 to-orange-500/10 border border-amber-500/20 rounded-xl p-4 mb-3 relative">
                                            <div className="flex items-center justify-between mb-2">
                                                <span className="text-sm font-bold text-amber-200">{selectedDirector.name}</span>
                                                <div className="flex items-center gap-2">
                                                    {customDirector && (
                                                        <span className="text-[8px] px-1.5 py-0.5 bg-yellow-500/20 text-yellow-400 rounded font-bold uppercase">AI Analyzed</span>
                                                    )}
                                                    <span className="text-[9px] bg-amber-500/20 text-amber-400 px-2 py-0.5 rounded-full font-medium uppercase">
                                                        {selectedDirector.origin}
                                                    </span>
                                                </div>
                                            </div>
                                            <p className="text-[11px] text-zinc-400 mb-2 line-clamp-2">{selectedDirector.description}</p>
                                            {selectedDirector.signatureCameraStyle && (
                                                <div className="text-[10px] text-amber-400/80">🎬 {selectedDirector.signatureCameraStyle}</div>
                                            )}
                                            {customDirector && (
                                                <button
                                                    onClick={() => { setCustomDirector(null); setSelectedDirectorId('werner_herzog'); }}
                                                    className="absolute top-2 right-2 p-1 text-zinc-500 hover:text-red-400 transition-colors"
                                                    title="Xóa đạo diễn tùy chỉnh"
                                                >
                                                    <X className="w-3.5 h-3.5" />
                                                </button>
                                            )}
                                        </div>
                                    )}

                                    <button
                                        onClick={() => setShowDirectorPicker(!showDirectorPicker)}
                                        className="w-full bg-zinc-900/50 border border-zinc-700 hover:border-zinc-600 rounded-xl px-4 py-3 text-left flex items-center justify-between transition-all group"
                                    >
                                        <span className="text-sm text-zinc-300 group-hover:text-white transition-colors">
                                            {selectedDirector ? 'Change Director' : 'Select a Director'}
                                        </span>
                                        <ChevronDown className={`w-4 h-4 text-zinc-500 transition-transform ${showDirectorPicker ? 'rotate-180' : ''}`} />
                                    </button>

                                    {/* Director Picker Overlay */}
                                    {showDirectorPicker && (
                                        <div className="absolute inset-0 bg-zinc-900/95 backdrop-blur-lg rounded-2xl z-50 overflow-hidden flex flex-col animate-fade-in">
                                            <div className="flex items-center justify-between p-4 border-b border-zinc-700/50">
                                                <span className="text-sm font-bold text-white">Select Director</span>
                                                <button
                                                    onClick={() => setShowDirectorPicker(false)}
                                                    className="text-zinc-400 hover:text-white transition-colors"
                                                >
                                                    <X className="w-4 h-4" />
                                                </button>
                                            </div>

                                            {/* Custom Director Search (NEW) */}
                                            <div className="px-4 pt-4 pb-2 border-b border-zinc-700/30">
                                                <label className="text-[10px] font-bold text-amber-400 uppercase tracking-wider mb-2 block">
                                                    🔍 Tìm đạo diễn bất kỳ (AI Search)
                                                </label>
                                                <div className="relative">
                                                    <input
                                                        type="text"
                                                        value={customDirectorName}
                                                        onChange={(e) => setCustomDirectorName(e.target.value)}
                                                        onKeyDown={(e) => e.key === 'Enter' && handleSearchCustomDirector()}
                                                        placeholder="VD: Bong Joon-ho, Denis Villeneuve..."
                                                        className="w-full bg-zinc-800/80 border border-zinc-600 rounded-xl py-2.5 pl-4 pr-12 text-sm text-white placeholder-zinc-500 focus:outline-none focus:border-amber-500/50 transition-colors"
                                                    />
                                                    <button
                                                        onClick={handleSearchCustomDirector}
                                                        disabled={isSearchingDirector || !customDirectorName.trim()}
                                                        className="absolute right-2 top-1/2 -translate-y-1/2 px-2 py-1 bg-amber-500/20 hover:bg-amber-500/30 text-amber-400 rounded-lg transition-colors disabled:opacity-50"
                                                    >
                                                        {isSearchingDirector ? (
                                                            <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" /><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" /></svg>
                                                        ) : (
                                                            <span className="text-xs font-bold">Tìm</span>
                                                        )}
                                                    </button>
                                                </div>
                                                <p className="text-[9px] text-zinc-500 mt-1.5">
                                                    AI sẽ phân tích phong cách và kỹ thuật của đạo diễn bạn nhập.
                                                </p>
                                            </div>

                                            {/* Custom Director Display (if selected) */}
                                            {customDirector && (
                                                <div className="mx-4 mt-3 p-3 bg-amber-500/10 border border-amber-500/30 rounded-xl">
                                                    <div className="flex items-center justify-between mb-1">
                                                        <span className="text-sm font-bold text-amber-300">{customDirector.name}</span>
                                                        <span className="text-[8px] px-1.5 py-0.5 bg-yellow-500/20 text-yellow-400 rounded font-bold uppercase">AI Analyzed</span>
                                                    </div>
                                                    <p className="text-[10px] text-zinc-400 mb-1">{customDirector.description}</p>
                                                    <div className="flex flex-wrap gap-1">
                                                        {customDirector.dna.split(',').slice(0, 4).map((tag, i) => (
                                                            <span key={i} className="text-[8px] px-1.5 py-0.5 bg-zinc-800 text-amber-400/70 rounded-md">{tag.trim()}</span>
                                                        ))}
                                                    </div>
                                                </div>
                                            )}

                                            <div className="flex-1 overflow-y-auto p-4 space-y-4 custom-scrollbar" style={{ scrollbarWidth: 'thin', scrollbarColor: '#52525b #27272a' }}>
                                                {(['documentary', 'cinema', 'tvc', 'music_video'] as DirectorCategory[]).map(category => (
                                                    <div key={category}>
                                                        <div className="text-[10px] font-bold text-zinc-500 uppercase tracking-wider mb-2 sticky top-0 bg-zinc-900 py-1">
                                                            {category.replace('_', ' ')}
                                                        </div>
                                                        <div className="space-y-1.5">
                                                            {DIRECTOR_PRESETS[category].map(dir => (
                                                                <button
                                                                    key={dir.id}
                                                                    onClick={() => { setSelectedDirectorId(dir.id); setCustomDirector(null); setShowDirectorPicker(false); }}
                                                                    className={`w-full p-3 rounded-xl text-left transition-all ${selectedDirectorId === dir.id && !customDirector
                                                                        ? 'bg-amber-500/20 border border-amber-500/50'
                                                                        : 'hover:bg-zinc-800 border border-transparent'
                                                                        }`}
                                                                >
                                                                    <div className="flex items-center justify-between">
                                                                        <span className="text-sm font-medium text-white">{dir.name}</span>
                                                                        <span className="text-[9px] text-amber-400/70">{dir.origin}</span>
                                                                    </div>
                                                                    <p className="text-[10px] text-zinc-500 mt-0.5 line-clamp-1">{dir.description}</p>
                                                                </button>
                                                            ))}
                                                        </div>
                                                    </div>
                                                ))}
                                            </div>
                                        </div>
                                    )}
                                </div>
                            </div>
                        </div>
                    ) : (
                        // Step 2: Review Analysis
                        <>
                            {/* Summary Stats */}
                            <div className="grid grid-cols-4 gap-4">
                                <div className="bg-zinc-800/50 rounded-xl p-4">
                                    <div className="text-2xl font-bold text-white">{analysisResult.totalWords}</div>
                                    <div className="text-sm text-zinc-400">Words</div>
                                </div>
                                <div className="bg-zinc-800/50 rounded-xl p-4">
                                    <div className="text-2xl font-bold text-white">{Math.ceil(analysisResult.estimatedDuration / 60)}m</div>
                                    <div className="text-sm text-zinc-400">Duration</div>
                                </div>
                                <div className="bg-zinc-800/50 rounded-xl p-4">
                                    <div className="text-2xl font-bold text-violet-400">{analysisResult.chapters.length}</div>
                                    <div className="text-sm text-zinc-400">Chapters</div>
                                </div>
                                <div className="bg-zinc-800/50 rounded-xl p-4">
                                    <div className="flex items-center justify-between">
                                        <div>
                                            <div className="text-2xl font-bold text-emerald-400">{analysisResult.suggestedSceneCount}</div>
                                            <div className="text-sm text-zinc-400">Scenes</div>
                                        </div>
                                    </div>
                                </div>
                            </div>

                            {/* Chapters */}
                            <div>
                                <h3 className="flex items-center gap-2 text-lg font-medium text-white mb-3">
                                    <Layers className="w-5 h-5 text-violet-400" /> Chapters Detected
                                </h3>
                                <div className="grid grid-cols-2 gap-2">
                                    {analysisResult.chapters.map((ch, i) => (
                                        <div key={ch.id} className="bg-zinc-800/50 border border-zinc-700 rounded-lg p-3">
                                            <div className="text-sm font-medium text-white">{ch.title}</div>
                                            <div className="text-xs text-zinc-500">{ch.suggestedTimeOfDay} • {ch.suggestedWeather}</div>
                                        </div>
                                    ))}
                                </div>
                            </div>

                            {/* Characters */}
                            <div>
                                <h3 className="flex items-center gap-2 text-lg font-medium text-white mb-3">
                                    <Users className="w-5 h-5 text-emerald-400" /> Characters Found
                                </h3>
                                <div className="grid grid-cols-2 gap-2">
                                    {analysisResult.characters.map((char, i) => {
                                        const exists = existingCharacters.some(c => c.name.toLowerCase() === char.name.toLowerCase());
                                        return (
                                            <div key={i} className={`border rounded-lg p-3 ${exists ? 'bg-emerald-500/10 border-emerald-500/30' : 'bg-amber-500/10 border-amber-500/30'}`}>
                                                <div className="flex items-center justify-between">
                                                    <span className="text-sm font-medium text-white">{char.name}</span>
                                                    {exists ? (
                                                        <span className="text-xs text-emerald-400 flex items-center gap-1"><Check className="w-3 h-3" /> Exists</span>
                                                    ) : (
                                                        <span className="text-xs text-amber-400">New</span>
                                                    )}
                                                </div>
                                                <div className="text-xs text-zinc-400 mt-1">{char.suggestedDescription}</div>
                                            </div>
                                        );
                                    })}
                                </div>
                            </div>

                            {/* Locations Detected (NEW) */}
                            {analysisResult.locations && analysisResult.locations.length > 0 && (
                                <div>
                                    <h3 className="flex items-center gap-2 text-lg font-medium text-white mb-3">
                                        <MapPin className="w-5 h-5 text-amber-400" /> Locations Detected ({analysisResult.locations.length})
                                    </h3>
                                    <div className="grid grid-cols-2 gap-2">
                                        {analysisResult.locations.map((loc: any, i: number) => (
                                            <div key={loc.id || i} className="bg-amber-500/10 border border-amber-500/30 rounded-lg p-3">
                                                <div className="flex items-center justify-between">
                                                    <span className="text-sm font-medium text-white flex items-center gap-1.5">
                                                        {loc.isInterior ? '🏠' : '🌳'} {loc.name}
                                                    </span>
                                                    <span className="text-xs text-amber-400/70">
                                                        {loc.chapterIds?.length || 0} chapters
                                                    </span>
                                                </div>
                                                <div className="text-xs text-zinc-400 mt-1 line-clamp-2">{loc.description}</div>
                                                <div className="flex flex-wrap gap-1 mt-2">
                                                    {loc.keywords?.slice(0, 3).map((kw: string, j: number) => (
                                                        <span key={j} className="text-[9px] px-1.5 py-0.5 bg-amber-500/20 text-amber-400 rounded">
                                                            {kw}
                                                        </span>
                                                    ))}
                                                </div>
                                            </div>
                                        ))}
                                    </div>
                                    <p className="text-[10px] text-zinc-500 mt-2">
                                        💡 After import, you can generate concept art for these locations in the Location Library
                                    </p>
                                </div>
                            )}

                            {/* Selected Style Preview */}
                            <div className="flex gap-4 p-4 bg-zinc-800/30 rounded-xl">
                                <div className="flex-1">
                                    <div className="text-sm text-zinc-400 mb-1">Character Style</div>
                                    <div className="flex items-center gap-2">
                                        <span className="text-xl">{selectedStyle?.icon}</span>
                                        <span className="text-white font-medium">{selectedStyle?.name}</span>
                                    </div>
                                </div>
                                <div className="flex-1">
                                    <div className="text-sm text-zinc-400 mb-1">Director</div>
                                    <div className="text-white font-medium">{selectedDirector?.name}</div>
                                </div>
                            </div>
                        </>
                    )}
                </div>

                {/* Footer */}
                <div className="flex items-center justify-between p-6 border-t border-zinc-800 bg-zinc-900/50">
                    {!analysisResult ? (
                        <>
                            <button
                                onClick={onClose}
                                className="px-4 py-2 text-zinc-400 hover:text-white transition-colors"
                            >
                                Cancel
                            </button>
                            <button
                                onClick={handleAnalyze}
                                disabled={!scriptText.trim() || isAnalyzing}
                                className="px-6 py-2.5 bg-gradient-to-r from-violet-500 to-fuchsia-500 text-white rounded-xl font-medium disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
                            >
                                {isAnalyzing ? (
                                    <>
                                        <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                                        Analyzing...
                                    </>
                                ) : (
                                    <>
                                        <Play className="w-4 h-4" />
                                        Analyze Script
                                    </>
                                )}
                            </button>
                        </>
                    ) : (
                        <>
                            <button
                                onClick={handleBackToEdit}
                                className="px-4 py-2 text-zinc-400 hover:text-white transition-colors"
                            >
                                ← Back to Edit
                            </button>
                            <button
                                onClick={handleImport}
                                className="px-6 py-2.5 bg-gradient-to-r from-emerald-500 to-teal-500 text-white rounded-xl font-medium flex items-center gap-2"
                            >
                                <Check className="w-4 h-4" />
                                Generate {analysisResult.suggestedSceneCount} Scenes
                            </button>
                        </>
                    )}
                </div>
            </div>
        </div >
    );
};

export default ManualScriptModal;
