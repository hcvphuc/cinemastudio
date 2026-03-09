import React from 'react';
import { Character, CharacterProp } from '../../types';
import Modal from '../Modal';
import SingleImageSlot from '../SingleImageSlot';
import { QualityRating } from '../common/QualityRating';

interface CharacterDetailModalProps {
    isOpen: boolean;
    onClose: () => void;
    character: Character | null;
    updateCharacter: (id: string, updates: Partial<Character>) => void;
    setDefault: (id: string) => void;
    onAnalyze: (id: string, image: string, options?: { skipMetadata?: boolean }) => void;
    onGenerateSheets: (id: string) => void;
    onEditImage: (id: string, image: string, type: 'master' | 'face' | 'body' | 'prop' | 'side' | 'back' | 'sheet', propIndex?: number) => void;
    onOpenCharGen: (id: string, prompt?: string) => void;
    onDelete: (id: string) => void;
}

export const CharacterDetailModal: React.FC<CharacterDetailModalProps> = ({
    isOpen,
    onClose,
    character,
    updateCharacter,
    setDefault,
    onAnalyze,
    onGenerateSheets,
    onEditImage,
    onOpenCharGen,
    onDelete
}) => {
    if (!character) return null;

    const updateProp = (propIndex: number, field: keyof CharacterProp, value: string | null) => {
        const newProps = [...character.props];
        newProps[propIndex] = { ...newProps[propIndex], [field]: value };
        updateCharacter(character.id, { props: newProps });
    };

    return (
        <Modal isOpen={isOpen} onClose={onClose} title={`Chỉnh sửa: ${character.name || 'Unnamed Character'}`}>
            <div className="space-y-6">

                {/* Header Actions */}
                <div className="flex justify-between items-center">
                    <div className="flex space-x-2">
                        <button
                            onClick={() => setDefault(character.id)}
                            className={`px-3 py-1 rounded-full border border-gray-600 transition-colors ${character.isDefault ? 'bg-yellow-500/20 text-yellow-400 border-yellow-500' : 'text-gray-400 hover:text-white hover:border-white'}`}
                        >
                            {character.isDefault ? '⭐ Default Character' : 'Set as Default'}
                        </button>
                    </div>
                    <button
                        onClick={() => {
                            if (confirm("Bạn có chắc muốn xóa nhân vật này?")) {
                                onDelete(character.id);
                                onClose();
                            }
                        }}
                        className="text-red-500 hover:text-red-400 text-sm underline"
                    >
                        Delete Character
                    </button>
                </div>

                {/* Basic Info */}
                <div className="space-y-4">
                    <div>
                        <label className="block text-sm font-medium text-gray-400 mb-1">Tên Nhân Vật</label>
                        <input
                            type="text"
                            value={character.name}
                            onChange={e => updateCharacter(character.id, { name: e.target.value })}
                            onMouseDown={(e) => e.stopPropagation()}
                            className="w-full bg-brand-dark/50 border border-gray-600 rounded px-3 py-2 text-brand-cream focus:outline-none focus:border-brand-orange"
                            placeholder="VD: Nguyễn Văn A"
                        />
                    </div>
                    <div>
                        <label className="block text-sm font-medium text-gray-400 mb-1">Mô tả đặc điểm</label>
                        <textarea
                            value={character.description}
                            onChange={e => updateCharacter(character.id, { description: e.target.value })}
                            onMouseDown={(e) => e.stopPropagation()}
                            rows={3}
                            className="w-full bg-brand-dark/50 border border-gray-600 rounded px-3 py-2 text-brand-cream focus:outline-none focus:border-brand-orange"
                            placeholder="VD: Tóc vàng, mắt xanh, áo khoác da màu đen, có sẹo trên mặt..."
                        />
                    </div>
                </div>


                {/* Master Image */}
                <div>
                    <h3 className="text-sm font-bold text-gray-300 mb-2 uppercase tracking-wider">Reference Chính</h3>
                    <SingleImageSlot
                        label="Ảnh Gốc (Master Reference)"
                        image={character.masterImage}
                        onUpload={(img) => updateCharacter(character.id, { masterImage: img })}
                        onDelete={() => updateCharacter(character.id, { masterImage: null })}
                        onEdit={character.masterImage ? () => onEditImage(character.id, character.masterImage!, 'master') : undefined}
                        onGenerate={() => onOpenCharGen(character.id, character.description || '')}
                        aspect="auto"
                        subLabel="Upload hoặc Tạo AI"
                        isProcessing={character.isAnalyzing}
                        processingStartTime={character.generationStartTime}
                    />

                    {/* DOP Learning Rating */}
                    {character.masterImage && (
                        <div className="mt-2 flex justify-center">
                            <QualityRating
                                dopRecordId={character.dopRecordId}
                                size="md"
                                className="bg-gray-800 px-4 py-2 rounded-lg"
                            />
                        </div>
                    )}

                    {/* Combined Analyze + Generate Buttons */}
                    {character.masterImage && !character.isAnalyzing && (
                        <div className="mt-4 space-y-2">
                            {/* Model Selector for Lora Generation */}
                            <div className="mb-3">
                                <label className="block text-xs font-medium text-gray-400 mb-1">Model tạo Lora:</label>
                                <select
                                    value={character.preferredModel || 'gemini-image-2k'}
                                    onChange={(e) => updateCharacter(character.id, { preferredModel: e.target.value })}
                                    className="w-full bg-brand-dark/80 border border-gray-600 rounded px-3 py-2 text-sm text-brand-cream focus:outline-none focus:border-brand-orange"
                                >
                                    {/* 🐣 UNIFIED (Priority 1 — auto-failover) */}
                                    <optgroup label="🐣 Unified (Auto-Failover)">
                                        <option value="gemini-image-1k">🐣 Gemini Image 1K (1408×768) — $0.36</option>
                                        <option value="gemini-image-2k">🐣 Gemini Image 2K (2816×1536) — $0.45</option>
                                        <option value="gemini-image-4k">🐣 Gemini Image 4K (5632×3072) — $0.50</option>
                                        <option value="gemini-2.5-flash-image">⚡ Gemini 2.5 Flash (1024²) — $0.25</option>
                                    </optgroup>
                                    {/* 👑 LEGACY (still works) */}
                                    <optgroup label="👑 Legacy (tier-specific)">
                                        <option value="gem/gemini-3.1-flash-image-1k">👑 [Legacy] Gemini 3.1 [1K]</option>
                                        <option value="gem/gemini-3.1-flash-image-2k">👑 [Legacy] Gemini 3.1 [2K]</option>
                                        <option value="gem/gemini-3.1-flash-image-4k">👑 [Legacy] Gemini 3.1 [4K]</option>
                                    </optgroup>
                                    {/* 🟡 GOMMO (Priority 2) */}
                                    <optgroup label="🟡 Gommo Proxy">
                                        <option value="google_image_gen_banana_pro">🟡 Nano Banana Pro [Gommo]</option>
                                        <option value="seedream_4_0">🟡 Seedream 4.0 [Gommo]</option>
                                        <option value="o1">🟡 IMAGE O1 [Gommo]</option>
                                    </optgroup>
                                    {/* Other providers */}
                                    <optgroup label="── Khác ──">
                                        <option value="fal-ai/flux-general">🚀 Flux.1 [Dev] Consistency</option>
                                        <option value="gemini-3-pro-image-preview">🔵 Nano Banana Pro [Direct]</option>
                                    </optgroup>
                                </select>
                            </div>

                            {/* Vision Model Selector for Analysis */}
                            <div className="mb-3">
                                <label className="block text-xs font-medium text-gray-400 mb-1">🔍 Model phân tích ảnh:</label>
                                <select
                                    value={character.preferredVisionModel || 'auto'}
                                    onChange={(e) => updateCharacter(character.id, { preferredVisionModel: e.target.value })}
                                    className="w-full bg-brand-dark/80 border border-gray-600 rounded px-3 py-2 text-sm text-brand-cream focus:outline-none focus:border-brand-orange"
                                >
                                    <option value="auto">🔄 Tự động (Imperial → Gemini → Groq)</option>
                                    <option value="imperial">👑 Imperial Vertex (gem/gemini-3-pro)</option>
                                    <option value="gemini">💎 Gemini Direct (cần API Key)</option>
                                    <option value="groq">⚡ Groq Vision (Llama 4 Scout)</option>
                                </select>
                            </div>

                            <button
                                onClick={() => onAnalyze(character.id, character.masterImage!)}
                                className="w-full px-4 py-2.5 bg-gradient-to-r from-indigo-600 to-purple-600 hover:from-indigo-500 hover:to-purple-500 text-white text-sm font-bold rounded-lg transition-all flex items-center justify-center space-x-2 shadow-lg shadow-purple-900/40"
                            >
                                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
                                </svg>
                                <span>Phân tích & Tạo Lora</span>
                            </button>

                            <button
                                onClick={() => onAnalyze(character.id, character.masterImage!, { skipMetadata: true })}
                                className="w-full px-4 py-2.5 bg-brand-dark/80 hover:bg-brand-dark text-brand-orange text-sm font-bold rounded-lg border border-brand-orange/30 transition-all flex items-center justify-center space-x-2"
                                title="Chỉ tạo ảnh nhận diện (Face ID/Body), giữ nguyên Tên và Mô tả hiện tại"
                            >
                                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                                </svg>
                                <span>Chỉ Tạo Ảnh (Giữ tên/mô tả)</span>
                            </button>

                            <p className="text-[10px] text-gray-500 mt-2 text-center italic">
                                *AI luôn phân tích style ảnh gốc để đảm bảo độ chính xác
                            </p>
                        </div>
                    )}
                </div>


                <div className="border-t border-gray-700 my-4"></div>

                {/* Character Sheet (Multi-View Reference) */}
                <div>
                    <h3 className="text-sm font-bold text-gray-300 mb-2 uppercase tracking-wider">
                        Character Sheet
                        {character.sheetGenMode === 'sheet' && (
                            <span className="ml-2 text-[10px] bg-green-500/20 text-green-400 px-2 py-0.5 rounded-full font-normal normal-case">
                                ✅ AI Generated
                            </span>
                        )}
                    </h3>
                    <SingleImageSlot
                        label="Character Reference Sheet"
                        image={character.characterSheet}
                        onUpload={(img) => updateCharacter(character.id, { characterSheet: img, sheetGenMode: 'legacy' })}
                        onDelete={() => updateCharacter(character.id, { characterSheet: null, sheetGenMode: undefined })}
                        onEdit={character.characterSheet ? () => onEditImage(character.id, character.characterSheet!, 'sheet') : undefined}
                        aspect="auto"
                        subLabel="All angles: Front / Left / Right / Back"
                    />
                    {!character.characterSheet && (character.faceImage || character.bodyImage) && (
                        <p className="text-[10px] text-yellow-500/70 mt-1 text-center italic">
                            ⚠️ Using legacy Face/Body refs. Re-analyze to generate sheet.
                        </p>
                    )}
                </div>
            </div>
        </Modal>
    );
};
