import { useState, useCallback, useRef, useEffect } from 'react';
import { ProjectState, Character, Product, Scene } from '../types';
import { saveProject, openProject } from '../utils/fileUtils';
import { INITIAL_STATE } from '../constants/presets';
import { slugify } from '../utils/helpers';
import { saveState, loadState, clearState, PersistedState } from '../utils/stateManager';

// Debounce helper
let saveTimeout: NodeJS.Timeout | null = null;
const debouncedPersist = (state: ProjectState, delayMs: number = 3000) => {
    if (saveTimeout) clearTimeout(saveTimeout);
    saveTimeout = setTimeout(() => {
        // Convert to persistable format (strip base64 images to save space)
        const persistable: Partial<PersistedState> = {
            characters: state.characters.map(c => ({
                id: c.id,
                name: c.name,
                description: c.description || '',
                masterImageUrl: c.masterImage?.startsWith('http') ? c.masterImage : undefined,
                faceIdUrl: c.faceImage?.startsWith('http') ? c.faceImage : undefined,
            })),
            products: state.products.map(p => ({
                id: p.id,
                name: p.name,
                description: p.description || '',
                imageUrl: p.masterImage?.startsWith('http') ? p.masterImage : undefined,
            })),
            scenes: state.scenes.map(s => ({
                id: s.id,
                visualPrompt: s.contextDescription || '',
                audioPrompt: s.voiceover || '',
                duration: 5,
                characterId: s.characterIds?.[0],
                productId: s.productIds?.[0],
                cameraAngle: s.cameraAngle,
                transition: s.transitionType,
            })),
            settings: {
                stylePrompt: state.stylePrompt,
                customStyleInstruction: state.customStyleInstruction,
                imageModel: state.imageModel,
                aspectRatio: state.aspectRatio,
                resolution: state.resolution,
                scriptLanguage: state.scriptLanguage,
            },
            project: {
                name: state.projectName,
            },
        };
        saveState(persistable);
    }, delayMs);
};

