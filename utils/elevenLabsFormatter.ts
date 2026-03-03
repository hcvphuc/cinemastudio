/**
 * ElevenLabs TTS Formatter
 * 
 * Converts preprocessed .md script text into ElevenLabs-optimized format:
 * - Strips [PART X: ...] headers (not spoken)
 * - Maps PART types to audio tags for emotion control
 * - Formats CLIFFHANGER lines with suspense tags
 * - Formats CTA lines with conversational tags  
 * - Adds <break> pauses between paragraphs
 * - Optional text normalization (numbers → words)
 */

export interface ElevenLabsConfig {
    model: 'v2' | 'v3';
    addAudioTags: boolean;
    addBreaks: boolean;
    normalizeNumbers: boolean;
    expandAbbreviations: boolean;
}

const DEFAULT_CONFIG: ElevenLabsConfig = {
    model: 'v3',
    addAudioTags: true,
    addBreaks: true,
    normalizeNumbers: false,
    expandAbbreviations: false,
};

// Map PART keywords to ElevenLabs audio tags
const PART_TONE_MAP: Record<string, string> = {
    'hook': '[curious]',
    'setup': '',                  // Neutral narration
    'backstory': '[sad]',
    'escalation': '[appalled]',
    'rising': '[appalled]',
    'allies': '[excited]',
    'uprising': '[excited]',
    'going viral': '[excited]',
    'reveal': '[excited]',
    'payoff': '[excited]',
    'truth': '[excited]',
    'aftermath': '[sighs]',
    'rebuilding': '[sighs]',
    'epilogue': '[whispers]',
    'conclusion': '[whispers]',
    'final': '[excited]',
};

/**
 * Detect the emotion tag for a PART header based on keywords
 */
function getPartTone(partTitle: string): string {
    const lower = partTitle.toLowerCase();
    for (const [keyword, tag] of Object.entries(PART_TONE_MAP)) {
        if (lower.includes(keyword)) return tag;
    }
    return ''; // No tag for unknown PART types
}

/**
 * Basic number-to-words conversion for common cases
 */
function numberToWords(n: number): string {
    if (n < 0) return 'negative ' + numberToWords(-n);

    const ones = ['', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine',
        'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen',
        'eighteen', 'nineteen'];
    const tens = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];

    if (n === 0) return 'zero';
    if (n < 20) return ones[n];
    if (n < 100) return tens[Math.floor(n / 10)] + (n % 10 ? '-' + ones[n % 10] : '');
    if (n < 1000) return ones[Math.floor(n / 100)] + ' hundred' + (n % 100 ? ' ' + numberToWords(n % 100) : '');
    if (n < 1000000) return numberToWords(Math.floor(n / 1000)) + ' thousand' + (n % 1000 ? ' ' + numberToWords(n % 1000) : '');
    return numberToWords(Math.floor(n / 1000000)) + ' million' + (n % 1000000 ? ' ' + numberToWords(n % 1000000) : '');
}

/**
 * Normalize text for TTS: expand numbers, abbreviations, time formats
 */
function normalizeForTTS(text: string, config: ElevenLabsConfig): string {
    let result = text;

    if (config.normalizeNumbers) {
        // Time format: "6:47 PM" → "six forty-seven P.M."
        result = result.replace(/(\d{1,2}):(\d{2})\s*(AM|PM)/gi, (_, h, m, period) => {
            const hour = numberToWords(parseInt(h));
            const min = parseInt(m) === 0 ? '' : ' ' + numberToWords(parseInt(m));
            return `${hour}${min} ${period.split('').join('.')}.`;
        });

        // Currency: "$12,000" → "twelve thousand dollars"
        result = result.replace(/\$([0-9,]+(?:\.\d{2})?)/g, (_, amount) => {
            const num = parseInt(amount.replace(/,/g, ''));
            return numberToWords(num) + ' dollars';
        });

        // Standalone numbers: "36 hours" → "thirty-six hours"
        result = result.replace(/\b(\d+)\b/g, (match) => {
            const num = parseInt(match);
            if (num > 0 && num < 10000000) {
                return numberToWords(num);
            }
            return match;
        });
    }

    if (config.expandAbbreviations) {
        result = result.replace(/\bDr\.\s/g, 'Doctor ');
        result = result.replace(/\bMr\.\s/g, 'Mister ');
        result = result.replace(/\bMrs\.\s/g, 'Missus ');
        result = result.replace(/\bSt\.\s(?=[A-Z])/g, 'Saint ');
        result = result.replace(/\bAve\.\s/g, 'Avenue ');
        result = result.replace(/\bHOA\b/g, 'H.O.A.');
    }

    return result;
}

