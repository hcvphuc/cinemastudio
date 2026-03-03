/**
 * ElevenLabs TTS Formatter v4
 * 
 * - AI-only mode (requires API key)
 * - Splits by PART, then sub-splits if > 4000 chars (at sentence boundary)
 * - No PART header line inside generated files
 * - Downloads as ZIP
 */

import { GoogleGenAI } from "@google/genai";

export interface ElevenLabsConfig {
    apiKey: string;
    model?: string;
    stripAfterEnd: boolean;
    maxCharsPerFile: number;  // ElevenLabs limit
}

export interface PartFile {
    filename: string;
    partLabel: string;
    content: string;
}

const DEFAULT_CONFIG: Partial<ElevenLabsConfig> = {
    stripAfterEnd: true,
    maxCharsPerFile: 4000,
};

/**
 * Split preprocessed script into PART sections
 */
function splitIntoParts(preprocessedText: string, stripAfterEnd: boolean = true): { partLabel: string; content: string }[] {
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
            const content = currentLines.join('\n').trim();
            if (content) {
                parts.push({ partLabel: currentPartLabel, content });
            }
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
 * Split text into chunks <= maxChars, breaking at sentence boundaries (after periods)
 */
function splitAtSentenceBoundary(text: string, maxChars: number): string[] {
    if (text.length <= maxChars) return [text];

    const chunks: string[] = [];
    let remaining = text;

    while (remaining.length > 0) {
        if (remaining.length <= maxChars) {
            chunks.push(remaining.trim());
            break;
        }

        // Find the last sentence boundary (. ! ? followed by space/newline) within maxChars
        let splitPos = -1;
        const searchArea = remaining.substring(0, maxChars);

        // Search backwards for the last sentence-ending punctuation followed by whitespace
        for (let i = searchArea.length - 1; i >= Math.floor(maxChars * 0.5); i--) {
            const char = searchArea[i];
            if ((char === '.' || char === '!' || char === '?') &&
                (i + 1 >= searchArea.length || /[\s\n]/.test(searchArea[i + 1]))) {
                splitPos = i + 1;
                break;
            }
        }

        // If no sentence boundary found in the safe range, try harder (look in first half)
        if (splitPos === -1) {
            for (let i = Math.floor(maxChars * 0.5) - 1; i >= 100; i--) {
                const char = searchArea[i];
                if ((char === '.' || char === '!' || char === '?')) {
                    splitPos = i + 1;
                    break;
                }
            }
        }

        // Last resort: split at maxChars
        if (splitPos === -1) {
            splitPos = maxChars;
        }

        chunks.push(remaining.substring(0, splitPos).trim());
        remaining = remaining.substring(splitPos).trim();
    }

    return chunks;
}

/**
 * Strip PART header lines from AI output
 * Removes lines like: [thoughtful, deliberate] Part A. The Hook. [inhales]
 */
function stripPartHeaders(text: string): string {
    return text
        .split('\n')
        .filter(line => {
            const t = line.trim();
            // Remove lines that are Part headers with audio tags
            if (/^\[.*?\]\s*Part\s+[A-Z0-9]+/i.test(t)) return false;
            // Remove plain Part headers
            if (/^Part\s+[A-Z0-9]+[\s.\-—]/i.test(t) && t.length < 120) return false;
            return true;
        })
        .join('\n')
        .replace(/^\n+/, '') // Remove leading empty lines
        .trim();
}

/**
 * AI-powered formatter for a single PART (no PART header in output)
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
1. DO NOT include any part header line. Start directly with the narration content.
2. CRITICAL: Add audio tags AFTER EVERY period/sentence. EVERY sentence must have a tag before it or after the previous period:
   - [emotion tag] before sentence: [cold, deliberate], [tense, low voice], [calculating, building], [dark, revealing], [intense], [analytical], [philosophical], etc.
   - [pause], [strategic pause], [calculated pause] AFTER each period, before next sentence
   - [inhales], [exhales], [exhales sharply] as breath marks every 2-3 sentences
3. Use CAPS for emphasis on KEY words: "the MOST wanted", "does NOT exist", "FORTY-TWO countries"
4. Break long sentences into shorter fragments with periods and [pause] tags for natural TTS pacing.
5. DO NOT add or remove any content text. Only ADD audio direction tags.
6. DO NOT add stage directions or descriptions. ONLY [bracketed] audio tags.
7. DO NOT start with the part name/header. Jump straight into the narration.
8. Output ONLY the enhanced script text. No markdown. No explanations.

EXAMPLE OUTPUT (notice: no part header, starts directly with content):
[cold, deliberate] Are you WATCHING? [strategic pause] Because what happens next. [pause] I PROMISE you. [calculated pause] will NOT believe your eyes. [exhales]

[tense, low voice] 6:47 PM. [pause] Riverside Glen Community Center. [inhales] A man walks in. [strategic pause] [dark, revealing] Blue surgical scrubs. [pause] Wrinkled. [calculated pause] Stains still fresh. [pause] He hasn't slept in thirty-six HOURS. [exhales sharply]

[cold, analytical] In three decades of organized crime. [pause] no ONE has evaded this level of surveillance. [strategic pause] [calculating] How. [pause] does a man with NO digital footprint. [calculated pause] become the MOST wanted drug trafficker. [pause, intense] in the Western Hemisphere? [inhales]

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

        // Strip any PART headers AI might have added despite instructions
        result = stripPartHeaders(result);

        if (result.length > 0) {
            console.log(`[ElevenLabs AI] ✅ ${partLabel}: ${result.length} chars output`);
            return result;
        }
    } catch (err: any) {
        console.error(`[ElevenLabs AI] ❌ ${partLabel} failed:`, err?.message || err);
        throw err; // Propagate to caller
    }

    throw new Error(`AI returned empty result for ${partLabel}`);
}

/**
 * Main: process script → array of PartFile objects (AI only, requires apiKey)
 */
export async function processScriptToParts(
    scriptText: string,
    apiKey: string,
    userConfig?: Partial<ElevenLabsConfig>
): Promise<PartFile[]> {
    const config = { ...DEFAULT_CONFIG, ...userConfig };
    const maxChars = config.maxCharsPerFile || 4000;

    // Step 1: Split into PART sections
    const parts = splitIntoParts(scriptText, config.stripAfterEnd !== false);
    console.log(`[ElevenLabs] Split script into ${parts.length} parts:`, parts.map(p => p.partLabel));

    // Step 2: Format each part with AI
    const ai = new GoogleGenAI({ apiKey });
    const modelName = config.model || 'gemini-2.0-flash';
    const timestamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
    const results: PartFile[] = [];
    let fileCounter = 1;

    for (let i = 0; i < parts.length; i++) {
        const part = parts[i];
        const formatted = await formatPartWithAI(ai, modelName, part.partLabel, part.content);
        const safeLabel = part.partLabel.replace(/[^a-zA-Z0-9\s\-]/g, '').replace(/\s+/g, '_');

        // Step 3: Sub-split if > maxChars
        const chunks = splitAtSentenceBoundary(formatted, maxChars);

        if (chunks.length === 1) {
            results.push({
                filename: `${timestamp}_${String(fileCounter).padStart(2, '0')}_${safeLabel}.txt`,
                partLabel: part.partLabel,
                content: chunks[0],
            });
            fileCounter++;
        } else {
            console.log(`[ElevenLabs] ${part.partLabel}: ${formatted.length} chars → split into ${chunks.length} files`);
            for (let j = 0; j < chunks.length; j++) {
                results.push({
                    filename: `${timestamp}_${String(fileCounter).padStart(2, '0')}_${safeLabel}_${j + 1}of${chunks.length}.txt`,
                    partLabel: `${part.partLabel} (${j + 1}/${chunks.length})`,
                    content: chunks[j],
                });
                fileCounter++;
            }
        }
    }

    return results;
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
