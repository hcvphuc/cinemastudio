import React from 'react';
import { Undo2, Redo2, Shield } from 'lucide-react';
import { APP_NAME, PRIMARY_GRADIENT, PRIMARY_GRADIENT_HOVER } from '../../constants/presets';

export interface HeaderProps {
    isSticky: boolean;
    onProfileClick: () => void;
    onSave: () => void;
    onSavePackage?: () => void;
    onOpen: () => void;
    onNewProject: () => void;
    onDownloadAll: () => void;
    canDownload: boolean;
    isContinuityMode: boolean;
    toggleContinuityMode: () => void;
    onUndo: () => void;
    onRedo: () => void;
    canUndo: boolean;
    canRedo: boolean;
    isLoggedIn: boolean;
    onCloudSave: () => void;
    onCloudOpen: () => void;
    onAdminClick?: () => void;
    profile?: any;
    subscriptionExpired?: boolean;
}

export const Header: React.FC<HeaderProps> = ({
    isSticky, onProfileClick, onSave, onSavePackage, onOpen, onNewProject,
    onDownloadAll, canDownload, isContinuityMode,
    toggleContinuityMode,
    onUndo, onRedo, canUndo, canRedo,
    isLoggedIn,
    onCloudSave, onCloudOpen, onAdminClick,
    profile, subscriptionExpired
}) => (
    <header className="fixed top-0 left-0 right-0 z-50 bg-gray-900 shadow-lg border-b border-gray-800">
        <div className="container mx-auto px-6 py-3 flex justify-between items-center">
            <h1 className="text-2xl font-bold text-white">{APP_NAME} <span className="text-xs font-normal text-gray-400 bg-gray-800 px-2 py-0.5 rounded-full ml-1">V6</span></h1>

            <div className="flex items-center space-x-4">
                {/* Continuity Toggle */}
                <div className="flex items-center space-x-2 bg-gray-800/80 px-3 py-1.5 rounded-full border border-gray-600" title="Khi bật: AI sẽ nhìn thấy ảnh của cảnh trước để vẽ cảnh sau giống bối cảnh/ánh sáng.">
                    <span className="text-xs font-semibold text-gray-300">Khóa Bối Cảnh (Continuity):</span>
                    <button
                        onClick={toggleContinuityMode}
                        className={`w-10 h-5 flex items-center rounded-full p-1 duration-300 ease-in-out ${isContinuityMode ? 'bg-brand-orange' : 'bg-gray-600'}`}
                    >
                        <div className={`bg-white w-3 h-3 rounded-full shadow-md transform duration-300 ease-in-out ${isContinuityMode ? 'translate-x-5' : ''}`}></div>
                    </button>
                </div>

                <div className="flex items-center space-x-2 md:space-x-4">
                    <div className="flex items-center space-x-1 border-r border-gray-700 pr-4 mr-2">
                        <button
                            onClick={onUndo}
                            disabled={!canUndo}
                            className={`p-2 rounded-lg transition-colors ${canUndo ? 'text-white hover:bg-white/10' : 'text-gray-600 cursor-not-allowed'}`}
                            title="Undo (Ctrl+Z)"
                        >
                            <Undo2 size={18} />
                        </button>
                        <button
                            onClick={onRedo}
                            disabled={!canRedo}
                            className={`p-2 rounded-lg transition-colors ${canRedo ? 'text-white hover:bg-white/10' : 'text-gray-600 cursor-not-allowed'}`}
                            title="Redo (Ctrl+Y)"
                        >
                            <Redo2 size={18} />
                        </button>
                    </div>

                    <button onClick={onNewProject} className="px-3 py-2 text-xs md:text-sm font-semibold text-white bg-blue-600/50 rounded-lg hover:bg-blue-600/70 transition-colors">📄 New</button>
                    {onSavePackage && (
                        <button onClick={onSavePackage} className="px-3 py-2 text-xs md:text-sm font-semibold text-white bg-white/10 rounded-lg hover:bg-white/20 transition-colors" title="Lưu dự án (Dạng gói ZIP)">
                            Lưu
                        </button>
                    )}
                    {/* <button onClick={onSave} className="px-3 py-2 text-xs md:text-sm font-semibold text-white bg-white/10 rounded-lg hover:bg-white/20 transition-colors">Lưu JSON (Cũ)</button> */}
                    <button onClick={onOpen} className="px-3 py-2 text-xs md:text-sm font-semibold text-white bg-white/10 rounded-lg hover:bg-white/20 transition-colors">Mở</button>

                    {isLoggedIn && (
                        <div className="flex items-center space-x-2 border-l border-gray-700 pl-4 ml-2">
                            <button onClick={onCloudSave} className="px-3 py-2 text-xs md:text-sm font-semibold text-brand-orange bg-brand-orange/10 rounded-lg hover:bg-brand-orange/20 transition-colors border border-brand-orange/20">Cloud Lưu</button>
                            <button onClick={onCloudOpen} className="px-3 py-2 text-xs md:text-sm font-semibold text-brand-orange bg-brand-orange/10 rounded-lg hover:bg-brand-orange/20 transition-colors border border-brand-orange/20">Cloud Mở</button>
                        </div>
                    )}

                    {canDownload && <button onClick={onDownloadAll} className={`px-3 py-2 text-xs md:text-sm font-semibold text-white rounded-lg bg-gradient-to-r ${PRIMARY_GRADIENT} hover:${PRIMARY_GRADIENT_HOVER} transition-all`}>Tải Full ZIP</button>}

                    {isLoggedIn && (
                        <div className="flex items-center space-x-2 pl-2 border-l border-gray-700">
                            <button onClick={onProfileClick} className="px-3 py-2 text-xs md:text-sm font-semibold text-white bg-white/10 rounded-lg hover:bg-white/20 transition-colors border border-white/10">Tài khoản</button>
                            {onAdminClick && (
                                <button
                                    onClick={onAdminClick}
                                    className="p-2 text-purple-400 hover:bg-purple-500/20 rounded-lg transition-colors"
                                    title="Admin Dashboard"
                                >
                                    <Shield size={18} />
                                </button>
                            )}
                        </div>
                    )}
                </div>
            </div>
        </div>
    </header>
);