/**
 * Main formatter: converts preprocessed script → ElevenLabs-ready text
 * 
 * Input: output from preprocessMarkdownScript() 
 *   (contains [PART X: ...] brackets, plain text, no other brackets)
 * 
 * Output: ElevenLabs-optimized text with audio tags, breaks, emphasis
 */
export function formatForElevenLabs(
    preprocessedText: string,
    userConfig?: Partial<ElevenLabsConfig>
): string {
    const config = { ...DEFAULT_CONFIG, ...userConfig };
    const lines = preprocessedText.split('\n');
    const result: string[] = [];

    let currentPartTone = '';
    let isFirstLineAfterPart = false;
    let consecutiveEmpty = 0;

    for (const line of lines) {
        const trimmed = line.trim();

        // Handle [PART X: ...] — DO NOT READ, but extract tone
        const partMatch = trimmed.match(/^\[PART\s+[A-Z0-9]+[:\s—\-–]+(.+)\]$/i);
        if (partMatch) {
            const partTitle = partMatch[1].trim();
            currentPartTone = config.addAudioTags ? getPartTone(partTitle) : '';
            isFirstLineAfterPart = true;

            // Add a long break between PARTs (except before the first one)
            if (result.length > 0 && config.addBreaks) {
                result.push('');
                if (config.model === 'v2') {
                    result.push('<break time="2.0s" />');
                } else {
                    result.push('…');
                    result.push('');
                }
            }
            consecutiveEmpty = 0;
            continue; // Skip the PART header itself
        }

        // Empty lines → breaks between paragraphs
        if (!trimmed) {
            consecutiveEmpty++;
            if (consecutiveEmpty <= 2) {
                if (config.addBreaks && result.length > 0) {
                    if (config.model === 'v2') {
                        result.push('<break time="1.0s" />');
                    } else {
                        result.push('');
                    }
                } else {
                    result.push('');
                }
            }
            continue;
        }
        consecutiveEmpty = 0;

        // Normalize text
        let processed = normalizeForTTS(trimmed, config);

        // Apply PART tone tag to first line after a PART header
        if (isFirstLineAfterPart && currentPartTone) {
            processed = `${currentPartTone} ${processed}`;
            isFirstLineAfterPart = false;
        }

        // Detect CLIFFHANGER-like suspense lines (questions ending with ?)
        // These were already extracted from **[CLIFFHANGER: text]** by preprocessor
        // We can detect them heuristically: short question lines
        if (processed.endsWith('?') && processed.length < 80 && config.addAudioTags) {
            // Check if this looks like a rhetorical/suspense question
            const suspenseWords = /^(who|what|why|how|will|can|does|did|is|are|was|were)\s/i;
            if (suspenseWords.test(processed)) {
                processed = `… [whispers] ${processed}`;
            }
        }

        result.push(processed);
    }

    return result.join('\n').trim();
}

/**
 * Generate download-ready filename
 */
export function getElevenLabsFilename(projectName?: string): string {
    const base = projectName
        ? projectName.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '')
        : 'voiceover';
    return `${base}_elevenlabs_vo.txt`;
}
