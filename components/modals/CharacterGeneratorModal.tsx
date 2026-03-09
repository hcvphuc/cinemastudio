import React, { useState, useEffect } from 'react';
import Modal from '../Modal';
import { Character } from '../../types';
import { IMAGE_MODELS, CHARACTER_STYLES, PRIMARY_GRADIENT, PRIMARY_GRADIENT_HOVER } from '../../constants/presets';
import { ModelSelector } from '../common/ModelSelector';
import { QualityRating } from '../common/QualityRating';

// LiveTimer component for realtime generation timer
const LiveTimer: React.FC<{ startTime: number }> = ({ startTime }) => {
    const [elapsed, setElapsed] = useState(0);
    useEffect(() => {
        const interval = setInterval(() => setElapsed(Date.now() - startTime), 100);
        return () => clearInterval(interval);
    }, [startTime]);
    const seconds = (elapsed / 1000).toFixed(1);
    return <span className="font-mono text-xs">{seconds}s</span>;
};

export interface CharacterGeneratorModalProps {
    isOpen: boolean;
    onClose: () => void;
    onSave: (image: string) => void;
    apiKey: string;
    model: string;
    charId: string | null;
    updateCharacter: (id: string, updates: Partial<Character>) => void;
    generateCharacterImage: (id: string, params: any) => Promise<void>;
    characters: Character[];
    initialPrompt?: string; // NEW: Pre-fill from script analysis
}
export const CharacterGeneratorModal: React.FC<CharacterGeneratorModalProps> = ({
    isOpen,
    onClose,
    onSave,
    apiKey,
    model,
    charId,
    updateCharacter,
    generateCharacterImage,
    characters,
    initialPrompt = ''
}) => {
    const [prompt, setPrompt] = useState('');
    const [style, setStyle] = useState('pixar');
    const [resolution, setResolution] = useState('1K');
    const [aspectRatio, setAspectRatio] = useState('9:16');
    const [error, setError] = useState<string | null>(null);
    const [selectedModel, setSelectedModel] = useState(model);
    const [customStyle, setCustomStyle] = useState('');

    const character = charId ? characters.find(c => c.id === charId) : null;
    const isGenerating = character?.isGenerating || false;
    const generationStartTime = character?.generationStartTime;
    const generationStatus = character?.generationStatus || '';
    const generatedImage = character?.generatedImage || null;
    const dopRecordId = character?.dopRecordId;

    useEffect(() => {
        if (isOpen) {
            setPrompt(initialPrompt || '');
            setError(null);
            setSelectedModel(model);
            setResolution('1K');
            setAspectRatio('9:16');
            setCustomStyle('');
        }
    }, [isOpen, model, initialPrompt]);

    const handleGenerate = async () => {
        if (!prompt.trim() || !charId) return;

        const selectedModelInfo = IMAGE_MODELS.find(m => m.value === selectedModel);
        const provider = selectedModelInfo?.provider || 'fal';

        // Only require Gemini API Key for Gemini models
        if (provider === 'gemini' && !apiKey) {
            setError("Vui lòng nhập API Key (Gemini) để sử dụng model này.");
            return;
        }

        setError(null);
        await generateCharacterImage(charId, {
            prompt,
            style,
            customStyle,
            aspectRatio,
            resolution,
            model: selectedModel
        });
    };

    if (!isOpen) return null;

    return (
        <Modal isOpen={isOpen} onClose={onClose} title="Tạo Nhân Vật Mới (AI Creator)">
            <div className="space-y-4">
                <div className="flex justify-end items-center space-x-2">
                    <span className="text-xs text-gray-400">Model:</span>
                    <ModelSelector
                        models={IMAGE_MODELS}
                        value={selectedModel}
                        onChange={setSelectedModel}
                        size="sm"
                        className="w-64"
                    />
                </div>

                <div>
                    <label className="block text-sm font-bold text-gray-300 mb-1">1. Mô tả nhân vật của bạn</label>
                    <textarea
                        value={prompt}
                        onChange={(e) => setPrompt(e.target.value)}
                        placeholder="VD: Một chú chó đốm dễ thương, đeo vòng cổ đỏ, mắt to tròn..."
                        rows={3}
                        className="w-full bg-gray-800 border border-gray-600 rounded-md text-white p-3 focus:outline-none focus:ring-2 focus:ring-green-500"
                    />
                </div>

                <div className="grid grid-cols-2 gap-4">
                    <div>
                        <label className="block text-xs font-medium text-gray-400 mb-1">Phong cách (Style)</label>
                        <select
                            value={style}
                            onChange={(e) => setStyle(e.target.value)}
                            className="w-full bg-gray-900 border border-gray-700 rounded p-2 text-sm text-white focus:border-green-500"
                        >
                            {CHARACTER_STYLES.map(s => (
                                <option key={s.value} value={s.value}>{s.label}</option>
                            ))}
                            <option value="custom" className="text-brand-orange font-bold">+ Tùy chỉnh (Style)...</option>
                        </select>
                    </div>
                    {style === 'custom' && (
                        <div className="col-span-2">
                            <label className="block text-[10px] font-medium text-brand-orange mb-1">Nhập phong cách tùy chỉnh</label>
                            <textarea
                                value={customStyle}
                                onChange={(e) => setCustomStyle(e.target.value)}
                                placeholder="VD: Ghibli style, hand-drawn, watercolor, soft lighting..."
                                rows={2}
                                className="w-full bg-gray-900 border border-brand-orange rounded p-2 text-xs text-white focus:outline-none"
                            />
                        </div>
                    )}
                    <div className="flex space-x-2">
                        <div className="flex-1">
                            <label className="block text-xs font-medium text-gray-400 mb-1">Tỷ lệ (Ratio)</label>
                            <select
                                value={aspectRatio}
                                onChange={(e) => setAspectRatio(e.target.value)}
                                className="w-full bg-gray-900 border border-gray-700 rounded p-2 text-sm text-white focus:border-green-500"
                            >
                                <option value="9:16">9:16 (Portrait)</option>
                                <option value="16:9">16:9 (Landscape)</option>
                                <option value="1:1">1:1 (Square)</option>
                                <option value="4:3">4:3 (TV)</option>
                                <option value="3:4">3:4 (Portrait)</option>
                            </select>
                        </div>
                        <div className="flex-1">
                            <label className="block text-xs font-medium text-gray-400 mb-1">Độ phân giải</label>
                            {(() => {
                                const modelInfo = IMAGE_MODELS.find(m => m.value === selectedModel);
                                const isGommo = modelInfo?.provider === 'gommo';
                                const isNanoAi = modelInfo?.provider === 'nanoai';
                                const providerLabel = isNanoAi ? '🟠' : (isGommo ? '🟡' : '🔵');
                                return (
                                    <select
                                        value={resolution}
                                        onChange={(e) => setResolution(e.target.value)}
                                        className="w-full bg-gray-900 border border-gray-700 rounded p-2 text-sm text-white focus:border-green-500"
                                    >
                                        <option value="1K">1K (1024x) - {providerLabel} Chuẩn</option>
                                        <option value="2K">2K (2048x) - {providerLabel} Nét</option>
                                        <option value="4K">4K (4096x) - {providerLabel} Siêu Nét</option>
                                    </select>
                                );
                            })()}
                        </div>
                    </div>
                </div>

                <div className="w-full aspect-square bg-gray-950 rounded-lg border-2 border-dashed border-gray-700 flex items-center justify-center overflow-hidden relative">
                    {isGenerating ? (
                        <div className="flex flex-col items-center space-y-3 p-4">
                            <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-green-500"></div>

                            {/* Status from DOP */}
                            <span className="text-green-500 text-sm text-center px-2">
                                {generationStatus || 'AI đang vẽ...'}
                            </span>

                            {/* Live Timer */}
                            {generationStartTime && (
                                <div className="bg-black/60 px-3 py-1 rounded-full border border-green-500/50 text-green-400 flex items-center gap-1">
                                    ⏱ <LiveTimer startTime={generationStartTime} />
                                </div>
                            )}
                        </div>
                    ) : generatedImage ? (
                        <div className="relative w-full h-full">
                            <img src={generatedImage} alt="Generated Character" className="w-full h-full object-contain" />
                            {/* DOP Learning Rating */}
                            <div className="absolute bottom-2 left-1/2 -translate-x-1/2">
                                <QualityRating
                                    dopRecordId={dopRecordId}
                                    size="md"
                                    className="bg-black/70 px-3 py-1.5 rounded-full backdrop-blur-sm"
                                />
                            </div>
                        </div>
                    ) : (
                        <span className="text-gray-600 text-sm">Ảnh sẽ hiện ở đây</span>
                    )}
                </div>

                {error && <p className="text-red-400 text-sm text-center">{error}</p>}

                <div className="flex space-x-3 pt-2">
                    {!generatedImage ? (
                        <button
                            onClick={() => {
                                handleGenerate();
                            }}
                            disabled={isGenerating || !prompt}
                            className={`w-full py-3 font-bold text-white rounded-lg bg-blue-600 hover:bg-blue-500 transition-all disabled:opacity-50 shadow-lg`}
                        >
                            Tạo Nhân Vật
                        </button>
                    ) : (
                        <>
                            <button
                                onClick={handleGenerate}
                                className="flex-1 py-3 font-semibold text-gray-300 bg-gray-700 hover:bg-gray-600 rounded-lg transition-colors"
                            >
                                Thử lại
                            </button>
                            <button
                                onClick={() => {
                                    onSave(generatedImage);
                                    onClose();
                                    updateCharacter(charId!, { generatedImage: null });
                                }}
                                className={`flex-[2] py-3 font-bold text-white rounded-lg bg-gradient-to-r ${PRIMARY_GRADIENT} hover:${PRIMARY_GRADIENT_HOVER} transition-all shadow-lg transform hover:scale-105`}
                            >
                                ✅ Lưu ảnh này
                            </button>
                        </>
                    )}
                </div>
            </div>
        </Modal>
    );
};
