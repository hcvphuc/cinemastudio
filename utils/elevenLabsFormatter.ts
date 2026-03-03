/**
 * ElevenLabs TTS Formatter v2
 * 
 * Converts preprocessed .md script text into ElevenLabs-optimized format.
 * Uses Gemini AI to add rich per-sentence audio tags, pauses, emphasis.
 * 
 * Output style matches professional true crime narration:
 * - [cold, deliberate] inline emotion tags per sentence
 * - [pause], [strategic pause], [long pause] for rhythm
 * - [inhales], [exhales], [exhales sharply] for breath
 * - CAPS for emphasis on key words
 * - Part headers spoken with tags: "[thoughtful] Part One. [pause] The Harvest."
 * - --- separators between parts
 * - No content after THE END / final section
 */

import { GoogleGenAI } from "@google/genai";

export interface ElevenLabsConfig {
    useAI: boolean;              // Use Gemini to add rich audio tags
    apiKey?: string;             // Gemini API key (required if useAI=true)
    model?: string;              // Gemini model to use
    stripAfterEnd: boolean;      // Remove content after THE END / final statistics
}

const DEFAULT_CONFIG: ElevenLabsConfig = {
    useAI: false,
    stripAfterEnd: true,
};

/**
 * Clean the preprocessed script for ElevenLabs:
 * - Strip [PART X: ...] brackets but keep readable "Part X. Title."
 * - Remove content after THE END / FINAL STATISTICS
 * - Clean up formatting
 */
function cleanForVO(preprocessedText: string, config: ElevenLabsConfig): string {
    const lines = preprocessedText.split('\n');
    const result: string[] = [];
    let reachedEnd = false;

    for (const line of lines) {
        const trimmed = line.trim();

        // Stop at THE END, FINAL STATISTICS, FINAL CTA
        if (config.stripAfterEnd) {
            if (/^(THE END|FINAL STATISTICS|FINAL CTA)/i.test(trimmed)) {
                reachedEnd = true;
                continue;
            }
            if (reachedEnd) continue;
        }

        // Convert [PART X: TITLE — Subtitle] → "Part X. Subtitle."  
        const partMatch = trimmed.match(/^\[PART\s+([A-Z0-9]+)[:\s]+([^—\-–]+)?[—\-–]?\s*(.*?)?\]$/i);
        if (partMatch) {
            const partLetter = partMatch[1];
            const subtitle = (partMatch[3] || partMatch[2] || '').trim();
            result.push('---');
            result.push('');
            result.push(`Part ${partLetter}. ${subtitle}.`);
            result.push('');
            continue;
        }

        // Skip empty consecutive lines (max 1)
        if (!trimmed) {
            const lastLine = result[result.length - 1];
            if (lastLine === '' || lastLine === '---') continue;
            result.push('');
            continue;
        }

        result.push(trimmed);
    }

    // Remove leading --- if first
    while (result.length > 0 && (result[0] === '---' || result[0] === '')) {
        result.shift();
    }

    return result.join('\n').trim();
}

/**
 * Simple (non-AI) formatter: adds basic tags based on heuristics
 */
function formatSimple(cleanedText: string): string {
    const lines = cleanedText.split('\n');
    const result: string[] = [];

    for (const line of lines) {
        const trimmed = line.trim();

        if (!trimmed || trimmed === '---') {
            result.push(trimmed);
            continue;
        }

        // Part headers
        if (/^Part\s+[A-Z0-9]+\.\s/i.test(trimmed)) {
            result.push(`[thoughtful, deliberate] ${trimmed} [inhales]`);
            continue;
        }

        // Questions → curious/rhetorical
        if (trimmed.endsWith('?')) {
            result.push(`[calculating] ${trimmed}`);
            continue;
        }

        // Short impactful lines (< 30 chars)
        if (trimmed.length < 30 && !trimmed.includes(',')) {
            result.push(`[cold, emphasis] ${trimmed} [pause]`);
            continue;
        }

        // Dialogue lines (in quotes)
        if (trimmed.startsWith('"') || trimmed.startsWith("'") || trimmed.startsWith('\u201C')) {
            result.push(`[dramatic] ${trimmed}`);
            continue;
        }

        // Default narration
        result.push(trimmed);
    }

    return result.join('\n');
}

