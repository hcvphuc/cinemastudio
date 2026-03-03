/**
 * useExcelImport Hook
 * 
 * Parses Excel/CSV files and converts them into Scene, SceneGroup, Character, and Product data
 * for bootstrapping a new project.
 * 
 * Enhanced: Automatically extracts character descriptions and products/props from scene text.
 */

import { useCallback, useState } from 'react';
import * as XLSX from 'xlsx';
import { Scene, SceneGroup, Character, Product } from '../types';
import { generateId } from '../utils/helpers';

export interface ExcelImportResult {
    scenes: Scene[];
    groups: SceneGroup[];
    characters: Character[];
    products: Product[];
}

export interface ColumnMapping {
    sceneNumber: string;
    group: string;
    voiceOver: string;
    dialogue: string;
    dialogueSpeaker: string;
    visualContext: string;
    cameraAngle: string;
    lens: string;
    characterNames: string;
    productNames: string;
    isKeyFrame: string;
}

const DEFAULT_MAPPING: ColumnMapping = {
    sceneNumber: 'scene_number',
    group: 'group',
    voiceOver: 'voice_over',
    dialogue: 'dialogue',
    dialogueSpeaker: 'dialogue_speaker',
    visualContext: 'visual_context',
    cameraAngle: 'camera_angle',
    lens: 'lens',
    characterNames: 'character_names',
    productNames: 'product_names',
    isKeyFrame: 'is_key_frame'
};

