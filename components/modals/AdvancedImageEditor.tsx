import React, { useState, useRef, useEffect } from 'react';
import { Type, GoogleGenAI } from "@google/genai";
import { X, Undo, Redo, Eraser, Brush, Download, Wand2, Image as ImageIcon, History, ArrowUp, ArrowDown, ArrowLeft, ArrowRight, Scan, Maximize, Layers, Palette, Search, Upload, LayoutGrid, List, Shirt, ChevronDown, RectangleHorizontal, Sparkles } from 'lucide-react';
import MaskCanvas, { MaskCanvasHandle } from '../MaskCanvas';
import { upscaleImage, expandImage, editImageWithMask, analyzeImage, compositeImages, applyStyleTransfer, generateImageFromImage, tryOnOutfit, GeneratedImage } from '../../utils/geminiImageEdit';
import { IMAGE_MODELS, ASPECT_RATIOS } from '../../constants/presets';
import { fixMimeType } from '../../utils/geminiUtils';
import { resolveImage, isIdbKey } from '../../utils/imageCache';

import { Character, Product } from '../../types';

// Filter models that support editing
const EDIT_MODELS = IMAGE_MODELS.filter(m => m.supportsEdit);

// Simple aspect ratios for the editor
const EDITOR_RATIOS = [
    { value: '16:9', label: '16:9' },
    { value: '9:16', label: '9:16' },
    { value: '1:1', label: '1:1' },
    { value: '4:3', label: '4:3' },
    { value: '3:4', label: '3:4' },
];

interface AdvancedImageEditorProps {
    isOpen: boolean;
    onClose: () => void;
    sourceImage?: string; // Optional: empty = Create Mode
    onSave: (editedImage: string, history: { id: string, image: string, prompt: string }[], viewKey?: string) => void;
    apiKey: string;
    initialHistory?: { id: string; image: string; prompt: string }[];
    character?: Character;
    product?: Product;
    activeView?: string;
    createMode?: boolean; // Open in create mode (no source image)
}

