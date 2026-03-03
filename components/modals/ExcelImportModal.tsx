/**
 * ExcelImportModal
 * 
 * Modal for importing scene data from Excel/CSV files.
 * Creates a new project skeleton with Scenes, Groups, and Characters.
 */

import React, { useState, useCallback, useRef } from 'react';
import { X, Upload, FileSpreadsheet, Check, AlertCircle, ChevronDown, Loader2, Film, Sparkles, Package } from 'lucide-react';
import { useExcelImport, ColumnMapping, ExcelImportResult } from '../../hooks/useExcelImport';
import { Scene, SceneGroup, Character } from '../../types';
import { DirectorPreset, DIRECTOR_PRESETS } from '../../constants/directors';

interface ExcelImportModalProps {
    isOpen: boolean;
    onClose: () => void;
    onImport: (result: ExcelImportResult, directorId?: string, autoGenerate?: boolean) => void;
}

export const ExcelImportModal: React.FC<ExcelImportModalProps> = ({
    isOpen,
    onClose,
    onImport
}) => {
    const fileInputRef = useRef<HTMLInputElement>(null);
    const [selectedFile, setSelectedFile] = useState<File | null>(null);
    const [rowCount, setRowCount] = useState(0);
    const [mapping, setMapping] = useState<ColumnMapping | null>(null);
    const [showMapping, setShowMapping] = useState(false);

    // Director selection
    const [selectedDirectorId, setSelectedDirectorId] = useState<string>('werner_herzog');
    const [showDirectorPicker, setShowDirectorPicker] = useState(false);

    // Auto-generate toggle
    const [autoGenerate, setAutoGenerate] = useState(false);

    const {
        isProcessing,
        error,
        previewData,
        headers,
        loadPreview,
        importFile,
        autoDetectMapping,
        DEFAULT_MAPPING
    } = useExcelImport();

    // Get all directors
    const allDirectors = Object.values(DIRECTOR_PRESETS).flat();
    const selectedDirector = allDirectors.find(d => d.id === selectedDirectorId);

    const handleFileSelect = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;

        setSelectedFile(file);
        const result = await loadPreview(file);
        if (result) {
            setRowCount(result.rowCount);
            const autoMapping = autoDetectMapping(result.headers);
            setMapping(autoMapping);
        }
    }, [loadPreview, autoDetectMapping]);

    const handleImport = useCallback(async () => {
        if (!selectedFile || !mapping) return;

        const result = await importFile(selectedFile, mapping);
        if (result) {
            onImport(result, selectedDirectorId, autoGenerate);
            onClose();
        }
    }, [selectedFile, mapping, importFile, onImport, onClose, selectedDirectorId, autoGenerate]);

    const updateMapping = (field: keyof ColumnMapping, value: string) => {
        if (!mapping) return;
        setMapping({ ...mapping, [field]: value });
    };

    if (!isOpen) return null;

    return (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-4">
            <div className="bg-zinc-900 rounded-2xl w-full max-w-3xl max-h-[90vh] overflow-hidden border border-zinc-700 shadow-2xl flex flex-col">
                {/* Header */}
                <div className="flex items-center justify-between p-6 border-b border-zinc-800">
                    <div className="flex items-center gap-3">
                        <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-emerald-500 to-teal-500 flex items-center justify-center">
                            <FileSpreadsheet className="w-5 h-5 text-white" />
                        </div>
                        <div>
                            <h2 className="text-xl font-semibold text-white">Import from Excel</h2>
                            <p className="text-sm text-zinc-400">Create a new project from spreadsheet data</p>
                        </div>
                    </div>
                    <button onClick={onClose} className="p-2 rounded-lg hover:bg-zinc-800 transition-colors">
                        <X className="w-5 h-5 text-zinc-400" />
                    </button>
                </div>

                {/* Content */}
                <div className="flex-1 overflow-y-auto p-6 space-y-6">
                    {/* File Upload */}
                    <div>
                        <input
                            ref={fileInputRef}
                            type="file"
                            accept=".xlsx,.xls,.csv"
                            onChange={handleFileSelect}
                            className="hidden"
                        />
                        <button
                            onClick={() => fileInputRef.current?.click()}
                            className="w-full border-2 border-dashed border-zinc-700 rounded-xl p-8 text-center hover:border-emerald-500/50 hover:bg-emerald-500/5 transition-colors"
                        >
                            <Upload className="w-10 h-10 text-zinc-500 mx-auto mb-3" />
                            <p className="text-white font-medium">
                                {selectedFile ? selectedFile.name : 'Click to upload Excel or CSV file'}
                            </p>
                            <p className="text-sm text-zinc-500 mt-1">
                                {selectedFile ? `${rowCount} rows detected` : 'Supports .xlsx, .xls, .csv'}
                            </p>
                        </button>
                    </div>

                    {/* Director Selection */}
                    <div className="bg-zinc-800/50 rounded-xl p-4">
                        <div className="flex items-center justify-between mb-3">
                            <h3 className="text-sm font-medium text-white flex items-center gap-2">
                                <Film className="w-4 h-4 text-amber-400" />
                                Director Style
                            </h3>
                            <button
                                onClick={() => setShowDirectorPicker(!showDirectorPicker)}
                                className="text-xs text-zinc-400 hover:text-white"
                            >
                                {showDirectorPicker ? 'Close' : 'Change'}
                            </button>
                        </div>

                        {/* Selected Director Display */}
                        <div className="flex items-center gap-3 p-3 bg-zinc-900/50 rounded-lg">
                            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-amber-500 to-orange-500 flex items-center justify-center text-white text-sm font-bold">
                                {selectedDirector?.name.charAt(0) || '?'}
                            </div>
                            <div className="flex-1">
                                <div className="text-white font-medium">{selectedDirector?.name || 'No Director'}</div>
                                <div className="text-xs text-zinc-500 truncate">{selectedDirector?.description}</div>
                            </div>
                        </div>

                        {/* Director Picker Dropdown */}
                        {showDirectorPicker && (
                            <div className="mt-3 max-h-48 overflow-y-auto space-y-1">
                                {Object.entries(DIRECTOR_PRESETS).map(([category, directors]) => (
                                    <div key={category}>
                                        <div className="text-xs text-zinc-500 uppercase tracking-wider py-1 px-2">{category}</div>
                                        {directors.map(d => (
                                            <button
                                                key={d.id}
                                                onClick={() => {
                                                    setSelectedDirectorId(d.id);
                                                    setShowDirectorPicker(false);
                                                }}
                                                className={`w-full text-left px-3 py-2 rounded-lg text-sm transition-colors ${d.id === selectedDirectorId
                                                    ? 'bg-amber-500/20 text-amber-300'
                                                    : 'hover:bg-zinc-700 text-zinc-300'
                                                    }`}
                                            >
                                                {d.name}
                                            </button>
                                        ))}
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>

                    {/* Error */}
                    {error && (
                        <div className="flex items-center gap-2 p-4 bg-red-500/10 border border-red-500/30 rounded-xl text-red-400">
                            <AlertCircle className="w-5 h-5 flex-shrink-0" />
                            <span>{error}</span>
                        </div>
                    )}

                    {/* Preview */}
                    {previewData && previewData.length > 0 && (
                        <div>
                            <h3 className="text-sm font-medium text-zinc-400 mb-3">Preview (First 5 rows)</h3>
                            <div className="overflow-x-auto">
                                <table className="w-full text-sm">
                                    <thead>
                                        <tr className="border-b border-zinc-700">
                                            {headers.slice(0, 5).map((h, i) => (
                                                <th key={i} className="px-3 py-2 text-left text-zinc-400 font-medium">
                                                    {h}
                                                </th>
                                            ))}
                                            {headers.length > 5 && (
                                                <th className="px-3 py-2 text-zinc-500">+{headers.length - 5} more</th>
                                            )}
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {previewData.map((row, i) => (
                                            <tr key={i} className="border-b border-zinc-800">
                                                {headers.slice(0, 5).map((h, j) => (
                                                    <td key={j} className="px-3 py-2 text-zinc-300 truncate max-w-[150px]">
                                                        {String(row[h] || '-')}
                                                    </td>
                                                ))}
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        </div>
                    )}

                    {/* Column Mapping */}
                    {headers.length > 0 && mapping && (
                        <div>
                            <button
                                onClick={() => setShowMapping(!showMapping)}
                                className="flex items-center gap-2 text-sm font-medium text-zinc-400 hover:text-white transition-colors"
                            >
                                <ChevronDown className={`w-4 h-4 transition-transform ${showMapping ? 'rotate-180' : ''}`} />
                                Column Mapping
                            </button>

                            {showMapping && (
                                <div className="mt-4 grid grid-cols-2 gap-4">
                                    {Object.entries(mapping).map(([field, value]) => (
                                        <div key={field}>
                                            <label className="text-xs text-zinc-500 block mb-1">
                                                {field.replace(/([A-Z])/g, ' $1').trim()}
                                            </label>
                                            <select
                                                value={value}
                                                onChange={(e) => updateMapping(field as keyof ColumnMapping, e.target.value)}
                                                className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-white"
                                            >
                                                <option value="">-- Not Mapped --</option>
                                                {headers.map(h => (
                                                    <option key={h} value={h}>{h}</option>
                                                ))}
                                            </select>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </div>
                    )}

                    {/* Summary */}
                    {selectedFile && rowCount > 0 && (
                        <div className="bg-zinc-800/50 rounded-xl p-4">
                            <h3 className="text-sm font-medium text-white mb-2">Import Summary</h3>
                            <div className="grid grid-cols-4 gap-4 text-center">
                                <div>
                                    <div className="text-2xl font-bold text-emerald-400">{rowCount}</div>
                                    <div className="text-xs text-zinc-500">Scenes</div>
                                </div>
                                <div>
                                    <div className="text-2xl font-bold text-violet-400">
                                        {previewData ? new Set(previewData.map(r => r[mapping?.group || ''])).size : '?'}
                                    </div>
                                    <div className="text-xs text-zinc-500">Groups</div>
                                </div>
                                <div>
                                    <div className="text-2xl font-bold text-amber-400">
                                        {previewData ? new Set(previewData.flatMap(r => String(r[mapping?.characterNames || '']).split(',').map(n => n.trim())).filter(Boolean)).size : '?'}
                                    </div>
                                    <div className="text-xs text-zinc-500">Characters</div>
                                </div>
                                <div>
                                    <div className="text-2xl font-bold text-orange-400">
                                        <Package className="w-5 h-5 inline" />
                                    </div>
                                    <div className="text-xs text-zinc-500">Props (auto)</div>
                                </div>
                            </div>
                        </div>
                    )}

                    {/* Auto-Generate Toggle */}
                    {selectedFile && rowCount > 0 && (
                        <div className="bg-zinc-800/50 rounded-xl p-4 border border-zinc-700">
                            <label className="flex items-start gap-3 cursor-pointer">
                                <input
                                    type="checkbox"
                                    checked={autoGenerate}
                                    onChange={(e) => setAutoGenerate(e.target.checked)}
                                    className="mt-1 w-4 h-4 rounded border-zinc-600 bg-zinc-700 text-emerald-500 focus:ring-emerald-500"
                                />
                                <div className="flex-1">
                                    <div className="flex items-center gap-2 text-white font-medium">
                                        <Sparkles className="w-4 h-4 text-amber-400" />
                                        Auto-generate Character & Props Images
                                    </div>
                                    <p className="text-xs text-zinc-400 mt-1">
                                        Tự động tạo hình nhân vật (Master Image → Face ID + Body) và đạo cụ/vũ khí sau khi import.
                                        Sẽ sử dụng API credits.
                                    </p>
                                    {autoGenerate && (
                                        <div className="mt-2 text-xs text-amber-400/80 bg-amber-500/10 rounded-lg px-3 py-2">
                                            ⚡ Ước tính: ~{(previewData ? new Set(previewData.flatMap(r => String(r[mapping?.characterNames || '']).split(',').map(n => n.trim())).filter(Boolean)).size : 0) * 2} API calls cho nhân vật + props. Thời gian: ~3-5 phút.
                                        </div>
                                    )}
                                </div>
                            </label>
                        </div>
                    )}
                </div>

                {/* Footer */}
                <div className="flex items-center justify-between p-6 border-t border-zinc-800 bg-zinc-900/50">
                    <button
                        onClick={onClose}
                        className="px-4 py-2 text-zinc-400 hover:text-white transition-colors"
                    >
                        Cancel
                    </button>
                    <button
                        onClick={handleImport}
                        disabled={!selectedFile || isProcessing || rowCount === 0}
                        className="px-6 py-2.5 bg-gradient-to-r from-emerald-500 to-teal-500 text-white rounded-xl font-medium disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
                    >
                        {isProcessing ? (
                            <>
                                <Loader2 className="w-4 h-4 animate-spin" />
                                Processing...
                            </>
                        ) : (
                            <>
                                <Check className="w-4 h-4" />
                                Import {rowCount} Scenes
                            </>
                        )}
                    </button>
                </div>
            </div>
        </div>
    );
};

export default ExcelImportModal;