export function useStateManager() {
    // Try to restore persisted state on first load
    const getInitialState = (): ProjectState => {
        const persisted = loadState();
        if (!persisted) return INITIAL_STATE;

        console.log('[StateManager] Restoring persisted state...');

        // Merge persisted data into initial state - only restore basic info
        const restoredCharacters: Character[] = persisted.characters?.map(c => ({
            ...INITIAL_STATE.characters[0], // Use default character as template
            id: c.id,
            name: c.name,
            description: c.description,
            masterImage: c.masterImageUrl || null,
            faceImage: c.faceIdUrl || null,
        })) || INITIAL_STATE.characters;

        const restoredProducts: Product[] = persisted.products?.map(p => ({
            id: p.id,
            name: p.name,
            description: p.description,
            masterImage: p.imageUrl || null,
            views: { front: null, back: null, left: null, right: null, top: null },
            isAnalyzing: false,
        })) || INITIAL_STATE.products;

        const restoredScenes: Scene[] = persisted.scenes?.map(s => ({
            ...INITIAL_STATE.scenes[0], // Use default scene template
            id: s.id,
            sceneNumber: '',
            language1: '',
            vietnamese: '',
            promptName: '',
            contextDescription: s.visualPrompt,
            voiceover: s.audioPrompt,
            characterIds: s.characterId ? [s.characterId] : [],
            productIds: s.productId ? [s.productId] : [],
            cameraAngle: s.cameraAngle,
            transitionType: s.transition,
            generatedImage: null,
            veoPrompt: '',
            isGenerating: false,
            error: null,
        })) || INITIAL_STATE.scenes;

        return {
            ...INITIAL_STATE,
            projectName: persisted.project?.name || '',
            characters: restoredCharacters,
            products: restoredProducts,
            scenes: restoredScenes,
            stylePrompt: persisted.settings?.stylePrompt || INITIAL_STATE.stylePrompt,
            customStyleInstruction: persisted.settings?.customStyleInstruction || '',
            imageModel: persisted.settings?.imageModel || INITIAL_STATE.imageModel,
            aspectRatio: persisted.settings?.aspectRatio || INITIAL_STATE.aspectRatio,
            resolution: persisted.settings?.resolution || INITIAL_STATE.resolution,
            scriptLanguage: persisted.settings?.scriptLanguage || INITIAL_STATE.scriptLanguage,
        };
    };

    const [state, setState] = useState<ProjectState>(getInitialState);
    const stateRef = useRef<ProjectState>(state);
    const [history, setHistory] = useState<{ past: ProjectState[], future: ProjectState[] }>({ past: [], future: [] });
    const isInitialMount = useRef(true);

    useEffect(() => {
        stateRef.current = state;
    }, [state]);

    // Auto-save when state changes (after initial mount)
    useEffect(() => {
        if (isInitialMount.current) {
            isInitialMount.current = false;
            return;
        }

        // Only save if there's meaningful content
        const hasContent = state.scenes.length > 0 ||
            state.characters.length > 1 ||
            state.products.length > 0 ||
            state.projectName.trim();

        if (hasContent) {
            debouncedPersist(state);
        }
    }, [state]);

    const updateStateAndRecord = useCallback((updater: (prevState: ProjectState) => ProjectState) => {
        setState(prevState => {
            const newState = updater(prevState);
            stateRef.current = newState; // Ensure ref is updated immediately for loops/async functions
            setHistory(h => {
                const newPast = [...h.past, prevState];
                if (newPast.length > 20) newPast.shift(); // Reduced from 50 to prevent memory bloat with base64 images
                return { past: newPast, future: [] };
            });
            return newState;
        });
    }, []);

    /**
     * Update state WITHOUT recording undo history.
     * Use this for batch operations (e.g., post-import image generation)
     * to prevent memory bloat from storing dozens of state snapshots
     * containing large base64 image strings.
     */
    const updateStateWithoutHistory = useCallback((updater: (prevState: ProjectState) => ProjectState) => {
        setState(prevState => {
            const newState = updater(prevState);
            stateRef.current = newState;
            return newState;
        });
    }, []);

    const undo = useCallback(() => {
        setHistory(h => {
            if (h.past.length === 0) return h;
            const previous = h.past[h.past.length - 1];
            const newPast = h.past.slice(0, h.past.length - 1);
            setState(previous);
            return { past: newPast, future: [state, ...h.future] };
        });
    }, [state]);

    const redo = useCallback(() => {
        setHistory(h => {
            if (h.future.length === 0) return h;
            const next = h.future[0];
            const newFuture = h.future.slice(1);
            setState(next);
            return { past: [...h.past, state], future: newFuture };
        });
    }, [state]);

    const handleSave = useCallback(() => {
        const filename = state.projectName ? `${slugify(state.projectName)}.json` : 'untitled-project.json';
        if (typeof saveProject !== 'undefined') {
            saveProject(state, filename);
        }
    }, [state]);

    const handleOpen = useCallback(() => {
        if (typeof openProject !== 'undefined') {
            openProject((loadedState: ProjectState) => {
                updateStateAndRecord(() => loadedState);
            });
        }
    }, [updateStateAndRecord]);

    const handleNewProject = useCallback(() => {
        const hasContent = state.scenes.length > 0 || state.characters.length > 1 || state.projectName.trim();
        if (hasContent) {
            if (!window.confirm('Bạn có chắc muốn tạo project mới? Mọi thay đổi chưa lưu sẽ bị mất!')) return;
        }
        // Clear persisted state when creating new project
        clearState();
        updateStateAndRecord(() => ({
            ...INITIAL_STATE,
            apiKey: state.apiKey,
            imageModel: state.imageModel,
            assetGallery: []
        }));
    }, [state.scenes.length, state.characters.length, state.projectName, state.apiKey, state.imageModel, updateStateAndRecord]);

    // Manual clear persisted state
    const clearPersistedState = useCallback(() => {
        clearState();
        console.log('[StateManager] Persisted state cleared');
    }, []);

    return {
        state,
        setState,
        stateRef,
        history,
        updateStateAndRecord,
        updateStateWithoutHistory,
        undo,
        redo,
        handleSave,
        handleOpen,
        handleNewProject,
        clearPersistedState
    };
}