export function useExcelImport() {
    const [isProcessing, setIsProcessing] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [previewData, setPreviewData] = useState<any[] | null>(null);
    const [headers, setHeaders] = useState<string[]>([]);

    /**
     * Parse Excel or CSV file and extract headers + preview rows
     */
    const parseFile = useCallback(async (file: File): Promise<{ headers: string[]; rows: any[] }> => {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();

            reader.onload = (e) => {
                try {
                    const data = e.target?.result;
                    const workbook = XLSX.read(data, { type: 'binary' });
                    const sheetName = workbook.SheetNames[0];
                    const sheet = workbook.Sheets[sheetName];
                    const jsonData = XLSX.utils.sheet_to_json(sheet, { header: 1 }) as any[][];

                    if (jsonData.length < 2) {
                        reject(new Error('File must have at least a header row and one data row.'));
                        return;
                    }

                    const headers = (jsonData[0] as string[]).map(h => String(h || '').toLowerCase().trim());
                    const rows = jsonData.slice(1).map(row => {
                        const obj: Record<string, any> = {};
                        headers.forEach((header, i) => {
                            obj[header] = row[i] ?? '';
                        });
                        return obj;
                    }).filter(row => Object.values(row).some(v => v !== ''));

                    resolve({ headers, rows });
                } catch (err: any) {
                    reject(new Error(`Failed to parse file: ${err.message}`));
                }
            };

            reader.onerror = () => reject(new Error('Failed to read file.'));
            reader.readAsBinaryString(file);
        });
    }, []);

    /**
     * Load file for preview
     */
    const loadPreview = useCallback(async (file: File) => {
        setIsProcessing(true);
        setError(null);
        try {
            const { headers, rows } = await parseFile(file);
            setHeaders(headers);
            setPreviewData(rows.slice(0, 5)); // Preview first 5 rows
            return { headers, rowCount: rows.length };
        } catch (err: any) {
            setError(err.message);
            return null;
        } finally {
            setIsProcessing(false);
        }
    }, [parseFile]);

    /**
     * Import file with column mapping and generate project data
     */
    const importFile = useCallback(async (
        file: File,
        mapping: ColumnMapping
    ): Promise<ExcelImportResult | null> => {
        setIsProcessing(true);
        setError(null);

        try {
            const { rows } = await parseFile(file);

            // 1. Extract unique groups
            const groupNames = new Set<string>();
            rows.forEach(row => {
                const groupName = String(row[mapping.group] || 'Default Group').trim();
                if (groupName) groupNames.add(groupName);
            });

            const groupMap: Record<string, SceneGroup> = {};
            Array.from(groupNames).forEach((name, index) => {
                const id = generateId();
                groupMap[name.toLowerCase()] = {
                    id,
                    name,
                    description: name,
                    timeOfDay: 'morning',
                    weather: 'clear'
                };
            });

            // 2. Extract unique character names
            const charNames = new Set<string>();
            rows.forEach(row => {
                const names = String(row[mapping.characterNames] || '').split(',').map(n => n.trim()).filter(Boolean);
                names.forEach(n => charNames.add(n));
            });

            const charMap: Record<string, Character> = {};
            Array.from(charNames).forEach(name => {
                const id = generateId();
                // Extract description from all scene rows mentioning this character
                const description = buildCharacterDescription(name, rows, mapping);
                charMap[name.toLowerCase()] = {
                    id,
                    name,
                    description, // Auto-extracted from script scenes
                    faceImage: null,
                    masterImage: null,
                    bodyImage: null,
                    sideImage: null,
                    backImage: null,
                    props: [],
                    isDefault: false
                };
            });

            // 2b. Extract products/props from scene descriptions
            const productMap = extractProductsFromScenes(rows, mapping);

            // 3. Create scenes
            const scenes: Scene[] = [];
            rows.forEach((row, index) => {
                const groupName = String(row[mapping.group] || 'Default Group').trim().toLowerCase();
                const group = groupMap[groupName];

                const charNamesInRow = String(row[mapping.characterNames] || '').split(',').map(n => n.trim().toLowerCase()).filter(Boolean);
                const characterIds = charNamesInRow.map(n => charMap[n]?.id).filter(Boolean) as string[];

                const visualContext = String(row[mapping.visualContext] || '').trim();
                if (!visualContext) return; // Skip empty rows

                const sceneNumber = row[mapping.sceneNumber] ? String(row[mapping.sceneNumber]) : String(index + 1);

                const dialogueSpeaker = String(row[mapping.dialogueSpeaker] || '').trim();
                const dialogueText = String(row[mapping.dialogue] || '').trim();
                const formattedDialogue = dialogueSpeaker && dialogueText
                    ? `${dialogueSpeaker}: ${dialogueText}`
                    : dialogueText;

                const scene: Scene = {
                    id: generateId(),
                    sceneNumber,
                    groupId: group?.id || '',
                    language1: formattedDialogue,
                    vietnamese: '',
                    promptName: `Scene ${sceneNumber}`,
                    voiceOverText: String(row[mapping.voiceOver] || '').trim(),
                    isVOScene: Boolean(row[mapping.voiceOver]),
                    contextDescription: visualContext,
                    characterIds,
                    productIds: [],
                    generatedImage: null,
                    veoPrompt: '',
                    isGenerating: false,
                    error: null,
                    cameraAngleOverride: row[mapping.cameraAngle] || undefined,
                    lensOverride: row[mapping.lens] || undefined,
                    isKeyFrame: String(row[mapping.isKeyFrame] || '').toLowerCase() === 'true'
                };

                scenes.push(scene);
            });

            const result: ExcelImportResult = {
                scenes,
                groups: Object.values(groupMap),
                characters: Object.values(charMap),
                products: Object.values(productMap)
            };

            console.log('[ExcelImport] ✅ Import complete:', {
                scenes: result.scenes.length,
                groups: result.groups.length,
                characters: result.characters.length
            });

            return result;

        } catch (err: any) {
            setError(err.message);
            return null;
        } finally {
            setIsProcessing(false);
        }
    }, [parseFile]);

    /**
     * Auto-detect column mapping from headers
     */
    const autoDetectMapping = useCallback((fileHeaders: string[]): ColumnMapping => {
        const mapping = { ...DEFAULT_MAPPING };
        const lowerHeaders = fileHeaders.map(h => h.toLowerCase());

        // Try to match each field
        const detectField = (field: keyof ColumnMapping, patterns: string[]) => {
            const match = lowerHeaders.find(h => patterns.some(p => h.includes(p)));
            if (match) mapping[field] = match;
        };

        detectField('sceneNumber', ['scene', 'number', 'stt', 'no.']);
        detectField('group', ['group', 'chapter', 'chương', 'nhóm', 'location']);
        detectField('voiceOver', ['voice', 'narration', 'vo', 'thuyết minh', 'lời dẫn']);
        detectField('dialogue', ['dialogue', 'dialog', 'lời thoại', 'thoại']);
        detectField('dialogueSpeaker', ['speaker', 'người nói', 'nhân vật nói']);
        detectField('visualContext', ['visual', 'context', 'prompt', 'description', 'mô tả', 'hình ảnh']);
        detectField('cameraAngle', ['camera', 'angle', 'góc máy', 'shot']);
        detectField('lens', ['lens', 'ống kính', 'focal']);
        detectField('characterNames', ['character', 'nhân vật', 'actor']);
        detectField('productNames', ['product', 'prop', 'sản phẩm', 'đạo cụ']);
        detectField('isKeyFrame', ['key', 'keyframe', 'hero', 'main']);

        return mapping;
    }, []);

    return {
        isProcessing,
        error,
        previewData,
        headers,
        loadPreview,
        importFile,
        autoDetectMapping,
        DEFAULT_MAPPING
    };
}

