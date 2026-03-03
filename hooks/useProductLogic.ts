import { useCallback } from 'react';
import { GoogleGenAI } from "@google/genai";
import { ProjectState, Product } from '../types';
import { generateId } from '../utils/helpers';
import { callGeminiAPI } from '../utils/geminiUtils';
import { uploadImageToSupabase, syncUserStatsToCloud } from '../utils/storageUtils';

export function useProductLogic(
    state: ProjectState,
    updateStateAndRecord: (updater: (prevState: ProjectState) => ProjectState) => void,
    userApiKey: string | null,
    setApiKeyModalOpen: (open: boolean) => void,
    userId?: string,
    addToGallery?: (image: string, type: string, prompt?: string, sourceId?: string) => void,
    setAgentState?: (agent: 'director' | 'dop', status: any, message?: string, stage?: string) => void

) {
    const addProduct = useCallback(() => {
        const newProduct: Product = {
            id: generateId(),
            name: '',
            description: '',
            masterImage: null,
            views: { front: null, back: null, left: null, right: null, top: null },
            isAnalyzing: false
        };
        updateStateAndRecord(s => ({ ...s, products: [...(s.products || []), newProduct] }));
    }, [updateStateAndRecord]);

    const deleteProduct = useCallback((id: string) => {
        setTimeout(() => {
            if (window.confirm('Delete this product?')) {
                updateStateAndRecord(s => ({ ...s, products: s.products.filter(p => p.id !== id) }));
            }
        }, 100);
    }, [updateStateAndRecord]);

    const updateProduct = useCallback((id: string, updates: Partial<Product>) => {
        updateStateAndRecord(s => ({
            ...s,
            products: (s.products || []).map(p => p.id === id ? { ...p, ...updates } : p)
        }));
    }, [updateStateAndRecord]);

    const handleProductMasterImageUpload = useCallback(async (id: string, image: string) => {
        const rawApiKey = userApiKey || (process.env as any).API_KEY;
        const apiKey = typeof rawApiKey === 'string' ? rawApiKey.trim() : rawApiKey;
        updateProduct(id, { masterImage: image, isAnalyzing: true });

        if (!apiKey) {
            updateProduct(id, { isAnalyzing: false });
            setApiKeyModalOpen(true);
            return;
        }

        try {
            const ai = new GoogleGenAI({ apiKey });
            let data: string;
            let mimeType: string = 'image/jpeg';
            let finalMasterUrl = image;

            if (image.startsWith('data:')) {
                const [header, b64] = image.split(',');
                mimeType = header.match(/:(.*?);/)?.[1] || 'image/jpeg';
                data = b64;

                if (userId) {
                    try {
                        finalMasterUrl = await uploadImageToSupabase(image, 'project-assets', `${userId}/products/${id}_master_${Date.now()}.jpg`);
                    } catch (e) {
                        console.error("Cloud upload failed for product master", e);
                    }
                }
            } else {
                const response = await fetch(image);
                const blob = await response.blob();
                mimeType = blob.type;
                data = await new Promise((resolve) => {
                    const reader = new FileReader();
                    reader.onloadend = () => resolve((reader.result as string).split(',')[1]);
                    reader.readAsDataURL(blob);
                });
            }

            const analyzePrompt = `Analyze this PRODUCT/PROP image. Return JSON: {"name": "Product Name", "description": "Detailed physical description."}`;
            const analysisRes = await ai.models.generateContent({
                model: 'gemini-2.5-flash',
                contents: { parts: [{ inlineData: { data, mimeType } }, { text: analyzePrompt }] },
                config: { responseMimeType: "application/json" }
            });

            let json = { name: "", description: "" };
            try {
                json = JSON.parse(analysisRes.text.replace(/```json/g, '').replace(/```/g, '').trim());
            } catch (e) {
                console.error("JSON parse error", e);
            }

            updateProduct(id, { masterImage: finalMasterUrl, name: json.name, description: json.description });

            const referenceImage = `data:${mimeType};base64,${data}`;
            const promptTemplate = (viewInfo: string) => `(STRICT REFERENCE: EXACT REPLICA) Generate a ${viewInfo} of the product described: ${json.description}. BACKGROUND: Pure Solid White Studio Background. STYLE: Product Photography.`.trim();

            let [front, back, left, right, top] = await Promise.all([
                callGeminiAPI(apiKey, promptTemplate('OFFICIAL FRONT VIEW (0 degrees)'), '1:1', 'gemini-3-pro-image-preview', referenceImage),
                callGeminiAPI(apiKey, promptTemplate('OFFICIAL BACK VIEW (180 degrees)'), '1:1', 'gemini-3-pro-image-preview', referenceImage),
                callGeminiAPI(apiKey, promptTemplate('OFFICIAL LEFT PROFILE VIEW (90 degrees)'), '1:1', 'gemini-3-pro-image-preview', referenceImage),
                callGeminiAPI(apiKey, promptTemplate('OFFICIAL RIGHT PROFILE VIEW (90 degrees)'), '1:1', 'gemini-3-pro-image-preview', referenceImage),
                callGeminiAPI(apiKey, promptTemplate('TOP-DOWN BIRD\'S EYE VIEW'), '1:1', 'gemini-3-pro-image-preview', referenceImage),
            ]);

            if (userId) {
                const uploadPromises = [
                    (front?.startsWith('data:') || front?.startsWith('blob:')) ? uploadImageToSupabase(front, 'project-assets', `${userId}/products/${id}_front_${Date.now()}.jpg`) : Promise.resolve(front),
                    (back?.startsWith('data:') || back?.startsWith('blob:')) ? uploadImageToSupabase(back, 'project-assets', `${userId}/products/${id}_back_${Date.now()}.jpg`) : Promise.resolve(back),
                    (left?.startsWith('data:') || left?.startsWith('blob:')) ? uploadImageToSupabase(left, 'project-assets', `${userId}/products/${id}_left_${Date.now()}.jpg`) : Promise.resolve(left),
                    (right?.startsWith('data:') || right?.startsWith('blob:')) ? uploadImageToSupabase(right, 'project-assets', `${userId}/products/${id}_right_${Date.now()}.jpg`) : Promise.resolve(right),
                    (top?.startsWith('data:') || top?.startsWith('blob:')) ? uploadImageToSupabase(top, 'project-assets', `${userId}/products/${id}_top_${Date.now()}.jpg`) : Promise.resolve(top),
                ];
                [front, back, left, right, top] = await Promise.all(uploadPromises);
            }

            updateProduct(id, { views: { front, back, left, right, top }, isAnalyzing: false });

            if (addToGallery) {
                if (front) addToGallery(front, 'product', `Front View: ${json.name}`, id);
                if (back) addToGallery(back, 'product', `Back View: ${json.name}`, id);
                if (left) addToGallery(left, 'product', `Left View: ${json.name}`, id);
                if (right) addToGallery(right, 'product', `Right View: ${json.name}`, id);
                if (top) addToGallery(top, 'product', `Top View: ${json.name}`, id);
            }

            // Count generated product views and sync stats
            const viewCount = [front, back, left, right, top].filter(Boolean).length;
            updateStateAndRecord(s => {
                const currentStats = s.usageStats || { '1K': 0, '2K': 0, '4K': 0, total: 0 };
                const updatedStats = {
                    ...currentStats,
                    total: (currentStats.total || 0) + viewCount,
                    products: (currentStats.products || 0) + viewCount,
                    lastGeneratedAt: new Date().toISOString()
                };
                if (userId) syncUserStatsToCloud(userId, updatedStats);
                return { ...s, usageStats: updatedStats };
            });
        } catch (error) {
            console.error("Product Analysis Error:", error);
            updateProduct(id, { isAnalyzing: false });
        }
    }, [userApiKey, updateProduct, setApiKeyModalOpen, userId]);

    const handleGenerateProductFromPrompt = useCallback(async (id: string, description: string) => {
        if (!description.trim()) {
            alert("Vui lòng nhập mô tả sản phẩm trước.");
            return;
        }

        updateProduct(id, { isAnalyzing: true });
        const rawApiKey = userApiKey || (process.env as any).API_KEY;
        const apiKey = typeof rawApiKey === 'string' ? rawApiKey.trim() : rawApiKey;

        if (!apiKey) {
            updateProduct(id, { isAnalyzing: false });
            alert("Cần API Key (Gemini) để tạo sản phẩm.");
            setApiKeyModalOpen(true);
            return;
        }

        try {
            const masterPrompt = `Professional product photography of ${description}. Studio lighting, white background, 8K detail, centered, front view, high quality product shot.`;
            const masterImage = await callGeminiAPI(apiKey, masterPrompt, '1:1');
            if (masterImage) {
                updateProduct(id, { masterImage: masterImage });
                await handleProductMasterImageUpload(id, masterImage);
            } else {
                updateProduct(id, { isAnalyzing: false });
                alert("Không thể tạo ảnh sản phẩm bằng Gemini. Vui lòng thử lại.");
            }
        } catch (err) {
            console.error("Gemini Product Gen Error:", err);
            updateProduct(id, { isAnalyzing: false });
            alert("Lỗi khi tạo sản phẩm. Vui lòng kiểm tra API Key.");
        }
    }, [userApiKey, updateProduct, handleProductMasterImageUpload, setApiKeyModalOpen, userId]);

    return {
        addProduct,
        deleteProduct,
        updateProduct,
        handleProductMasterImageUpload,
        handleGenerateProductFromPrompt
    };
}
