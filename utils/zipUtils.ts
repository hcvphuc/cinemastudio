import { ProjectState } from '../types';
import { slugify } from './helpers';

// @ts-ignore
const JSZip = window.JSZip;

/**
 * Ensures we have a valid Blob/Base64 for zip insertion.
 * - If dataURI: returns it directly (JSZip handles it).
 * - If URL (blob/http): fetches it and returns the Blob.
 * - Extracts extension from MIME type.
 */
const prepareImageForZip = async (source: string): Promise<{ data: string | Blob; ext: string } | null> => {
    if (!source) return null;

    try {
        // CASE 1: Data URI (base64)
        if (source.startsWith('data:')) {
            const match = source.match(/^data:image\/(\w+);base64,(.+)$/);
            if (match) {
                let mimeExt = match[1];
                let ext = 'png';
                if (['jpeg', 'jpg'].includes(mimeExt)) ext = 'jpg';
                else if (mimeExt === 'webp') ext = 'webp';
                else if (mimeExt === 'gif') ext = 'gif';
                else if (mimeExt !== 'png') ext = mimeExt;

                return { data: match[2], ext };
            }
        }

        // CASE 2: Blob URL (blob:http://...) - created by base64ToBlobUrl for memory optimization
        if (source.startsWith('blob:')) {
            const response = await fetch(source);
            const blob = await response.blob();
            const mimeType = blob.type || 'image/png';
            let ext = 'png';
            if (mimeType.includes('jpeg') || mimeType.includes('jpg')) ext = 'jpg';
            else if (mimeType.includes('webp')) ext = 'webp';
            return { data: blob, ext };
        }

        // CASE 3: URL (http:)
        const response = await fetch(source);
        const blob = await response.blob();
        const mimeType = blob.type;
        let ext = 'png';
        if (mimeType.includes('jpeg') || mimeType.includes('jpg')) ext = 'jpg';
        else if (mimeType.includes('webp')) ext = 'webp';

        return { data: blob, ext };

    } catch (error) {
        console.warn('Failed to fetch image for ZIP:', source?.substring(0, 80), error);
        return null;
    }
};

