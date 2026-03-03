import { supabase } from './supabaseClient';

// Re-export supabase client for other modules
export { supabase };

/**
 * Uploads a base64 image string to Supabase Storage.
 * @param base64Data The base64 image data (including the data:image/...;base64, prefix)
 * @param bucket The name of the storage bucket
 * @param path The path/filename within the bucket
 * @returns The public URL of the uploaded image
 */
export async function uploadImageToSupabase(
    imageData: string,
    bucket: string = 'project-assets',
    path: string = `assets/${Date.now()}.jpg`
): Promise<string> {
    try {
        let binaryData: Uint8Array;
        let contentType: string = 'image/jpeg';

        if (imageData.startsWith('blob:')) {
            // Handle Blob URLs (from base64ToBlobUrl memory optimization)
            const response = await fetch(imageData);
            const blob = await response.blob();
            contentType = blob.type || 'image/jpeg';
            const arrayBuffer = await blob.arrayBuffer();
            binaryData = new Uint8Array(arrayBuffer);
        } else if (imageData.startsWith('data:')) {
            // Handle data: URIs (legacy path)
            const base64Body = imageData.split(',')[1];
            binaryData = Uint8Array.from(atob(base64Body), c => c.charCodeAt(0));
            contentType = imageData.match(/:(.*?);/)?.[1] || 'image/jpeg';
        } else {
            throw new Error('Unsupported image format for upload');
        }

        const { data, error } = await supabase.storage
            .from(bucket)
            .upload(path, binaryData, {
                contentType,
                upsert: true
            });

        if (error) throw error;

        // Get public URL
        const { data: { publicUrl } } = supabase.storage
            .from(bucket)
            .getPublicUrl(path);

        return publicUrl;
    } catch (error: any) {
        const errMsg = error?.message || 'Lỗi không xác định';
        console.error(`[Storage] Upload failed for path "${path}":`, error);
        throw new Error(`Lỗi tải ảnh lên Storage (${path}): ${errMsg}`);
    }
}

/**
 * Scans a ProjectState for base64 images and uploads them to Supabase Storage.
 * Returns a new ProjectState with URLs replacing base64 data.
 */
export async function processProjectAssets(state: any, userId: string): Promise<any> {
    console.log('[Storage] Starting asset processing for cloud save...');
    const newState = JSON.parse(JSON.stringify(state)); // Deep clone
    const timestamp = Date.now();
    let uploadCount = 0;

    // 2. Process Characters
    if (newState.characters) {
        for (const char of newState.characters) {
            const fields = ['masterImage', 'faceImage', 'bodyImage', 'sideImage', 'backImage', 'generatedImage'];
            for (const field of fields) {
                if (char[field]?.startsWith('data:') || char[field]?.startsWith('blob:')) {
                    console.log(`[Storage] Uploading character ${field}: ${char.id}`);
                    char[field] = await uploadImageToSupabase(
                        char[field],
                        'project-assets',
                        `${userId}/characters/${char.id}_${field}_${timestamp}.jpg`
                    );
                    uploadCount++;
                }
            }
            if (char.props) {
                for (const prop of char.props) {
                    if (prop.image?.startsWith('data:') || prop.image?.startsWith('blob:')) {
                        console.log(`[Storage] Uploading character prop: ${prop.id}`);
                        prop.image = await uploadImageToSupabase(
                            prop.image,
                            'project-assets',
                            `${userId}/characters/${char.id}_prop_${prop.id}_${timestamp}.jpg`
                        );
                        uploadCount++;
                    }
                }
            }
        }
    }

    // 3. Process Products
    if (newState.products) {
        for (const prod of newState.products) {
            if (prod.masterImage?.startsWith('data:') || prod.masterImage?.startsWith('blob:')) {
                console.log(`[Storage] Uploading product master: ${prod.id}`);
                prod.masterImage = await uploadImageToSupabase(
                    prod.masterImage,
                    'project-assets',
                    `${userId}/products/${prod.id}_master_${timestamp}.jpg`
                );
                uploadCount++;
            }
            if (prod.views) {
                const views = ['front', 'back', 'left', 'right', 'top'];
                for (const view of views) {
                    if (prod.views[view]?.startsWith('data:') || prod.views[view]?.startsWith('blob:')) {
                        console.log(`[Storage] Uploading product view ${view}: ${prod.id}`);
                        prod.views[view] = await uploadImageToSupabase(
                            prod.views[view],
                            'project-assets',
                            `${userId}/products/${prod.id}_view_${view}_${timestamp}.jpg`
                        );
                        uploadCount++;
                    }
                }
            }
        }
    }

    console.log(`[Storage] Finished processing. Uploaded ${uploadCount} assets.`);
    return newState;
}

