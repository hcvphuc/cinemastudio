import React from 'react';
import { SectionTitle } from '../common/SectionTitle';
import { GLOBAL_STYLES, IMAGE_MODELS, ASPECT_RATIOS, CAMERA_MODELS, LENS_OPTIONS } from '../../constants/presets';
import { ModelSelector } from '../common/ModelSelector';

interface StyleSettingsSectionProps {
    stylePrompt: string;
    onStylePromptChange: (e: React.ChangeEvent<HTMLSelectElement>) => void;
    customStyleInstruction: string;
    onCustomStyleInstructionChange: (val: string) => void;
    imageModel: string;
    onImageModelChange: (e: React.ChangeEvent<HTMLSelectElement>) => void;
    resolution: string;
    onResolutionChange: (val: string) => void;
    aspectRatio: string;
    onAspectRatioChange: (e: React.ChangeEvent<HTMLSelectElement>) => void;
    scriptLanguage: string;
    onScriptLanguageChange: (e: React.ChangeEvent<HTMLSelectElement>) => void;
    customScriptLanguage: string;
    onCustomScriptLanguageChange: (val: string) => void;
    cameraModel: string;
    onCameraModelChange: (val: string) => void;
    customCameraModel: string;
    onCustomCameraModelChange: (val: string) => void;
    defaultLens: string;
    onDefaultLensChange: (val: string) => void;
    customDefaultLens: string;
    onCustomDefaultLensChange: (val: string) => void;
    customMetaTokens: string;
    onCustomMetaTokensChange: (val: string) => void;
    onOpenScriptGenerator: () => void;
    isScriptGenerating: boolean;
    onTriggerFileUpload: () => void;
    onAnalyzeStyleFromImage?: (image: string) => Promise<void>;
    isAnalyzingStyle?: boolean;
    isContinuityMode: boolean;
    toggleContinuityMode: () => void;
    isOutfitLockMode: boolean;
    toggleOutfitLockMode: () => void;
    onOpenManualScript?: () => void; // NEW: Open Manual Script Import modal
    onOpenExcelImport?: () => void; // NEW: Open Excel Import modal
    generationConfig?: import('../../types').GenerationConfig;
    onGenerationConfigChange?: (config: import('../../types').GenerationConfig) => void;
    imageOutputFormat?: 'jpeg' | 'png';
    onImageOutputFormatChange?: (format: 'jpeg' | 'png') => void;
}



