/**
 * Image Cache Utility (stub)
 * Provides helper functions for resolving images stored in IndexedDB.
 */

/** Check if a string is an IndexedDB key (idb:// prefix) */
export function isIdbKey(str: string): boolean {
    return typeof str === 'string' && str.startsWith('idb://');
}

/** Resolve an image key to a usable URL (data URL or blob URL) */
export async function resolveImage(key: string): Promise<string | null> {
    // If it's not an IDB key, return as-is
    if (!isIdbKey(key)) return key;

    // Stub: return null if IDB is not available
    try {
        const dbName = 'image-cache';
        const storeName = 'images';
        const cleanKey = key.replace('idb://', '');

        return new Promise((resolve) => {
            const request = indexedDB.open(dbName, 1);
            request.onupgradeneeded = () => {
                const db = request.result;
                if (!db.objectStoreNames.contains(storeName)) {
                    db.createObjectStore(storeName);
                }
            };
            request.onsuccess = () => {
                const db = request.result;
                if (!db.objectStoreNames.contains(storeName)) {
                    resolve(null);
                    return;
                }
                const tx = db.transaction(storeName, 'readonly');
                const store = tx.objectStore(storeName);
                const getReq = store.get(cleanKey);
                getReq.onsuccess = () => {
                    const data = getReq.result;
                    if (data instanceof Blob) {
                        resolve(URL.createObjectURL(data));
                    } else if (typeof data === 'string') {
                        resolve(data);
                    } else {
                        resolve(null);
                    }
                };
                getReq.onerror = () => resolve(null);
            };
            request.onerror = () => resolve(null);
        });
    } catch {
        return null;
    }
}
