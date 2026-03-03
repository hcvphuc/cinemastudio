import React, { useState } from 'react';
import { Trash2, GripVertical, Download, Pencil, Layers, X, Eye } from 'lucide-react';
import { SceneRowProps } from './SceneRow';

// Preset angles for Insert Angles feature (same as SceneRow)
const INSERT_ANGLE_OPTIONS = [
    { value: 'wide-shot', label: 'Wide Shot (WS)' },
    { value: 'medium-shot', label: 'Medium Shot (MS)' },
    { value: 'close-up', label: 'Close Up (CU)' },
    { value: 'extreme-cu', label: 'Extreme Close Up (ECU)' },
    { value: 'low-angle', label: 'Low Angle' },
    { value: 'high-angle', label: 'High Angle' },
    { value: 'ots', label: 'Over The Shoulder' },
    { value: 'dutch-angle', label: 'Dutch Angle' },
];

interface StoryBoardCardProps extends SceneRowProps {
    onEditImage?: (scene: any) => void;
}

export const StoryBoardCard: React.FC<StoryBoardCardProps> = ({
    scene, index, updateScene, assignSceneToGroup, sceneGroups, removeScene,
    generateImage, openImageViewer,
    onDragStart, onDragOver, onDrop,
    onInsertAngles,
    onEditImage,
    onExpandScene,
    isExpandingSequence
}) => {
    const [showAnglesMenu, setShowAnglesMenu] = useState(false);

    // Download image with sequential numbering
    const handleDownloadImage = () => {
        if (!scene.generatedImage) return;
        const paddedNumber = String(index + 1).padStart(3, '0');
        const fileName = `${paddedNumber}.png`;
        const link = document.createElement('a');
        link.href = scene.generatedImage;
        link.download = fileName;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    };

    // Handle insert angle selection
    const handleInsertAngle = (angleValue: string) => {
        if (onInsertAngles && scene.generatedImage) {
            onInsertAngles(scene.id, [{ value: angleValue }], scene.generatedImage);
        }
        setShowAnglesMenu(false);
    };

    return (
        <div
            draggable
            onDragStart={() => onDragStart(index)}
            onDragOver={(e) => { e.preventDefault(); onDragOver(index); }}
            onDrop={() => onDrop(index)}
            className={`flex flex-col bg-gray-800/40 rounded-xl border transition-all group/card relative overflow-hidden h-full ${index === (window as any).dragOverIndex ? 'border-brand-orange bg-brand-orange/10 scale-[1.02] shadow-2xl z-10' : 'border-gray-700/50 hover:border-gray-500'
                }`}
        >
            {/* Image Section */}
            <div
                className="aspect-video bg-black relative cursor-pointer overflow-hidden group/img"
                onClick={() => scene.generatedImage && openImageViewer()}
            >
                {scene.isGenerating ? (
                    <div className="absolute inset-0 flex flex-col items-center justify-center bg-gray-900/80">
                        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-brand-orange mb-2"></div>
                        <span className="text-[10px] text-brand-orange animate-pulse">Rendering...</span>
                    </div>
                ) : scene.generatedImage ? (
                    <img src={scene.generatedImage} alt={`Scene ${index + 1}`} className="w-full h-full object-cover transition-transform duration-500 group-hover/img:scale-110" />
                ) : (
                    <div className="absolute inset-0 flex flex-col items-center justify-center text-gray-600 space-y-2">
                        <span className="text-3xl">🖼️</span>
                        <span className="text-[10px] uppercase tracking-wider font-bold">No Image</span>
                    </div>
                )}

                {/* Actions Overlay */}
                <div className="absolute inset-0 bg-black/70 opacity-0 group-hover/img:opacity-100 transition-opacity flex items-center justify-center gap-1.5 p-2">
                    {/* Download Button */}
                    {scene.generatedImage && (
                        <button
                            onClick={(e) => { e.stopPropagation(); handleDownloadImage(); }}
                            className="p-2 bg-green-600 text-white rounded-full hover:scale-110 transition-transform shadow-lg"
                            title="Tải ảnh"
                        >
                            <Download size={14} />
                        </button>
                    )}

                    {/* Edit Button - Always show if image exists */}
                    {scene.generatedImage && (
                        <button
                            onClick={(e) => { e.stopPropagation(); if (onEditImage) onEditImage(scene); }}
                            className="p-2 bg-blue-600 text-white rounded-full hover:scale-110 transition-transform shadow-lg"
                            title="Chỉnh sửa ảnh"
                        >
                            <Pencil size={14} />
                        </button>
                    )}

                    {/* Insert Angles Button - Always show if image exists */}
                    {scene.generatedImage && (
                        <div className="relative">
                            <button
                                onClick={(e) => { e.stopPropagation(); setShowAnglesMenu(!showAnglesMenu); }}
                                className={`p-2 ${showAnglesMenu ? 'bg-purple-500' : 'bg-purple-600'} text-white rounded-full hover:scale-110 transition-transform shadow-lg`}
                                title="Thêm góc máy"
                            >
                                <Layers size={14} />
                            </button>

                            {/* Angles Dropdown */}
                            {showAnglesMenu && (
                                <div
                                    className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 bg-gray-900 border border-gray-700 rounded-lg shadow-xl p-2 min-w-[160px] z-50"
                                    onClick={(e) => e.stopPropagation()}
                                >
                                    <div className="flex justify-between items-center mb-2 pb-1 border-b border-gray-700">
                                        <span className="text-[9px] font-bold text-gray-400 uppercase">Chọn góc</span>
                                        <button onClick={() => setShowAnglesMenu(false)} className="text-gray-500 hover:text-white">
                                            <X size={12} />
                                        </button>
                                    </div>
                                    <div className="space-y-1 max-h-[200px] overflow-y-auto">
                                        {INSERT_ANGLE_OPTIONS.map(opt => (
                                            <button
                                                key={opt.value}
                                                onClick={() => handleInsertAngle(opt.value)}
                                                className="w-full text-left px-2 py-1.5 text-[10px] text-gray-300 hover:bg-purple-500/20 hover:text-purple-300 rounded transition-colors"
                                            >
                                                {opt.label}
                                            </button>
                                        ))}
                                    </div>
                                </div>
                            )}
                        </div>
                    )}

                    {/* View/Zoom Button (was Generate) */}
                    <button
                        onClick={(e) => { e.stopPropagation(); openImageViewer(); }}
                        className="p-2 bg-brand-orange text-white rounded-full hover:scale-110 transition-transform shadow-lg"
                        title="Xem ảnh lớn"
                    >
                        <Eye size={14} />
                    </button>
                </div>

                {/* Drag Handle Overlay */}
                <div className="absolute top-2 left-2 p-1.5 bg-black/50 text-white rounded cursor-grab active:cursor-grabbing opacity-0 group-hover/card:opacity-100 transition-opacity">
                    <GripVertical size={14} />
                </div>

                {/* Key Frame Badge + Toggle */}
                <button
                    onClick={(e) => { e.stopPropagation(); updateScene(scene.id, { isKeyFrame: !scene.isKeyFrame }); }}
                    className={`absolute top-2 right-2 px-2 py-1 rounded-full text-[9px] font-bold uppercase tracking-wide transition-all ${scene.isKeyFrame
                        ? 'bg-yellow-500 text-black shadow-lg shadow-yellow-500/30'
                        : 'bg-black/50 text-gray-400 opacity-0 group-hover/card:opacity-100 hover:bg-yellow-500/20 hover:text-yellow-400'
                        }`}
                    title={scene.isKeyFrame ? 'Remove Key Frame (scenes will use previous anchor)' : 'Mark as Key Frame (hero shot for nearby scenes)'}
                >
                    {scene.isKeyFrame ? '⭐ KEY' : '☆ Key'}
                </button>
            </div>

            {/* Content Section */}
            <div className="p-3 flex-1 flex flex-col space-y-2">
                {/* Voiceover Display */}
                <div className="flex-1 overflow-y-auto max-h-40 scrollbar-thin scrollbar-thumb-zinc-700 scrollbar-track-transparent">
                    <p
                        className="text-[11px] text-gray-300 italic leading-relaxed"
                        title={scene.voiceover || scene.voiceOverText || scene.language1 || scene.vietnamese || scene.contextDescription || ''}
                    >
                        <span className="text-violet-400 not-italic mr-1">🎙️</span>
                        {scene.voiceover || scene.voiceOverText || scene.language1 || scene.vietnamese || scene.contextDescription || '(Chưa có voiceover)'}
                    </p>
                </div>

                <div className="mt-auto pt-2 flex justify-between items-center border-t border-gray-700/50">
                    <div className="flex items-center space-x-2">
                        <span className="text-[10px] font-black text-brand-orange bg-brand-orange/10 px-2 py-0.5 rounded-md border border-brand-orange/20">
                            {scene.sceneNumber || (index + 1)}
                        </span>
                        {scene.groupId && (
                            <span className="text-[8px] font-black text-purple-400 bg-purple-500/10 px-1.5 py-0.5 rounded border border-purple-500/20 uppercase">
                                {sceneGroups?.find(g => g.id === scene.groupId)?.name}
                            </span>
                        )}
                        <span className="text-[9px] font-bold text-gray-500 uppercase tracking-tighter">Scene</span>
                    </div>
                    <div className="flex items-center gap-2">
                        <span className="text-[9px] text-gray-600 italic truncate max-w-[80px]">
                            {scene.promptName || 'Untitled'}
                        </span>
                        {/* Delete Button - moved to bottom */}
                        <button
                            onClick={() => removeScene(scene.id)}
                            className="p-1 text-red-400/50 hover:text-red-400 hover:bg-red-500/10 rounded transition-colors"
                            title="Xóa cảnh"
                        >
                            <Trash2 size={12} />
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
};