export const handleDownloadAll = async (state: ProjectState) => {
    if (!JSZip) {
        alert("JSZip not found. Please ensure it is loaded.");
        return;
    }

    const scenes = state.scenes || [];
    const characters = state.characters || [];
    const products = state.products || [];
    const projectSlug = state.projectName ? slugify(state.projectName) : 'project';

    // Helper: download a zip blob
    const downloadZipBlob = (content: Blob, filename: string) => {
        const link = document.createElement('a');
        link.href = URL.createObjectURL(content);
        link.download = filename;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    };

    // Helper: add scenes to a zip folder
    const addScenesToZip = async (scenesSubset: typeof scenes, startIdx: number, folder: any) => {
        let count = 0;
        for (let i = 0; i < scenesSubset.length; i++) {
            const scene = scenesSubset[i];
            if (scene.generatedImage) {
                const img = await prepareImageForZip(scene.generatedImage);
                if (img) {
                    const globalIdx = startIdx + i;
                    const sceneKey = scene.sceneNumber || scene.id || `idx${globalIdx}`;
                    const options = typeof img.data === 'string' ? { base64: true } : {};
                    folder?.file(`${String(globalIdx + 1).padStart(3, '0')}_${sceneKey}.${img.ext}`, img.data, options);
                    count++;
                }
            }
        }
        return count;
    };

    // Helper: add character/product assets
    const addAssetsToZip = async (zip: any) => {
        const assetsFolder = zip.folder("Assets");
        const charsFolder = assetsFolder?.folder("Characters");
        const productsFolder = assetsFolder?.folder("Products");
        let count = 0;

        for (const c of characters) {
            const cName = slugify(c.name) || c.id;
            const charImages = [
                { key: 'master', img: c.masterImage },
                { key: 'sheet', img: c.characterSheet },
                { key: 'face', img: c.faceImage },
                { key: 'body', img: c.bodyImage },
                { key: 'side', img: c.sideImage },
                { key: 'back', img: c.backImage },
            ];
            for (const item of charImages) {
                if (item.img) {
                    const img = await prepareImageForZip(item.img);
                    if (img) {
                        const options = typeof img.data === 'string' ? { base64: true } : {};
                        charsFolder?.file(`${cName}_${item.key}.${img.ext}`, img.data, options);
                        count++;
                    }
                }
            }
        }

        for (const p of products) {
            const pName = slugify(p.name) || p.id;
            if (p.masterImage) {
                const img = await prepareImageForZip(p.masterImage);
                if (img) {
                    const options = typeof img.data === 'string' ? { base64: true } : {};
                    productsFolder?.file(`${pName}_master.${img.ext}`, img.data, options);
                    count++;
                }
            }
            if (p.views) {
                for (const [key, viewImg] of Object.entries(p.views)) {
                    if (viewImg) {
                        const img = await prepareImageForZip(viewImg as string);
                        if (img) {
                            const options = typeof img.data === 'string' ? { base64: true } : {};
                            productsFolder?.file(`${pName}_${key}.${img.ext}`, img.data, options);
                            count++;
                        }
                    }
                }
            }
        }
        return count;
    };

    // Split scenes into 2 halves
    const mid = Math.ceil(scenes.length / 2);
    const scenesA = scenes.slice(0, mid);
    const scenesB = scenes.slice(mid);

    try {
        // === ZIP Part 1: First half of scenes + Assets ===
        const zip1 = new JSZip();
        const scenesFolder1 = zip1.folder("Scenes");
        const docsFolder1 = zip1.folder("Docs");

        const scriptContent = scenes.map(s => `[SCENE ${s.sceneNumber}] ${s.voiceOverText}`).join('\n\n');
        docsFolder1?.file("script_voiceover.txt", scriptContent);

        const sceneCount1 = await addScenesToZip(scenesA, 0, scenesFolder1);
        const assetCount = await addAssetsToZip(zip1);

        if (sceneCount1 + assetCount === 0) {
            alert("Không tìm thấy ảnh nào để tải xuống.");
            return;
        }

        console.log(`[ZIP] Part 1: ${sceneCount1} scenes + ${assetCount} assets`);
        const content1 = await zip1.generateAsync({ type: "blob", compression: "DEFLATE", compressionOptions: { level: 6 } });
        downloadZipBlob(content1, `${projectSlug}_Part1_Scenes1-${mid}.zip`);

        // === ZIP Part 2: Second half of scenes (only if exists) ===
        if (scenesB.length > 0) {
            // Small delay to avoid browser blocking multiple downloads
            await new Promise(r => setTimeout(r, 800));

            const zip2 = new JSZip();
            const scenesFolder2 = zip2.folder("Scenes");

            const sceneCount2 = await addScenesToZip(scenesB, mid, scenesFolder2);
            if (sceneCount2 > 0) {
                console.log(`[ZIP] Part 2: ${sceneCount2} scenes`);
                const content2 = await zip2.generateAsync({ type: "blob", compression: "DEFLATE", compressionOptions: { level: 6 } });
                downloadZipBlob(content2, `${projectSlug}_Part2_Scenes${mid + 1}-${scenes.length}.zip`);
            }
        }

        alert(`✅ Đã tải ${scenesB.length > 0 ? '2 file ZIP' : '1 file ZIP'} thành công!`);

    } catch (e: any) {
        console.error('ZIP generation failed:', e);
        alert(`Lỗi tạo ZIP: ${e.message || e}. Thử xóa bớt ảnh cũ hoặc dùng Save Project.`);
    }
};

/* 
 * =========================================================================================
 *  PROJECT PACKAGE SYSTEM (SAVE/LOAD ZIP)
 * =========================================================================================
 *  Allows saving the entire project as a ZIP file including:
 *  - project.json: The state with image PATHS instead of base64
 *  - script.txt: Readable script
 *  - assets/: Folder containing all images
 */

const blobToBase64 = (blob: Blob): Promise<string> => {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result as string);
        reader.onerror = reject;
        reader.readAsDataURL(blob);
    });
};

