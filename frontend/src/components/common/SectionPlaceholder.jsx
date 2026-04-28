import React, { useState, useEffect, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { statementService } from '../../services/api';
import { Download, Trash2, FileCheck2, AlertCircle, FolderOpen, Search, FileDown } from 'lucide-react';
import { Button } from '../ui/Button';

function cleanFileName(name) {
    return name.replace(/^transformed_\d+_/, '');
}

function formatDateTime(iso) {
    const d = new Date(iso);
    return {
        date: d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }),
        time: d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true }),
    };
}

export function SectionPlaceholder({ title, description, icon }) {
    const [data, setData] = useState([]);
    const [isLoading, setIsLoading] = useState(false);
    const [downloading, setDownloading] = useState(null);
    const [deleting, setDeleting] = useState(null);
    const [error, setError] = useState(null);
    const [search, setSearch] = useState('');

    const fetchStatements = async () => {
        setIsLoading(true);
        setError(null);
        try {
            const response = await statementService.getAll();
            if (response.success) setData(response.data);
        } catch (err) {
            console.error('Fetch error:', err);
            setError('Could not load statements. Please try again.');
        } finally {
            setIsLoading(false);
        }
    };

    useEffect(() => {
        if (title === 'My Statements') fetchStatements();
    }, [title]);

    const filtered = useMemo(() =>
        data.filter(item =>
            cleanFileName(item.originalName).toLowerCase().includes(search.toLowerCase())
        ), [data, search]);

    const handleDownload = async (item) => {
        setDownloading(item.id);
        try {
            const downloadUrl = `/api/statements/download-file?fileUrl=${encodeURIComponent(item.fileUrl)}`;
            const res = await fetch(downloadUrl);
            if (!res.ok) throw new Error(`Server returned ${res.status}`);
            const blob = await res.blob();
            const blobUrl = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = blobUrl;
            a.download = cleanFileName(item.originalName);
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(blobUrl);
        } catch {
            alert('Failed to download the file.');
        } finally {
            setDownloading(null);
        }
    };

    const handleDelete = async (item) => {
        if (!window.confirm(`Remove "${cleanFileName(item.originalName)}" from your statements?`)) return;
        setDeleting(item.id);
        try {
            await statementService.deleteFile(item.id);
            setData(prev => prev.filter(s => s.id !== item.id));
        } catch {
            alert('Failed to delete the statement.');
        } finally {
            setDeleting(null);
        }
    };

    if (title === 'My Statements') {
        return (
            <div className="w-full min-h-[calc(100vh-80px)] bg-[#f8fafc]">

                {/* ── Header ─────────────────────────────────────────── */}
                <div className="bg-white border-b border-slate-200">
                    <div className="max-w-6xl mx-auto px-8 py-5 flex items-center justify-between">
                        <div>
                            <h1 className="text-lg font-bold text-slate-900 tracking-tight">My Statements</h1>
                            <p className="text-slate-400 text-xs mt-0.5">Edited PDF statements saved after each download</p>
                        </div>
                        {!isLoading && data.length > 0 && (
                            <div className="flex items-center gap-2">
                                <span className="inline-flex items-center gap-1.5 bg-slate-100 text-slate-600 text-xs font-semibold px-3 py-1.5 rounded-lg">
                                    <span className="w-2 h-2 rounded-full bg-blue-400" />
                                    {data.length} Total
                                </span>
                                <span className="inline-flex items-center gap-1.5 bg-emerald-50 text-emerald-700 text-xs font-semibold px-3 py-1.5 rounded-lg border border-emerald-100">
                                    <span className="w-2 h-2 rounded-full bg-emerald-400" />
                                    {data.length} Edited
                                </span>
                            </div>
                        )}
                    </div>
                </div>

                <div className="max-w-6xl mx-auto px-8 py-8">

                    {/* ── Loading ───────────────────────────────────────── */}
                    {isLoading && (
                        <div className="flex flex-col items-center justify-center py-40 gap-4">
                            <div className="w-11 h-11 border-4 border-slate-200 border-t-blue-500 rounded-full animate-spin" />
                            <p className="text-slate-400 text-sm font-medium">Loading your statements…</p>
                        </div>
                    )}

                    {/* ── Error ─────────────────────────────────────────── */}
                    {!isLoading && error && (
                        <div className="flex items-center gap-3 bg-red-50 border border-red-200 rounded-2xl p-5 text-red-700 max-w-lg mx-auto mt-10">
                            <AlertCircle className="w-5 h-5 shrink-0" />
                            <p className="text-sm font-medium flex-1">{error}</p>
                            <button onClick={fetchStatements} className="text-xs font-bold underline underline-offset-2">Retry</button>
                        </div>
                    )}

                    {/* ── Empty State ───────────────────────────────────── */}
                    {!isLoading && !error && data.length === 0 && (
                        <motion.div
                            initial={{ opacity: 0, y: 24 }}
                            animate={{ opacity: 1, y: 0 }}
                            transition={{ duration: 0.4 }}
                            className="flex flex-col items-center justify-center py-40 gap-5 text-center"
                        >
                            <div className="relative">
                                <div className="w-24 h-24 bg-white rounded-3xl shadow-xl border border-slate-100 flex items-center justify-center">
                                    <FolderOpen className="w-11 h-11 text-slate-300" />
                                </div>
                                <div className="absolute -bottom-1 -right-1 w-7 h-7 bg-blue-500 rounded-full flex items-center justify-center shadow-md">
                                    <span className="text-white text-xs font-black">0</span>
                                </div>
                            </div>
                            <div>
                                <h3 className="text-xl font-extrabold text-slate-700 mb-1">No statements yet</h3>
                                <p className="text-slate-400 text-sm max-w-xs leading-relaxed">Upload a PDF bank statement, edit it, then click <span className="font-semibold text-slate-500">Download</span> — it will appear here automatically.</p>
                            </div>
                        </motion.div>
                    )}

                    {/* ── Table ─────────────────────────────────────────── */}
                    {!isLoading && !error && data.length > 0 && (
                        <motion.div
                            initial={{ opacity: 0, y: 16 }}
                            animate={{ opacity: 1, y: 0 }}
                            transition={{ duration: 0.35 }}
                        >
                            {/* Toolbar */}
                            <div className="flex items-center justify-between mb-4 gap-3">
                                <div className="relative flex-1 max-w-sm">
                                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400 pointer-events-none" />
                                    <input
                                        type="text"
                                        placeholder="Search files…"
                                        value={search}
                                        onChange={e => setSearch(e.target.value)}
                                        className="w-full pl-9 pr-4 py-2.5 text-sm bg-white border border-slate-200 rounded-xl text-slate-700 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-400 transition"
                                    />
                                </div>
                                <span className="text-xs text-slate-400 font-medium whitespace-nowrap">
                                    {filtered.length} of {data.length} file{data.length !== 1 ? 's' : ''}
                                </span>
                            </div>

                            {/* Table container */}
                            <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
                                {/* Column Headers */}
                                <div className="grid grid-cols-[40px_1fr_160px_100px_160px] items-center px-5 py-3 border-b border-slate-100 bg-slate-50/80">
                                    <span className="text-[11px] font-bold text-slate-400 uppercase tracking-widest">#</span>
                                    <span className="text-[11px] font-bold text-slate-400 uppercase tracking-widest">File Name</span>
                                    <span className="text-[11px] font-bold text-slate-400 uppercase tracking-widest">Date &amp; Time</span>
                                    <span className="text-[11px] font-bold text-slate-400 uppercase tracking-widest">Size</span>
                                    <span className="text-[11px] font-bold text-slate-400 uppercase tracking-widest text-right">Actions</span>
                                </div>

                                {/* Rows */}
                                <AnimatePresence initial={false}>
                                    {filtered.length === 0 ? (
                                        <div className="py-16 text-center text-slate-400 text-sm">No results match your search.</div>
                                    ) : (
                                        filtered.map((item, idx) => {
                                            const displayName = cleanFileName(item.originalName);
                                            const { date, time } = formatDateTime(item.uploadDate);
                                            const isDownloading = downloading === item.id;
                                            const isDeleting = deleting === item.id;

                                            return (
                                                <motion.div
                                                    key={item.id}
                                                    initial={{ opacity: 0, y: 8 }}
                                                    animate={{ opacity: 1, y: 0 }}
                                                    exit={{ opacity: 0, height: 0, overflow: 'hidden', transition: { duration: 0.22 } }}
                                                    transition={{ delay: idx * 0.04 }}
                                                    className="grid grid-cols-[40px_1fr_160px_100px_160px] items-center px-5 py-4 border-b border-slate-50 last:border-0 hover:bg-blue-50/30 transition-colors group"
                                                >
                                                    {/* Row number */}
                                                    <span className="text-xs font-bold text-slate-300 tabular-nums">{idx + 1}</span>

                                                    {/* File name + badge */}
                                                    <div className="flex items-center gap-3 min-w-0 pr-4">
                                                        <div className="shrink-0 w-9 h-9 bg-gradient-to-br from-blue-500 to-indigo-500 rounded-xl flex items-center justify-center shadow-sm">
                                                            <FileCheck2 className="w-4.5 h-4.5 text-white" strokeWidth={2.5} />
                                                        </div>
                                                        <div className="min-w-0">
                                                            <p className="text-sm font-semibold text-slate-800 truncate leading-snug" title={displayName}>
                                                                {displayName}
                                                            </p>
                                                            <span className="inline-flex items-center gap-1 mt-0.5 bg-emerald-50 text-emerald-700 text-[10px] font-bold px-1.5 py-0.5 rounded-full border border-emerald-200">
                                                                <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
                                                                Edited
                                                            </span>
                                                        </div>
                                                    </div>

                                                    {/* Date & Time */}
                                                    <div>
                                                        <p className="text-xs font-semibold text-slate-700">{date}</p>
                                                        <p className="text-xs text-slate-400 mt-0.5">{time}</p>
                                                    </div>

                                                    {/* Size */}
                                                    <span className="text-xs font-semibold text-slate-500 font-financial">{item.size}</span>

                                                    {/* Actions */}
                                                    <div className="flex items-center justify-end gap-2">
                                                        <button
                                                            onClick={() => handleDownload(item)}
                                                            disabled={isDownloading}
                                                            className="inline-flex items-center gap-1.5 bg-green-500 hover:bg-green-600 active:scale-95 disabled:opacity-60 text-white text-xs font-bold px-3.5 py-2 rounded-xl shadow-sm shadow-green-200 transition-all"
                                                        >
                                                            {isDownloading ? (
                                                                <>
                                                                    <div className="w-3 h-3 border-2 border-white/40 border-t-white rounded-full animate-spin" />
                                                                    <span>Saving…</span>
                                                                </>
                                                            ) : (
                                                                <>
                                                                    <Download className="w-3.5 h-3.5" />
                                                                    <span>Download</span>
                                                                </>
                                                            )}
                                                        </button>
                                                        <button
                                                            onClick={() => handleDelete(item)}
                                                            disabled={isDeleting}
                                                            title="Remove from list"
                                                            className="inline-flex items-center justify-center w-8 h-8 rounded-xl text-slate-300 hover:text-red-400 hover:bg-red-50 border border-transparent hover:border-red-200 transition-all active:scale-95 disabled:opacity-40"
                                                        >
                                                            {isDeleting
                                                                ? <div className="w-3.5 h-3.5 border-2 border-red-200 border-t-red-500 rounded-full animate-spin" />
                                                                : <Trash2 className="w-3.5 h-3.5" />}
                                                        </button>
                                                    </div>
                                                </motion.div>
                                            );
                                        })
                                    )}
                                </AnimatePresence>
                            </div>

                            {/* Footer note */}
                            <p className="text-center text-xs text-slate-400 mt-4">
                                Files are stored on this device. Statements are saved automatically after each download.
                            </p>
                        </motion.div>
                    )}
                </div>
            </div>
        );
    }

    return (
        <motion.div
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            className="py-12 flex flex-col items-center justify-center text-center min-h-[60vh] md:min-h-[70vh]"
        >
            <div className="w-20 h-20 md:w-24 md:h-24 bg-white rounded-3xl shadow-2xl flex items-center justify-center mb-6 md:mb-8 border border-slate-100 relative group transition-transform hover:scale-105">
                {icon}
                <div className="absolute inset-0 bg-blue-500/5 rounded-3xl blur-xl -z-10 opacity-0 group-hover:opacity-100 transition-opacity" />
            </div>
            <h2 className="text-2xl md:text-4xl font-extrabold text-slate-900 mb-4 tracking-tight px-4">{title}</h2>
            <p className="text-slate-500 max-w-md mx-auto leading-relaxed text-base md:text-lg px-6">
                {description}
            </p>
            <div className="mt-8 md:mt-10 flex gap-4">
                <Button variant="primary" onClick={() => window.location.reload()}>
                    Back to Home
                </Button>
            </div>
        </motion.div>
    );
}
