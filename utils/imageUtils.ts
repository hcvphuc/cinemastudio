
/**
 * Image Utilities
 * Helper functions for image processing, cropping, and splitting
 */

/**
 * Splits a 2x2 grid image (like Midjourney output) into 4 separate base64 images.
 * @param gridBase64 - The input grid image in base64 format
 * @returns An array of 4 base64 strings
 */
export async function splitImageGrid(gridBase64: string): Promise<string[]> {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = async () => {
            const canvas = document.createElement('canvas');
            const ctx = canvas.getContext('2d');
            if (!ctx) {
                reject(new Error('Could not create canvas context'));
                return;
            }

            const width = img.width / 2;
            const height = img.height / 2;
            canvas.width = width;
            canvas.height = height;

            const results: string[] = [];

            // Define the 4 quadrants: [top-left, top-right, bottom-left, bottom-right]
            const quadrants = [
                { x: 0, y: 0 },
                { x: width, y: 0 },
                { x: 0, y: height },
                { x: width, y: height }
            ];

            for (const q of quadrants) {
                ctx.clearRect(0, 0, width, height);
                ctx.drawImage(img, q.x, q.y, width, height, 0, 0, width, height);
                // Use toBlob + createObjectURL instead of toDataURL to save memory
                const blob = await new Promise<Blob>((res, rej) => {
                    canvas.toBlob(b => b ? res(b) : rej(new Error('toBlob failed')), 'image/jpeg', 0.9);
                });
                results.push(URL.createObjectURL(blob));
            }

            resolve(results);
        };
        img.onerror = (err) => reject(err);
        img.src = gridBase64;
    });
}

/**
 * Checks if a model ID corresponds to a model that returns a grid (like Midjourney).
 */
export function isGridModel(modelId: string): boolean {
    return modelId.toLowerCase().includes('midjourney');
}