export const saveProjectPackage = async (state: ProjectState) => {
    try {
        if (!JSZip) {
            alert("JSZip library not detected. Please ensure it is loaded.");
            return;
        }

        const zip = new JSZip();
        const assetsFolder = zip.folder("assets"); // Folder for images

        // Manual Clone to avoid JSON.stringify limit (V8 string limit) and ensure safety
        // We only deep-clone the arrays containing images we modify
        // DEFENSIVE CODING: Use (array || []) to prevent crashes on legacy projects missing fields
        const safeCharacters = (state.characters || []).map(c => ({
            ...c,
            props: Array.isArray(c.props) ? c.props.map(p => ({ ...p })) : []
        }));

        const safeProducts = (state.products || []).map(p => ({
            ...p,
            masterImage: p.masterImage,
            views: p.views ? { ...p.views } : undefined
        }));

        const safeScenes = (state.scenes || []).map(s => ({ ...s }));

        const safeGallery = state.assetGallery ? state.assetGallery.map(a => ({ ...a })) : undefined;

        const safeState: ProjectState = {
            ...state,
            characters: safeCharacters,
            products: safeProducts,
            scenes: safeScenes,
            assetGallery: safeGallery
        };

        let assetCount = 0;

        // Helper: Save image to zip and update path in state
        const processImageField = async (imageSource: string | null | undefined, filenameNoExt: string): Promise<string | null> => {
            if (!imageSource) return null;

            // Use our robust fetcher
            const img = await prepareImageForZip(imageSource);
            if (img) {
                const filename = `${filenameNoExt}.${img.ext}`;
                const path = `assets/${filename}`;

                // Add to zip (handle base64 string or blob)
                const options = typeof img.data === 'string' ? { base64: true } : {};
                assetsFolder?.file(filename, img.data, options);
                assetCount++;

                return path; // Return relative path for JSON
            }
            return null; // Keep original if fetch fails? Or null. Let's return null to avoid broken links.
        };

        // 1. Process Characters
        for (const c of safeState.characters) {
            if (c.masterImage) c.masterImage = await processImageField(c.masterImage, `char_${c.id}_master`);
            if ((c as any).characterSheet) (c as any).characterSheet = await processImageField((c as any).characterSheet, `char_${c.id}_sheet`);
            if (c.faceImage) c.faceImage = await processImageField(c.faceImage, `char_${c.id}_face`);
            if (c.bodyImage) c.bodyImage = await processImageField(c.bodyImage, `char_${c.id}_body`);
            if (c.sideImage) c.sideImage = await processImageField(c.sideImage, `char_${c.id}_side`);
            if (c.backImage) c.backImage = await processImageField(c.backImage, `char_${c.id}_back`);

            // Handle Props
            if (c.props) {
                for (let i = 0; i < c.props.length; i++) {
                    if (c.props[i].image) {
                        c.props[i].image = await processImageField(c.props[i].image, `char_${c.id}_prop_${i}`);
                    }
                }
            }
        }

        // 2. Process Products
        for (const p of safeState.products) {
            if (p.masterImage) p.masterImage = await processImageField(p.masterImage, `prod_${p.id}_master`);
            if (p.views) {
                if (p.views.front) p.views.front = await processImageField(p.views.front, `prod_${p.id}_front`);
                if (p.views.back) p.views.back = await processImageField(p.views.back, `prod_${p.id}_back`);
                if (p.views.left) p.views.left = await processImageField(p.views.left, `prod_${p.id}_left`);
                if (p.views.right) p.views.right = await processImageField(p.views.right, `prod_${p.id}_right`);
                if (p.views.top) p.views.top = await processImageField(p.views.top, `prod_${p.id}_top`);
            }
        }

        // 3. Process Scenes — use index + id for unique filenames (sceneNumber may be empty/duplicate!)
        for (let i = 0; i < safeState.scenes.length; i++) {
            const s = safeState.scenes[i];
            const sceneKey = s.sceneNumber || s.id || `idx${i}`;
            if (s.generatedImage) s.generatedImage = await processImageField(s.generatedImage, `scene_${String(i).padStart(3, '0')}_${sceneKey}_gen`);
            if (s.referenceImage) s.referenceImage = await processImageField(s.referenceImage, `scene_${String(i).padStart(3, '0')}_${sceneKey}_ref`);
            if (s.endFrameImage) s.endFrameImage = await processImageField(s.endFrameImage, `scene_${String(i).padStart(3, '0')}_${sceneKey}_end`);
        }

        // 4. Process Gallery
        if (safeState.assetGallery) {
            for (const a of safeState.assetGallery) {
                if (a.image) a.image = await processImageField(a.image, `gallery_${a.id}`);
            }
        }

        // 5. Custom Style Image
        if (safeState.customStyleImage) {
            safeState.customStyleImage = await processImageField(safeState.customStyleImage, `style_custom_ref`);
        }

        console.log(`[Save Package] Processed ${assetCount} images.`);

        // 6. Save JSON
        zip.file("project.json", JSON.stringify(safeState, null, 2));

        // 7. Save Read-only Script
        const scriptContent = (state.scenes || []).map(s => `[SCENE ${s.sceneNumber}] ${s.voiceOverText || ''}`).join('\n\n');
        zip.file("script_voiceover.txt", scriptContent);

        // Download — use streamFiles to reduce memory peak
        try {
            const content = await zip.generateAsync({
                type: "blob",
                compression: "DEFLATE",
                compressionOptions: { level: 6 },
                streamFiles: true  // Process files one at a time to reduce memory
            });
            const filename = state.projectName ? `${slugify(state.projectName)}_PROJECT.zip` : 'project_package.zip';
            const link = document.createElement('a');
            link.href = URL.createObjectURL(content);
            link.download = filename;
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
            setTimeout(() => URL.revokeObjectURL(link.href), 1000);
        } catch (zipError: any) {
            console.error("ZIP generation failed:", zipError);
            alert(`Lỗi tạo ZIP: ${zipError.message || zipError}.\nDự án quá lớn — thử dùng "Download All" (sẽ tự tách 2 file ZIP nhỏ hơn).`);
        }

    } catch (error) {
        console.error("Failed to save project package:", error);
        alert("Lỗi khi lưu dự án ZIP (Code): " + (error instanceof Error ? error.message : String(error)));
    }
};