export const StyleSettingsSection: React.FC<StyleSettingsSectionProps> = ({
    stylePrompt,
    onStylePromptChange,
    customStyleInstruction,
    onCustomStyleInstructionChange,
    imageModel,
    onImageModelChange,
    resolution,
    onResolutionChange,
    aspectRatio,
    onAspectRatioChange,
    scriptLanguage,
    onScriptLanguageChange,
    customScriptLanguage,
    onCustomScriptLanguageChange,
    cameraModel,
    onCameraModelChange,
    customCameraModel,
    onCustomCameraModelChange,
    defaultLens,
    onDefaultLensChange,
    customDefaultLens,
    onCustomDefaultLensChange,
    customMetaTokens,
    onCustomMetaTokensChange,
    onOpenScriptGenerator,
    isScriptGenerating,
    onTriggerFileUpload,
    onAnalyzeStyleFromImage,
    isAnalyzingStyle,
    isContinuityMode,
    toggleContinuityMode,
    isOutfitLockMode,
    toggleOutfitLockMode,
    onOpenManualScript,
    onOpenExcelImport,
    generationConfig,
    onGenerationConfigChange,
    imageOutputFormat = 'jpeg',
    onImageOutputFormatChange
}) => {


    const [showAdvancedGen, setShowAdvancedGen] = React.useState(false);

    const handleStyleImageUpload = (e: React.ChangeEvent<HTMLInputElement>) => {

        const file = e.target.files?.[0];
        if (!file || !onAnalyzeStyleFromImage) return;

        const reader = new FileReader();
        reader.onloadend = () => {
            onAnalyzeStyleFromImage(reader.result as string);
        };
        reader.readAsDataURL(file);
        e.target.value = '';
    };


    return (
        <div className="my-16 p-6 bg-gray-800/50 rounded-lg border border-gray-700">
            <SectionTitle>Your Styles</SectionTitle>
            <div className="grid md:grid-cols-3 gap-6 items-start">
                <div className="md:col-span-2 space-y-4">
                    {/* Row 1: Global Style + Model Images */}
                    <div className="grid grid-cols-2 gap-4">
                        <div>
                            <label className="block text-sm font-medium text-gray-300 mb-2">Phong cách Tổng thể (Global Style)</label>
                            <select
                                value={stylePrompt}
                                onChange={onStylePromptChange}
                                className="w-full bg-gray-700 text-white px-3 py-2 rounded-md focus:outline-none focus:ring-2 focus:ring-green-500 border border-gray-600 appearance-none"
                            >
                                {GLOBAL_STYLES.map(style => (
                                    <option key={style.value} value={style.value}>{style.label}</option>
                                ))}
                                <option value="custom" className="text-brand-orange font-bold">+ Custom Style (Tự nhập Prompt)...</option>
                            </select>
                            {stylePrompt === 'custom' && (
                                <div className="mt-2 animate-fadeIn space-y-2">
                                    <textarea
                                        value={customStyleInstruction}
                                        onChange={e => onCustomStyleInstructionChange(e.target.value)}
                                        onMouseDown={(e) => e.stopPropagation()}
                                        placeholder="Nhập mô tả phong cách, ánh sáng, màu sắc (VD: Cyberpunk city, neon lights, rain, high contrast, 8k masterpiece...)"
                                        className="w-full bg-gray-900/80 text-white px-3 py-2 rounded-md border border-brand-orange text-xs focus:outline-none min-h-[80px]"
                                    />
                                    {onAnalyzeStyleFromImage && (
                                        <div className="flex items-center space-x-2">
                                            <input
                                                type="file"
                                                accept="image/*"
                                                onChange={handleStyleImageUpload}
                                                className="hidden"
                                                id="style-image-upload"
                                            />
                                            <label
                                                htmlFor="style-image-upload"
                                                className={`flex-1 px-3 py-2 text-xs font-medium rounded-md text-center cursor-pointer transition-all ${isAnalyzingStyle
                                                    ? 'bg-purple-600/50 text-gray-300 cursor-wait'
                                                    : 'bg-purple-600 hover:bg-purple-500 text-white'
                                                    }`}
                                            >
                                                {isAnalyzingStyle ? (
                                                    <span className="flex items-center justify-center space-x-2">
                                                        <svg className="animate-spin h-4 w-4" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                                                            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                                                            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                                                        </svg>
                                                        <span>Đang phân tích...</span>
                                                    </span>
                                                ) : (
                                                    <span>📷 Upload ảnh để phân tích Style</span>
                                                )}
                                            </label>
                                        </div>
                                    )}
                                </div>
                            )}

                        </div>
                        <div>
                            <label className="block text-sm font-medium text-gray-300 mb-2">Model Images</label>
                            <ModelSelector
                                models={IMAGE_MODELS}
                                value={imageModel}
                                onChange={(val) => onImageModelChange({ target: { value: val } } as any)}
                                size="md"
                            />
                        </div>
                    </div>

                    {/* Row 2: Resolution + Aspect Ratio + Image Format + Script Language */}
                    <div className="grid grid-cols-4 gap-4">
                        <div>
                            <label className="block text-sm font-medium text-gray-300 mb-2">Độ phân giải (Resolution)</label>
                            {(() => {
                                const selectedModel = IMAGE_MODELS.find(m => m.value === imageModel);
                                const isGommo = selectedModel?.provider === 'gommo';
                                const providerLabel = isGommo ? '🟡 Gommo' : '🔵 Gemini';
                                return (
                                    <select
                                        value={resolution || '1K'}
                                        onChange={(e) => onResolutionChange(e.target.value)}
                                        className="w-full bg-gray-700 text-white px-3 py-2 rounded-md focus:outline-none focus:ring-2 focus:ring-green-500 border border-gray-600 appearance-none"
                                    >
                                        <option value="1K">1K (Standard) - {providerLabel}</option>
                                        <option value="2K">2K (High Res) - {providerLabel}</option>
                                        <option value="4K">4K (Ultra) - {providerLabel}</option>
                                    </select>
                                );
                            })()}
                        </div>
                        <div>
                            <label className="block text-sm font-medium text-gray-300 mb-2">Tỷ lệ ảnh (Aspect Ratio)</label>
                            <select
                                value={aspectRatio}
                                onChange={onAspectRatioChange}
                                className="w-full bg-gray-700 text-white px-3 py-2 rounded-md focus:outline-none focus:ring-2 focus:ring-green-500 border border-gray-600"
                            >
                                {ASPECT_RATIOS.map(ratio => (
                                    <option key={ratio.value} value={ratio.value}>{ratio.label}</option>
                                ))}
                            </select>
                        </div>
                        <div>
                            <label className="block text-sm font-medium text-gray-300 mb-2">📦 Image Format</label>
                            <div className="flex rounded-md overflow-hidden border border-gray-600">
                                <button
                                    onClick={() => onImageOutputFormatChange?.('jpeg')}
                                    className={`flex-1 px-3 py-2 text-xs font-bold transition-colors ${imageOutputFormat === 'jpeg'
                                            ? 'bg-emerald-600 text-white'
                                            : 'bg-gray-700 text-gray-400 hover:text-white'
                                        }`}
                                >
                                    JPEG 92%
                                    <div className={`text-[9px] font-normal mt-0.5 ${imageOutputFormat === 'jpeg' ? 'text-emerald-200' : 'text-gray-500'}`}>~400KB/ảnh</div>
                                </button>
                                <button
                                    onClick={() => onImageOutputFormatChange?.('png')}
                                    className={`flex-1 px-3 py-2 text-xs font-bold transition-colors ${imageOutputFormat === 'png'
                                            ? 'bg-amber-600 text-white'
                                            : 'bg-gray-700 text-gray-400 hover:text-white'
                                        }`}
                                >
                                    PNG
                                    <div className={`text-[9px] font-normal mt-0.5 ${imageOutputFormat === 'png' ? 'text-amber-200' : 'text-gray-500'}`}>~3-5MB/ảnh</div>
                                </button>
                            </div>
                        </div>
                        <div>
                            <label className="block text-sm font-medium text-gray-300 mb-2">Ngôn ngữ nguồn cho Script</label>
                            <select
                                value={scriptLanguage}
                                onChange={onScriptLanguageChange}
                                className="w-full bg-gray-700 text-white px-3 py-2 rounded-md focus:outline-none focus:ring-2 focus:ring-green-500 border border-gray-600"
                            >
                                <option value="vietnamese">🇻🇳 Tiếng Việt</option>
                                <option value="language1">🇺🇸 Tiếng Anh (Default)</option>
                                <option value="spanish">🇪🇸 Tiếng Tây Ban Nha</option>
                                <option value="chinese">🇨🇳 Tiếng Trung Quốc</option>
                                <option value="hindi">🇮🇳 Tiếng Ấn Độ (Hindi)</option>
                                <option value="arabic">🇸🇦 Tiếng Ả Rập</option>
                                <option value="custom" className="text-brand-orange font-bold">+ Custom Language...</option>
                            </select>
                            {scriptLanguage === 'custom' && (
                                <div className="mt-2 animate-fadeIn">
                                    <input
                                        type="text"
                                        value={customScriptLanguage}
                                        onChange={e => onCustomScriptLanguageChange(e.target.value)}
                                        placeholder="Nhập tên ngôn ngữ (VD: French, Japanese, Spanish...)"
                                        className="w-full bg-gray-900/80 text-white px-3 py-2 rounded-md border border-brand-orange text-xs focus:outline-none"
                                    />
                                </div>
                            )}
                        </div>
                    </div>

                    {/* === CINEMATOGRAPHY SETTINGS (NEW) === */}
                    <div className="mt-4 pt-4 border-t border-gray-600">
                        {/* Continuity Controls */}
                        <div className="grid grid-cols-2 gap-3 pb-4 border-b border-gray-800">
                            <button
                                onClick={toggleContinuityMode}
                                className={`flex flex-col items-start p-3 rounded-xl border transition-all ${isContinuityMode ? 'bg-purple-500/10 border-purple-500/50' : 'bg-gray-900/50 border-gray-800 hober:border-gray-700'}`}
                            >
                                <span className={`text-[9px] font-black uppercase tracking-widest ${isContinuityMode ? 'text-purple-400' : 'text-gray-500'}`}>Shot Continuity</span>
                                <span className="text-xs font-bold text-gray-200 mt-1">{isContinuityMode ? 'On: Multi-Shot Lock' : 'Off: Independent'}</span>
                            </button>

                            <button
                                onClick={toggleOutfitLockMode}
                                className={`flex flex-col items-start p-3 rounded-xl border transition-all ${isOutfitLockMode ? 'bg-blue-500/10 border-blue-500/50' : 'bg-gray-900/50 border-gray-800 hover:border-gray-700'}`}
                            >
                                <span className={`text-[9px] font-black uppercase tracking-widest ${isOutfitLockMode ? 'text-blue-400' : 'text-gray-500'}`}>Outfit Lock (Clothes)</span>
                                <span className="text-xs font-bold text-gray-200 mt-1">{isOutfitLockMode ? 'On: Strict Outfit' : 'Off: Flexible'}</span>
                            </button>
                        </div>

                        <div className="flex items-center justify-between mb-4">
                            <span className="text-sm font-semibold text-brand-orange">📹 Cinematography</span>
                            <span className="text-[10px] text-gray-500 bg-gray-700 px-2 py-0.5 rounded-full">Pro Settings</span>
                        </div>
                        <div className="grid grid-cols-2 gap-4">
                            <div>
                                <label className="block text-xs font-medium text-gray-400 mb-1.5">Camera Body</label>
                                <select
                                    value={cameraModel || 'auto'}
                                    onChange={(e) => onCameraModelChange(e.target.value)}
                                    className="w-full bg-gray-700 text-white px-2 py-1.5 rounded text-xs focus:outline-none focus:ring-1 focus:ring-brand-orange border border-gray-600 appearance-none"
                                >
                                    {CAMERA_MODELS.map(cam => (
                                        <option key={cam.value} value={cam.value}>{cam.label}</option>
                                    ))}
                                    <option value="custom" className="text-brand-orange font-bold">+ Custom Camera...</option>
                                </select>
                                {cameraModel === 'custom' && (
                                    <div className="mt-1 animate-fadeIn">
                                        <input
                                            type="text"
                                            value={customCameraModel}
                                            onChange={e => onCustomCameraModelChange(e.target.value)}
                                            placeholder="VD: IMAX 70mm, GoPro Hero 11..."
                                            className="w-full bg-gray-900/80 text-white px-2 py-1.5 rounded border border-brand-orange text-[10px] focus:outline-none"
                                        />
                                    </div>
                                )}
                            </div>
                            <div>
                                <label className="block text-xs font-medium text-gray-400 mb-1.5">Default Lens</label>
                                <select
                                    value={defaultLens || 'auto'}
                                    onChange={(e) => onDefaultLensChange(e.target.value)}
                                    className="w-full bg-gray-700 text-white px-2 py-1.5 rounded text-xs focus:outline-none focus:ring-1 focus:ring-brand-orange border border-gray-600 appearance-none"
                                >
                                    {LENS_OPTIONS.map(lens => (
                                        <option key={lens.value} value={lens.value}>{lens.label}</option>
                                    ))}
                                    <option value="custom" className="text-brand-orange font-bold">+ Custom Lens...</option>
                                </select>
                                {defaultLens === 'custom' && (
                                    <div className="mt-1 animate-fadeIn">
                                        <input
                                            type="text"
                                            value={customDefaultLens}
                                            onChange={e => onCustomDefaultLensChange(e.target.value)}
                                            placeholder="VD: 70-200mm f/2.8, Fisheye 8mm..."
                                            className="w-full bg-gray-900/80 text-white px-2 py-1.5 rounded border border-brand-orange text-[10px] focus:outline-none"
                                        />
                                    </div>
                                )}
                            </div>
                        </div>
                        <div className="mt-3">
                            <label className="block text-xs font-medium text-gray-400 mb-1.5">
                                Meta Tokens <span className="text-gray-500">(để trống = AI tự thêm creative tokens)</span>
                            </label>
                            <input
                                type="text"
                                value={customMetaTokens}
                                onChange={(e) => onCustomMetaTokensChange(e.target.value)}
                                placeholder="VD: cinematic lighting, film grain, shallow depth of field..."
                                className="w-full bg-gray-900 text-white px-2 py-1.5 rounded text-sm focus:outline-none focus:ring-1 focus:ring-brand-orange border border-gray-600 placeholder-gray-600"
                            />
                        </div>
                    </div>
                </div>
                <div className="flex flex-col items-center justify-center h-full space-y-3">
                    <div className="w-full">
                        <button
                            onClick={onOpenScriptGenerator}
                            disabled={isScriptGenerating}
                            className={`w-full px-6 py-4 font-semibold text-white rounded-lg transition-all duration-300 transform hover:scale-105 flex flex-col items-center justify-center ${isScriptGenerating
                                ? 'bg-blue-600/50 cursor-wait'
                                : 'bg-gradient-to-r from-blue-500 to-blue-300 hover:from-blue-400 hover:to-blue-200 shadow-lg shadow-blue-500/20'
                                }`}
                        >
                            {isScriptGenerating ? (
                                <>
                                    <svg className="animate-spin h-5 w-5 text-white mb-1" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                                    </svg>
                                    <span className="text-sm">Đang tạo kịch bản...</span>
                                </>
                            ) : (
                                <>
                                    <span className="text-lg">✨ Viết Kịch Bản AI</span>
                                    <span className="text-xs font-normal opacity-80 mt-1">Từ ý tưởng đến phân cảnh</span>
                                </>
                            )}
                        </button>
                    </div>
                    <div className="w-full relative">
                        <button
                            onClick={onOpenManualScript || onTriggerFileUpload}
                            className={`w-full px-6 py-2 font-semibold text-white rounded-lg bg-gradient-to-r from-violet-600 to-fuchsia-600 hover:from-violet-500 hover:to-fuchsia-500 transition-all duration-300 transform hover:scale-105 shadow-lg shadow-violet-700/20`}
                        >
                            📝 Manual Script
                        </button>
                    </div>
                    <div className="w-full relative">
                        <button
                            onClick={onOpenExcelImport}
                            className={`w-full px-6 py-2 font-semibold text-white rounded-lg bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 transition-all duration-300 transform hover:scale-105 shadow-lg shadow-emerald-700/20`}
                        >
                            📊 Import Excel
                        </button>
                    </div>
                </div>
            </div>

            {/* Advanced Generation Settings Section */}
            <div className="mt-8 pt-6 border-t border-gray-700/50">
                <button
                    onClick={() => setShowAdvancedGen(!showAdvancedGen)}
                    className="flex items-center gap-2 text-xs font-black text-gray-400 hover:text-brand-orange transition-colors uppercase tracking-widest"
                >
                    <div className={`w-1.5 h-1.5 rounded-full ${showAdvancedGen ? 'bg-brand-orange' : 'bg-gray-700'}`}></div>
                    Advanced Generation Settings
                </button>

                {showAdvancedGen && generationConfig && onGenerationConfigChange && (
                    <div className="mt-4 grid grid-cols-1 md:grid-cols-4 gap-4 animate-in fade-in slide-in-from-top-2 duration-300">
                        <div className="p-3 bg-black/20 rounded-xl border border-gray-700/30">
                            <label className="block text-[10px] font-black text-gray-500 uppercase tracking-widest mb-1.5">Image Delay (ms)</label>
                            <input
                                type="number"
                                value={generationConfig.imageDelay}
                                onChange={(e) => onGenerationConfigChange({ ...generationConfig, imageDelay: parseInt(e.target.value) || 0 })}
                                className="w-full bg-gray-950 text-brand-cream px-2 py-1 rounded text-xs border border-gray-800 focus:border-brand-orange outline-none"
                            />
                        </div>
                        <div className="p-3 bg-black/20 rounded-xl border border-gray-700/30">
                            <label className="block text-[10px] font-black text-gray-500 uppercase tracking-widest mb-1.5">Veo Delay (ms)</label>
                            <input
                                type="number"
                                value={generationConfig.veoDelay}
                                onChange={(e) => onGenerationConfigChange({ ...generationConfig, veoDelay: parseInt(e.target.value) || 0 })}
                                className="w-full bg-gray-950 text-brand-cream px-2 py-1 rounded text-xs border border-gray-800 focus:border-brand-orange outline-none"
                            />
                        </div>
                        <div className="p-3 bg-black/20 rounded-xl border border-gray-700/30">
                            <label className="block text-[10px] font-black text-gray-500 uppercase tracking-widest mb-1.5">Insert Delay (ms)</label>
                            <input
                                type="number"
                                value={generationConfig.insertAngleDelay}
                                onChange={(e) => onGenerationConfigChange({ ...generationConfig, insertAngleDelay: parseInt(e.target.value) || 0 })}
                                className="w-full bg-gray-950 text-brand-cream px-2 py-1 rounded text-xs border border-gray-800 focus:border-brand-orange outline-none"
                            />
                        </div>
                        <div className="p-3 bg-black/20 rounded-xl border border-gray-700/30">
                            <label className="block text-[10px] font-black text-gray-500 uppercase tracking-widest mb-1.5">Batch Concurrency</label>
                            <select
                                value={generationConfig.concurrencyLimit}
                                onChange={(e) => onGenerationConfigChange({ ...generationConfig, concurrencyLimit: parseInt(e.target.value) })}
                                className="w-full bg-gray-950 text-brand-cream px-2 py-1 rounded text-xs border border-gray-800 focus:border-brand-orange outline-none appearance-none"
                            >
                                <option value={1}>1 (Sequential)</option>
                                <option value={2}>2 (Parallel)</option>
                                <option value={3}>3 (Parallel)</option>
                                <option value={4}>4 (Parallel)</option>
                            </select>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
};

