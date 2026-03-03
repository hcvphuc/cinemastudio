import React, { useState, useEffect } from 'react';
import Modal from '../Modal';
import { supabase } from '../../utils/supabaseClient';
import { PRIMARY_GRADIENT, PRIMARY_GRADIENT_HOVER } from '../../constants/presets';
import { type ProviderType, getProviderConfig, setProviderConfig, validateApiKey, clearProviderCache } from '../../utils/aiProvider';

export interface ApiKeyModalProps {
    isOpen: boolean;
    onClose: () => void;
    apiKey: string;
    setApiKey: (key: string) => void;
    userId?: string;
}

const PROVIDERS: { type: ProviderType; label: string; description: string; placeholder: string }[] = [
    { type: 'gemini', label: '🔵 Gemini Direct', description: 'Google AI Studio API key', placeholder: 'AIza...' },
    { type: 'vertex-key', label: '🟢 Vertex Key', description: 'VietAI Gateway (vertex-key.com)', placeholder: 'vai-...' },
];

export const ApiKeyModal: React.FC<ApiKeyModalProps> = ({ isOpen, onClose, apiKey, setApiKey, userId }) => {
    const [checkStatus, setCheckStatus] = useState<'idle' | 'checking' | 'success' | 'error'>('idle');
    const [statusMsg, setStatusMsg] = useState('');
    const [selectedProvider, setSelectedProvider] = useState<ProviderType>('gemini');
    const [vertexKeyApiKey, setVertexKeyApiKey] = useState('');

    useEffect(() => {
        if (isOpen) {
            setCheckStatus('idle');
            setStatusMsg('');
            const config = getProviderConfig();
            setSelectedProvider(config.type);
            setVertexKeyApiKey(config.vertexKeyApiKey);
        }
    }, [isOpen]);

    const currentKey = selectedProvider === 'vertex-key' ? vertexKeyApiKey : apiKey;
    const currentPlaceholder = PROVIDERS.find(p => p.type === selectedProvider)?.placeholder || '';

    const handleKeyChange = (value: string) => {
        if (selectedProvider === 'vertex-key') {
            setVertexKeyApiKey(value);
        } else {
            setApiKey(value);
        }
    };

    const handleVerify = async () => {
        const trimmedKey = currentKey.trim();
        if (!trimmedKey) {
            setCheckStatus('error');
            setStatusMsg("Vui lòng nhập API Key.");
            return;
        }

        setCheckStatus('checking');
        try {
            const isValid = await validateApiKey(selectedProvider, trimmedKey);

            if (!isValid) {
                throw new Error('API key không hợp lệ hoặc không hoạt động.');
            }

            // Save provider config
            setProviderConfig({
                type: selectedProvider,
                ...(selectedProvider === 'vertex-key'
                    ? { vertexKeyApiKey: trimmedKey }
                    : { geminiApiKey: trimmedKey }
                ),
            });
            clearProviderCache();

            // Also update parent state for Gemini key (backward compat)
            if (selectedProvider === 'gemini') {
                setApiKey(trimmedKey);
            } else {
                // For vertex-key, also store as geminiApiKey for backward compat
                localStorage.setItem('geminiApiKey', trimmedKey);
                setApiKey(trimmedKey);
            }

            // Save to Supabase if user is logged in
            if (userId) {
                const { error: supabaseError } = await supabase
                    .from('user_api_keys')
                    .upsert({
                        user_id: userId,
                        provider: selectedProvider,
                        encrypted_key: trimmedKey,
                        is_active: true,
                        updated_at: new Date().toISOString()
                    }, { onConflict: 'user_id,provider' });

                if (supabaseError) {
                    console.error('Supabase save error:', supabaseError);
                }
            }

            setCheckStatus('success');
            const providerLabel = PROVIDERS.find(p => p.type === selectedProvider)?.label || selectedProvider;
            setStatusMsg(`✅ ${providerLabel} — Kết nối thành công! Key đã được lưu.`);
            setTimeout(onClose, 1500);
        } catch (error: any) {
            setCheckStatus('error');
            let msg = error.message || "Lỗi kết nối.";
            if (msg.includes('403') || msg.includes('PERMISSION_DENIED')) {
                msg = "Lỗi 403: Quyền bị từ chối. Kiểm tra API key và billing.";
            } else if (msg.includes('400') || msg.includes('INVALID_ARGUMENT')) {
                msg = "Lỗi 400: API Key không hợp lệ.";
            } else if (msg.includes('401')) {
                msg = "Lỗi 401: API Key sai hoặc hết hạn.";
            }
            setStatusMsg(msg);
        }
    };

    return (
        <Modal isOpen={isOpen} onClose={onClose} title="Quản lý API Key">
            {/* Provider Selector */}
            <div className="mb-4">
                <label className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2 block">
                    AI Provider
                </label>
                <div className="grid grid-cols-2 gap-2">
                    {PROVIDERS.map(p => (
                        <button
                            key={p.type}
                            onClick={() => {
                                setSelectedProvider(p.type);
                                setCheckStatus('idle');
                                setStatusMsg('');
                            }}
                            className={`p-3 rounded-lg border text-left transition-all ${selectedProvider === p.type
                                    ? 'border-violet-500 bg-violet-500/10 text-white'
                                    : 'border-gray-700 bg-gray-800/50 text-gray-400 hover:border-gray-600'
                                }`}
                        >
                            <div className="font-medium text-sm">{p.label}</div>
                            <div className="text-xs text-gray-500 mt-0.5">{p.description}</div>
                        </button>
                    ))}
                </div>
            </div>

            {/* API Key Input */}
            <label className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-1.5 block">
                {selectedProvider === 'vertex-key' ? 'Vertex Key API Key' : 'Gemini API Key'}
            </label>
            <input
                type="password"
                value={currentKey}
                onChange={(e) => handleKeyChange(e.target.value)}
                placeholder={currentPlaceholder}
                className="w-full px-3 py-2 bg-gray-800 border border-gray-600 rounded-md text-white focus:outline-none focus:ring-2 focus:ring-violet-500"
            />

            {selectedProvider === 'vertex-key' && (
                <p className="text-xs text-gray-500 mt-1.5">
                    Lấy key tại <a href="https://vertex-key.com" target="_blank" rel="noopener noreferrer" className="text-violet-400 hover:underline">vertex-key.com</a>
                </p>
            )}

            {checkStatus !== 'idle' && (
                <div className={`mt-3 text-sm p-3 rounded-lg border flex items-start ${checkStatus === 'checking' ? 'bg-blue-900/30 border-blue-800 text-blue-200' :
                    checkStatus === 'success' ? 'bg-green-900/30 border-green-800 text-green-200' :
                        'bg-red-900/30 border-red-800 text-red-200'
                    }`}>
                    <span className="mr-2 text-lg">
                        {checkStatus === 'checking' && '⏳'}
                        {checkStatus === 'success' && '✅'}
                        {checkStatus === 'error' && '⚠️'}
                    </span>
                    <span>{statusMsg}</span>
                </div>
            )}

            <div className="flex justify-end mt-6 space-x-2">
                <button onClick={onClose} className="px-4 py-2 text-gray-400 hover:text-white transition-colors font-medium">Đóng</button>
                <button
                    onClick={handleVerify}
                    disabled={checkStatus === 'checking'}
                    className={`px-6 py-2 font-semibold text-white rounded-lg bg-gradient-to-r ${PRIMARY_GRADIENT} hover:${PRIMARY_GRADIENT_HOVER} transition-all duration-300 transform hover:scale-105 disabled:opacity-50 disabled:cursor-not-allowed`}
                >
                    {checkStatus === 'checking' ? 'Đang kiểm tra...' : 'Kiểm tra & Lưu'}
                </button>
            </div>
        </Modal>
    );
};