export async function syncUserStatsToCloud(userId: string, stats: any) {
    if (!userId) return;
    try {
        const { error } = await supabase
            .from('profiles')
            .update({ usage_stats: stats })
            .eq('id', userId);

        if (error) {
            console.warn('[Storage] Failed to sync usage stats (profiles table might miss usage_stats column?):', error);
        } else {
            console.log('[Storage] Usage stats synced to cloud.');
        }
    } catch (e) {
        console.error("[Storage] Exception syncing stats", e);
    }
}

export async function fetchUserStatsFromCloud(userId: string) {
    if (!userId) return null;
    try {
        // First try user_global_stats table (new schema)
        const { data: globalStats, error: globalError } = await supabase
            .from('user_global_stats')
            .select('stats')
            .eq('user_id', userId)
            .single();

        if (!globalError && globalStats?.stats) {
            console.log('[Storage] ✅ Loaded stats from user_global_stats');
            // Map from globalStats format to usageStats format
            const gs = globalStats.stats;
            return {
                total: gs.totalImages || 0,
                scenes: gs.scenesGenerated || 0,
                characters: gs.charactersGenerated || 0,
                products: gs.productsGenerated || 0,
                concepts: gs.conceptsGenerated || 0,
                geminiImages: gs.geminiImages || 0,
                gommoImages: gs.gommoImages || 0,
                '1K': gs.resolution1K || 0,
                '2K': gs.resolution2K || 0,
                '4K': gs.resolution4K || 0,
                textTokens: gs.textTokens || 0,
                promptTokens: gs.promptTokens || 0,
                candidateTokens: gs.candidateTokens || 0,
                textCalls: gs.textCalls || 0,
                estimatedPromptTokens: gs.estimatedImagePromptTokens || 0,
                lastGeneratedAt: gs.lastGenerationAt
            };
        }

        // Fallback to profiles.usage_stats (old schema)
        const { data: profileData, error: profileError } = await supabase
            .from('profiles')
            .select('usage_stats')
            .eq('id', userId)
            .single();

        if (!profileError && profileData?.usage_stats) {
            console.log('[Storage] ✅ Loaded stats from profiles.usage_stats (fallback)');
            return profileData.usage_stats;
        }

        console.log('[Storage] No stats found for user, starting fresh');
        return null;
    } catch (e) {
        console.warn("[Storage] Failed to fetch usage stats:", e);
        return null;
    }
}

/**
 * Track text API token usage and sync to Supabase
 * Should be called after text API calls to accumulate token counts
 */
export async function trackTextTokenUsage(
    userId: string | null | undefined,
    currentStats: any,
    updateStateAndRecord: (fn: (s: any) => any) => void
) {
    // Get token usage from window (set by callGeminiText)
    const tokenUsage = (window as any).__lastTextTokenUsage;
    if (!tokenUsage) return;

    // Clear for next call
    (window as any).__lastTextTokenUsage = null;

    const updatedStats = {
        ...currentStats,
        textTokens: (currentStats?.textTokens || 0) + (tokenUsage.totalTokens || 0),
        promptTokens: (currentStats?.promptTokens || 0) + (tokenUsage.promptTokens || 0),
        candidateTokens: (currentStats?.candidateTokens || 0) + (tokenUsage.candidateTokens || 0),
        textCalls: (currentStats?.textCalls || 0) + 1,
        lastGeneratedAt: new Date().toISOString()
    };

    updateStateAndRecord(s => ({
        ...s,
        usageStats: updatedStats
    }));

    if (userId) {
        syncUserStatsToCloud(userId, updatedStats);
    }

    console.log('[Storage] Token usage tracked:', {
        added: tokenUsage.totalTokens,
        totalAccumulated: updatedStats.textTokens,
        calls: updatedStats.textCalls
    });
}
