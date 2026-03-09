/**
 * ElevenLabs TTS Formatter v3
 * 
 * Converts preprocessed .md script text into ElevenLabs-optimized format.
 * 
 * KEY UPGRADE: Split by PARTs → per-part AI formatting → ZIP output.
 * 
 * Output style matches professional true crime narration:
 * - [cold, deliberate] inline emotion tags per sentence
 * - [pause], [strategic pause], [long pause] for rhythm
 * - [inhales], [exhales], [exhales sharply] for breath
 * - CAPS for emphasis on key words
 * - Part headers spoken with tags: "[thoughtful] Part One. [pause] The Harvest."
 * - --- separators between parts
 * - No content after THE END / final section
 * 
 * Two output modes:
 * - ZIP mode (default): per-PART .txt files in a ZIP
 * - Single file mode: all parts in one .txt
 */

import { GoogleGenAI } from "@google/genai";
import JSZip from "jszip";

// ─── Types ────────────────────────────────────────────────────────

export interface ElevenLabsConfig {
    useAI: boolean;              // Use Gemini to add rich audio tags
    apiKey?: string;             // Gemini API key (required if useAI=true)
    model?: string;              // Gemini model to use
    stripAfterEnd: boolean;      // Remove content after THE END / final statistics
    outputMode: 'zip' | 'single'; // ZIP with per-part files or single merged file
}

interface PartFile {
    label: string;       // "PART_A", "PART_B", etc.
    title: string;       // "The Table Flip"
    content: string;     // Cleaned VO text for this part
}

const DEFAULT_CONFIG: ElevenLabsConfig = {
    useAI: false,
    stripAfterEnd: true,
    outputMode: 'zip',
};

// ─── Step 1: Strip content after THE END ──────────────────────────

function stripAfterEnd(text: string): string {
    const lines = text.split('\n');
    const result: string[] = [];
    for (const line of lines) {
        const trimmed = line.trim();
        if (/^(THE END|FINAL STATISTICS|FINAL CTA)/i.test(trimmed)) {
            break;
        }
        result.push(line);
    }
    return result.join('\n').trim();
}

// ─── Step 2: Split script into PARTs ──────────────────────────────

function splitIntoParts(preprocessedText: string): PartFile[] {
    const lines = preprocessedText.split('\n');
    const parts: PartFile[] = [];
    let currentLabel = 'INTRO';
    let currentTitle = 'Introduction';
    let currentLines: string[] = [];

    for (const line of lines) {
        const trimmed = line.trim();

        // Detect [PART X: TITLE — Subtitle] format
        const partMatch = trimmed.match(/^\[PART\s+([A-Z0-9]+)[:\s]+([^—\-–]+)?[—\-–]?\s*(.*?)?\]$/i);
        if (partMatch) {
            // Save previous part
            if (currentLines.length > 0) {
                const content = currentLines.join('\n').trim();
                if (content) {
                    parts.push({
                        label: `PART_${currentLabel}`,
                        title: currentTitle,
                        content,
                    });
                }
            }

            // Start new part
            currentLabel = partMatch[1].toUpperCase();
            currentTitle = (partMatch[3] || partMatch[2] || '').trim();
            currentLines = [];
            continue;
        }

        currentLines.push(line);
    }

    // Push final part
    if (currentLines.length > 0) {
        const content = currentLines.join('\n').trim();
        if (content) {
            parts.push({
                label: `PART_${currentLabel}`,
                title: currentTitle,
                content,
            });
        }
    }

    // If no PARTs detected, return entire script as single part
    if (parts.length === 0) {
        parts.push({
            label: 'FULL_SCRIPT',
            title: 'Voiceover',
            content: preprocessedText.trim(),
        });
    }

    return parts;
}

// ─── Step 3a: Simple Formatter (per-part) ─────────────────────────