const generateId = () => `id_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

export const AdvancedImageEditor: React.FC<AdvancedImageEditorProps> = ({
    isOpen,
    onClose,
    sourceImage,
    onSave,
    apiKey,
    initialHistory,
    character,
    product,
    activeView: initialActiveView,
    createMode = false
}) => {
    // Canvas State
    const canvasRef = useRef<MaskCanvasHandle>(null);
    const [brushSize, setBrushSize] = useState(20);
    const [isEraser, setIsEraser] = useState(false);
    const [prompt, setPrompt] = useState('');
    const [isGenerating, setIsGenerating] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [loadingMessage, setLoadingMessage] = useState<string>('');
    const [promptHistory, setPromptHistory] = useState<string[]>(['']);
    const [promptIndex, setPromptIndex] = useState(0);
    const isHistoryChange = useRef(false);
    const [isDrawMode, setIsDrawMode] = useState(false); // Default OFF - user must enable

    // Try On State
    const [tryOnImage, setTryOnImage] = useState<string | null>(null);
    const [corkboardImage, setCorkboardImage] = useState<string | null>(null);
    const [isTryOnLoading, setIsTryOnLoading] = useState(false);

    // Image State
    const [currentImage, setCurrentImage] = useState(sourceImage || '');
    const [history, setHistory] = useState<{ id: string, image: string, prompt: string, resolution?: '1k' | '2k' | '4k' }[]>(
        initialHistory && initialHistory.length > 0
            ? initialHistory.map(h => ({ ...h, resolution: h.resolution || '1k' }))
            : sourceImage
                ? [{ id: generateId(), image: sourceImage, prompt: 'Original', resolution: '1k' }]
                : [] // Empty for createMode
    );
    const [historyLayout, setHistoryLayout] = useState<'list' | 'grid'>('list');
    const [isCreateMode, setIsCreateMode] = useState(createMode || !sourceImage);

    // Advanced Features State
    const [analysisTags, setAnalysisTags] = useState<string[] | null>(null);
    const [referenceImages, setReferenceImages] = useState<string[]>([]); // Multi-image references (up to 10)
    const MAX_REFERENCE_IMAGES = 10; // Gemini's limit for inline images
    const [styleRefImage, setStyleRefImage] = useState<string | null>(null);
    const [upscaleLevel, setUpscaleLevel] = useState<'1k' | '2k' | '4k'>('2k');
    const referenceInputRef = useRef<HTMLInputElement>(null);
    const styleInputRef = useRef<HTMLInputElement>(null);
    const dropzoneInputRef = useRef<HTMLInputElement>(null);
    const [activeTab, setActiveTab] = useState<'tools' | 'layers' | 'analysis' | 'try-on'>('tools');
    const [imageAspectRatio, setImageAspectRatio] = useState("1:1");
    const [currentView, setCurrentView] = useState<string | undefined>(initialActiveView);
    const [currentResolution, setCurrentResolution] = useState<'1k' | '2k' | '4k'>('1k');
    const [editModel, setEditModel] = useState(EDIT_MODELS[0]?.value || 'gemini-3-pro-image-preview');
    const [showModelDropdown, setShowModelDropdown] = useState(false);

    // Dimensions for the canvas
    const [dimensions, setDimensions] = useState({ width: 800, height: 600 });
    const containerRef = useRef<HTMLDivElement>(null);

    // Helper: Convert URL to base64 (handles Supabase URLs from saved projects)
    const ensureBase64Image = async (imageStr: string): Promise<string> => {
        if (imageStr.startsWith('data:')) return imageStr;

        if (isIdbKey(imageStr)) {
            const resolved = await resolveImage(imageStr);
            if (resolved) return resolved;
            throw new Error(`Failed to resolve IndexedDB image: ${imageStr}`);
        }

        try {
            // Direct fetch (Supabase has proper CORS headers)
            const response = await fetch(imageStr);
            if (!response.ok) throw new Error('Fetch failed');
            const blob = await response.blob();
            return new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onloadend = () => resolve(reader.result as string);
                reader.onerror = reject;
                reader.readAsDataURL(blob);
            });
        } catch (err) {
            console.error('[Editor] Failed to convert URL to base64:', err);
            // Fallback: try proxy if available
            try {
                const proxyResponse = await fetch(`http://localhost:3001/api/proxy/fetch-image?url=${encodeURIComponent(imageStr)}`);
                if (!proxyResponse.ok) throw new Error('Proxy fetch failed');
                const blob = await proxyResponse.blob();
                return new Promise((resolve, reject) => {
                    const reader = new FileReader();
                    reader.onloadend = () => resolve(reader.result as string);
                    reader.onerror = reject;
                    reader.readAsDataURL(blob);
                });
            } catch (proxyErr) {
                console.error('[Editor] Proxy fallback also failed:', proxyErr);
                throw new Error('Could not load image from URL');
            }
        }
    };

    // Initial Load & CORS Handling
    useEffect(() => {
        if (isOpen && sourceImage) {
            // Always convert to base64 to ensure processing functions work correctly
            const loadImage = async () => {
                try {
                    const base64Image = await ensureBase64Image(sourceImage);
                    setCurrentImage(base64Image);

                    if (initialHistory && initialHistory.length > 0) {
                        // Also convert history images if they are URLs
                        const convertedHistory = await Promise.all(
                            initialHistory.map(async (h) => ({
                                ...h,
                                image: await ensureBase64Image(h.image),
                                resolution: h.resolution || '1k'
                            }))
                        );
                        setHistory(convertedHistory);
                    } else {
                        setHistory([{ id: 'original', image: base64Image, prompt: 'Original', resolution: '1k' }]);
                    }
                } catch (err) {
                    console.error('[Editor] Failed to load image:', err);
                    setError('Không thể tải ảnh. Vui lòng thử lại.');
                }
            };

            loadImage();
            // FULL STATE RESET on open - prevents "second open" display bugs
            setIsCreateMode(false);
            setCurrentResolution('1k');
            setAnalysisTags(null);
            setReferenceImages([]);
            setStyleRefImage(null);
            setPrompt('');
            setPromptHistory(['']);
            setPromptIndex(0);
            setActiveTab('tools');
            setHistoryLayout('list');
            setShowModelDropdown(false);
            setError(null);
            setLoadingMessage('');
            setIsGenerating(false);
            setBrushSize(20);
            setIsEraser(false);
            setIsDrawMode(false);
            setTryOnImage(null);
            setCorkboardImage(null);
            setIsTryOnLoading(false);
            setUpscaleLevel('2k');
            setImageAspectRatio('1:1');
            setCurrentView(initialActiveView);
            setEditModel(EDIT_MODELS[0]?.value || 'gemini-3-pro-image-preview');
            // Reset dimensions to force recalculation
            setDimensions({ width: 800, height: 600 });
        }
    }, [isOpen, sourceImage, initialActiveView]);

    // Initial Load & Resize Handler
    useEffect(() => {
        if (isOpen && containerRef.current) {
            const updateDimensions = () => {
                const { clientWidth, clientHeight } = containerRef.current!;
                const img = new Image();
                img.src = currentImage;
                img.onload = () => {
                    const aspect = img.width / img.height;
                    let newWidth = clientWidth;
                    let newHeight = clientWidth / aspect;

                    if (newHeight > clientHeight) {
                        newHeight = clientHeight;
                        newWidth = clientHeight * aspect;
                    }

                    setDimensions({ width: newWidth, height: newHeight });
                };
            };

            updateDimensions();

            // Determine Gemini aspect ratio
            const img = new Image();
            img.src = currentImage;
            img.onload = () => {
                const ratio = img.width / img.height;
                if (ratio > 1.4) setImageAspectRatio("16:9");
                else if (ratio < 0.7) setImageAspectRatio("9:16");
                else if (ratio > 1.1) setImageAspectRatio("4:3");
                else if (ratio < 0.9) setImageAspectRatio("3:4");
                else setImageAspectRatio("1:1");
            };

            window.addEventListener('resize', updateDimensions);
            return () => window.removeEventListener('resize', updateDimensions);
        }
    }, [isOpen, currentImage]);

    // Use a ref to keep track of history length for the popstate handler
    // to avoid re-running the effect on every history change.
    const historyRef = useRef(history);
    useEffect(() => {
        historyRef.current = history;
    }, [history]);

    // Prevention of accidental navigation (Warning on Back/Refresh/Swipe)
    useEffect(() => {
        if (!isOpen) return;

        const trapId = `editor_trap_${Date.now()}`;
        const initialUrl = window.location.href;

        const handleBeforeUnload = (e: BeforeUnloadEvent) => {
            if (historyRef.current.length > 1) {
                e.preventDefault();
                e.returnValue = '';
                return '';
            }
        };

        // Soft navigation (Back button, Swipe)
        // Push a dummy state so "Back" intercepts here first
        window.history.pushState({ trapId }, '', initialUrl);

        const handlePopState = (e: PopStateEvent) => {
            // Check if our trap was popped
            if (e.state?.trapId !== trapId) {
                if (historyRef.current.length > 1) {
                    if (window.confirm("You have unsaved changes in CyberMask Studio. Discard changes and exit?")) {
                        onClose();
                    } else {
                        // Restore the trap: user clicked "Back", so we are now one step "behind" the trap.
                        // We go forward to return to the trap state.
                        window.history.forward();
                    }
                } else {
                    onClose();
                }
            }
        };

        window.addEventListener('beforeunload', handleBeforeUnload);
        window.addEventListener('popstate', handlePopState);

        return () => {
            window.removeEventListener('beforeunload', handleBeforeUnload);
            window.removeEventListener('popstate', handlePopState);

            // Clean up the trap state: if we are currently on the trap state, go back once.
            if (window.history.state?.trapId === trapId) {
                window.history.back();
            }
        };
    }, [isOpen, onClose]);

    const addToHistory = (newImage: string, actionPrompt: string, resolution?: '1k' | '2k' | '4k') => {
        setHistory(prev => [...prev, {
            id: generateId(),
            image: newImage,
            prompt: actionPrompt,
            resolution: resolution || currentResolution
        }]);
    }

    // Prompt History Management
    useEffect(() => {
        if (isHistoryChange.current) {
            isHistoryChange.current = false;
            return;
        }

        const timer = setTimeout(() => {
            if (prompt !== promptHistory[promptIndex]) {
                const newHistory = promptHistory.slice(0, promptIndex + 1);
                newHistory.push(prompt);
                setPromptHistory(newHistory);
                setPromptIndex(newHistory.length - 1);
            }
        }, 1000); // 1s debounce to prevent cluttering

        return () => clearTimeout(timer);
    }, [prompt, promptIndex, promptHistory]);

    const handlePromptUndo = () => {
        if (promptIndex > 0) {
            isHistoryChange.current = true;
            const newIndex = promptIndex - 1;
            setPromptIndex(newIndex);
            setPrompt(promptHistory[newIndex]);
        }
    };

    const handlePromptRedo = () => {
        if (promptIndex < promptHistory.length - 1) {
            isHistoryChange.current = true;
            const newIndex = promptIndex + 1;
            setPromptIndex(newIndex);
            setPrompt(promptHistory[newIndex]);
        }
    };

    const handleGenerateCorkboard = async () => {
        if (!tryOnImage) return;
        setIsTryOnLoading(true);
        setLoadingMessage('Generating outfit corkboard...');
        setError(null);
        try {
            const [header, data] = tryOnImage.split(',');
            const mimeType = header.match(/:(.*?);/)?.[1] || 'image/png';

            const promptStr = "Create a fashion product collage on a brown corkboard based on this outfit. Separate items like jacket, shirt, pants, shoes, and accessories clearly with labels like in a studio product shoot.";
            // Use the new reference-to-image utility
            const result = await generateImageFromImage(apiKey, data, mimeType, promptStr, imageAspectRatio, currentResolution, editModel);

            setCorkboardImage(`data:${result.mimeType};base64,${result.base64}`);
        } catch (err: any) {
            console.error("Corkboard generation failed", err);
            setError(`Corkboard extraction failed: ${err.message || String(err)}`);
        } finally {
            setIsTryOnLoading(false);
            setLoadingMessage('');
        }
    };

    const handleFinalTryOn = async () => {
        if (!corkboardImage) return;
        setIsGenerating(true);
        setLoadingMessage('Applying outfit to character...');
        setError(null);
        try {
            const hasMask = canvasRef.current?.hasDrawing() || false;
            let canvasMask = null;
            if (hasMask) {
                canvasMask = await canvasRef.current?.getMaskDataURL();
            }

            const tryOnResult = await tryOnOutfit(
                apiKey,
                currentImage,
                corkboardImage,
                canvasMask,
                imageAspectRatio,
                currentResolution,
                editModel
            );

            const newUrl = `data:${tryOnResult.mimeType};base64,${tryOnResult.base64}`;
            setCurrentImage(newUrl);
            addToHistory(newUrl, `Try On Application (${hasMask ? 'Masked' : 'Auto'})`);
        } catch (err: any) {
            console.error("Try On failed", err);
            setError(`Try On application failed: ${err.message || String(err)}`);
        } finally {
            setIsGenerating(false);
            setLoadingMessage('');
        }
    };

    const handleGenerate = async () => {
        if (!prompt.trim()) return;
        setIsGenerating(true);
        setError(null);
        setLoadingMessage('Generating...');

        try {
            // Helper to convert blob to GeneratedImage
            const toGenImg = async (blob: Blob, sourceUrl?: string): Promise<GeneratedImage> => {
                return new Promise((resolve) => {
                    const reader = new FileReader();
                    reader.onloadend = () => resolve({
                        base64: (reader.result as string).split(',')[1],
                        mimeType: fixMimeType(blob.type, sourceUrl)
                    });
                    reader.readAsDataURL(blob);
                });
            }

            // ═══════════════════════════════════════════════════════════════
            // CREATE MODE: No source image - pure text-to-image generation
            // ═══════════════════════════════════════════════════════════════
            if (isCreateMode || !currentImage) {
                setLoadingMessage('Generating new image from prompt...');

                // Use Gemini native text-to-image
                const ai = new GoogleGenAI({ apiKey });
                const response = await ai.models.generateContent({
                    model: editModel,
                    contents: prompt,
                    config: {
                        responseModalities: ['TEXT', 'IMAGE'] as any,
                    },
                });

                // Extract image from response
                const parts = response.candidates?.[0]?.content?.parts || [];
                const imagePart = parts.find((p: any) => p.inlineData?.mimeType?.includes('image'));

                if (imagePart?.inlineData) {
                    const newImage = `data:${imagePart.inlineData.mimeType};base64,${imagePart.inlineData.data}`;
                    setCurrentImage(newImage);
                    addToHistory(newImage, prompt);
                    setIsCreateMode(false); // Switch to edit mode after first generation
                } else {
                    throw new Error('No image generated. Try a different prompt.');
                }
                return;
            }

            // Check if we are doing Composition with multiple reference images
            if (activeTab === 'layers' && referenceImages.length > 0) {
                setLoadingMessage(`Compositing ${referenceImages.length} reference image(s)...`);
                const baseBlob = await (await fetch(currentImage)).blob();
                const baseGen = await toGenImg(baseBlob);

                // Convert all reference images to GeneratedImage format
                const refGenImages: GeneratedImage[] = [];
                for (const refImg of referenceImages) {
                    const refBlob = await (await fetch(refImg)).blob();
                    refGenImages.push(await toGenImg(refBlob));
                }

                // For multi-image, we use the first image for compositing and include others in prompt context
                // Gemini can handle multiple images in a single call
                if (refGenImages.length === 1) {
                    const result = await compositeImages(apiKey, baseGen, refGenImages[0], prompt, imageAspectRatio, currentResolution, editModel);
                    if (result.base64) {
                        const newImage = `data:${result.mimeType};base64,${result.base64}`;
                        setCurrentImage(newImage);
                        addToHistory(newImage, `Composite: ${prompt}`);
                    }
                } else {
                    // Multi-image: Use generateContent with all images inline
                    const ai = new GoogleGenAI({ apiKey });
                    const parts: any[] = [
                        { inlineData: { data: baseGen.base64, mimeType: baseGen.mimeType } },
                        ...refGenImages.map(img => ({ inlineData: { data: img.base64, mimeType: img.mimeType } })),
                        { text: `Composite these ${refGenImages.length + 1} images together based on this instruction: ${prompt}. The first image is the base/background. The subsequent images are elements to be added. Seamlessly blend lighting, shadows, and style.` }
                    ];

                    const response = await ai.models.generateContent({
                        model: editModel,
                        contents: { parts },
                        config: {
                            responseModalities: ['IMAGE'],
                            imageConfig: { aspectRatio: imageAspectRatio }
                        }
                    });

                    const imagePart = response.candidates?.[0]?.content?.parts?.find(p => p.inlineData);
                    if (imagePart?.inlineData) {
                        const newImage = `data:${imagePart.inlineData.mimeType};base64,${imagePart.inlineData.data}`;
                        setCurrentImage(newImage);
                        addToHistory(newImage, `Multi-Composite (${referenceImages.length} refs): ${prompt}`);
                    }
                }
                return;
            }

            if (activeTab === 'layers' && styleRefImage) {
                setLoadingMessage('Applying Style Transfer...');
                const baseBlob = await (await fetch(currentImage)).blob();
                const styleBlob = await (await fetch(styleRefImage)).blob();

                const baseGen = await toGenImg(baseBlob);
                const styleGen = await toGenImg(styleBlob);

                const result = await applyStyleTransfer(apiKey, baseGen, styleGen, prompt, imageAspectRatio, currentResolution, editModel);
                if (result.base64) {
                    const newImage = `data:${result.mimeType};base64,${result.base64}`;
                    setCurrentImage(newImage);
                    addToHistory(newImage, `Style Transfer: ${prompt}`);
                    setStyleRefImage(null); // Clear after use? Optional.
                }
                return;
            }

            // Check if user has drawn a mask
            const hasMask = canvasRef.current?.hasDrawing() || false;
            const [header, data] = currentImage.split(',');
            const mimeType = header.match(/:(.*?);/)?.[1] || 'image/png';

            let result: GeneratedImage;

            if (hasMask) {
                // Edit with Mask
                setLoadingMessage('Editing with Mask...');
                const maskBase64 = await canvasRef.current?.getMaskDataURL();
                if (!maskBase64) throw new Error("Failed to generate mask");
                result = await editImageWithMask(apiKey, data, mimeType, maskBase64, prompt, imageAspectRatio, currentResolution, editModel);
                canvasRef.current?.clear();
            } else {
                // No mask - use text-to-image regeneration
                setLoadingMessage('Regenerating with prompt...');
                result = await generateImageFromImage(apiKey, data, mimeType, prompt, imageAspectRatio, currentResolution, editModel);
            }

            if (result.base64) {
                const newImage = `data:${result.mimeType};base64,${result.base64}`;
                setCurrentImage(newImage);
                addToHistory(newImage, prompt);
            }

        } catch (err: any) {
            console.error("Operation failed:", err);
            setError(err.message || "Operation failed");
        } finally {
            setIsGenerating(false);
            setLoadingMessage('');
        }
    };

    const getResolutionOrder = (res: '1k' | '2k' | '4k') => {
        return res === '1k' ? 1 : res === '2k' ? 2 : 3;
    };

    const handleUpscale = async () => {
        const currentResOrder = getResolutionOrder(currentResolution);
        const targetResOrder = getResolutionOrder(upscaleLevel);

        if (targetResOrder <= currentResOrder) {
            setError(`Cannot downscale or stay at the same resolution. Current: ${currentResolution.toUpperCase()}, Target: ${upscaleLevel.toUpperCase()}`);
            return;
        }

        setIsGenerating(true);
        setError(null);
        setLoadingMessage(`Upscaling Image to ${upscaleLevel.toUpperCase()}...`);
        try {
            const [header, data] = currentImage.split(',');
            const mimeType = header.match(/:(.*?);/)?.[1] || 'image/png';
            const result = await upscaleImage(apiKey, data, mimeType, imageAspectRatio, upscaleLevel, editModel);
            if (result.base64) {
                const newImage = `data:${result.mimeType};base64,${result.base64}`;
                setCurrentImage(newImage);
                setCurrentResolution(upscaleLevel);
                addToHistory(newImage, `Upscaled (${upscaleLevel.toUpperCase()})`, upscaleLevel);
            }
        } catch (err: any) {
            console.error("Upscale failed:", err);
            setError(err.message || "Upscale failed");
        } finally {
            setIsGenerating(false);
            setLoadingMessage('');
        }
    };

    const handleExpand = async (direction: 'up' | 'down' | 'left' | 'right') => {
        setIsGenerating(true);
        setError(null);
        setLoadingMessage(`Expanding ${direction}...`);
        try {
            const [header, data] = currentImage.split(',');
            const mimeType = header.match(/:(.*?);/)?.[1] || 'image/png';
            const result = await expandImage(apiKey, data, mimeType, direction, imageAspectRatio, currentResolution, editModel);
            if (result.base64) {
                const newImage = `data:${result.mimeType};base64,${result.base64}`;
                setCurrentImage(newImage);
                addToHistory(newImage, `Expand ${direction}`);
            }
        } catch (err: any) {
            console.error("Expand failed:", err);
            setError(err.message || "Expand failed");
        } finally {
            setIsGenerating(false);
            setLoadingMessage('');
        }
    };

    const handleAnalyze = async () => {
        setIsGenerating(true);
        setLoadingMessage('Analyzing Image...');
        try {
            // Helper to convert current image to GeneratedImage structure
            const blob = await (await fetch(currentImage)).blob();
            const reader = new FileReader();
            reader.readAsDataURL(blob);
            reader.onloadend = async () => {
                const base64 = (reader.result as string).split(',')[1];
                const result = await analyzeImage(apiKey, { base64, mimeType: fixMimeType(blob.type, currentImage) });
                setAnalysisTags(result);
                setIsGenerating(false);
                setLoadingMessage('');
                setActiveTab('analysis');
            }
        } catch (err: any) {
            console.error("Analysis failed:", err);
            setError(err.message || "Analysis failed");
            setIsGenerating(false);
            setLoadingMessage('');
        }
    };

    const handleUndo = () => {
        canvasRef.current?.undo();
    };

    const handleRestoreHistory = (scan: typeof history[0]) => {
        setCurrentImage(scan.image);
        if (scan.resolution) {
            setCurrentResolution(scan.resolution);
        }
    };

    const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>, setter: (s: string | null) => void) => {
        const file = e.target.files?.[0];
        if (file) {
            const reader = new FileReader();
            reader.onload = (ev) => {
                setter(ev.target?.result as string);
            };
            reader.readAsDataURL(file);
        }
    };

    // View Selection Handlers
    const switchView = async (viewKey: string, imageUrl: string | null) => {
        if (!imageUrl) return;
        try {
            const base64Image = await ensureBase64Image(imageUrl);
            setCurrentImage(base64Image);
            setCurrentView(viewKey);
            setCurrentResolution('1k');
            setHistory([{ id: generateId(), image: base64Image, prompt: 'Original', resolution: '1k' }]);
        } catch (err) {
            console.error('[Editor] Failed to switch view:', err);
            setError('Không thể chuyển view. Vui lòng thử lại.');
        }
    };

    const ViewNavigator = () => {
        const views = character
            ? [
                { key: 'master', label: 'Reference', img: character.masterImage },
                { key: 'face', label: 'Face', img: character.faceImage },
                { key: 'body', label: 'Outfit', img: character.bodyImage },
                { key: 'side', label: 'Side', img: character.sideImage },
                { key: 'back', label: 'Back', img: character.backImage },
            ]
            : product
                ? [
                    { key: 'master', label: 'Main', img: product.masterImage },
                    { key: 'front', label: 'Front', img: product.views.front },
                    { key: 'back', label: 'Back', img: product.views.back },
                    { key: 'left', label: 'Left', img: product.views.left },
                    { key: 'right', label: 'Right', img: product.views.right },
                    { key: 'top', label: 'Top', img: product.views.top },
                ]
                : [];

        if (views.length === 0) return null;

        // Collapsible design - shows as compact icon row in TOP-LEFT, expands on hover
        return (
            <div className="absolute top-3 left-3 z-40 group/viewnav">
                {/* Collapsed state - just small icon indicators */}
                <div className="flex flex-col gap-1 bg-black/50 backdrop-blur-md rounded-xl p-1.5 border border-white/10 transition-all duration-300 group-hover/viewnav:opacity-0 group-hover/viewnav:pointer-events-none">
                    <div className="flex items-center gap-1">
                        <ImageIcon size={12} className="text-purple-400" />
                        <span className="text-[8px] font-bold text-gray-400 uppercase">Views</span>
                    </div>
                    <div className="flex gap-0.5">
                        {views.filter(v => v.img).slice(0, 5).map((v) => (
                            <div
                                key={v.key}
                                className={`w-6 h-6 rounded overflow-hidden border ${currentView === v.key ? 'border-purple-500' : 'border-white/10'}`}
                            >
                                <img src={v.img} className="w-full h-full object-cover" alt={v.label} />
                            </div>
                        ))}
                    </div>
                </div>

                {/* Expanded state - full view selector on hover */}
                <div className="absolute top-0 left-0 opacity-0 pointer-events-none group-hover/viewnav:opacity-100 group-hover/viewnav:pointer-events-auto transition-all duration-300">
                    <div className="flex flex-col bg-black/70 backdrop-blur-xl rounded-2xl border border-white/10 p-3 shadow-2xl min-w-[180px]">
                        <div className="flex items-center gap-2 mb-3 pb-2 border-b border-white/10">
                            <ImageIcon size={14} className="text-purple-400" />
                            <span className="text-xs font-black text-white uppercase tracking-wider">Character Views</span>
                        </div>
                        <div className="grid grid-cols-3 gap-2">
                            {views.map((v) => (
                                <button
                                    key={v.key}
                                    onClick={() => switchView(v.key, v.img)}
                                    disabled={!v.img}
                                    className={`group relative flex flex-col items-center transition-all ${!v.img ? 'opacity-20 cursor-not-allowed grayscale' : 'hover:scale-105'}`}
                                >
                                    <div className={`w-12 h-12 rounded-lg overflow-hidden border-2 transition-all duration-200 ${currentView === v.key ? 'border-purple-500 shadow-[0_0_12px_rgba(168,85,247,0.5)]' : 'border-white/10 group-hover:border-white/30'}`}>
                                        {v.img ? (
                                            <img src={v.img} className="w-full h-full object-cover" alt={v.label} />
                                        ) : (
                                            <div className="w-full h-full bg-gray-900/50 flex items-center justify-center">
                                                <ImageIcon size={14} className="text-gray-700" />
                                            </div>
                                        )}
                                    </div>
                                    <span className={`mt-1 text-[8px] font-bold uppercase ${currentView === v.key ? 'text-purple-400' : 'text-gray-500'}`}>
                                        {v.label}
                                    </span>
                                </button>
                            ))}
                        </div>
                    </div>
                </div>
            </div>
        );
    };

    if (!isOpen) return null;

    return (
        <div className="fixed inset-0 bg-black/90 flex items-center justify-center z-[60]">
            <div className="bg-[#121212] w-full h-full md:w-[95vw] md:h-[95vh] md:max-w-[1600px] md:rounded-2xl flex flex-col overflow-hidden relative shadow-2xl border border-gray-800">

                {/* Header */}
                <div className="h-14 min-h-[56px] border-b border-gray-800 flex items-center justify-between px-4 bg-[#1a1a1a]">
                    <div className="flex items-center gap-3">
                        <div className="flex items-center space-x-2 text-purple-400">
                            <Wand2 size={20} />
                            <span className="font-bold text-base tracking-wide text-white hidden sm:inline">CyberMask Studio</span>
                        </div>

                        {/* New Image Button */}
                        <button
                            onClick={() => {
                                setCurrentImage('');
                                setHistory([]);
                                setIsCreateMode(true);
                                setPrompt('');
                            }}
                            className="flex items-center gap-1.5 px-3 py-1.5 bg-gradient-to-r from-pink-600 to-purple-600 hover:from-pink-500 hover:to-purple-500 rounded-lg text-white text-xs font-bold transition-all"
                            title="Tạo ảnh mới"
                        >
                            <Sparkles size={14} />
                            <span className="hidden sm:inline">New</span>
                        </button>
                    </div>

                    <div className="flex items-center gap-2">
                        {/* Ratio Selector - Quick Toggle */}
                        <div className="flex items-center bg-gray-800/50 rounded-lg p-0.5 border border-gray-700">
                            {EDITOR_RATIOS.map(ratio => (
                                <button
                                    key={ratio.value}
                                    onClick={() => setImageAspectRatio(ratio.value)}
                                    className={`px-2 py-1 text-xs font-medium rounded-md transition-colors ${imageAspectRatio === ratio.value
                                        ? 'bg-purple-600 text-white'
                                        : 'text-gray-400 hover:text-white'
                                        }`}
                                    title={ratio.label}
                                >
                                    {ratio.label}
                                </button>
                            ))}
                        </div>

                        {/* Resolution Selector */}
                        <div className="flex items-center bg-gray-800/50 rounded-lg p-0.5 border border-gray-700">
                            {(['1k', '2k', '4k'] as const).map(res => (
                                <button
                                    key={res}
                                    onClick={() => setCurrentResolution(res)}
                                    className={`px-2 py-1 text-xs font-medium rounded-md transition-colors ${currentResolution === res
                                        ? 'bg-green-600 text-white'
                                        : 'text-gray-400 hover:text-white'
                                        }`}
                                    title={`${res.toUpperCase()} Resolution`}
                                >
                                    {res.toUpperCase()}
                                </button>
                            ))}
                        </div>

                        {/* Model Selector */}
                        <div className="relative">
                            <button
                                onClick={() => setShowModelDropdown(!showModelDropdown)}
                                className="flex items-center gap-2 bg-gray-800 hover:bg-gray-700 px-3 py-1.5 rounded-lg border border-gray-600 text-sm text-white transition-colors"
                            >
                                <span className="max-w-[180px] truncate">
                                    {EDIT_MODELS.find(m => m.value === editModel)?.label || 'Select Model'}
                                </span>
                                <ChevronDown size={14} />
                            </button>
                            {showModelDropdown && (
                                <div className="absolute right-0 top-full mt-1 w-80 max-h-72 overflow-y-auto bg-gray-900 border border-gray-700 rounded-lg shadow-xl z-50">
                                    {EDIT_MODELS.map(model => (
                                        <button
                                            key={model.value}
                                            onClick={() => {
                                                setEditModel(model.value);
                                                setShowModelDropdown(false);
                                            }}
                                            className={`w-full text-left px-4 py-2 hover:bg-gray-800 transition-colors ${editModel === model.value ? 'bg-purple-600/20 text-purple-300' : 'text-white'}`}
                                        >
                                            <div className="font-medium text-sm">{model.label}</div>
                                            <div className="text-[10px] text-gray-500">{model.description}</div>
                                        </button>
                                    ))}
                                </div>
                            )}
                        </div>
                        <button onClick={handleAnalyze} disabled={isGenerating} className="p-2 text-blue-400 hover:text-blue-300 transition-colors" title="Analyze Image">
                            <Search size={20} />
                        </button>
                        <button onClick={handleUpscale} disabled={isGenerating} className="flex items-center gap-2 bg-green-600/20 hover:bg-green-600/40 text-green-400 px-3 py-1.5 rounded-lg border border-green-600/50 transition-colors text-sm font-medium disabled:opacity-50">
                            <Scan size={16} />
                            Upscale {upscaleLevel.toUpperCase()}
                        </button>
                        <div className="h-6 w-px bg-gray-700 mx-2"></div>
                        <button onClick={handleUndo} className="p-2 text-gray-400 hover:text-white transition-colors" title="Undo Mask (Ctrl+Z)">
                            <Undo size={20} />
                        </button>
                        <button onClick={onClose} className="p-2 text-gray-400 hover:text-red-400 transition-colors">
                            <X size={24} />
                        </button>
                    </div>
                </div>

                {/* Main Workspace */}
                <div className="flex-1 flex overflow-hidden">

                    {/* Left: History */}
                    <div className={`bg-[#151515] border-r border-gray-800 flex flex-col transition-all ${historyLayout === 'grid' ? 'w-64' : 'w-24'}`}>
                        <div className="p-3 border-b border-gray-800 flex justify-between items-center">
                            <span className="text-gray-400 text-xs font-bold uppercase tracking-wider">History</span>
                            <button onClick={() => setHistoryLayout(prev => prev === 'list' ? 'grid' : 'list')} className="text-gray-500 hover:text-white">
                                {historyLayout === 'list' ? <LayoutGrid size={16} /> : <List size={16} />}
                            </button>
                        </div>
                        <div className={`flex-1 overflow-y-auto p-2 ${historyLayout === 'grid' ? 'grid grid-cols-2 gap-2' : 'space-y-2'}`}>
                            {history.map((scan, i) => (
                                <div
                                    key={scan.id}
                                    onClick={() => handleRestoreHistory(scan)}
                                    className={`relative p-1 rounded-lg cursor-pointer transition-all border group ${currentImage === scan.image ? 'border-purple-500 bg-purple-500/10' : 'border-transparent hover:bg-gray-800'}`}
                                >
                                    <img src={scan.image} className="w-full h-16 object-cover rounded bg-black" />
                                    <div className="absolute top-2 left-2 px-1 rounded-md bg-black/60 border border-white/10 text-[8px] font-black text-white uppercase tracking-tighter opacity-0 group-hover:opacity-100 transition-opacity">
                                        {scan.resolution || '1k'}
                                    </div>
                                    {historyLayout === 'list' && <div className="hidden md:block text-[10px] text-gray-400 truncate mt-1">{i === 0 ? 'Original' : scan.prompt}</div>}
                                    {/* Drag to layer button */}
                                    <button
                                        onClick={(e) => { e.stopPropagation(); setReferenceImages(prev => [...prev, scan.image].slice(0, MAX_REFERENCE_IMAGES)); setActiveTab('layers'); }}
                                        className="absolute top-1 right-1 bg-black/60 text-white p-1 rounded-full opacity-0 group-hover:opacity-100 transition-opacity"
                                        title="Add to References"
                                    >
                                        <Layers size={10} />
                                    </button>
                                </div>
                            ))}
                        </div>
                    </div>

                    {/* Center: Canvas */}
                    <div className="flex-1 bg-[#0a0a0a] flex flex-col relative">



                        {/* Canvas Container */}
                        <div className="flex-1 flex items-center justify-center p-8 overflow-hidden group/canvas" ref={containerRef}>
                            {/* Create Mode: Dropzone */}
                            {(isCreateMode || !currentImage) ? (
                                <div
                                    className="w-full max-w-2xl aspect-video border-2 border-dashed border-gray-600 hover:border-purple-500 rounded-xl flex flex-col items-center justify-center cursor-pointer transition-all bg-gray-900/30 hover:bg-gray-900/50"
                                    onClick={() => dropzoneInputRef.current?.click()}
                                    onDragOver={(e) => { e.preventDefault(); e.currentTarget.classList.add('border-purple-500', 'bg-purple-500/10'); }}
                                    onDragLeave={(e) => { e.currentTarget.classList.remove('border-purple-500', 'bg-purple-500/10'); }}
                                    onDrop={(e) => {
                                        e.preventDefault();
                                        e.currentTarget.classList.remove('border-purple-500', 'bg-purple-500/10');
                                        const file = e.dataTransfer.files[0];
                                        if (file && file.type.startsWith('image/')) {
                                            const reader = new FileReader();
                                            reader.onloadend = () => {
                                                const base64 = reader.result as string;
                                                setCurrentImage(base64);
                                                addToHistory(base64, 'Uploaded');
                                                setIsCreateMode(false);
                                            };
                                            reader.readAsDataURL(file);
                                        }
                                    }}
                                >
                                    <input
                                        ref={dropzoneInputRef}
                                        type="file"
                                        accept="image/*"
                                        className="hidden"
                                        onChange={(e) => {
                                            const file = e.target.files?.[0];
                                            if (file) {
                                                const reader = new FileReader();
                                                reader.onloadend = () => {
                                                    const base64 = reader.result as string;
                                                    setCurrentImage(base64);
                                                    addToHistory(base64, 'Uploaded');
                                                    setIsCreateMode(false);
                                                };
                                                reader.readAsDataURL(file);
                                            }
                                            e.target.value = '';
                                        }}
                                    />
                                    <Upload size={48} className="text-gray-500 mb-4" />
                                    <p className="text-gray-400 text-lg font-medium mb-2">Kéo thả ảnh vào đây</p>
                                    <p className="text-gray-600 text-sm mb-4">hoặc click để chọn file</p>
                                    <div className="flex items-center gap-2 text-gray-500 text-xs">
                                        <span className="px-2 py-1 bg-gray-800 rounded">PNG</span>
                                        <span className="px-2 py-1 bg-gray-800 rounded">JPG</span>
                                        <span className="px-2 py-1 bg-gray-800 rounded">WEBP</span>
                                    </div>
                                    <p className="text-purple-400 text-sm mt-6">Hoặc nhập prompt bên dưới để tạo ảnh mới</p>
                                </div>
                            ) : (
                                <div className="relative shadow-2xl border border-gray-800">
                                    {/* Character/Product Navigation */}
                                    <div className="absolute inset-x-0 bottom-0 pointer-events-none z-30 opacity-0 group-hover/canvas:opacity-100 transition-opacity duration-300">
                                        <div className="pointer-events-auto">
                                            <ViewNavigator />
                                        </div>
                                    </div>

                                    <MaskCanvas
                                        ref={canvasRef}
                                        image={currentImage}
                                        width={dimensions.width}
                                        height={dimensions.height}
                                        brushRadius={brushSize / 2}
                                        brushColor={isEraser ? "#000001" : "rgba(168, 85, 247, 0.8)"}
                                        disabled={!isDrawMode || (activeTab !== 'tools' && activeTab !== 'try-on')}
                                    />

                                    {referenceImages.length > 0 && activeTab === 'layers' && (
                                        <div className="absolute top-2 right-2 bg-black/60 text-xs text-white px-2 py-1 rounded pointer-events-none border border-white/20">
                                            {referenceImages.length} ref(s)
                                        </div>
                                    )}
                                </div>
                            )}
                        </div>
                    </div>

                    {/* Right Panel: Active Tab Content */}
                    <div className="w-72 bg-[#151515] border-l border-gray-800 flex flex-col">
                        <div className="flex bg-[#0f0f0f] border-b border-gray-800">
                            <button
                                onClick={() => setActiveTab('tools')}
                                className={`flex-1 py-3 flex items-center justify-center border-b-2 transition-all ${activeTab === 'tools' ? 'border-purple-500 text-purple-400 bg-purple-500/5' : 'border-transparent text-gray-500 hover:text-gray-300'}`}
                                title="Drawing Tools"
                            >
                                <Brush size={18} />
                            </button>
                            <button
                                onClick={() => setActiveTab('try-on')}
                                className={`flex-1 py-3 flex items-center justify-center border-b-2 transition-all ${activeTab === 'try-on' ? 'border-purple-500 text-purple-400 bg-purple-500/5' : 'border-transparent text-gray-500 hover:text-gray-300'}`}
                                title="Virtual Try On"
                            >
                                <Shirt size={18} />
                            </button>
                            <button
                                onClick={() => setActiveTab('layers')}
                                className={`flex-1 py-3 flex items-center justify-center border-b-2 transition-all ${activeTab === 'layers' ? 'border-purple-500 text-purple-400 bg-purple-500/5' : 'border-transparent text-gray-500 hover:text-gray-300'}`}
                                title="Layers & Style"
                            >
                                <Layers size={18} />
                            </button>
                            <button
                                onClick={() => setActiveTab('analysis')}
                                className={`flex-1 py-3 flex items-center justify-center border-b-2 transition-all ${activeTab === 'analysis' ? 'border-purple-500 text-purple-400 bg-purple-500/5' : 'border-transparent text-gray-500 hover:text-gray-300'}`}
                                title="Image Analysis"
                            >
                                <Search size={18} />
                            </button>
                        </div>

                        {/* Analysis Content */}
                        {activeTab === 'analysis' && (
                            <div className="p-4 space-y-4">
                                <h3 className="text-white font-bold flex items-center gap-2"><Search size={16} /> Image Analysis</h3>
                                {!analysisTags ? (
                                    <div className="text-center py-8">
                                        <p className="text-gray-500 text-sm mb-4">Identify objects and styles in your image.</p>
                                        <button onClick={handleAnalyze} className="bg-blue-600 hover:bg-blue-500 text-white px-4 py-2 rounded-lg text-sm w-full">Start Analysis</button>
                                    </div>
                                ) : (
                                    <div>
                                        <div className="flex flex-wrap gap-2">
                                            {analysisTags.map((tag, i) => (
                                                <span
                                                    key={i}
                                                    className="bg-gray-800 hover:bg-gray-700 text-gray-300 text-xs px-2 py-1 rounded cursor-pointer border border-gray-700"
                                                    onClick={() => setPrompt(prev => prev + (prev ? ', ' : '') + tag)}
                                                >
                                                    {tag}
                                                </span>
                                            ))}
                                        </div>
                                        <button onClick={() => setAnalysisTags(null)} className="mt-4 text-xs text-red-400 hover:text-red-300 w-full text-center">Clear Results</button>
                                    </div>
                                )}
                            </div>
                        )}

                        {/* Layers & Compositing Content */}
                        {activeTab === 'layers' && (
                            <div className="p-4 space-y-6">
                                {/* Multi-Image Reference Upload */}
                                <div>
                                    <h3 className="text-white font-bold flex items-center gap-2 mb-2">
                                        <Layers size={16} /> Reference Images
                                        <span className="ml-auto text-xs text-gray-500 font-normal">
                                            {referenceImages.length}/{MAX_REFERENCE_IMAGES}
                                        </span>
                                    </h3>
                                    <p className="text-xs text-gray-500 mb-3">
                                        Add up to {MAX_REFERENCE_IMAGES} reference images for compositing. Drag & drop or click to upload.
                                    </p>

                                    {/* Drop Zone */}
                                    <div
                                        className={`border-2 border-dashed rounded-lg p-4 transition-all cursor-pointer ${referenceImages.length >= MAX_REFERENCE_IMAGES
                                            ? 'border-gray-700 bg-gray-900/30 cursor-not-allowed'
                                            : 'border-gray-600 hover:border-purple-500 bg-gray-900/50 hover:bg-purple-900/20'
                                            }`}
                                        onClick={() => referenceImages.length < MAX_REFERENCE_IMAGES && referenceInputRef.current?.click()}
                                        onDragOver={(e) => {
                                            e.preventDefault();
                                            e.currentTarget.classList.add('border-purple-500', 'bg-purple-900/30');
                                        }}
                                        onDragLeave={(e) => {
                                            e.currentTarget.classList.remove('border-purple-500', 'bg-purple-900/30');
                                        }}
                                        onDrop={(e) => {
                                            e.preventDefault();
                                            e.currentTarget.classList.remove('border-purple-500', 'bg-purple-900/30');
                                            const files = (Array.from(e.dataTransfer.files) as File[]).filter(f => f.type.startsWith('image/'));
                                            const maxToAdd = MAX_REFERENCE_IMAGES - referenceImages.length;
                                            const filesToProcess = files.slice(0, maxToAdd);

                                            filesToProcess.forEach((file: File) => {
                                                const reader = new FileReader();
                                                reader.onload = (ev: ProgressEvent<FileReader>) => {
                                                    setReferenceImages(prev => [...prev, ev.target?.result as string]);
                                                };
                                                reader.readAsDataURL(file);
                                            });
                                        }}
                                    >
                                        {referenceImages.length < MAX_REFERENCE_IMAGES ? (
                                            <div className="flex flex-col items-center justify-center py-4 text-gray-400">
                                                <Upload size={28} className="mb-2" />
                                                <span className="text-sm font-medium">Drop images here</span>
                                                <span className="text-xs text-gray-600 mt-1">or click to browse</span>
                                            </div>
                                        ) : (
                                            <div className="text-center py-4 text-gray-500">
                                                <span className="text-xs">Maximum {MAX_REFERENCE_IMAGES} images reached</span>
                                            </div>
                                        )}
                                    </div>

                                    {/* Multi-select hidden input */}
                                    <input
                                        type="file"
                                        ref={referenceInputRef}
                                        multiple
                                        accept="image/*"
                                        className="hidden"
                                        onChange={(e) => {
                                            const files = Array.from(e.target.files || []) as File[];
                                            const maxToAdd = MAX_REFERENCE_IMAGES - referenceImages.length;
                                            const filesToProcess = files.slice(0, maxToAdd);

                                            filesToProcess.forEach(file => {
                                                const reader = new FileReader();
                                                reader.onload = (ev) => {
                                                    setReferenceImages(prev => [...prev, ev.target?.result as string]);
                                                };
                                                reader.readAsDataURL(file);
                                            });
                                            e.target.value = ''; // Reset input
                                        }}
                                    />

                                    {/* Thumbnail Gallery */}
                                    {referenceImages.length > 0 && (
                                        <div className="mt-3 grid grid-cols-3 gap-2">
                                            {referenceImages.map((img, idx) => (
                                                <div key={idx} className="relative group aspect-square">
                                                    <img
                                                        src={img}
                                                        alt={`Ref ${idx + 1}`}
                                                        className="w-full h-full object-cover rounded-lg border border-gray-700"
                                                    />
                                                    <div className="absolute top-1 left-1 bg-black/70 text-white text-[9px] px-1.5 py-0.5 rounded font-bold">
                                                        {idx + 1}
                                                    </div>
                                                    <button
                                                        onClick={(e) => {
                                                            e.stopPropagation();
                                                            setReferenceImages(prev => prev.filter((_, i) => i !== idx));
                                                        }}
                                                        className="absolute top-1 right-1 bg-red-600 hover:bg-red-500 p-1 rounded-full text-white opacity-0 group-hover:opacity-100 transition-opacity"
                                                    >
                                                        <X size={10} />
                                                    </button>
                                                </div>
                                            ))}
                                        </div>
                                    )}

                                    {/* Clear All Button */}
                                    {referenceImages.length > 1 && (
                                        <button
                                            onClick={() => setReferenceImages([])}
                                            className="w-full mt-2 text-xs text-red-400 hover:text-red-300 transition-colors"
                                        >
                                            Clear all ({referenceImages.length})
                                        </button>
                                    )}
                                </div>

                                <div className="h-px bg-gray-800"></div>

                                {/* Style Upload */}
                                <div>
                                    <h3 className="text-white font-bold flex items-center gap-2 mb-2"><Palette size={16} /> Style Reference</h3>
                                    <p className="text-xs text-gray-500 mb-3">Transfer style from another image.</p>

                                    {!styleRefImage ? (
                                        <button onClick={() => styleInputRef.current?.click()} className="border border-dashed border-gray-600 hover:border-gray-400 rounded-lg h-32 w-full flex flex-col items-center justify-center text-gray-500 hover:text-gray-300 transition-colors bg-gray-900/50">
                                            <Upload size={24} className="mb-2" />
                                            <span className="text-xs">Upload Style Image</span>
                                        </button>
                                    ) : (
                                        <div className="relative group">
                                            <img src={styleRefImage} className="w-full h-32 object-cover rounded-lg border border-gray-700" />
                                            <button onClick={() => setStyleRefImage(null)} className="absolute top-2 right-2 bg-black/60 p-1 rounded-full text-white hover:bg-red-500"><X size={14} /></button>
                                        </div>
                                    )}
                                    <input type="file" ref={styleInputRef} onChange={(e) => handleFileUpload(e, setStyleRefImage)} className="hidden" accept="image/*" />
                                </div>
                            </div>
                        )}

                        {/* Tools (Standard Mask Edit) Content */}
                        {activeTab === 'tools' && (
                            <div className="p-5 space-y-8 flex-1 overflow-y-auto">
                                {/* Quick Expand Section */}
                                <div className="space-y-4">
                                    <h3 className="text-white font-bold flex items-center gap-2"><Maximize size={18} className="text-blue-400" /> Magic Expand</h3>
                                    <div className="grid grid-cols-2 gap-2">
                                        {(['up', 'down', 'left', 'right'] as const).map(dir => (
                                            <button
                                                key={dir}
                                                onClick={() => handleExpand(dir)}
                                                disabled={isGenerating}
                                                className="flex flex-col items-center justify-center p-3 rounded-xl bg-gray-800/50 hover:bg-blue-600/20 border border-gray-700 hover:border-blue-500/50 transition-all group disabled:opacity-50"
                                            >
                                                {dir === 'up' && <ArrowUp size={20} className="text-blue-400 group-hover:scale-110 transition-transform" />}
                                                {dir === 'down' && <ArrowDown size={20} className="text-blue-400 group-hover:scale-110 transition-transform" />}
                                                {dir === 'left' && <ArrowLeft size={20} className="text-blue-400 group-hover:scale-110 transition-transform" />}
                                                {dir === 'right' && <ArrowRight size={20} className="text-blue-400 group-hover:scale-110 transition-transform" />}
                                                <span className="text-[10px] text-gray-500 mt-1 uppercase font-bold tracking-widest">{dir}</span>
                                            </button>
                                        ))}
                                    </div>
                                </div>

                                <div className="h-px bg-gray-800/50"></div>

                                {/* Upscale Section */}
                                <div className="space-y-4">
                                    <div className="flex items-center justify-between">
                                        <h3 className="text-white font-bold flex items-center gap-2"><Scan size={18} className="text-green-400" /> Image Quality</h3>
                                        <div className="px-2 py-0.5 rounded-full bg-green-500/10 border border-green-500/20 text-[9px] font-black text-green-400 uppercase tracking-widest">
                                            Current: {currentResolution.toUpperCase()}
                                        </div>
                                    </div>
                                    <div className="grid grid-cols-3 gap-2">
                                        {(['1k', '2k', '4k'] as const).map(level => {
                                            const isCurrentOrLower = getResolutionOrder(level) <= getResolutionOrder(currentResolution);
                                            return (
                                                <button
                                                    key={level}
                                                    onClick={() => !isCurrentOrLower && setUpscaleLevel(level)}
                                                    disabled={isCurrentOrLower}
                                                    className={`flex flex-col items-center justify-center p-2 rounded-xl border transition-all ${upscaleLevel === level
                                                        ? 'bg-green-600/20 border-green-500 text-green-400 shadow-[0_0_15px_rgba(34,197,94,0.1)]'
                                                        : isCurrentOrLower
                                                            ? 'bg-gray-900/30 border-gray-800 text-gray-700 cursor-not-allowed grayscale'
                                                            : 'bg-gray-800/50 border-gray-700 text-gray-500 hover:border-gray-600'
                                                        }`}
                                                >
                                                    <span className="text-[10px] font-black uppercase tracking-widest">{level}</span>
                                                    <span className="text-[8px] font-medium opacity-60">
                                                        {level === '1k' ? '1024px' : level === '2k' ? '2048px' : '4096px'}
                                                    </span>
                                                </button>
                                            );
                                        })}
                                    </div>
                                </div>

                                <div className="h-px bg-gray-800/50"></div>

                                <div className="space-y-6">
                                    <div className="flex items-center justify-between">
                                        <h3 className="text-white font-bold flex items-center gap-2"><Brush size={18} className="text-purple-400" /> Brush Tools</h3>
                                        <div className="flex items-center gap-3">
                                            <button
                                                onClick={() => setIsDrawMode(!isDrawMode)}
                                                className={`flex items-center gap-2 px-2 py-1 rounded-lg border transition-all text-[10px] font-black uppercase tracking-widest ${isDrawMode ? 'bg-purple-500/20 border-purple-500 text-purple-400' : 'bg-gray-800 border-gray-700 text-gray-500 hover:text-gray-300'}`}
                                                title={isDrawMode ? "Disable Painting" : "Enable Painting"}
                                            >
                                                <Brush size={12} className={isDrawMode ? 'animate-pulse' : ''} />
                                                <span>{isDrawMode ? 'ON' : 'OFF'}</span>
                                            </button>
                                            <button
                                                onClick={() => canvasRef.current?.clear()}
                                                className="text-[10px] text-gray-500 hover:text-red-400 flex items-center gap-1 uppercase tracking-tighter transition-colors"
                                            >
                                                <Eraser size={12} /> Clear
                                            </button>
                                        </div>
                                    </div>

                                    <div className="grid grid-cols-2 gap-3">
                                        <button
                                            onClick={() => setIsEraser(false)}
                                            className={`flex flex-col items-center justify-center gap-2 p-4 rounded-xl border transition-all duration-300 ${!isEraser ? 'bg-purple-600/20 border-purple-500 text-purple-400 shadow-[0_0_15px_rgba(168,85,247,0.2)]' : 'bg-gray-800/30 border-gray-700/50 text-gray-500 hover:bg-gray-800 hover:border-gray-600'}`}
                                        >
                                            <Brush size={24} />
                                            <span className="text-[11px] font-bold uppercase tracking-wider">Paint</span>
                                        </button>
                                        <button
                                            onClick={() => setIsEraser(true)}
                                            className={`flex flex-col items-center justify-center gap-2 p-4 rounded-xl border transition-all duration-300 ${isEraser ? 'bg-purple-600/20 border-purple-500 text-purple-400 shadow-[0_0_15px_rgba(168,85,247,0.2)]' : 'bg-gray-800/30 border-gray-700/50 text-gray-500 hover:bg-gray-800 hover:border-gray-600'}`}
                                        >
                                            <Eraser size={24} />
                                            <span className="text-[11px] font-bold uppercase tracking-wider">Erase</span>
                                        </button>
                                    </div>

                                    <div className="space-y-4 pt-2">
                                        <div className="flex justify-between items-center bg-gray-900/50 p-2 rounded-lg border border-gray-800/50">
                                            <span className="text-[10px] font-black text-gray-500 uppercase tracking-[0.2em] ml-1">Size</span>
                                            <span className="text-xs text-purple-400 font-mono bg-purple-500/10 px-2 py-0.5 rounded border border-purple-500/20">{brushSize}px</span>
                                        </div>
                                        <div className="px-1">
                                            <input
                                                type="range"
                                                min="2"
                                                max="150"
                                                value={brushSize}
                                                onChange={(e) => setBrushSize(parseInt(e.target.value))}
                                                className="w-full h-1 bg-gray-800 rounded-lg appearance-none cursor-pointer accent-purple-500 hover:accent-purple-400 transition-all"
                                            />
                                        </div>
                                    </div>
                                </div>

                                <div className="space-y-4">
                                    <div className="h-px bg-gradient-to-r from-transparent via-gray-800 to-transparent"></div>
                                    <div className="p-4 bg-purple-500/5 rounded-xl border border-purple-500/10 relative overflow-hidden group">
                                        <div className="absolute top-0 right-0 p-2 opacity-10 group-hover:opacity-20 transition-opacity">
                                            <Wand2 size={40} />
                                        </div>
                                        <div className="flex items-center gap-2 text-purple-400 font-bold mb-3 text-xs">
                                            <Wand2 size={14} />
                                            <span>MASKING GUIDE</span>
                                        </div>
                                        <ul className="space-y-3 text-[11px] text-gray-500 font-medium">
                                            <li className="flex gap-2">
                                                <span className="text-purple-500/50">01.</span>
                                                <span>Paint over parts you want to <span className="text-purple-300">modify</span>.</span>
                                            </li>
                                            <li className="flex gap-2">
                                                <span className="text-purple-500/50">02.</span>
                                                <span>Describe the change in the <span className="text-purple-300">Prompt</span> below.</span>
                                            </li>
                                            <li className="flex gap-2">
                                                <span className="text-purple-500/50">03.</span>
                                                <span>Hit <span className="text-purple-300">Generate</span> to let AI work its magic.</span>
                                            </li>
                                        </ul>
                                    </div>
                                </div>
                            </div>
                        )}

                        {/* Try On Content */}
                        {activeTab === 'try-on' && (
                            <div className="p-5 space-y-6 flex-1 overflow-y-auto">
                                <div className="space-y-4">
                                    <h3 className="text-white font-bold flex items-center gap-2 mb-2">
                                        <Shirt size={18} className="text-purple-400" /> Virtual Try On
                                    </h3>
                                    <p className="text-[11px] text-gray-500 leading-relaxed font-medium">
                                        1. Upload an outfit image.<br />
                                        2. Extract elements to a corkboard.<br />
                                        3. <span className="text-purple-400">Optional:</span> Paint a mask for precise placement.<br />
                                        4. Click Final Try On.
                                    </p>

                                    <div className="space-y-3">
                                        <div
                                            className={`relative aspect-square rounded-xl border-2 border-dashed transition-all cursor-pointer overflow-hidden group ${tryOnImage ? 'border-purple-500/50' : 'border-gray-800 hover:border-gray-700 bg-gray-900/50 shadow-inner'}`}
                                            onClick={() => document.getElementById('try-on-upload')?.click()}
                                        >
                                            {tryOnImage ? (
                                                <>
                                                    <img src={tryOnImage} alt="Outfit" className="w-full h-full object-cover" />
                                                    <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center backdrop-blur-[2px]">
                                                        <Upload className="text-white drop-shadow-lg" size={24} />
                                                    </div>
                                                </>
                                            ) : (
                                                <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-gray-500">
                                                    <div className="p-4 rounded-full bg-gray-800/50 mb-1">
                                                        <Shirt size={32} className="opacity-40" />
                                                    </div>
                                                    <span className="text-xs font-bold uppercase tracking-widest opacity-60">Upload Outfit</span>
                                                </div>
                                            )}
                                        </div>
                                        <input
                                            id="try-on-upload"
                                            type="file"
                                            className="hidden"
                                            accept="image/*"
                                            onChange={(e) => {
                                                const file = e.target.files?.[0];
                                                if (file) {
                                                    const reader = new FileReader();
                                                    reader.onload = (ev) => {
                                                        setTryOnImage(ev.target?.result as string);
                                                        setCorkboardImage(null);
                                                    };
                                                    reader.readAsDataURL(file);
                                                }
                                            }}
                                        />

                                        <button
                                            onClick={handleGenerateCorkboard}
                                            disabled={!tryOnImage || isTryOnLoading}
                                            className="w-full py-3 bg-purple-600/20 border border-purple-500/50 text-purple-400 rounded-xl font-bold text-[10px] uppercase tracking-widest hover:bg-purple-600/30 transition-all disabled:opacity-30 flex items-center justify-center gap-2 shadow-lg active:scale-[0.98]"
                                        >
                                            {isTryOnLoading ? (
                                                <div className="animate-spin rounded-full h-3 w-3 border-2 border-purple-400/20 border-t-purple-400"></div>
                                            ) : (
                                                <LayoutGrid size={14} />
                                            )}
                                            {isTryOnLoading ? 'EXTRACTING...' : 'GENERATE CORKBOARD'}
                                        </button>
                                    </div>

                                    {corkboardImage && (
                                        <div className="space-y-4 pt-4 border-t border-gray-800/50 animate-in fade-in slide-in-from-bottom-2 duration-500">
                                            <div className="flex justify-between items-center bg-gray-900/30 p-2 rounded-lg border border-gray-800/50">
                                                <span className="text-[10px] font-black text-gray-500 uppercase tracking-widest flex items-center gap-1">
                                                    <LayoutGrid size={10} /> CORKBOARD RESULT
                                                </span>
                                                <button onClick={() => setCorkboardImage(null)} className="text-[10px] text-gray-600 hover:text-red-400 transition-colors">Clear</button>
                                            </div>
                                            <div className="relative aspect-video rounded-xl border border-gray-800 overflow-hidden bg-black/40 group shadow-inner">
                                                <img src={corkboardImage} alt="Corkboard" className="w-full h-full object-contain" />
                                                <div className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity">
                                                    <button
                                                        onClick={() => setCurrentImage(corkboardImage)}
                                                        className="bg-black/80 text-white p-2 rounded-lg hover:bg-purple-600 transition-all border border-white/10"
                                                        title="Use as canvas"
                                                    >
                                                        <Maximize size={14} />
                                                    </button>
                                                </div>
                                            </div>

                                            <button
                                                onClick={handleFinalTryOn}
                                                disabled={isTryOnLoading || isGenerating}
                                                className="w-full py-4 bg-gradient-to-br from-indigo-600 via-purple-600 to-pink-600 text-white rounded-xl font-black text-xs uppercase tracking-[0.2em] hover:shadow-[0_0_25px_rgba(168,85,247,0.5)] transition-all active:scale-95 flex items-center justify-center gap-3 border border-white/10"
                                            >
                                                {isGenerating ? (
                                                    <div className="animate-spin rounded-full h-4 w-4 border-2 border-white/20 border-t-white"></div>
                                                ) : (
                                                    <Shirt size={18} className="drop-shadow-[0_0_5px_rgba(255,255,255,0.5)]" />
                                                )}
                                                {isGenerating ? 'APPLYING...' : 'FINAL TRY ON'}
                                            </button>

                                            <div className="p-4 bg-purple-500/5 rounded-xl border border-purple-500/10 text-[10px] text-purple-400/80 font-medium leading-relaxed italic text-center">
                                                Tip: Paint a mask to tell AI exactly where to put the clothes!
                                            </div>
                                        </div>
                                    )}
                                </div>
                            </div>
                        )}

                    </div>

                </div>

                {/* Bottom Bar: Prompt & Actions */}
                <div className="p-6 bg-[#1a1a1a] border-t border-gray-800 flex justify-center z-40">
                    <div className="max-w-5xl w-full flex flex-col gap-3">
                        {/* Tools Header */}
                        <div className="flex items-center justify-between px-1">
                            <div className="flex items-center gap-2">
                                <div className="w-1.5 h-3 bg-purple-500 rounded-full shadow-[0_0_8px_rgba(168,85,247,0.5)]" />
                                <span className="text-[10px] font-bold text-gray-400 uppercase tracking-widest">
                                    Vẽ hoặc sửa ảnh bằng AI
                                </span>
                            </div>
                            <div className="flex items-center gap-4">
                                <span className={`text-[10px] font-mono transition-opacity ${prompt.length > 0 ? 'opacity-40' : 'opacity-0'}`}>
                                    {prompt.length} characters
                                </span>
                                <div className="flex items-center gap-1 bg-gray-900/80 backdrop-blur-sm p-1 rounded-lg border border-gray-800 shadow-sm">
                                    <button
                                        onClick={handlePromptUndo}
                                        disabled={promptIndex <= 0}
                                        className="p-1.5 text-gray-400 hover:text-white hover:bg-gray-800 rounded transition-all disabled:opacity-20"
                                        title="Undo (Ctrl+Z)"
                                    >
                                        <Undo size={14} />
                                    </button>
                                    <div className="w-px h-3 bg-gray-800 mx-0.5" />
                                    <button
                                        onClick={handlePromptRedo}
                                        disabled={promptIndex >= promptHistory.length - 1}
                                        className="p-1.5 text-gray-400 hover:text-white hover:bg-gray-800 rounded transition-all disabled:opacity-20"
                                        title="Redo (Ctrl+Y)"
                                    >
                                        <Redo size={14} />
                                    </button>
                                </div>
                            </div>
                        </div>

                        {/* Input Row */}
                        <div className="flex items-end gap-3">
                            <div className="flex-1 relative group">
                                <textarea
                                    value={prompt}
                                    onChange={(e) => setPrompt(e.target.value)}
                                    rows={1}
                                    onKeyDown={(e) => {
                                        if (e.key === 'Enter' && !e.shiftKey) {
                                            e.preventDefault();
                                            handleGenerate();
                                        }
                                        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
                                            e.preventDefault();
                                            if (e.shiftKey) {
                                                handlePromptRedo();
                                            } else {
                                                handlePromptUndo();
                                            }
                                        }
                                        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
                                            e.preventDefault();
                                            handlePromptRedo();
                                        }
                                    }}
                                    placeholder={
                                        activeTab === 'layers' && referenceImages.length > 0 ? `Describe how to composite ${referenceImages.length} reference(s)...` :
                                            activeTab === 'layers' && styleRefImage ? "Describe style adjustments..." :
                                                "Describe what to change (e.g., 'Change hair to blue', 'Add a cat')..."
                                    }
                                    className="w-full bg-[#0d0d0d] border border-gray-700/50 rounded-2xl py-4 pl-6 pr-6 text-white placeholder-gray-500 focus:outline-none focus:border-purple-500/50 focus:ring-2 focus:ring-purple-500/10 shadow-inner text-base min-h-[60px] max-h-[160px] transition-all resize-none overflow-hidden"
                                    style={{ height: 'auto' }}
                                    onInput={(e) => {
                                        const target = e.target as HTMLTextAreaElement;
                                        target.style.height = 'auto';
                                        target.style.height = `${Math.min(target.scrollHeight, 160)}px`;
                                    }}
                                />
                            </div>

                            <div className="flex gap-3 h-[60px]">
                                <button
                                    onClick={handleGenerate}
                                    disabled={isGenerating || !prompt.trim()}
                                    className="h-full px-8 bg-gradient-to-br from-purple-600 via-purple-700 to-blue-800 hover:from-purple-500 hover:to-blue-700 text-white font-black rounded-2xl shadow-lg shadow-purple-900/20 transform transition-all active:scale-95 disabled:opacity-30 disabled:grayscale disabled:cursor-not-allowed flex items-center justify-center space-x-3 group/gen min-w-[180px]"
                                >
                                    {isGenerating ? (
                                        <div className="animate-spin rounded-full h-5 w-5 border-2 border-white/20 border-t-white"></div>
                                    ) : (
                                        <>
                                            <Wand2 size={20} className="group-hover/gen:rotate-12 transition-transform" />
                                            <span className="uppercase tracking-widest text-sm">Generate</span>
                                        </>
                                    )}
                                </button>

                                <button
                                    onClick={() => { onSave(currentImage, history, currentView); onClose(); }}
                                    className="h-full px-6 bg-white hover:bg-gray-50 text-black font-black rounded-2xl shadow-xl transition-all active:scale-95 flex items-center justify-center space-x-2 group/save border border-gray-200"
                                >
                                    <span className="uppercase tracking-widest text-sm text-black">💾 Save</span>
                                </button>

                                <button
                                    onClick={() => {
                                        if (currentImage) {
                                            const link = document.createElement('a');
                                            link.href = currentImage;
                                            link.download = `edited_image_${Date.now()}.png`;
                                            document.body.appendChild(link);
                                            link.click();
                                            document.body.removeChild(link);
                                        }
                                    }}
                                    disabled={!currentImage}
                                    className="h-full px-6 bg-green-600 hover:bg-green-500 text-white font-black rounded-2xl shadow-xl transition-all active:scale-95 flex items-center justify-center space-x-2 group/dl disabled:opacity-50"
                                >
                                    <Download size={18} className="group-hover/dl:translate-y-0.5 transition-transform" />
                                    <span className="uppercase tracking-widest text-sm">Download</span>
                                </button>
                            </div>
                        </div>
                    </div>
                </div>

                {isGenerating && loadingMessage && (
                    <div className="absolute bottom-32 left-1/2 transform -translate-x-1/2 bg-black/80 backdrop-blur text-white px-8 py-4 rounded-full shadow-2xl z-50 flex items-center space-x-4 border border-purple-500/50">
                        <div className="animate-spin rounded-full h-5 w-5 border-t-2 border-r-2 border-purple-500"></div>
                        <span className="font-medium tracking-wide animate-pulse">{loadingMessage}</span>
                    </div>
                )}

                {error && (
                    <div className="absolute bottom-24 left-1/2 transform -translate-x-1/2 bg-red-500/90 text-white px-6 py-3 rounded-full shadow-xl animate-bounce z-50">
                        ⚠️ {error}
                    </div>
                )}
            </div>
        </div>
    );
};