/**
 * AI-powered formatter: uses Gemini to add rich per-sentence audio tags
 */
async function formatWithAI(cleanedText: string, apiKey: string, model?: string): Promise<string> {
    const ai = new GoogleGenAI({ apiKey });

    const prompt = `You are an expert audio director for ElevenLabs Text-to-Speech narration.

Your task: Take the following script and add inline audio direction tags to make it sound like a PREMIUM YouTube true crime / storytelling narration.

## RULES:

1. Add [emotion tags] BEFORE sentences or phrases: [cold, deliberate], [tense, low voice], [calculating, building], [dark, revealing], [intense, methodical], [analytical], [impressed], [philosophical], etc.

2. Add [pause], [strategic pause], [calculated pause], [long pause] BETWEEN sentences and phrases for dramatic rhythm.

3. Add breath tags: [inhales], [exhales], [exhales sharply], [inhales deeply] at natural breath points.

4. Use CAPS for emphasis on KEY words: "the MOST wanted", "he does NOT exist", "FORTY-TWO countries"

5. Break long sentences with [pause] tags for natural speech pacing:
   BAD: "In three decades of organized crime no one has evaded this level of surveillance."
   GOOD: "[cold, analytical] In three decades of organized crime. [pause] no ONE has evaded this level of surveillance."

6. Part headers should be spoken with tags: "[thoughtful, investigative] Part One. [pause] The Harvest. [inhales]"

7. Keep "---" separators between parts.

8. DO NOT add any content that isn't in the original. DO NOT remove any content. Only ADD audio tags, pauses, emphasis.

9. DO NOT add descriptions like "he said" or stage directions. ONLY audio tags in [brackets].

10. Every paragraph should have at least one emotion tag at the start and strategic pauses within.

## EXAMPLE OUTPUT FORMAT:
[cold, deliberate] THE FALL OF THE GHOST. [calculated pause] THE END OF THE ARCHITECT.

[tense, low voice] February 22, 2026. [strategic pause] 6:47 AM. [inhales] Tapalpa, Jalisco.

Six tactical aircraft. tear through the thick fog over the Sierra Madre mountains. [pause] Their target? [low, intense] A man. who does NOT exist.

---

[thoughtful, investigative] Part One. [pause] The Harvest. [inhales]

[low, revealing] 1977. [pause] Naranjo de Chila, Michoacán. [calculating] A town so remote. it doesn't appear on MOST maps.

## INPUT SCRIPT:
${cleanedText}

## OUTPUT (audio-directed script only, no explanations):`;

    try {
        const response = await ai.models.generateContent({
            model: model || 'gemini-2.0-flash',
            contents: prompt,
            config: {
                temperature: 0.7,
                maxOutputTokens: 65536,
            }
        });

        const text = response.text?.trim();
        if (text) return text;
    } catch (err) {
        console.error('[ElevenLabs Formatter] AI formatting failed:', err);
    }

    // Fallback to simple formatting
    return formatSimple(cleanedText);
}

/**
 * Main export function
 */
export async function formatForElevenLabs(
    preprocessedText: string,
    userConfig?: Partial<ElevenLabsConfig>
): Promise<string> {
    const config = { ...DEFAULT_CONFIG, ...userConfig };

    // Step 1: Clean script
    const cleaned = cleanForVO(preprocessedText, config);

    // Step 2: Format with AI or simple heuristics
    if (config.useAI && config.apiKey) {
        return await formatWithAI(cleaned, config.apiKey, config.model);
    }

    return formatSimple(cleaned);
}

/**
 * Synchronous version for non-AI formatting (backward compat)
 */
export function formatForElevenLabsSync(
    preprocessedText: string
): string {
    const cleaned = cleanForVO(preprocessedText, { useAI: false, stripAfterEnd: true });
    return formatSimple(cleaned);
}

/**
 * Generate download-ready filename
 */
export function getElevenLabsFilename(projectName?: string): string {
    const timestamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
    const base = projectName
        ? projectName.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '')
        : 'voiceover';
    return `${timestamp}_${base}_elevenlabs.txt`;
}