function formatSimple(text: string, partLabel: string, partTitle: string): string {
    const lines = text.split('\n');
    const result: string[] = [];

    // Add spoken part header
    if (partLabel !== 'FULL_SCRIPT' && partLabel !== 'PART_INTRO') {
        const letter = partLabel.replace('PART_', '');
        result.push(`[thoughtful, deliberate] Part ${letter}. ${partTitle}. [inhales]`);
        result.push('');
    }

    for (const line of lines) {
        const trimmed = line.trim();

        if (!trimmed) {
            const lastLine = result[result.length - 1];
            if (lastLine !== '' && lastLine !== undefined) {
                result.push('');
            }
            continue;
        }

        // Skip stray --- 
        if (trimmed === '---') continue;

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

    return result.join('\n').trim();
}

// ─── Step 3b: AI Formatter (per-part) ─────────────────────────────

async function formatPartWithAI(
    apiKey: string,
    model: string | undefined,
    partLabel: string,
    partTitle: string,
    content: string
): Promise<string> {
    const ai = new GoogleGenAI({ apiKey });

    const partHeader = partLabel !== 'FULL_SCRIPT' && partLabel !== 'PART_INTRO'
        ? `This is "${partLabel.replace('PART_', 'Part ')}: ${partTitle}".`
        : 'This is the script content.';

    const prompt = `You are an expert audio director for ElevenLabs Text-to-Speech narration.

${partHeader}

Your task: Take the following script and add inline audio direction tags to make it sound like a PREMIUM YouTube true crime / storytelling narration.

## RULES:

1. Add [emotion tags] BEFORE sentences or phrases: [cold, deliberate], [tense, low voice], [calculating, building], [dark, revealing], [intense, methodical], [analytical], [impressed], [philosophical], etc.

2. Add [pause], [strategic pause], [calculated pause], [long pause] BETWEEN sentences and phrases for dramatic rhythm.

3. Add breath tags: [inhales], [exhales], [exhales sharply], [inhales deeply] at natural breath points.

4. Use CAPS for emphasis on KEY words: "the MOST wanted", "he does NOT exist", "FORTY-TWO countries"

5. Break long sentences with [pause] tags for natural speech pacing:
   BAD: "In three decades of organized crime no one has evaded this level of surveillance."
   GOOD: "[cold, analytical] In three decades of organized crime. [pause] no ONE has evaded this level of surveillance."

6. If this is a named part, start with the spoken part header:
   "[thoughtful, investigative] Part One. [pause] The Harvest. [inhales]"

7. DO NOT add any content that isn't in the original. DO NOT remove any content. Only ADD audio tags, pauses, emphasis.

8. DO NOT add descriptions like "he said" or stage directions. ONLY audio tags in [brackets].

9. Every paragraph should have at least one emotion tag at the start and strategic pauses within.

10. Match the emotional arc of the content — build tension gradually, hit hard on reveals, go quiet on reflective moments.

## EXAMPLE OUTPUT FORMAT:
[cold, deliberate] THE FALL OF THE GHOST. [calculated pause] THE END OF THE ARCHITECT.

[tense, low voice] February 22, 2026. [strategic pause] 6:47 AM. [inhales] Tapalpa, Jalisco.

Six tactical aircraft. tear through the thick fog over the Sierra Madre mountains. [pause] Their target? [low, intense] A man. who does NOT exist.

---

[thoughtful, investigative] Part One. [pause] The Harvest. [inhales]

[low, revealing] 1977. [pause] Naranjo de Chila, Michoacán. [calculating] A town so remote. it doesn't appear on MOST maps.

## INPUT SCRIPT:
${content}

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
        console.error(`[ElevenLabs Formatter] AI formatting failed for ${partLabel}:`, err);
    }

    // Fallback to simple formatting
    return formatSimple(content, partLabel, partTitle);
}

// ─── Main Exports ─────────────────────────────────────────────────

/**
 * Main export: returns Blob (ZIP or single .txt)
 */
export async function formatForElevenLabs(
    preprocessedText: string,
    userConfig?: Partial<ElevenLabsConfig>
): Promise<Blob> {
    const config = { ...DEFAULT_CONFIG, ...userConfig };

    // Step 1: Strip after THE END
    let text = preprocessedText;
    if (config.stripAfterEnd) {
        text = stripAfterEnd(text);
    }

    // Step 2: Split into parts
    const parts = splitIntoParts(text);
    console.log(`[ElevenLabs] Split script into ${parts.length} part(s):`, parts.map(p => p.label));

    // Step 3: Format each part
    const formattedParts: { label: string; title: string; formatted: string }[] = [];

    for (const part of parts) {
        let formatted: string;
        if (config.useAI && config.apiKey) {
            console.log(`[ElevenLabs] AI formatting ${part.label}...`);
            formatted = await formatPartWithAI(config.apiKey, config.model, part.label, part.title, part.content);
        } else {
            formatted = formatSimple(part.content, part.label, part.title);
        }
        formattedParts.push({ label: part.label, title: part.title, formatted });
    }

    // Step 4: Output
    if (config.outputMode === 'zip' && formattedParts.length > 1) {
        // ZIP mode: per-part .txt files
        const zip = new JSZip();
        for (const part of formattedParts) {
            const filename = `${part.label}_${part.title.replace(/[^a-zA-Z0-9]+/g, '_').replace(/_+$/, '')}.txt`;
            zip.file(filename, part.formatted);
        }
        return await zip.generateAsync({ type: 'blob' });
    } else {
        // Single file mode: merge all parts
        const merged = formattedParts.map(p => p.formatted).join('\n\n---\n\n');
        return new Blob([merged], { type: 'text/plain;charset=utf-8' });
    }
}

/**
 * Synchronous version for non-AI formatting (backward compat)
 */
export function formatForElevenLabsSync(
    preprocessedText: string
): Blob {
    const text = stripAfterEnd(preprocessedText);
    const parts = splitIntoParts(text);

    const formattedParts = parts.map(part =>
        formatSimple(part.content, part.label, part.title)
    );

    if (parts.length > 1) {
        // ZIP mode
        // For sync, we can't use JSZip async, so return single file
        const merged = formattedParts.join('\n\n---\n\n');
        return new Blob([merged], { type: 'text/plain;charset=utf-8' });
    }

    return new Blob([formattedParts[0]], { type: 'text/plain;charset=utf-8' });
}

/**
 * Generate download-ready filename
 */
export function getElevenLabsFilename(projectName?: string, isZip?: boolean): string {
    const timestamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
    const base = projectName
        ? projectName.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '')
        : 'voiceover';
    const ext = isZip ? 'zip' : 'txt';
    return `${timestamp}_${base}_elevenlabs.${ext}`;
}
