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

    const zip = new JSZip();
    const scenesFolder = zip.folder("Scenes");
    const assetsFolder = zip.folder("Assets");
    const charsFolder = assetsFolder?.folder("Characters");
    const productsFolder = assetsFolder?.folder("Products");
    const docsFolder = zip.folder("Docs");

    let fileCount = 0;

    // 0. Include Script Text
    const scenes = state.scenes || []; // Defensive
    const scriptContent = scenes.map(s => `[SCENE ${s.sceneNumber}] ${s.voiceOverText}`).join('\n\n');
    docsFolder?.file("script_voiceover.txt", scriptContent);

    // 1. SCENE MAP IMAGES
    const scenePromises = scenes.map(async (scene, idx) => {
        if (scene.generatedImage) {
            const img = await prepareImageForZip(scene.generatedImage);
            if (img) {
                // Use index + sceneNumber for unique filenames (sceneNumber may be empty!)
                const sceneKey = scene.sceneNumber || scene.id || `idx${idx}`;
                const options = typeof img.data === 'string' ? { base64: true } : {};
                scenesFolder?.file(`${String(idx + 1).padStart(3, '0')}_${sceneKey}.${img.ext}`, img.data, options);
                fileCount++;
            }
        }
    });

    // 2. ASSETS - Characters
    const characters = state.characters || []; // Defensive
    const charPromises = characters.map(async (c) => {
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
                    fileCount++;
                }
            }
        }
    });

    // 3. ASSETS - Products
    const products = state.products || []; // Defensive
    const prodPromises = products.map(async (p) => {
        const pName = slugify(p.name) || p.id;

        // Master image
        if (p.masterImage) {
            const img = await prepareImageForZip(p.masterImage);
            if (img) {
                const options = typeof img.data === 'string' ? { base64: true } : {};
                productsFolder?.file(`${pName}_master.${img.ext}`, img.data, options);
                fileCount++;
            }
        }

        // Views
        if (p.views) {
            const viewImages = [
                { key: 'front', img: p.views.front },
                { key: 'back', img: p.views.back },
                { key: 'left', img: p.views.left },
                { key: 'right', img: p.views.right },
                { key: 'top', img: p.views.top },
            ];
            for (const item of viewImages) {
                if (item.img) {
                    const img = await prepareImageForZip(item.img);
                    if (img) {
                        const options = typeof img.data === 'string' ? { base64: true } : {};
                        productsFolder?.file(`${pName}_${item.key}.${img.ext}`, img.data, options);
                        fileCount++;
                    }
                }
            }
        }
    });

    // Wait for all fetches
    await Promise.all([...scenePromises, ...charPromises, ...prodPromises]);

    if (fileCount === 0) {
        alert("Không tìm thấy ảnh nào (Scenes/Characters/Products) để tải xuống.");
        return;
    }

    // Generate and download
    try {
        const content = await zip.generateAsync({ type: "blob", compression: "DEFLATE", compressionOptions: { level: 6 } });
        const filename = state.projectName ? `${slugify(state.projectName)}_full.zip` : 'project-assets.zip';
        const link = document.createElement('a');
        link.href = URL.createObjectURL(content);
        link.download = filename;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(link.href);
    } catch (e: any) {
        console.error('ZIP generation failed:', e);
        alert(`Lỗi tạo ZIP: ${e.message || e}. Dự án quá lớn — thử xóa bớt ảnh cũ hoặc dùng Save Project thay vì Download All.`);
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
        // Defensive access for script content as well
        const scriptContent = (state.scenes || []).map(s => `[SCENE ${s.sceneNumber}] ${s.voiceOverText || ''}`).join('\n\n');
        zip.file("script_voiceover.txt", scriptContent);

        // Download
        const content = await zip.generateAsync({ type: "blob", compression: "DEFLATE", compressionOptions: { level: 6 } });
        const filename = state.projectName ? `${slugify(state.projectName)}_PROJECT.zip` : 'project_package.zip';
        const link = document.createElement('a');
        link.href = URL.createObjectURL(content);
        link.download = filename;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(link.href);

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