export const loadProjectPackage = async (file: File): Promise<ProjectState> => {
    if (!JSZip) throw new Error("JSZip not loaded");

    const zip = await new JSZip().loadAsync(file);

    // 1. Read project.json
    const jsonFile = zip.file("project.json");
    if (!jsonFile) throw new Error("Invalid Project Package: Missing project.json");

    const jsonStr = await jsonFile.async("string");
    const state = JSON.parse(jsonStr) as ProjectState;

    // Helper: Restore image from zip path — returns Blob URL (memory efficient)
    const restoreImage = async (path: string | null | undefined): Promise<string | null> => {
        if (!path || !path.startsWith('assets/')) return path || null;

        const imgFile = zip.file(path);
        if (imgFile) {
            const blob = await imgFile.async("blob");
            // Return Blob URL instead of base64 to save memory
            return URL.createObjectURL(blob);
        }
        return null;
    };

    // 2. Restore Characters
    if (state.characters) {
        for (const c of state.characters) {
            c.masterImage = await restoreImage(c.masterImage);
            if ((c as any).characterSheet !== undefined) (c as any).characterSheet = await restoreImage((c as any).characterSheet);
            c.faceImage = await restoreImage(c.faceImage);
            c.bodyImage = await restoreImage(c.bodyImage);
            c.sideImage = await restoreImage(c.sideImage);
            c.backImage = await restoreImage(c.backImage);

            if (c.props) {
                for (const p of c.props) {
                    p.image = await restoreImage(p.image);
                }
            }
        }
    }

    // 3. Restore Products
    if (state.products) {
        for (const p of state.products) {
            p.masterImage = await restoreImage(p.masterImage);
            if (p.views) {
                p.views.front = await restoreImage(p.views.front);
                p.views.back = await restoreImage(p.views.back);
                p.views.left = await restoreImage(p.views.left);
                p.views.right = await restoreImage(p.views.right);
                p.views.top = await restoreImage(p.views.top);
            }
        }
    }

    // 4. Restore Scenes
    if (state.scenes) {
        for (const s of state.scenes) {
            s.generatedImage = await restoreImage(s.generatedImage);
            s.referenceImage = await restoreImage(s.referenceImage);
            s.endFrameImage = await restoreImage(s.endFrameImage);

            // Auto-fill voiceover from existing text if not present (migration for old projects)
            if (!s.voiceover && (s.voiceOverText || s.language1 || s.vietnamese || s.contextDescription)) {
                s.voiceover = s.voiceOverText || s.language1 || s.vietnamese || s.contextDescription || '';
                console.log(`[ZIP Migration] Scene ${s.sceneNumber || s.id}: auto-filled voiceover`);
            }
        }
    }

    // 5. Restore Gallery
    if (state.assetGallery) {
        for (const a of state.assetGallery) {
            a.image = await restoreImage(a.image);
        }
    }

    // 6. Custom Style Image
    state.customStyleImage = await restoreImage(state.customStyleImage);

    return state;
};
