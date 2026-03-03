/**
 * ElevenLabs TTS Formatter v3
 * 
 * Splits script by PART → processes each with AI → downloads as ZIP
 * Each PART becomes a separate .txt file with rich audio tags.
 */

import { GoogleGenAI } from "@google/genai";

export interface ElevenLabsConfig {
    useAI: boolean;
    apiKey?: string;
    model?: string;
    stripAfterEnd: boolean;
}

export interface PartFile {
    filename: string;
    partLabel: string;
    content: string;
}

const DEFAULT_CONFIG: ElevenLabsConfig = {
    useAI: false,
    stripAfterEnd: true,
};

/**
 * Split preprocessed script into PART sections
 */
export function splitIntoParts(preprocessedText: string, stripAfterEnd: boolean = true): { partLabel: string; content: string }[] {
    const lines = preprocessedText.split('\n');
    const parts: { partLabel: string; content: string }[] = [];
    let currentPartLabel = 'Intro';
    let currentLines: string[] = [];
    let reachedEnd = false;

    for (const line of lines) {
        const trimmed = line.trim();

        // Stop at THE END, FINAL STATISTICS
        if (stripAfterEnd && /^(THE END|FINAL STATISTICS|FINAL CTA)/i.test(trimmed)) {
            reachedEnd = true;
            continue;
        }
        if (reachedEnd) continue;

        // Detect [PART X: TITLE — Subtitle]
        const partMatch = trimmed.match(/^\[PART\s+([A-Z0-9]+)[:\s]+(.+)\]$/i);
        if (partMatch) {
            // Save previous part
            const content = currentLines.join('\n').trim();
            if (content) {
                parts.push({ partLabel: currentPartLabel, content });
            }
            // Start new part
            const partLetter = partMatch[1];
            const partTitle = partMatch[2].trim();
            currentPartLabel = `Part ${partLetter} - ${partTitle}`;
            currentLines = [];
            continue;
        }

        // Also detect ## PART X: ... (unprocessed format)
        const mdPartMatch = trimmed.match(/^#{0,3}\s*PART\s+([A-Z0-9]+)[:\s—\-–]+(.+)$/i);
        if (mdPartMatch) {
            const content = currentLines.join('\n').trim();
            if (content) {
                parts.push({ partLabel: currentPartLabel, content });
            }
            const partLetter = mdPartMatch[1];
            const partTitle = mdPartMatch[2].trim();
            currentPartLabel = `Part ${partLetter} - ${partTitle}`;
            currentLines = [];
            continue;
        }

        // Skip --- separators
        if (/^---+$/.test(trimmed)) continue;

        // Skip markdown headers that aren't content
        if (/^#{1,3}\s/.test(trimmed)) continue;

        // Strip bold formatting
        const stripped = trimmed.replace(/\*\*(.+?)\*\*/g, '$1');

        // Handle bracket annotations (CLIFFHANGER, CTA, etc.)
        const bracketMatch = stripped.match(/^\[?(CLIFFHANGER|CTA|MICRO-CTA)[:\s—\-–]*(.*?)\]?[:\s]*(.*)$/i);
        if (bracketMatch) {
            const text = (bracketMatch[3] || bracketMatch[2] || '').trim();
            if (text) currentLines.push(text);
            continue;
        }

        // Skip structural tags
        if (/^\[?(FLASHBACK|PUNCHLINE|FINAL CTA|FINAL STATISTICS)/i.test(stripped)) continue;

        if (stripped) {
            currentLines.push(stripped);
        } else {
            currentLines.push('');
        }
    }

    // Save last part
    const lastContent = currentLines.join('\n').trim();
    if (lastContent) {
        parts.push({ partLabel: currentPartLabel, content: lastContent });
    }

    return parts;
}

/**
 * Simple (non-AI) formatter
 */
function formatSimple(text: string, partLabel: string): string {
    const lines = text.split('\n');
    const result: string[] = [];

    // Add part header
    result.push(`[thoughtful, deliberate] ${partLabel}. [inhales]`);
    result.push('');

    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) { result.push(''); continue; }

        if (trimmed.endsWith('?')) {
            result.push(`[calculating] ${trimmed}`);
        } else if (trimmed.length < 30 && !trimmed.includes(',')) {
            result.push(`[cold, emphasis] ${trimmed} [pause]`);
        } else if (trimmed.startsWith('"') || trimmed.startsWith('\u201C')) {
            result.push(`[dramatic] ${trimmed}`);
        } else {
            result.push(trimmed);
        }
    }

    return result.join('\n');
}

/**
 * AI-powered formatter for a single PART
 */
async function formatPartWithAI(
    ai: GoogleGenAI,
    modelName: string,
    partLabel: string,
    content: string
): Promise<string> {
    const prompt = `You are an expert audio director for ElevenLabs Text-to-Speech narration.

Take this "${partLabel}" section and add inline audio direction tags for PREMIUM YouTube storytelling narration.

RULES:
1. Start with the part header spoken with tags: "[thoughtful, investigative] ${partLabel}. [inhales]"
2. Add [emotion tags] BEFORE each sentence: [cold, deliberate], [tense, low voice], [calculating], [dark, revealing], [intense], [analytical], [philosophical], etc.
3. Add [pause], [strategic pause], [calculated pause], [long pause] BETWEEN sentences for dramatic rhythm.
4. Add breath tags: [inhales], [exhales], [exhales sharply] at natural breath points.
5. Use CAPS for emphasis on KEY words: "the MOST wanted", "does NOT exist"
6. Break long sentences with periods and [pause] tags.
7. DO NOT add or remove any content text. Only ADD audio direction tags, pauses, emphasis.
8. DO NOT add descriptions like "he said". ONLY audio tags in [brackets].
9. Every paragraph must have at least one emotion tag and strategic pauses.
10. Output ONLY the enhanced script text. No markdown code blocks. No explanations.

EXAMPLE:
[thoughtful, deliberate] Part A. The Hook. [inhales]

[cold, deliberate] Are you WATCHING? [strategic pause] Because what happens next. [pause] I PROMISE you. will not believe your eyes.

[tense, low voice] 6:47 PM. [pause] Riverside Glen Community Center. [inhales]

INPUT:
${content}`;

    try {
        console.log(`[ElevenLabs AI] Processing: ${partLabel} (${content.length} chars)...`);

        const response = await ai.models.generateContent({
            model: modelName,
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
            config: {
                temperature: 0.7,
                maxOutputTokens: 16384,
            }
        });

        let result = response.text?.trim() || '';

        // Strip markdown code blocks if AI wrapped it
        if (result.startsWith('```')) {
            result = result.replace(/^```\w*\n?/, '').replace(/\n?```$/, '').trim();
        }

        if (result.length > 0) {
            console.log(`[ElevenLabs AI] ✅ ${partLabel}: ${result.length} chars output`);
            return result;
        }
    } catch (err: any) {
        console.error(`[ElevenLabs AI] ❌ ${partLabel} failed:`, err?.message || err);
    }

    // Fallback
    console.log(`[ElevenLabs AI] ⚠️ ${partLabel}: using simple format fallback`);
    return formatSimple(content, partLabel);
}

/**
 * Main: process script → array of PartFile objects
 */
export async function processScriptToParts(
    scriptText: string,
    userConfig?: Partial<ElevenLabsConfig>
): Promise<PartFile[]> {
    const config = { ...DEFAULT_CONFIG, ...userConfig };

    // Step 1: Split into parts
    const parts = splitIntoParts(scriptText, config.stripAfterEnd);
    console.log(`[ElevenLabs] Split script into ${parts.length} parts:`, parts.map(p => p.partLabel));

    // Step 2: Format each part
    const results: PartFile[] = [];
    const timestamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);

    if (config.useAI && config.apiKey) {
        const ai = new GoogleGenAI({ apiKey: config.apiKey });
        const modelName = config.model || 'gemini-2.0-flash';

        for (let i = 0; i < parts.length; i++) {
            const part = parts[i];
            const formatted = await formatPartWithAI(ai, modelName, part.partLabel, part.content);
            const safeLabel = part.partLabel.replace(/[^a-zA-Z0-9\s\-]/g, '').replace(/\s+/g, '_');
            results.push({
                filename: `${timestamp}_${String(i + 1).padStart(2, '0')}_${safeLabel}.txt`,
                partLabel: part.partLabel,
                content: formatted,
            });
        }
    } else {
        for (let i = 0; i < parts.length; i++) {
            const part = parts[i];
            const formatted = formatSimple(part.content, part.partLabel);
            const safeLabel = part.partLabel.replace(/[^a-zA-Z0-9\s\-]/g, '').replace(/\s+/g, '_');
            results.push({
                filename: `${timestamp}_${String(i + 1).padStart(2, '0')}_${safeLabel}.txt`,
                partLabel: part.partLabel,
                content: formatted,
            });
        }
    }

    return results;
}

/**
 * Synchronous version (simple format only)
 */
export function processScriptToPartsSync(scriptText: string): PartFile[] {
    const parts = splitIntoParts(scriptText, true);
    const timestamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);

    return parts.map((part, i) => {
        const formatted = formatSimple(part.content, part.partLabel);
        const safeLabel = part.partLabel.replace(/[^a-zA-Z0-9\s\-]/g, '').replace(/\s+/g, '_');
        return {
            filename: `${timestamp}_${String(i + 1).padStart(2, '0')}_${safeLabel}.txt`,
            partLabel: part.partLabel,
            content: formatted,
        };
    });
}

/**
 * Generate ZIP filename
 */
export function getElevenLabsZipFilename(projectName?: string): string {
    const timestamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
    const base = projectName
        ? projectName.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '')
        : 'voiceover';
    return `${timestamp}_${base}_elevenlabs.zip`;
}
