import React, { useState, useEffect } from 'react';
import { GoogleGenAI } from "@google/genai";
import Modal from '../Modal';
import { supabase } from '../../utils/supabaseClient';
import { PRIMARY_GRADIENT, PRIMARY_GRADIENT_HOVER } from '../../constants/presets';
import {
    getImperialApiKey,
    setImperialApiKey,
    isImperialUltraEnabled,
    setImperialUltraEnabled,
    checkImperialHealth,
    getImperialKeySource
} from '../../utils/imperialUltraClient';

export interface ApiKeyModalProps {
    isOpen: boolean;
    onClose: () => void;
    apiKey: string;
    setApiKey: (key: string) => void;
    userId?: string;
}

export const ApiKeyModal: React.FC<ApiKeyModalProps> = ({ isOpen, onClose, apiKey, setApiKey, userId }) => {
    const [checkStatus, setCheckStatus] = useState<'idle' | 'checking' | 'success' | 'error'>('idle');
    const [statusMsg, setStatusMsg] = useState('');

    // Imperial Ultra state
    const [imperialKey, setImperialKeyState] = useState('');
    const [imperialEnabled, setImperialEnabledState] = useState(true);
    const [imperialCheckStatus, setImperialCheckStatus] = useState<'idle' | 'checking' | 'success' | 'error'>('idle');
    const [imperialStatusMsg, setImperialStatusMsg] = useState('');

    useEffect(() => {
        if (isOpen) {
            setCheckStatus('idle');
            setStatusMsg('');
            setImperialCheckStatus('idle');
            setImperialStatusMsg('');

            // Load Imperial settings
            const currentKey = getImperialApiKey();
            const keySource = getImperialKeySource();
            // Only show user-entered key, not default
            setImperialKeyState(keySource === 'user' ? currentKey : '');
            setImperialEnabledState(isImperialUltraEnabled());
        }
    }, [isOpen]);

    const handleVerify = async () => {
        const trimmedKey = apiKey.trim();
        if (!trimmedKey) {
            setCheckStatus('error');
            setStatusMsg("Vui lòng nhập API Key.");
            return;
        }

        setCheckStatus('checking');
        try {
            const ai = new GoogleGenAI({ apiKey: trimmedKey });
            const response = await ai.models.generateContent({
                model: 'gemini-2.5-flash',
                contents: 'Test connection'
            });

            if (response.promptFeedback?.blockReason) {
                throw new Error(`Bị chặn: ${response.promptFeedback.blockReason}`);
            }


            if (userId) {
                // Upsert to Supabase
                const { error: supabaseError } = await supabase
                    .from('user_api_keys')
                    .upsert({
                        user_id: userId,
                        provider: 'gemini',
                        encrypted_key: trimmedKey,
                        is_active: true,
                        updated_at: new Date().toISOString()
                    }, { onConflict: 'user_id,provider' });

                if (supabaseError) {
                    console.error('Supabase save error:', supabaseError);
                    // We don't block the user if cloud save fails, but we could
                }
            }

            setApiKey(trimmedKey); // Save trimmed key
            setCheckStatus('success');
            setStatusMsg("Kết nối thành công! Key đã được lưu trên hệ thống.");
            setTimeout(onClose, 1500);
        } catch (error: any) {
            setCheckStatus('error');
            let msg = error.message || "Lỗi kết nối.";
            if (msg.includes('403') || msg.includes('PERMISSION_DENIED')) {
                msg = "Lỗi 403: Quyền bị từ chối. Hãy kiểm tra: 1) Project GCP đã bật Generative AI API chưa? 2) Billing đã kích hoạt chưa?";
            } else if (msg.includes('400') || msg.includes('INVALID_ARGUMENT')) {
                msg = "Lỗi 400: API Key không hợp lệ.";
            } else if (msg.includes('404')) {
                msg = "Lỗi 404: Model không tồn tại hoặc API version không hỗ trợ.";
            }
            setStatusMsg(msg);
        }
    };

    const handleImperialVerify = async () => {
        setImperialCheckStatus('checking');
        setImperialStatusMsg('Đang kiểm tra kết nối vertex-key.com...');

        try {
            // Save key first (so health check uses it)
            if (imperialKey.trim()) {
                setImperialApiKey(imperialKey.trim());
            }

            // Toggle enabled/disabled
            setImperialUltraEnabled(imperialEnabled);

            if (!imperialEnabled) {
                setImperialCheckStatus('success');
                setImperialStatusMsg('Imperial Ultra đã tắt.');
                return;
            }

            const healthy = await checkImperialHealth();

            if (healthy) {
                setImperialCheckStatus('success');
                const keySource = getImperialKeySource();
                setImperialStatusMsg(`✅ Kết nối thành công! (Key: ${keySource.toUpperCase()})`);
            } else {
                setImperialCheckStatus('error');
                setImperialStatusMsg('❌ Không thể kết nối vertex-key.com. Kiểm tra API Key hoặc server.');
            }
        } catch (error: any) {
            setImperialCheckStatus('error');
            setImperialStatusMsg(`Lỗi: ${error.message}`);
        }
    };

    return (
        <Modal isOpen={isOpen} onClose={onClose} title="Quản lý API Key">
            {/* ═══════════════ GEMINI SECTION ═══════════════ */}
            <div className="mb-6">
                <h3 className="text-sm font-semibold text-gray-300 mb-2 flex items-center gap-2">
                    <span className="text-blue-400">🔵</span> Gemini API Key (Google AI Studio)
                </h3>
                <p className="text-gray-500 text-xs mb-2">Nhập Gemini API key (Paid Tier 1) để sử dụng tất cả tính năng cơ bản.</p>
                <input
                    type="password"
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    placeholder="Enter your Gemini API Key"
                    className="w-full px-3 py-2 bg-gray-800 border border-gray-600 rounded-md text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
                {checkStatus !== 'idle' && (
                    <div className={`mt-2 text-sm p-2 rounded-lg border flex items-start ${checkStatus === 'checking' ? 'bg-blue-900/30 border-blue-800 text-blue-200' :
                        checkStatus === 'success' ? 'bg-green-900/30 border-green-800 text-green-200' :
                            'bg-red-900/30 border-red-800 text-red-200'
                        }`}>
                        <span className="mr-2">
                            {checkStatus === 'checking' && '⏳'}
                            {checkStatus === 'success' && '✅'}
                            {checkStatus === 'error' && '⚠️'}
                        </span>
                        <span className="text-xs">{statusMsg}</span>
                    </div>
                )}
                <button
                    onClick={handleVerify}
                    disabled={checkStatus === 'checking'}
                    className={`mt-2 px-4 py-1.5 text-sm font-semibold text-white rounded-lg bg-gradient-to-r from-blue-600 to-blue-500 hover:from-blue-500 hover:to-blue-400 transition-all duration-300 disabled:opacity-50 disabled:cursor-not-allowed`}
                >
                    {checkStatus === 'checking' ? 'Đang kiểm tra...' : 'Kiểm tra Gemini'}
                </button>
            </div>

            {/* ═══════════════ DIVIDER ═══════════════ */}
            <div className="border-t border-gray-700 my-4"></div>

            {/* ═══════════════ IMPERIAL ULTRA SECTION ═══════════════ */}
            <div className="mb-4">
                <h3 className="text-sm font-semibold text-gray-300 mb-2 flex items-center gap-2">
                    <span className="text-red-400">🔴</span> Imperial Ultra (Vertex API)
                    <label className="ml-auto flex items-center gap-2 cursor-pointer">
                        <span className="text-xs text-gray-500">{imperialEnabled ? 'Bật' : 'Tắt'}</span>
                        <div
                            onClick={() => setImperialEnabledState(!imperialEnabled)}
                            className={`relative inline-block w-10 h-5 rounded-full transition-colors duration-300 ${imperialEnabled ? 'bg-red-500' : 'bg-gray-600'}`}
                        >
                            <div className={`absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full transition-transform duration-300 ${imperialEnabled ? 'translate-x-5' : ''}`}></div>
                        </div>
                    </label>
                </h3>
                <p className="text-gray-500 text-xs mb-2">
                    Proxy API premium qua vertex-key.com. Hỗ trợ ảnh 4K, Smart Routing, và tự động failover.
                    {!imperialKey.trim() && <span className="text-yellow-500"> (Đang dùng key mặc định)</span>}
                </p>
                <input
                    type="password"
                    value={imperialKey}
                    onChange={(e) => setImperialKeyState(e.target.value)}
                    placeholder="vai-... (để trống = dùng key mặc định)"
                    disabled={!imperialEnabled}
                    className={`w-full px-3 py-2 bg-gray-800 border border-gray-600 rounded-md text-white focus:outline-none focus:ring-2 focus:ring-red-500 ${!imperialEnabled ? 'opacity-50' : ''}`}
                />
                {imperialCheckStatus !== 'idle' && (
                    <div className={`mt-2 text-sm p-2 rounded-lg border flex items-start ${imperialCheckStatus === 'checking' ? 'bg-blue-900/30 border-blue-800 text-blue-200' :
                        imperialCheckStatus === 'success' ? 'bg-green-900/30 border-green-800 text-green-200' :
                            'bg-red-900/30 border-red-800 text-red-200'
                        }`}>
                        <span className="mr-2">
                            {imperialCheckStatus === 'checking' && '⏳'}
                            {imperialCheckStatus === 'success' && '✅'}
                            {imperialCheckStatus === 'error' && '⚠️'}
                        </span>
                        <span className="text-xs">{imperialStatusMsg}</span>
                    </div>
                )}
                <button
                    onClick={handleImperialVerify}
                    disabled={imperialCheckStatus === 'checking'}
                    className={`mt-2 px-4 py-1.5 text-sm font-semibold text-white rounded-lg bg-gradient-to-r from-red-600 to-orange-500 hover:from-red-500 hover:to-orange-400 transition-all duration-300 disabled:opacity-50 disabled:cursor-not-allowed`}
                >
                    {imperialCheckStatus === 'checking' ? 'Đang kiểm tra...' : 'Kiểm tra Imperial'}
                </button>
            </div>

            {/* ═══════════════ ACTIONS ═══════════════ */}
            <div className="flex justify-end mt-6 space-x-2">
                <button onClick={onClose} className="px-4 py-2 text-gray-400 hover:text-white transition-colors font-medium">Đóng</button>
            </div>
        </Modal>
    );
};
