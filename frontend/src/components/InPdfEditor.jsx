import React, { useState, useEffect, useRef } from 'react';
import * as pdfjsLib from 'pdfjs-dist';
import { motion, AnimatePresence } from 'framer-motion';
import { ArrowRight, FileDown, List, Eye, Wand2, Loader2 } from 'lucide-react';
import { TransactionTable } from './TransactionTable';

pdfjsLib.GlobalWorkerOptions.workerSrc = `//cdnjs.cloudflare.com/ajax/libs/pdf.js/${pdfjsLib.version}/pdf.worker.min.mjs`;

export function InPdfEditor(props) {
    const { fileUrl, password, onUpdateFileUrl, initialTransactions = [], initialBalances = { opening: 0, closing: 0 } } = props;

    const [pdf, setPdf] = useState(null);
    const [numPages, setNumPages] = useState(0);
    const [pagesData, setPagesData] = useState([]);
    const [isLoading, setIsLoading] = useState(true);
    const [scale] = useState(1.5);
    const [viewMode, setViewMode] = useState('pdf');
    const [isTransforming, setIsTransforming] = useState(false);
    const [internalTransactions, setInternalTransactions] = useState(initialTransactions);

    // AU Bank ke liye fixed table structure (best for your PDF)
    const tableStructure = React.useMemo(() => ({
        pageIndex: 1,
        headerY: 550,
        debitX: 420,
        creditX: 490,
        balanceX: 570,
        boundaries: {
            debitLeft: 350,
            debitCredit: 460,
            creditBalance: 530
        }
    }), []);

    // Backend data ko priority do
    useEffect(() => {
        if (initialTransactions && initialTransactions.length > 0) {
            console.log(`[InPdfEditor] ✅ Backend se ${initialTransactions.length} transactions mile`);
            setInternalTransactions(initialTransactions);
        }
    }, [initialTransactions]);

    useEffect(() => {
        const loadPdf = async () => {
            setIsLoading(true);
            setInternalTransactions(initialTransactions || []);

            try {
                const fullUrl = fileUrl.startsWith('http') 
                    ? fileUrl 
                    : `https://pdf-editor-ax8j.onrender.com${fileUrl}`;

                const loadingTask = pdfjsLib.getDocument({ 
                    url: fullUrl, 
                    password: password || undefined 
                });
                
                const loadedPdf = await loadingTask.promise;
                setPdf(loadedPdf);
                setNumPages(loadedPdf.numPages);

                const allPagesData = [];

                for (let i = 1; i <= loadedPdf.numPages; i++) {
                    const page = await loadedPdf.getPage(i);
                    const textContent = await page.getTextContent();
                    const viewport = page.getViewport({ scale: 1 });

                    const items = textContent.items.map((item, idx) => ({
                        id: `p${i}-t${idx}`,
                        text: item.str,
                        originalText: item.str,
                        x: item.transform[4],
                        y: item.transform[5],
                        width: item.width || 80,
                        height: item.height || 12,
                        fontSize: Math.sqrt(item.transform[0]**2 + item.transform[1]**2),
                        pageIdx: i,
                        hasChanged: false
                    }));

                    allPagesData.push({
                        pageIndex: i,
                        width: viewport.width,
                        height: viewport.height,
                        items: items.filter(it => it.text.trim().length > 0)
                    });
                }

                setPagesData(allPagesData);
                console.log(`[PDF_LOAD] ${loadedPdf.numPages} pages loaded | Backend Transactions: ${initialTransactions.length}`);

            } catch (err) {
                console.error("PDF Load Error:", err);
            } finally {
                setIsLoading(false);
            }
        };

        if (fileUrl) loadPdf();
    }, [fileUrl, password]);

    const handleDownload = () => {
        window.open(fileUrl, '_blank');
    };

    if (isLoading) {
        return (
            <div className="w-full h-[calc(100vh-80px)] flex flex-col items-center justify-center bg-slate-50">
                <Loader2 className="w-12 h-12 text-blue-500 animate-spin mb-4" />
                <p className="text-slate-600 font-medium">Loading PDF...</p>
            </div>
        );
    }

    return (
        <div className="w-full h-[calc(100vh-80px)] flex flex-col overflow-hidden bg-slate-50">
            {/* Action Bar */}
            <div className="bg-white border-b border-slate-200 px-6 py-3 flex items-center justify-between shrink-0 z-30">
                <div className="flex items-center gap-3">
                    <button onClick={() => window.dispatchEvent(new CustomEvent('nav-to-upload'))}
                        className="inline-flex items-center gap-1 text-slate-400 hover:text-slate-700 text-xs font-semibold">
                        <ArrowRight className="w-3.5 h-3.5 rotate-180" /> Back
                    </button>
                    <h2 className="text-sm font-bold text-slate-800">Statement Editor</h2>
                </div>

                <div className="flex items-center gap-3">
                    <div className="flex bg-slate-100 rounded-lg p-0.5 border border-slate-200">
                        <button onClick={() => setViewMode('pdf')}
                            className={`px-4 py-1.5 rounded-md text-xs font-semibold ${viewMode === 'pdf' ? 'bg-white shadow-sm' : 'text-slate-500'}`}>
                            <Eye className="w-4 h-4 inline mr-1" /> Preview
                        </button>
                        <button onClick={() => setViewMode('table')}
                            className={`px-4 py-1.5 rounded-md text-xs font-semibold ${viewMode === 'table' ? 'bg-white shadow-sm' : 'text-slate-500'}`}>
                            <List className="w-4 h-4 inline mr-1" /> Edit Mode
                        </button>
                    </div>

                    <button onClick={handleDownload}
                        className="bg-green-600 hover:bg-green-700 text-white px-4 py-2 rounded-lg text-xs font-bold flex items-center gap-2">
                        <FileDown className="w-4 h-4" /> Download
                    </button>
                </div>
            </div>

            <div className="flex-1 overflow-auto p-6 flex flex-col items-center">
                {viewMode === 'pdf' ? (
                    <div className="space-y-8">
                        {pagesData.map(page => (
                            <div key={page.pageIndex} className="shadow-2xl bg-white">
                                <canvas 
                                    width={page.width * scale} 
                                    height={page.height * scale}
                                    className="block"
                                />
                            </div>
                        ))}
                    </div>
                ) : (
                    <div className="w-full max-w-7xl">
                        <TransactionTable
                            transactions={internalTransactions}
                            openingBalance={initialBalances.opening}
                            closingBalance={initialBalances.closing}
                            fileUrl={fileUrl}
                            onUpdateFileUrl={onUpdateFileUrl}
                            onTransform={() => setIsTransforming(true)}
                            isTransforming={isTransforming}
                        />
                    </div>
                )}
            </div>

            <AnimatePresence>
                {isTransforming && (
                    <motion.div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
                        <div className="bg-white p-10 rounded-2xl flex flex-col items-center">
                            <Wand2 className="w-16 h-16 text-purple-600 animate-spin mb-4" />
                            <p className="text-xl font-semibold">Transforming PDF...</p>
                        </div>
                    </motion.div>
                )}
            </AnimatePresence>
        </div>
    );
}