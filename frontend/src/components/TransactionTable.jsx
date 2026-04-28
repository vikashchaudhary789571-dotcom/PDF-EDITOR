import React, { useState, useEffect, useMemo } from 'react';
import { Card, CardContent } from './ui/Card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './ui/Table';
import { Save, RefreshCw, Wand2, Trash2, ChevronLeft, ChevronRight } from 'lucide-react';
import { Button } from './ui/Button';
import { statementService } from '../services/api';

export function TransactionTable(props) {
    const {
        transactions: initialTransactions = [],
        openingBalance: initOpening = 0,
        fileUrl,
        onUpdateFileUrl,
        onTransform,
        onTransactionsChange,
        isTransforming: isTransformingProp = false
    } = props;
    const [transactions, setTransactions] = useState([]);
    const [openingBalance, setOpeningBalance] = useState(parseFloat(initOpening || 0).toFixed(2));
    const [isSaving, setIsSaving] = useState(false);
    const [isTransformingLocal, setIsTransformingLocal] = useState(false);
    const isTransforming = isTransformingProp || isTransformingLocal;

    // Pagination state
    const [currentPage, setCurrentPage] = useState(1);
    const itemsPerPage = 10;

    // Track the last known transaction count so we only reset the page when a
    // genuinely new file is loaded (different row count), not when a value is
    // edited in-place (which would otherwise jump back to page 1 every keystroke).
    const prevLengthRef = React.useRef(initialTransactions.length);

    useEffect(() => {
        setTransactions(initialTransactions);
        setOpeningBalance(parseFloat(initOpening || 0).toFixed(2));
        if (initialTransactions.length !== prevLengthRef.current) {
            setCurrentPage(1);
            prevLengthRef.current = initialTransactions.length;
        }
    }, [initialTransactions, initOpening]);

    const notifyParent = (updatedTxns) => {
        if (onTransactionsChange) {
            onTransactionsChange(updatedTxns);
        }
    };

    // Calculate total pages
    const totalPages = Math.ceil(transactions.length / itemsPerPage);

    // Get current page transactions
    const paginatedTransactions = useMemo(() => {
        const startIndex = (currentPage - 1) * itemsPerPage;
        return transactions.slice(startIndex, startIndex + itemsPerPage);
    }, [transactions, currentPage]);

    // Dynamically computed closing balance = last transaction's balance
    const closingBalance = useMemo(() => {
        if (transactions.length === 0) return parseFloat(initOpening) || 0;
        const lastBalance = transactions[transactions.length - 1]?.balance;
        return parseFloat(String(lastBalance).replace(/,/g, '')) || 0;
    }, [transactions, initOpening]);

    // Calculate totals for debit and credit columns - auto-updates when transactions change
    const totals = useMemo(() => {
        return transactions.reduce((acc, t) => {
            const debit = parseFloat(String(t.debit || 0).replace(/,/g, '')) || 0;
            const credit = parseFloat(String(t.credit || 0).replace(/,/g, '')) || 0;
            acc.debit += debit;
            acc.credit += credit;
            return acc;
        }, { debit: 0, credit: 0 });
    }, [transactions]);

    const getRecalculatedTransactions = (txns, openBal) => {
        let currentBalance = parseFloat(openBal) || 0;
        return txns.map(t => {
            const debit = parseFloat(String(t.debit).replace(/,/g, '')) || 0;
            const credit = parseFloat(String(t.credit).replace(/,/g, '')) || 0;

            // For bank statements, Credit increases balance, Debit decreases it
            currentBalance = currentBalance + credit - debit;

            return {
                ...t,
                balance: currentBalance.toFixed(2)
            };
        });
    };

    // Removed runRecalculation as per instruction

    const handleChange = (id, field, value) => {
        setTransactions(prev => {
            const next = prev.map(t => {
                if (t.id !== id) return t;
                return { ...t, [field]: value };
            });

            // If we changed a numeric field, trigger a full recalculation automatically
            let finalOutput = next;
            if (['debit', 'credit', 'balance'].includes(field)) {
                finalOutput = getRecalculatedTransactions(next, openingBalance);
            }

            notifyParent(finalOutput);
            return finalOutput;
        });
    };

    const handleSavePdf = async () => {
        setIsSaving(true);
        try {
            const data = await statementService.regenerate(transactions, fileUrl);
            if (data.success) {
                alert("PDF regenerated successfully with all table changes!");
                if (onUpdateFileUrl) onUpdateFileUrl(data.fileUrl);
            } else {
                alert("Failed to regenerate PDF: " + data.message);
            }
        } catch (error) {
            console.error("Save error:", error);
            alert("Connection error when saving table data.");
        } finally {
            setIsSaving(false);
        }
    };

    const handleTransform = () => {
        if (onTransform) {
            // Pass transactions as-is plus the UI-displayed closingBalance.
            // Do NOT re-run getRecalculatedTransactions here: it recomputes from
            // opening balance + debit/credit sums which can diverge from the
            // actual bank statement closing balance if any row's values differ.
            // Individual edits already trigger recalculation via handleChange.
            onTransform(transactions, initialTransactions, closingBalance);
        }
    };

    const formatCurrency = (val) => {
        return new Intl.NumberFormat('en-IN', {
            style: 'currency',
            currency: 'INR',
            minimumFractionDigits: 2
        }).format(val || 0);
    };

    return (
        <div className="space-y-6">
            <div className="flex items-center justify-between mb-2">
                <div className="flex gap-4">
                    <Card className="bg-blue-50 border-blue-100 w-[230px]">
                        <CardContent className="p-4">
                            <p className="text-[10px] text-blue-500 font-semibold uppercase tracking-widest mb-2">Opening Balance</p>
                            <div className="flex items-baseline gap-1">
                                <span className="text-sm font-semibold text-blue-400 leading-none">₹</span>
                                <input
                                    type="number"
                                    value={openingBalance}
                                    onChange={(e) => {
                                        const newBal = e.target.value;
                                        setOpeningBalance(newBal);
                                        // Also trigger recalculation with new starting point
                                        const recalc = getRecalculatedTransactions(transactions, newBal);
                                        setTransactions(recalc);
                                        notifyParent(recalc);
                                    }}
                                    onBlur={(e) => setOpeningBalance(parseFloat(e.target.value || 0).toFixed(2))}
                                    className="text-2xl font-semibold text-blue-900 bg-transparent border-none outline-none w-full tracking-tight tabular-nums font-mono"
                                />
                            </div>
                        </CardContent>
                    </Card>

                    <Card className="bg-emerald-50 border-emerald-100 w-[230px]">
                        <CardContent className="p-4">
                            <p className="text-[10px] text-emerald-500 font-semibold uppercase tracking-widest mb-2">Closing Balance</p>
                            <div className="flex items-baseline gap-1">
                                <span className="text-sm font-semibold text-emerald-400 leading-none">₹</span>
                                <span className="text-2xl font-semibold text-emerald-900 tracking-tight tabular-nums font-mono">{parseFloat(closingBalance).toFixed(2)}</span>
                            </div>
                        </CardContent>
                    </Card>
                </div>

                <div className="flex gap-2 items-center">
                    {/* Removed Auto Calculate button */}

                    <Button
                        variant="primary"
                        size="sm"
                        className="bg-purple-600 hover:bg-purple-700 border-purple-700"
                        onClick={handleTransform}
                        disabled={isTransforming}
                    >
                        {isTransforming ? (
                            <><RefreshCw className="w-4 h-4 mr-2 animate-spin" /> Transforming...</>
                        ) : (
                            <><Wand2 className="w-4 h-4 mr-2" /> Transform</>
                        )}
                    </Button>

                    <Button
                        variant="primary"
                        size="sm"
                        className="bg-rose-500 hover:bg-rose-600 border-rose-600"
                    >
                        <Trash2 className="w-4 h-4 mr-2" /> Discard Changes
                    </Button>
                </div>
            </div>

            <Card className="border-slate-200 shadow-xl overflow-hidden bg-white">
                <div className="overflow-x-auto">
                    <Table>
                        <TableHeader className="bg-slate-50/50 backdrop-blur-sm sticky top-0 z-10">
                            <TableRow>
                                <TableHead className="font-bold text-slate-800 text-[11px] uppercase tracking-wider py-4">S.No</TableHead>
                                <TableHead className="font-bold text-slate-800 text-[11px] uppercase tracking-wider py-4">Transaction Date</TableHead>
                                <TableHead className="font-bold text-slate-800 text-[11px] uppercase tracking-wider py-4">Value Date</TableHead>
                                <TableHead className="font-bold text-slate-800 text-[11px] uppercase tracking-wider py-4">Description/Narration</TableHead>
                                <TableHead className="font-bold text-slate-800 text-[11px] uppercase tracking-wider py-4">Ref/Chq No.</TableHead>
                                <TableHead className="font-bold text-slate-800 text-[11px] uppercase tracking-wider py-4 text-right">Debit (₹)</TableHead>
                                <TableHead className="font-bold text-slate-800 text-[11px] uppercase tracking-wider py-4 text-right">Credit (₹)</TableHead>
                                <TableHead className="font-bold text-slate-800 text-[11px] uppercase tracking-wider py-4 text-right">Balance (₹)</TableHead>
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {paginatedTransactions.length > 0 ? (
                                paginatedTransactions.map((t, idx) => {
                                    const globalIdx = (currentPage - 1) * itemsPerPage + idx;
                                    return (
                                        <TableRow key={t.id} className="hover:bg-blue-50/30 transition-colors border-b border-slate-100 last:border-none">
                                            <TableCell className="text-[12px] text-slate-400 font-medium">{globalIdx + 1}</TableCell>
                                            <TableCell className="p-1">
                                                <input
                                                    value={t.date}
                                                    onChange={(e) => handleChange(t.id, 'date', e.target.value)}
                                                    className="w-full text-[13px] border-none bg-transparent hover:bg-slate-100 focus:bg-white focus:ring-1 focus:ring-blue-500 rounded p-2 text-slate-600 outline-none"
                                                />
                                            </TableCell>
                                            <TableCell className="p-1">
                                                <input
                                                    value={t.valueDate || ''}
                                                    onChange={(e) => handleChange(t.id, 'valueDate', e.target.value)}
                                                    className="w-full text-[13px] border-none bg-transparent hover:bg-slate-100 focus:bg-white focus:ring-1 focus:ring-blue-500 rounded p-2 text-slate-600 outline-none"
                                                />
                                            </TableCell>
                                            <TableCell className="p-1 min-w-[300px]">
                                                <textarea
                                                    value={t.description}
                                                    onChange={(e) => handleChange(t.id, 'description', e.target.value)}
                                                    rows={1}
                                                    className="w-full text-[13px] border-none bg-transparent hover:bg-slate-100 focus:bg-white focus:ring-1 focus:ring-blue-500 rounded p-2 text-slate-800 font-medium outline-none resize-none overflow-hidden"
                                                    onInput={(e) => {
                                                        e.target.style.height = 'auto';
                                                        e.target.style.height = e.target.scrollHeight + 'px';
                                                    }}
                                                />
                                            </TableCell>
                                            <TableCell className="p-1">
                                                <input
                                                    value={t.reference || ''}
                                                    onChange={(e) => handleChange(t.id, 'reference', e.target.value)}
                                                    className="w-full text-[13px] border-none bg-transparent hover:bg-slate-100 focus:bg-white focus:ring-1 focus:ring-blue-500 rounded p-2 text-slate-600 outline-none"
                                                />
                                            </TableCell>
                                            <TableCell className="p-1 text-right">
                                                <input
                                                    type="text"
                                                    value={parseFloat(String(t.debit || 0).replace(/,/g, '')) !== 0 ? t.debit : ''}
                                                    placeholder="-"
                                                    onChange={(e) => handleChange(t.id, 'debit', e.target.value)}
                                                    className="font-financial w-full text-[13px] border-none bg-transparent hover:bg-slate-100 focus:bg-white focus:ring-1 focus:ring-red-500 rounded p-2 text-red-600 font-semibold text-right outline-none"
                                                />
                                            </TableCell>
                                            <TableCell className="p-1 text-right">
                                                <input
                                                    type="text"
                                                    value={parseFloat(String(t.credit || 0).replace(/,/g, '')) !== 0 ? t.credit : ''}
                                                    placeholder="-"
                                                    onChange={(e) => handleChange(t.id, 'credit', e.target.value)}
                                                    className="font-financial w-full text-[13px] border-none bg-transparent hover:bg-slate-100 focus:bg-white focus:ring-1 focus:ring-emerald-500 rounded p-2 text-emerald-600 font-semibold text-right outline-none"
                                                />
                                            </TableCell>
                                            <TableCell className="p-1 text-right">
                                                <input
                                                    type="text"
                                                    value={t.balance !== '' && t.balance !== undefined ? parseFloat(String(t.balance).replace(/,/g, '') || 0).toFixed(2) : ''}
                                                    onChange={(e) => handleChange(t.id, 'balance', e.target.value)}
                                                    className="font-financial w-full text-[14px] border-none bg-transparent hover:bg-slate-100 focus:bg-white focus:ring-1 focus:ring-blue-500 rounded p-2 text-slate-900 font-semibold text-right outline-none"
                                                />
                                            </TableCell>
                                        </TableRow>
                                    );
                                })
                            ) : (
                                <TableRow>
                                    <TableCell colSpan={8} className="text-center py-16">
                                        <div className="flex flex-col items-center justify-center text-slate-400">
                                            <Save className="w-12 h-12 mb-4 opacity-10" />
                                            <p className="text-lg font-medium">No transactions extracted.</p>
                                            <p className="text-sm">Try uploading a clearer statement PDF.</p>
                                        </div>
                                    </TableCell>
                                </TableRow>
                            )}
                            {/* Total Row - Auto-calculates when credit/debit values change */}
                            {transactions.length > 0 && (
                                <TableRow className="bg-slate-100 border-t-2 border-slate-300 font-bold">
                                    <TableCell className="text-[12px] text-slate-600 font-bold"></TableCell>
                                    <TableCell className="p-2 text-[13px] text-slate-800 font-bold">Total</TableCell>
                                    <TableCell className="p-2"></TableCell>
                                    <TableCell className="p-2"></TableCell>
                                    <TableCell className="p-2"></TableCell>
                                    <TableCell className="p-2 text-right">
                                        <span className="font-financial text-[13px] text-red-700 font-bold">
                                            {totals.debit > 0 ? totals.debit.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '-'}
                                        </span>
                                    </TableCell>
                                    <TableCell className="p-2 text-right">
                                        <span className="font-financial text-[13px] text-emerald-700 font-bold">
                                            {totals.credit > 0 ? totals.credit.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '-'}
                                        </span>
                                    </TableCell>
                                    <TableCell className="p-2 text-right">
                                        <span className="font-financial text-[14px] text-slate-900 font-bold">
                                            {closingBalance.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                                        </span>
                                    </TableCell>
                                </TableRow>
                            )}
                        </TableBody>
                    </Table>
                </div>

                {/* Pagination Controls */}
                {transactions.length > itemsPerPage && (
                    <div className="px-6 py-4 bg-slate-50/50 border-t border-slate-100 flex items-center justify-between">
                        <div className="text-xs font-medium text-slate-500">
                            Showing <span className="text-slate-900">{(currentPage - 1) * itemsPerPage + 1}</span> to <span className="text-slate-900">{Math.min(currentPage * itemsPerPage, transactions.length)}</span> of <span className="text-slate-900">{transactions.length}</span> transactions
                        </div>
                        <div className="flex items-center gap-2">
                            <Button
                                variant="outline"
                                size="sm"
                                onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
                                disabled={currentPage === 1}
                                className="h-8 w-8 p-0"
                            >
                                <ChevronLeft className="w-4 h-4" />
                            </Button>

                            <div className="flex items-center gap-1">
                                {[...Array(totalPages)].map((_, i) => {
                                    const pageNum = i + 1;
                                    // Show first, last, and pages around current
                                    if (
                                        pageNum === 1 ||
                                        pageNum === totalPages ||
                                        (pageNum >= currentPage - 1 && pageNum <= currentPage + 1)
                                    ) {
                                        return (
                                            <Button
                                                key={pageNum}
                                                variant={currentPage === pageNum ? "primary" : "outline"}
                                                size="sm"
                                                onClick={() => setCurrentPage(pageNum)}
                                                className={`h-8 w-8 p-0 text-xs font-bold ${currentPage === pageNum ? 'bg-blue-600 border-blue-600' : 'text-slate-600'}`}
                                            >
                                                {pageNum}
                                            </Button>
                                        );
                                    } else if (
                                        pageNum === currentPage - 2 ||
                                        pageNum === currentPage + 2
                                    ) {
                                        return <span key={pageNum} className="text-slate-400 text-xs px-1">...</span>;
                                    }
                                    return null;
                                })}
                            </div>

                            <Button
                                variant="outline"
                                size="sm"
                                onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
                                disabled={currentPage === totalPages}
                                className="h-8 w-8 p-0"
                            >
                                <ChevronRight className="w-4 h-4" />
                            </Button>
                        </div>
                    </div>
                )}
            </Card>
        </div>
    );
}