// ═══════════════════════════════════════════════════════════════════
// HELPER FUNCTIONS - Character & Product Extraction from Script Text
// ═══════════════════════════════════════════════════════════════════

/**
 * Extract character description from all scene rows where this character appears.
 * Looks for parenthetical descriptions like "(45, power suit, blonde hair slicked back)"
 * and camera stage directions like "[CAMERA: Pan to MARGARET - 72, gray hair, worn cardigan]"
 */
function buildCharacterDescription(charName: string, rows: any[], mapping: ColumnMapping): string {
    const nameLower = charName.toLowerCase();
    const fragments: string[] = [];
    const seen = new Set<string>();

    for (const row of rows) {
        // Search in all text-heavy columns
        const textsToScan = [
            String(row[mapping.visualContext] || ''),
            String(row[mapping.voiceOver] || ''),
            String(row[mapping.dialogue] || ''),
            // Also check common extra columns from detailed CSVs
            String(row['full_script_content'] || row['full_voiceover_text'] || ''),
            String(row['scene_description'] || ''),
        ].join(' ');

        if (!textsToScan.toLowerCase().includes(nameLower)) continue;

        // Strategy 1: Extract parenthetical descriptions after character name
        // e.g., "KAREN WHITFIELD (45, HOA President, power suit, blonde hair slicked back)"
        const parenRegex = new RegExp(
            charName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\(([^)]+)\\)',
            'gi'
        );
        let parenMatch;
        while ((parenMatch = parenRegex.exec(textsToScan)) !== null) {
            const desc = parenMatch[1].trim();
            if (desc.length > 5 && !seen.has(desc.toLowerCase())) {
                seen.add(desc.toLowerCase());
                fragments.push(desc);
            }
        }

        // Strategy 2: Extract camera stage directions describing the character
        // e.g., "[CAMERA: Pan to MARGARET THOMPSON - 72, gray hair in simple bun, worn beige cardigan]"
        // or "** Pan to MARGARET THOMPSON - 72, gray hair..."
        const dashRegex = new RegExp(
            charName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*[-–—]\\s*([^\\]\\*\\n]+)',
            'gi'
        );
        let dashMatch;
        while ((dashMatch = dashRegex.exec(textsToScan)) !== null) {
            const desc = dashMatch[1].trim().replace(/\]$/, '').trim();
            if (desc.length > 5 && !seen.has(desc.toLowerCase())) {
                seen.add(desc.toLowerCase());
                fragments.push(desc);
            }
        }

        // Strategy 3: Visual context that directly names the character with descriptors
        // e.g., "Close-up angry woman yelling" when character_names column contains this char
        const charNamesInRow = String(row[mapping.characterNames] || '').toLowerCase();
        if (charNamesInRow.includes(nameLower)) {
            const visual = String(row[mapping.visualContext] || '').trim();
            // Only take visuals that seem to describe appearance (contain appearance keywords)
            const appearanceKeywords = ['close-up', 'face', 'hair', 'wearing', 'dressed', 'outfit', 'suit', 'uniform', 'glasses', 'old', 'young', 'tall', 'short'];
            if (visual && appearanceKeywords.some(kw => visual.toLowerCase().includes(kw))) {
                const shortVisual = visual.substring(0, 150);
                if (!seen.has(shortVisual.toLowerCase())) {
                    seen.add(shortVisual.toLowerCase());
                    fragments.push(shortVisual);
                }
            }
        }
    }

    if (fragments.length === 0) {
        return ''; // No description found
    }

    // Combine and cap at 600 characters
    const combined = fragments.join('. ');
    const result = combined.length > 600 ? combined.substring(0, 597) + '...' : combined;

    console.log(`[ExcelImport] 📝 Character "${charName}" description extracted:`, result.substring(0, 100) + '...');
    return result;
}

/**
 * Extract unique products/props/weapons from scene visual descriptions.
 * Uses keyword patterns to detect important physical objects.
 */
function extractProductsFromScenes(rows: any[], mapping: ColumnMapping): Record<string, Product> {
    const productMap: Record<string, Product> = {};

    // Common prop/weapon patterns to detect in visual descriptions
    const propPatterns = [
        // Documents & Legal
        /\b(eviction notice|legal document|deed|title deed|manila envelope|official documents?|folder|contract)\b/gi,
        // Weapons
        /\b(gun|pistol|rifle|shotgun|sword|knife|dagger|blade|axe|bow|spear|shield|hammer|mace)\b/gi,
        // Technology
        /\b(laptop|phone|tablet|camera|radio|walkie.?talkie|monitor|computer)\b/gi,
        // Vehicles
        /\b(car|truck|motorcycle|helicopter|boat|ship|bicycle|van|ambulance|police car)\b/gi,
        // Furniture & Props
        /\b(gavel|podium|nameplate|badge|key|keychain|handcuffs|flashlight|lantern|torch)\b/gi,
    ];

    // Also check product_names column if mapped
    const explicitProducts = new Set<string>();
    rows.forEach(row => {
        const names = String(row[mapping.productNames] || '').split(',').map(n => n.trim()).filter(Boolean);
        names.forEach(n => explicitProducts.add(n));
    });

    // Add explicit products first
    explicitProducts.forEach(name => {
        const key = name.toLowerCase();
        if (!productMap[key]) {
            productMap[key] = {
                id: generateId(),
                name,
                description: name,
                masterImage: null,
                views: { front: null, back: null, left: null, right: null, top: null },
                isAnalyzing: false
            };
        }
    });

    // Scan visual contexts for props (limit to important/recurring ones)
    const propMentionCount: Record<string, number> = {};
    rows.forEach(row => {
        const text = [
            String(row[mapping.visualContext] || ''),
            String(row['scene_description'] || ''),
            String(row['visual_keywords'] || ''),
        ].join(' ');

        for (const pattern of propPatterns) {
            let match;
            // Reset lastIndex for global regex
            pattern.lastIndex = 0;
            while ((match = pattern.exec(text)) !== null) {
                const propName = match[1].toLowerCase().trim();
                if (propName.length >= 3) {
                    propMentionCount[propName] = (propMentionCount[propName] || 0) + 1;
                }
            }
        }
    });

    // Only add props that appear at least 2 times (to filter noise)
    Object.entries(propMentionCount)
        .filter(([, count]) => count >= 2)
        .sort(([, a], [, b]) => b - a) // Most mentioned first
        .slice(0, 10) // Max 10 auto-detected props
        .forEach(([propName, count]) => {
            if (!productMap[propName]) {
                // Capitalize first letter
                const displayName = propName.charAt(0).toUpperCase() + propName.slice(1);
                productMap[propName] = {
                    id: generateId(),
                    name: displayName,
                    description: `${displayName} - referenced ${count} times in script`,
                    masterImage: null,
                    views: { front: null, back: null, left: null, right: null, top: null },
                    isAnalyzing: false
                };
            }
        });

    if (Object.keys(productMap).length > 0) {
        console.log(`[ExcelImport] 🎯 Extracted ${Object.keys(productMap).length} products/props:`,
            Object.values(productMap).map(p => p.name));
    }

    return productMap;
}
