import React, { useState, useEffect, useRef } from 'react';
import * as pdfjsLib from 'pdfjs-dist';
import { motion, AnimatePresence } from 'framer-motion';
import { Save, ArrowRight, FileDown, Search, Type, Loader2, RefreshCw, List, Eye, Wand2 } from 'lucide-react';
import { Button } from './ui/Button';
import { statementService } from '../services/api';
import { TransactionTable } from './TransactionTable';

// Initialize PDF.js worker
pdfjsLib.GlobalWorkerOptions.workerSrc = `//cdnjs.cloudflare.com/ajax/libs/pdf.js/${pdfjsLib.version}/pdf.worker.min.mjs`;

export function InPdfEditor(props) {
    const { fileUrl, onUpdateFileUrl, initialPassword } = props;
    const [pdf, setPdf] = useState(null);
    const [numPages, setNumPages] = useState(0);
    const [pagesData, setPagesData] = useState([]); // Array of { pageIndex, textItems: [] }
    const [isLoading, setIsLoading] = useState(true);
    const [scale, setScale] = useState(1.5);
    const [isSaving, setIsSaving] = useState(false);
    const [isTransforming, setIsTransforming] = useState(false);
    const [transformError, setTransformError] = useState(null);
    const containerRef = useRef(null);
    const [viewMode, setViewMode] = useState('pdf'); // 'pdf' or 'table'
    const { initialTransactions = [], initialBalances = { opening: 0, closing: 0 } } = props;

    // Logic to identify columns and rows for auto-calculation
    const [tableStructure, setTableStructure] = useState(null);
    const [fileVersion, setFileVersion] = useState(0);
    const [internalTransactions, setInternalTransactions] = useState(initialTransactions);
    const pdfPasswordRef = useRef(initialPassword || null);

    // Sync internalTransactions when initialTransactions prop changes
    useEffect(() => {
        if (initialTransactions && initialTransactions.length > 0) {
            setInternalTransactions(initialTransactions);
        }
    }, [initialTransactions]);

    const analyzeTableStructure = (allPagesData) => {
        const dateSigs = ['date', 'value dt', 'vldt', 'tran date', 'value date', 'transaction date'];
        const debitSigs = ['debit', 'withdrawal', 'payment', 'paid out', 'dr(', 'dr (', 'dr (₹)', 'withdrawn', 'debit amount'];
        const creditSigs = ['credit', 'deposit', 'receipt', 'paid in', 'cr(', 'cr (', 'cr (₹)', 'deposited', 'credit amount'];
        const balanceSigs = ['balance', 'bal (', 'bal(₹)', 'closing balance', 'running balance', 'account balance'];

        let foundStructure = null;

        for (const page of allPagesData) {
            const items = page.items;
            const rows = [];
            let currentRow = [];
            let lastY = -1;
            const sorted = [...items].sort((a, b) => b.y - a.y);
            
            sorted.forEach(it => {
                if (Math.abs(it.y - lastY) > 5) {
                    if (currentRow.length > 0) rows.push(currentRow);
                    currentRow = [it];
                    lastY = it.y;
                } else {
                    currentRow.push(it);
                }
            });
            if (currentRow.length > 0) rows.push(currentRow);

            console.log(`[analyzeTableStructure] Page ${page.pageIndex} has ${rows.length} rows`);

            // STRATEGY 1: Find a row with date AND (debit OR credit OR balance) headers
            for (const row of rows) {
                const textJoined = row.map(it => it.text.toLowerCase()).join(' ');
                
                // Skip metadata rows
                if (textJoined.includes(':')) continue;
                if (textJoined.includes('opening') || textJoined.includes('closing')) continue;

                const findMatch = (sigs) => row.find(it => sigs.some(s => it.text.toLowerCase().includes(s)));
                const mDate = findMatch(dateSigs);
                const mDebit = findMatch(debitSigs);
                const mCredit = findMatch(creditSigs);
                const mBalance = findMatch(balanceSigs);

                if (mDate && (mDebit || mCredit || mBalance)) {
                    const getX = (it) => it ? it.x + it.width / 2 : null;

                    foundStructure = {
                        pageIndex: page.pageIndex,
                        headerY: row[0].y,
                        debitX: getX(mDebit),
                        creditX: getX(mCredit),
                        balanceX: getX(mBalance)
                    };

                    // FALLBACKS: If a column isn't found, try to find it relative to others
                    if (foundStructure.debitX === null && foundStructure.creditX !== null) foundStructure.debitX = foundStructure.creditX - 100;
                    if (foundStructure.creditX === null && foundStructure.debitX !== null) foundStructure.creditX = foundStructure.debitX + 100;
                    if (foundStructure.balanceX === null && foundStructure.creditX !== null) foundStructure.balanceX = foundStructure.creditX + 100;

                    // DEFINE BOUNDARIES: Midpoints between header centers
                    foundStructure.boundaries = {
                        debitLeft: (foundStructure.debitX || 400) - 50,
                        debitCredit: (foundStructure.debitX + foundStructure.creditX) / 2,
                        creditBalance: (foundStructure.creditX + foundStructure.balanceX) / 2
                    };

                    console.log("[analyzeTableStructure] ✓ Found structure (Strategy 1):", foundStructure);
                    setTableStructure(foundStructure);
                    return;
                }
            }

            // STRATEGY 2: Look for numeric column patterns if headers aren't clearly labeled
            // Find rows with numeric values that are likely table data rows
            let numericRows = [];
            for (const row of rows) {
                const numericItems = row.filter(it => /^[0-9,.\-\s()₹]+$/.test(it.text.trim()) || it.text.trim() === '-');
                if (numericItems.length >= 2) {
                    numericRows.push({ row, numericItems });
                }
            }

            // Requirement: At least 3 rows normally, but only 1 if it's the first page
            const minRowsReq = page.pageIndex === 1 ? 1 : 3;

            if (numericRows.length >= minRowsReq) {
                // Filter rows: Ignore anything in the top 150 points (usually address section)
                // BUT if it's Page 1 and we have very few rows, be more lenient
                const yThreshold = page.pageIndex === 1 ? 750 : 620;
                numericRows = numericRows.filter(({ row }) => row[0].y < yThreshold);
                
                if (numericRows.length >= (page.pageIndex === 1 ? 1 : 2)) {
                    // Extract column positions from numeric rows
                const xPositions = {};
                numericRows.forEach(({ numericItems }) => {
                    numericItems.forEach(item => {
                        const x = Math.round(item.x);
                        xPositions[x] = (xPositions[x] || 0) + 1;
                    });
                });

                // Sort by frequency to find the most common column positions
                const sortedCols = Object.entries(xPositions)
                    .sort((a, b) => b[1] - a[1])
                    .slice(0, 4)
                    .map(([x]) => parseFloat(x));

                // Filter: Table columns (Debit/Credit/Balance) MUST be on the right side (x > 350)
                const rightCols = sortedCols.filter(x => x > 350).sort((a, b) => a - b);

                if (rightCols.length >= 3) {
                    foundStructure = {
                        pageIndex: page.pageIndex,
                        headerY: (rows[0]?.[0]?.y || 0) + 25, // Safer offset for multi-line headers
                        debitX: rightCols[0],
                        creditX: rightCols[1],
                        balanceX: rightCols[2],
                        boundaries: {
                            debitLeft: rightCols[0] - 50,
                            debitCredit: (rightCols[0] + rightCols[1]) / 2,
                            creditBalance: (rightCols[1] + rightCols[2]) / 2
                        }
                    };
                    console.log("[analyzeTableStructure] ✓ Found structure (Strategy 2 - numeric pattern):", foundStructure);
                    setTableStructure(foundStructure);
                    return;
                }
            }
    }
}

        if (!foundStructure) {
            console.warn("[analyzeTableStructure] ✗ NO TABLE STRUCTURE DETECTED");
            console.warn("This PDF may not have a standard transaction table format.");
        }
    };

    const runAutoCalculation = (dataToProcess = null) => {
        if (!tableStructure) return;

        setPagesData(prevPages => {
            const sourcePages = dataToProcess || prevPages;
            const nextPages = JSON.parse(JSON.stringify(sourcePages));
            let runningBalance = null;

            // Flatten all items from all pages 
            const allItems = [];
            nextPages.forEach(p => {
                p.items.forEach(item => {
                    allItems.push({ ...item, pageIdx: p.pageIndex });
                });
            });

            // Process items top-to-bottom
            allItems.sort((a, b) => a.pageIdx === b.pageIdx ? b.y - a.y : a.pageIdx - b.pageIdx);

            // Group into rows
            const rows = [];
            let currentRow = [];
            let lastY = -1;

            allItems.forEach(item => {
                if (Math.abs(item.y - lastY) > 5) {
                    if (currentRow.length > 0) rows.push(currentRow);
                    currentRow = [item];
                    lastY = item.y;
                } else {
                    currentRow.push(item);
                }
            });
            if (currentRow.length > 0) rows.push(currentRow);

            // Ripple Math logic
            let lastKnownBalance = null;
            const updatedInternalTxns = [...internalTransactions];
            let txnIdx = 0;

            rows.forEach((row) => {
                // ROW FILTER: Must be below header if on same page, or on any subsequent page
                const firstItem = row[0];
                if (!firstItem) return;

                const isAfterHeaderPage = firstItem.pageIdx > tableStructure.pageIndex;
                const isOnHeaderPageBelowHeader = firstItem.pageIdx === tableStructure.pageIndex && firstItem.y < tableStructure.headerY - 10;

                if (!isAfterHeaderPage && !isOnHeaderPageBelowHeader) return;

                // VALIDATION: Strict Transaction Row Verification
                const rowText = row.map(it => (it.text || '').toLowerCase()).join(' ');

                // 1. Skip if it contains summary keywords
                if (rowText.includes('balance') && (rowText.includes('opening') || rowText.includes('closing'))) return;

                // 2. REQUIRE a Date format to start/be in the row (e.g. DD MMM or DD/MM)
                const dateRegex = /\d{1,2}[\/\-\s](?:[A-Za-z]{3}|\d{1,2})/;
                if (!dateRegex.test(rowText)) return;

                // BOUNDED COLUMN ASSIGNMENT: Virtual "Walls" based on header centers
                const rowItems = row.filter(it => /^[0-9,.\-\s()₹]+$/.test(it.text.trim()) || it.text.trim() === '-');
                const columnAssignments = { debitItem: null, creditItem: null, balanceItem: null };

                rowItems.forEach(it => {
                    const mid = it.x + (it.width || 0) / 2;
                    let targetKey = null;

                    // Bucket check with safety minimum X (Debit should be after narration/ref, usually > 400px)
                    if (mid < tableStructure.boundaries.debitLeft) return;

                    if (mid < tableStructure.boundaries.debitCredit) {
                        targetKey = 'debitItem';
                    } else if (mid < tableStructure.boundaries.creditBalance) {
                        targetKey = 'creditItem';
                    } else {
                        targetKey = 'balanceItem';
                    }

                    const existing = columnAssignments[targetKey];
                    if (!existing || (it.text !== '-' && existing.text === '-')) {
                        columnAssignments[targetKey] = it;
                    }
                });

                const { debitItem, creditItem, balanceItem } = columnAssignments;

                if (balanceItem) {
                    const cleanNum = (txt) => {
                        if (!txt || txt === '-' || txt.trim() === '') return 0;
                        let val = txt.replace(/,/g, '').replace(/\((.*)\)/, '-$1').replace(/[^0-9.-]/g, '');
                        return parseFloat(val) || 0;
                    };

                    const debit = debitItem ? cleanNum(debitItem.text) : 0;
                    const credit = creditItem ? cleanNum(creditItem.text) : 0;

                    if (lastKnownBalance === null) {
                        const origBal = cleanNum(balanceItem.originalText);
                        const origDeb = debitItem ? cleanNum(debitItem.originalText) : 0;
                        const origCre = creditItem ? cleanNum(creditItem.originalText) : 0;
                        const opening = origBal - origCre + origDeb;
                        lastKnownBalance = opening + credit - debit;
                    } else {
                        lastKnownBalance = lastKnownBalance + credit - debit;
                    }

                    const formattedBalance = lastKnownBalance.toLocaleString('en-IN', {
                        minimumFractionDigits: 2,
                        maximumFractionDigits: 2
                    });

                    // Update PDF Item
                    if (balanceItem.text !== formattedBalance) {
                        balanceItem.text = formattedBalance;
                        balanceItem.hasChanged = true;
                    }

                    // Also sync Debit/Credit values to PDF layer
                    if (debitItem) {
                        const formattedDebit = formatLikeOriginal(debit, debitItem.originalText);
                        if (debitItem.text !== formattedDebit) {
                            debitItem.text = formattedDebit;
                            debitItem.hasChanged = true;
                        }
                    }
                    if (creditItem) {
                        const formattedCredit = formatLikeOriginal(credit, creditItem.originalText);
                        if (creditItem.text !== formattedCredit) {
                            creditItem.text = formattedCredit;
                            creditItem.hasChanged = true;
                        }
                    }

                    // Update Internal Transactions (Sync PDF -> Table)
                    if (updatedInternalTxns[txnIdx]) {
                        updatedInternalTxns[txnIdx].debit = debit;
                        updatedInternalTxns[txnIdx].credit = credit;
                        updatedInternalTxns[txnIdx].balance = lastKnownBalance.toFixed(2);
                        txnIdx++;
                    }
                }
            });

            if (updatedInternalTxns.length > 0) {
                setInternalTransactions(updatedInternalTxns);
            }

            return nextPages.map(page => ({
                ...page,
                items: page.items.map(origItem => {
                    const updated = allItems.find(ai => ai.id === origItem.id);
                    return updated || origItem;
                })
            }));
        });
    };

    useEffect(() => {
        const loadPdf = async (pwd = null) => {
            setIsLoading(true);
            try {
                setPagesData([]);
                // Suppress non-critical PDF warnings
                const pdfjsWorker = pdfjsLib.GlobalWorkerOptions.workerSrc;
                
                const loadingTask = pdfjsLib.getDocument(pwd ? { url: fileUrl, password: pwd } : fileUrl);
                
                // Don't fail on warnings - PDF might still be readable
                loadingTask.onPassword = (updatePassword) => {
                    if (pwd) updatePassword(pwd);
                };
                
                const loadedPdf = await loadingTask.promise;
                
                if (pwd) pdfPasswordRef.current = pwd;
                
                setPdf(loadedPdf);
                setNumPages(loadedPdf.numPages);

                const allPagesData = [];
                for (let i = 1; i <= loadedPdf.numPages; i++) {
                    try {
                        const page = await loadedPdf.getPage(i);
                        const textContent = await page.getTextContent({ normalizeWhitespace: true });
                        const viewport = page.getViewport({ scale: 1 });

                    // Extract the actual text color from the page's operator list
                    let pageTextColor = null;
                    try {
                        const ops = await page.getOperatorList();
                        const OPS = pdfjsLib.OPS;

                        if (!OPS) throw new Error('pdfjsLib.OPS not available');

                        const rgbCounts = {};
                        const grayCounts = {};
                        let currentFill = null;
                        let currentColorSpace = 'DeviceRGB';

                        // All text-showing operators (Tj, TJ, ', ")
                        const textShowOps = new Set([
                            OPS.showText,
                            OPS.showSpacedText,
                            OPS.nextLineShowText,
                            OPS.nextLineSetSpacingShowText,
                        ].filter(Boolean));

                        for (let opIdx = 0; opIdx < ops.fnArray.length; opIdx++) {
                            const fn = ops.fnArray[opIdx];
                            const args = ops.argsArray[opIdx];

                            // Direct RGB: rg operator
                            if (fn === OPS.setFillRGBColor) {
                                currentFill = { r: args[0], g: args[1], b: args[2], isRgb: true };
                            }
                            // Direct Gray: g operator
                            else if (fn === OPS.setFillGray) {
                                const v = args[0];
                                currentFill = { r: v, g: v, b: v, isRgb: false };
                            }
                            // Direct CMYK: k operator
                            else if (fn === OPS.setFillCMYKColor) {
                                const [c, m, y, k] = args;
                                currentFill = {
                                    r: (1 - c) * (1 - k),
                                    g: (1 - m) * (1 - k),
                                    b: (1 - y) * (1 - k),
                                    isRgb: true
                                };
                            }
                            // Color space change: cs operator
                            else if (fn === OPS.setFillColorSpace) {
                                currentColorSpace = args ? String(args[0]) : 'DeviceRGB';
                                currentFill = null;
                            }
                            // sc / scn operators
                            else if (fn === OPS.setFillColor || fn === OPS.setFillColorN) {
                                if (args && args.length >= 1) {
                                    const cs = currentColorSpace.toLowerCase();
                                    if (cs.includes('gray') || (args.length === 1 && typeof args[0] === 'number')) {
                                        const v = args[0];
                                        currentFill = { r: v, g: v, b: v, isRgb: false };
                                    } else if (args.length === 3) {
                                        currentFill = { r: args[0], g: args[1], b: args[2], isRgb: true };
                                    } else if (args.length === 4) {
                                        const [c, m, y, k] = args;
                                        currentFill = { r: (1-c)*(1-k), g: (1-m)*(1-k), b: (1-y)*(1-k), isRgb: true };
                                    }
                                }
                            }

                            // Count color when text is actually drawn
                            if (textShowOps.has(fn) && currentFill) {
                                const { r, g, b, isRgb } = currentFill;
                                // Skip white / near-white
                                if (!(r > 0.95 && g > 0.95 && b > 0.95)) {
                                    const key = `${r.toFixed(4)},${g.toFixed(4)},${b.toFixed(4)}`;
                                    if (isRgb) {
                                        rgbCounts[key] = (rgbCounts[key] || 0) + 1;
                                    } else {
                                        grayCounts[key] = (grayCounts[key] || 0) + 1;
                                    }
                                }
                            }
                        }

                        // Prefer most-frequent RGB color; fall back to grayscale if no RGB found
                        const counts = Object.keys(rgbCounts).length > 0 ? rgbCounts : grayCounts;
                        let bestKey = null, bestCount = 0;
                        for (const [key, count] of Object.entries(counts)) {
                            if (count > bestCount) { bestCount = count; bestKey = key; }
                        }
                        if (bestKey) {
                            const [r, g, b] = bestKey.split(',').map(Number);
                            pageTextColor = { r, g, b };
                            console.log(`[PDF] Page ${i} text color: rgb(${r.toFixed(3)}, ${g.toFixed(3)}, ${b.toFixed(3)}) [${bestCount} uses]`);
                        } else {
                            console.warn(`[PDF] Page ${i}: no text color detected in operator list`);
                        }
                    } catch (colorErr) {
                        console.warn(`[PDF] Could not extract text color for page ${i}:`, colorErr.message || colorErr);
                    }

                    const items = textContent.items.map((item, idx) => {
                        const fontSize = Math.sqrt(item.transform[0] ** 2 + item.transform[1] ** 2);
                        return {
                            id: `p${i}-t${idx}`,
                            text: item.str,
                            originalText: item.str,
                            x: item.transform[4],
                            y: item.transform[5],
                            width: item.width || (item.str.length * fontSize * 0.6),
                            height: item.height || fontSize,
                            fontSize: fontSize,
                            fontName: item.fontName,
                            hasChanged: false
                        };
                    });

                    allPagesData.push({
                        pageIndex: i,
                        width: viewport.width,
                        height: viewport.height,
                        textColor: pageTextColor,
                        items: items.filter(item => item.text.trim().length > 0)
                    });
                    } catch (pageErr) {
                        console.warn(`[PDF] Error loading page ${i}:`, pageErr.message);
                        // Continue with next page even if one fails
                    }
                }
                setPagesData(allPagesData);
                
                // Log PDF diagnostic info
                console.log(`[PDF Analysis] Total pages: ${allPagesData.length}`);
                console.log(`[PDF Analysis] Total text items extracted: ${allPagesData.reduce((sum, p) => sum + p.items.length, 0)}`);
                
                analyzeTableStructure(allPagesData);
                
                // Clear any transform errors on successful load
                setTransformError(null);
                
                // If table structure found, log success
                if (tableStructure) {
                    console.log(`✓ [PDF Analysis] Table structure detected successfully`);
                } else {
                    console.warn(`✗ [PDF Analysis] WARNING: Could not auto-detect table structure`);
                    console.warn(`  This may be normal for non-standard PDFs`);
                }
            } catch (error) {
                if (error.name === 'PasswordException') {
                    const password = prompt('This PDF is password protected. Please enter the password:');
                    if (password) await loadPdf(password);
                } else {
                    console.error("Error loading PDF:", error);
                    setTransformError(`Failed to load PDF: ${error.message}`);
                    alert(`Failed to load PDF for editing: ${error.message}`);
                }
            } finally {
                setIsLoading(false);
            }
        };

        if (fileUrl) {
            loadPdf(initialPassword || pdfPasswordRef.current);
        }
    }, [fileUrl, fileVersion, initialPassword]);

    const handleTextChange = (pageIdx, itemId, newText) => {
        setPagesData(current => {
            const updated = current.map(p => {
                if (p.pageIndex !== pageIdx) return p;
                return {
                    ...p,
                    items: p.items.map(item => {
                        if (item.id !== itemId) return item;
                        return { ...item, text: newText, hasChanged: newText !== item.originalText };
                    })
                };
            });

            // Trigger auto-calculation on the next tick
            setTimeout(() => runAutoCalculation(updated), 0);
            return updated;
        });
    };

    const handleTableUpdate = (updatedTxns) => {
        setInternalTransactions(updatedTxns);

        // Update PDF state to mirror table changes
        if (!tableStructure) return;

        setPagesData(prevPages => {
            const nextPages = JSON.parse(JSON.stringify(prevPages));
            const allItems = [];
            nextPages.forEach(p => {
                p.items.forEach(item => {
                    allItems.push({ ...item, pageIdx: p.pageIndex });
                });
            });
            allItems.sort((a, b) => a.pageIdx === b.pageIdx ? b.y - a.y : a.pageIdx - b.pageIdx);

            const rows = [];
            let currentRow = [];
            let lastY = -1;
            allItems.forEach(item => {
                if (Math.abs(item.y - lastY) > 5) {
                    if (currentRow.length > 0) rows.push(currentRow);
                    currentRow = [item];
                    lastY = item.y;
                } else {
                    currentRow.push(item);
                }
            });
            if (currentRow.length > 0) rows.push(currentRow);
            const txnRows = rows.filter(row => {
                const firstItem = row[0];
                if (!firstItem) return false;
                const isAfterHeaderPage = firstItem.pageIdx > tableStructure.pageIndex;
                const isOnHeaderPageBelowHeader = firstItem.pageIdx === tableStructure.pageIndex && firstItem.y < tableStructure.headerY - 10;
                if (!isAfterHeaderPage && !isOnHeaderPageBelowHeader) return false;

                const rowText = row.map(it => (it.text || '').toLowerCase()).join(' ');
                if (rowText.includes('balance') && (rowText.includes('opening') || rowText.includes('closing'))) return false;

                // VALIDATION: Transaction rows MUST have a date-like pattern
                const dateRegex = /\d{1,2}[\/\-\s](?:[A-Za-z]{3}|\d{1,2})/;
                if (!dateRegex.test(rowText)) return false;

                return row.some(it => Math.abs(it.x - tableStructure.balanceX) < 40);
            });

            txnRows.forEach((row, idx) => {
                const txn = updatedTxns[idx];
                if (!txn) return;

                const rowItems = row.filter(it => /^[0-9,.\-\s()₹]+$/.test(it.text.trim()) || it.text.trim() === '-');
                const columnAssignments = { debit: null, credit: null, balance: null };

                rowItems.forEach(it => {
                    const mid = it.x + (it.width || 0) / 2;
                    if (mid < tableStructure.boundaries.debitLeft) return;

                    let targetKey = null;
                    if (mid < tableStructure.boundaries.debitCredit) targetKey = 'debit';
                    else if (mid < tableStructure.boundaries.creditBalance) targetKey = 'credit';
                    else targetKey = 'balance';

                    const existing = columnAssignments[targetKey];
                    if (!existing || (it.text !== '-' && existing.text === '-')) {
                        columnAssignments[targetKey] = it;
                    }
                });

                const fields = [
                    { val: txn.debit, it: columnAssignments.debit },
                    { val: txn.credit, it: columnAssignments.credit },
                    { val: txn.balance, it: columnAssignments.balance },
                ];

                fields.forEach(({ val, it }) => {
                    if (it) {
                        const newVal = normalizeNum(val);
                        // Dash safety
                        if (newVal === 0 && (it.originalText === '-' || it.originalText.trim() === '')) return;

                        const formatted = formatLikeOriginal(newVal, it.originalText);
                        if (it.text !== formatted) {
                            it.text = formatted;
                            it.hasChanged = true;
                        }
                    }
                });
            });

            return nextPages;
        });
    };

    const handleDownload = async () => {
        if (!fileUrl) return;
        try {
            const fileName = fileUrl.split('/').pop() || 'statement.pdf';
            const downloadUrl = `http://localhost:5001/api/statements/download-file?fileUrl=${encodeURIComponent(fileUrl)}`;
            const response = await fetch(downloadUrl);
            if (!response.ok) throw new Error(`Server returned ${response.status}`);
            const blob = await response.blob();
            const blobUrl = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = blobUrl;
            a.download = fileName;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(blobUrl);
            // Save to My Statements
            const sizeMB = blob.size > 1024 * 1024
                ? (blob.size / (1024 * 1024)).toFixed(1) + ' MB'
                : (blob.size / 1024).toFixed(1) + ' KB';
            await statementService.saveFile(fileUrl, fileName, sizeMB);
        } catch (error) {
            console.error('Download error:', error);
            alert('Failed to download the PDF.');
        }
    };

    const handleSave = async () => {
        setIsSaving(true);
        // Collect per-page text colors to send to backend
        const pageColors = {};
        pagesData.forEach(page => {
            if (page.textColor) {
                pageColors[page.pageIndex] = page.textColor;
            }
        });

        const changes = [];
        pagesData.forEach(page => {
            page.items.forEach(item => {
                if (item.hasChanged) {
                    changes.push({
                        pageIndex: page.pageIndex,
                        x: item.x,
                        y: item.y,
                        width: item.width,
                        height: item.height,
                        newText: item.text,
                        fontSize: item.fontSize
                    });
                }
            });
        });

        if (changes.length === 0) {
            alert("No changes to save.");
            setIsSaving(false);
            return;
        }

        try {
            const response = await fetch('http://localhost:5001/api/statements/edit-direct', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    fileUrl,
                    changes,
                    pageColors,
                    password: pdfPasswordRef.current
                })
            });
            const data = await response.json();
            if (data.success) {
                alert("Changes applied to PDF successfully!");
                if (onUpdateFileUrl) {
                    onUpdateFileUrl(data.fileUrl);
                    setFileVersion(v => v + 1); // Trigger refresh
                }
            } else {
                alert("Save failed: " + data.message);
            }
        } catch (error) {
            console.error("Save error:", error);
            alert("Connection error when saving changes.");
        } finally {
            setIsSaving(false);
        }
    };

    // ── TRANSFORM: Pixel-perfect coordinate-based PDF editing ──────────────
    const normalizeNum = (str) => {
        if (str === null || str === undefined) return 0;
        const s = String(str).trim();
        if (s === '' || s === '-') return 0;
        // Strip commas, currency symbols, and handle negative numbers in parentheses
        const val = s.replace(/,/g, '').replace(/\((.*)\)/, '-$1').replace(/[^0-9.-]/g, '');
        return parseFloat(val) || 0;
    };

    const formatLikeOriginal = (newVal, originalText) => {
        // If the value is 0, always represent it as a dash to match bank statement style
        if (newVal === 0) return '-';

        // ALWAYS use exactly 2 decimals for bank statement values
        const decimals = 2;
        const hasCommas = String(originalText).includes(',') || newVal >= 1000;

        if (hasCommas) {
            return newVal.toLocaleString('en-IN', {
                minimumFractionDigits: decimals,
                maximumFractionDigits: decimals
            });
        }
        return newVal.toFixed(decimals);
    };

    const handleTransformWithPrecision = async (editedTxns, _originalTxns, tableClosingBalance) => {
        setIsTransforming(true);
        setViewMode('pdf');
        try {
            if (!tableStructure) {
                const userChoice = window.confirm(
                    "⚠️ Table structure could not be auto-detected.\n\n" +
                    "This PDF might have:\n" +
                    "• Non-standard table layout\n" +
                    "• Missing column headers (Date/Debit/Credit/Balance)\n" +
                    "• Unusual formatting\n\n" +
                    "Try uploading a different PDF with clear column headers.\n\n" +
                    "Or continue anyway? (May result in incomplete transformation)"
                );
                setIsTransforming(false);
                if (!userChoice) return;
                // If user chooses to continue, we'll attempt a best-effort approach
            }

            const changes = [];

            // Helper: parse a numeric string from PDF text (handles commas, dashes, parentheses)
            const cleanOrigNum = (txt) => {
                if (!txt || txt === '-' || txt.trim() === '') return 0;
                const val = String(txt).replace(/,/g, '').replace(/\((.*)\)/, '-$1').replace(/[^0-9.-]/g, '');
                return parseFloat(val) || 0;
            };

            // 1. Pass: Extract all items from all pages for row/column analysis
            const allItems = [];
            pagesData.forEach(p => {
                p.items.forEach(item => {
                    allItems.push({ ...item, pageIdx: p.pageIndex });
                });
            });
            // Sort page-first (ascending), then top-to-bottom within each page (descending Y)
            allItems.sort((a, b) => a.pageIdx === b.pageIdx ? b.y - a.y : a.pageIdx - b.pageIdx);

            // Group items into rows — reset row whenever the page changes OR Y jumps > 8 pts
            const rows = [];
            let currentRow = [];
            let lastY = -1;
            let lastPageIdx = -1;
            allItems.forEach(item => {
                const pageChanged = item.pageIdx !== lastPageIdx && lastPageIdx !== -1;
                if (pageChanged || Math.abs(item.y - lastY) > 8) {
                    if (currentRow.length > 0) rows.push(currentRow);
                    currentRow = [item];
                    lastY = item.y;
                    lastPageIdx = item.pageIdx;
                } else {
                    currentRow.push(item);
                    lastPageIdx = item.pageIdx;
                }
            });
            if (currentRow.length > 0) rows.push(currentRow);

            // Stricter date regex: requires a full "DD Mon" or "DD/MM" pattern to avoid
            // false matches on phone numbers ("41 4110"), reference IDs ("60/61"), etc.
            const txnDateRegex = /\b\d{1,2}[\s\/\-](Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec|\d{2})[\s\/\-]?\d{0,4}\b/i;

            // 2. Pass: Filter for rows that actually look like transaction rows
            const txnRows = rows.filter(row => {
                const firstItem = row[0];
                if (!firstItem) return false;
                
                // VERTICAL GUARD: Skip very top of Page 1 (address/logo)
                if (firstItem.pageIdx === 1 && firstItem.y > 780) return false;

                const rowText = row.map(it => (it.text || '').toLowerCase()).join(' ');
                // Skip summary/balance rows
                if (rowText.includes('balance') && (rowText.includes('opening') || rowText.includes('closing'))) return false;
                if (rowText.includes('transaction') && rowText.includes('debit') && rowText.includes('credit')) return false;

                // Match Date Pattern
                if (!txnDateRegex.test(rowText)) return false;

                // Must have at least one numeric item (Amount)
                const numericCount = row.filter(it => /^[0-9,.\-₹]+$/.test(it.text.trim())).length;
                return numericCount >= 1;
            });

            // 3. Pass: Map table data to these rows using VALUE-BASED MATCHING.
            //    Instead of blind index alignment (which breaks when txnRows and editedTxns
            //    have different counts), we match each PDF row to the original transaction
            //    whose debit+credit+balance values match the row's original text values.
            //    This survives extra/missing rows caused by footers, repeated headers, etc.
            const usedTxnIndices = new Set();

            const findMatchingTxnIdx = (origDebit, origCredit, origBalance) => {
                // First pass: exact match on all three values
                for (let i = 0; i < internalTransactions.length; i++) {
                    if (usedTxnIndices.has(i)) continue;
                    const t = internalTransactions[i];
                    const td = cleanOrigNum(String(t.debit));
                    const tc = cleanOrigNum(String(t.credit));
                    const tb = cleanOrigNum(String(t.balance));
                    if (Math.abs(td - origDebit) < 0.02 &&
                        Math.abs(tc - origCredit) < 0.02 &&
                        Math.abs(tb - origBalance) < 0.02) {
                        return i;
                    }
                }
                // Second pass: match on balance only (handles edge cases where debit/credit dash vs 0)
                for (let i = 0; i < internalTransactions.length; i++) {
                    if (usedTxnIndices.has(i)) continue;
                    const t = internalTransactions[i];
                    const tb = cleanOrigNum(String(t.balance));
                    if (Math.abs(tb - origBalance) < 0.02) {
                        return i;
                    }
                }
                return -1;
            };

            let globalRowIdx = 0;
            txnRows.forEach((row) => {
                // BOUNDED COLUMN ASSIGNMENT
                const rowItems = row.filter(it => /^[0-9,.\-\s()₹]+$/.test(it.text.trim()) || it.text.trim() === '-');
                const columnAssignments = { debit: null, credit: null, balance: null };

                rowItems.forEach(it => {
                    const mid = it.x + (it.width || 0) / 2;
                    if (mid < tableStructure.boundaries.debitLeft) return;

                    let targetKey = null;
                    if (mid < tableStructure.boundaries.debitCredit) targetKey = 'debit';
                    else if (mid < tableStructure.boundaries.creditBalance) targetKey = 'credit';
                    else targetKey = 'balance';

                    const existing = columnAssignments[targetKey];
                    if (!existing || (it.text !== '-' && existing.text === '-')) {
                        columnAssignments[targetKey] = it;
                    }
                });

                if (!columnAssignments.balance) return; 

                const origDebit   = cleanOrigNum(columnAssignments.debit?.originalText);
                const origCredit  = cleanOrigNum(columnAssignments.credit?.originalText);
                const origBalance = cleanOrigNum(columnAssignments.balance?.originalText);

                const matchedIdx = findMatchingTxnIdx(origDebit, origCredit, origBalance);
                
                // Priority matching: 1. Value match, 2. Global sequence match
                const txn = matchedIdx >= 0 ? editedTxns[matchedIdx] : editedTxns[globalRowIdx];
                
                if (txn) {
                    if (matchedIdx >= 0) usedTxnIndices.add(matchedIdx);
                    
                    const fields = [
                        { val: txn.debit, it: columnAssignments.debit },
                        { val: txn.credit, it: columnAssignments.credit },
                        { val: txn.balance, it: columnAssignments.balance },
                    ];

                    fields.forEach(({ val, it }) => {
                        if (it) {
                            const newVal = normalizeNum(val);
                            if (newVal === 0 && (it.originalText === '-' || it.originalText.trim() === '')) return;

                            const formatted = formatLikeOriginal(newVal, it.originalText);
                            if (it.originalText !== formatted) {
                                changes.push({
                                    pageIndex: it.pageIdx,
                                    x: it.x,
                                    y: it.y,
                                    width: it.width,
                                    height: it.height,
                                    fontSize: it.fontSize,
                                    newText: formatted,
                                    isNumeric: true,
                                    isBold: false,
                                    isTableItem: true,
                                    hPadding: 0
                                });
                            }
                        }
                    });
                }
                
                globalRowIdx++; // Increment global counter for EVERY transaction row found in PDF
            });

            // 3.5. Pass: Find and update the 'Total' row at the bottom of the table if it exists
            rows.forEach(row => {
                const rowText = row.map(it => it.text.toLowerCase()).join(' ');
                // Identify total row: contains "total" but isn't an Opening/Closing balance row
                if (rowText.includes('total') && !rowText.includes('opening') && !rowText.includes('closing')) {
                    const totalDebit = editedTxns.reduce((sum, t) => sum + normalizeNum(t.debit), 0);
                    const totalCredit = editedTxns.reduce((sum, t) => sum + normalizeNum(t.credit), 0);

                    const rowItems = row.filter(it => /^[0-9,.\-\s()₹]+$/.test(it.text.trim()) || it.text.trim() === '-');
                    rowItems.forEach(it => {
                        const mid = it.x + (it.width || 0) / 2;
                        let targetVal = null;

                        // Identify if this item belongs to the Debit or Credit total column
                        if (mid > tableStructure.boundaries.debitLeft && mid < tableStructure.boundaries.debitCredit) {
                            targetVal = totalDebit;
                        } else if (mid >= tableStructure.boundaries.debitCredit && mid < tableStructure.boundaries.creditBalance) {
                            targetVal = totalCredit;
                        }

                        if (targetVal !== null) {
                            const formatted = formatLikeOriginal(targetVal, it.originalText);
                            if (it.originalText !== formatted) {
                                changes.push({
                                    pageIndex: it.pageIdx,
                                    x: it.x,
                                    y: it.y,
                                    width: it.width,
                                    height: it.height,
                                    fontSize: it.fontSize,
                                    newText: formatted,
                                    isNumeric: true,
                                    isBold: true,
                                    isTableItem: true,
                                    maskColor: [229, 231, 235] // Match the #E5E7EB gray background
                                });
                            }
                        }
                    });
                }
            });

            // 4. Pass: Update Summary Section (Opening/Closing Balance header rows)
            // Design rule: place everything at each row's OWN original coordinates.
            // Never share colon-x or right-edge across rows — that causes cross-row
            // mask bleed (e.g. erasing "0" from "01 Aug" on the Statement Period row
            // which shares the same PDF y-coordinate as the Closing Balance row).
            const summaryUpdates = [];

            pagesData.forEach(page => {
                // Build rows by grouping items with similar y-coordinate
                const pRows = [];
                let pCurr = [];
                let pY = -1;
                [...page.items].sort((a, b) => b.y - a.y).forEach(it => {
                    if (Math.abs(it.y - pY) > 5) {
                        if (pCurr.length > 0) pRows.push(pCurr);
                        pCurr = [it]; pY = it.y;
                    } else pCurr.push(it);
                });
                if (pCurr.length > 0) pRows.push(pCurr);

                // Collect right-column standalone colons for this page (x > 380 to exclude
                // left-column label colons like "Statement Date :" which sit at x ~ 250)
                const rightColonXOnPage = page.items
                    .filter(it => it.text.trim() === ':' && it.x > 380)
                    .sort((a, b) => a.x - b.x)[0]?.x ?? null;

                pRows.forEach(row => {
                    const rowText = row.map(it => it.text.toLowerCase()).join(' ');
                    const isOpening = /opening.*balance/i.test(rowText);
                    const isClosing = /closing.*balance/i.test(rowText);
                    if (!isOpening && !isClosing) return;

                    const targetVal = isOpening
                        ? initialBalances?.opening
                        : (tableClosingBalance ?? initialBalances?.closing);
                    if (targetVal === null || targetVal === undefined) return;

                    // Rightmost numeric item on this row is the balance value
                    const numItems = row.filter(it => /^[0-9,.\-\s()₹]+$/.test(it.text.trim()));
                    if (numItems.length === 0) return;
                    const best = numItems.sort((a, b) => b.x - a.x)[0];

                    const formatted = formatLikeOriginal(normalizeNum(targetVal), best.originalText);
                    // Nothing changed — leave the original PDF untouched
                    if (best.originalText === formatted) return;

                    // --- Locate the colon for THIS row only ---
                    // Rule: only look at in-row items AND enforce x > 380 so we never
                    // accidentally grab a left-column colon that shares the same y-band.
                    let colonItem = row.find(it => it.text.trim() === ':' && it.x > 380);

                    // Fallback: use the page-level right-column colon x (still only right col)
                    if (!colonItem && rightColonXOnPage !== null) {
                        colonItem = {
                            x: rightColonXOnPage,
                            y: best.y,
                            width: (best.fontSize || 8) * 0.4,
                            height: best.height || 10,
                            fontSize: best.fontSize || 8
                        };
                    }

                    // Draw colon FIRST so it is rendered before the value mask
                    if (colonItem) {
                        summaryUpdates.push({
                            pageIndex: page.pageIndex,
                            x: colonItem.x,
                            y: colonItem.y ?? best.y,
                            width: (colonItem.fontSize || best.fontSize || 8) * 0.4,
                            height: colonItem.height || best.height || 10,
                            newText: ':',
                            fontSize: colonItem.fontSize || best.fontSize || 8,
                            isNumeric: false,
                            isBold: false,
                            isSummaryItem: true
                        });
                    }

                    // Draw value right-aligned to its ORIGINAL right edge (best.x + best.width).
                    // Also pass minDrawX = colonRightEdge + 6 so the backend enforces a minimum
                    // draw position — the value never overlaps the colon even when the new text
                    // is wider than the original (which would shift drawX leftward into the colon).
                    const colonGap = 6; // pts of breathing room between colon right-edge and value
                    const colonRightEdge = colonItem
                        ? colonItem.x + (colonItem.width || (best.fontSize || 8) * 0.4) + colonGap
                        : null;
                    summaryUpdates.push({
                        pageIndex: page.pageIndex,
                        x: best.x,
                        y: best.y,
                        width: best.width,
                        height: best.height,
                        fontSize: best.fontSize,
                        newText: formatted,
                        isNumeric: true,
                        isBold: true,
                        isSummaryItem: true,
                        minDrawX: colonRightEdge  // backend enforces drawX >= this
                    });
                });
            });

            // Add summary updates to changes, ensuring no duplicates
            summaryUpdates.forEach(su => {
                if (!changes.some(c => Math.abs(c.x - su.x) < 0.1 && Math.abs(c.y - su.y) < 0.1 && c.pageIndex === su.pageIndex)) {
                    changes.push(su);
                }
            });

            // 5. Pass: Add Manual Text Edits (items edited directly in the PDF preview)
            pagesData.forEach(page => {
                page.items.forEach(item => {
                    if (item.hasChanged) {
                        // Avoid duplicates from table/summary sync
                        const isAlreadyCalculated = changes.some(c =>
                            Math.abs(c.x - item.x) < 0.1 &&
                            Math.abs(c.y - item.y) < 0.1 &&
                            c.pageIndex === page.pageIndex
                        );
                        if (!isAlreadyCalculated) {
                            changes.push({
                                pageIndex: page.pageIndex,
                                x: item.x,
                                y: item.y,
                                width: item.width,
                                height: item.height,
                                fontSize: item.fontSize,
                                newText: item.text,
                                isNumeric: !isNaN(parseFloat(item.text.replace(/,/g, ''))),
                                isBold: item.fontName?.toLowerCase().includes('bold') || false,
                            });
                        }
                    }
                });
            });

            if (changes.length === 0) {
                alert('No changes detected compared to the original statement.');
                setIsTransforming(false);
                return;
            }

            // Collect per-page text colors for the backend
            const pageColors = {};
            pagesData.forEach(page => {
                if (page.textColor) pageColors[page.pageIndex] = page.textColor;
            });

            console.log(`[Transform] 📤 Submitting ${changes.length} changes to backend...`);
            console.log(`[Transform] Current PDF: ${fileUrl}`);
            
            let transformResponse;
            try {
                const response = await fetch('http://localhost:5001/api/statements/edit-direct', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ fileUrl, changes, pageColors, password: pdfPasswordRef.current }),
                });

                if (!response.ok) {
                    const err = await response.json();
                    console.error(`[Transform] ❌ Server error: ${response.status}`, err);
                    alert(`Transformation failed: ${err.message || response.statusText}`);
                    setViewMode('table');
                    return;
                }

                transformResponse = await response.json();
                console.log(`[Transform] ✓ Backend response:`, transformResponse);
            } catch (fetchErr) {
                console.error(`[Transform] ❌ Network error:`, fetchErr);
                alert(`Network error: ${fetchErr.message}`);
                setViewMode('table');
                return;
            }

            if (!transformResponse.success) {
                console.error(`[Transform] ❌ Transform failed:`, transformResponse.message);
                alert(`Transformation failed: ${transformResponse.message}`);
                setViewMode('table');
                return;
            }

            const newFileUrl = transformResponse.fileUrl;
            if (!newFileUrl) {
                console.error(`[Transform] ❌ No file URL in response`);
                alert('Transformation completed but file URL is missing');
                setViewMode('table');
                return;
            }

            console.log(`[Transform] 📥 New PDF URL: ${newFileUrl}`);
            console.log(`[Transform] 📊 Stats:`, transformResponse.stats);

            // Verify the file exists before updating state
            try {
                console.log(`[Transform] 🔍 Verifying file exists...`);
                const headResponse = await fetch(newFileUrl, { method: 'HEAD' });
                if (!headResponse.ok) {
                    console.error(`[Transform] ⚠ File not accessible: ${headResponse.status}`);
                } else {
                    console.log(`[Transform] ✓ File verified (${headResponse.headers.get('content-length')} bytes)`);
                }
            } catch (headErr) {
                console.warn(`[Transform] ⚠ Could not verify file:`, headErr.message);
            }

            // Update to new PDF
            console.log(`[Transform] 🔄 Updating to new PDF...`);
            onUpdateFileUrl(newFileUrl);

            // Small delay to ensure previous renders are cancelled
            setTimeout(() => {
                console.log(`[Transform] 🔄 Triggering PDF reload...`);
                setFileVersion(v => v + 1);
            }, 100);

            console.log(`[Transform] ✓ Transform flow complete!`);
        } catch (error) {
            console.error('[Transform] ❌ Unexpected error:', error);
            alert('An error occurred while transforming the PDF.');
        } finally {
            setIsTransforming(false);
        }
    };

    if (isLoading) {
        return (
            <div className="w-full h-[calc(100vh-80px)] flex flex-col items-center justify-center bg-slate-50">
                <Loader2 className="w-12 h-12 text-blue-500 animate-spin mb-4" />
                <p className="text-slate-600 font-medium">Analyzing document structure...</p>
                <p className="text-slate-400 text-sm">Preparing interactive text layers</p>
            </div>
        );
    }

    return (
        <div className="w-full h-[calc(100vh-80px)] flex flex-col overflow-hidden bg-slate-50">
            {/* Action Bar */}
            <div className="bg-white border-b border-slate-200 px-6 py-3 flex items-center justify-between shrink-0 z-30">
                {/* Left: Back + Title */}
                <div className="flex items-center gap-3">
                    <button
                        onClick={() => {
                            const hasChanges = pagesData.some(p => p.items.some(i => i.hasChanged));
                            if (hasChanges && !window.confirm("You have unsaved changes. Discard them?")) return;
                            window.dispatchEvent(new CustomEvent('nav-to-upload'));
                        }}
                        className="inline-flex items-center gap-1 text-slate-400 hover:text-slate-700 transition-colors text-xs font-semibold"
                        title="Back to Home"
                    >
                        <ArrowRight className="w-3.5 h-3.5 rotate-180" />
                        Back
                    </button>
                    <div className="h-5 w-px bg-slate-200" />
                    <h2 className="text-sm font-bold text-slate-800">Statement Editor</h2>
                </div>

                {/* Right: View Toggle + Download */}
                <div className="flex items-center gap-3">
                    <div className="flex items-center bg-slate-100 rounded-lg p-0.5 border border-slate-200">
                        <button
                            onClick={() => setViewMode('pdf')}
                            className={`px-3 py-1.5 rounded-md text-xs font-semibold transition-all flex items-center gap-1.5 ${viewMode === 'pdf'
                                ? 'bg-white text-slate-800 shadow-sm'
                                : 'text-slate-400 hover:text-slate-600'
                                }`}
                        >
                            <Eye className="w-3.5 h-3.5" /> Preview
                        </button>
                        <button
                            onClick={() => setViewMode('table')}
                            className={`px-3 py-1.5 rounded-md text-xs font-semibold transition-all flex items-center gap-1.5 ${viewMode === 'table'
                                ? 'bg-white text-slate-800 shadow-sm'
                                : 'text-slate-400 hover:text-slate-600'
                                }`}
                        >
                            <List className="w-3.5 h-3.5" /> Edit Mode
                        </button>
                    </div>

                    <button
                        onClick={handleDownload}
                        className="inline-flex items-center gap-1.5 bg-green-500 hover:bg-green-600 active:scale-[0.97] text-white text-xs font-bold px-4 py-2 rounded-lg shadow-sm transition-all"
                    >
                        <FileDown className="w-3.5 h-3.5" /> Download
                    </button>


                </div>
            </div>

            <div className="flex-1 overflow-auto p-6 md:p-12 flex flex-col items-center gap-8 custom-scrollbar scroll-smooth bg-slate-50/50" ref={containerRef}>
                {viewMode === 'pdf' ? (
                    <div className="relative w-full flex flex-col items-center gap-8">
                        <AnimatePresence>
                            {isTransforming && (
                                <motion.div
                                    initial={{ opacity: 0 }}
                                    animate={{ opacity: 1 }}
                                    exit={{ opacity: 0 }}
                                    className="fixed inset-0 z-[100] bg-slate-900/10 backdrop-blur-[2px] flex items-center justify-center"
                                >
                                    <motion.div
                                        initial={{ scale: 0.9, opacity: 0 }}
                                        animate={{ scale: 1, opacity: 1 }}
                                        className="bg-white p-8 rounded-2xl shadow-2xl flex flex-col items-center gap-4 border border-slate-100 max-w-sm w-full mx-4"
                                    >
                                        <div className="relative">
                                            <div className="w-16 h-16 rounded-full border-4 border-purple-100 border-t-purple-600 animate-spin" />
                                            <Wand2 className="w-6 h-6 text-purple-600 absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2" />
                                        </div>
                                        <div className="text-center">
                                            <h3 className="text-lg font-bold text-slate-900">Transforming PDF</h3>
                                            <p className="text-sm text-slate-500 mt-1">Applying precision edits to your financial statement...</p>
                                        </div>
                                    </motion.div>
                                </motion.div>
                            )}
                        </AnimatePresence>

                        {pagesData.map((pageData) => (
                            <PageItem
                                key={`${pageData.pageIndex}-${fileUrl}`}
                                pdf={pdf}
                                pageData={pageData}
                                scale={scale}
                                readOnly={true}
                            />
                        ))}
                    </div>
                ) : (
                    <div className="w-full max-w-6xl animate-in">
                        <TransactionTable
                            transactions={internalTransactions}
                            openingBalance={initialBalances?.opening}
                            closingBalance={initialBalances?.closing}
                            fileUrl={fileUrl}
                            onUpdateFileUrl={onUpdateFileUrl}
                            onTransform={handleTransformWithPrecision}
                            onTransactionsChange={handleTableUpdate}
                            isTransforming={isTransforming}
                        />
                    </div>
                )}
            </div>
        </div>
    );
}

function PageItem({ pdf, pageData, scale, onTextChange, readOnly = false }) {
    const canvasRef = useRef(null);
    const [scaledViewport, setScaledViewport] = useState(null);
    const renderTaskRef = useRef(null);
    const isMountedRef = useRef(true);

    useEffect(() => {
        isMountedRef.current = true;
        return () => {
            isMountedRef.current = false;
        };
    }, []);

    useEffect(() => {
        // Cancel previous render task before starting new one
        if (renderTaskRef.current) {
            try {
                renderTaskRef.current.cancel();
            } catch (e) {
                // Ignore cancellation errors
            }
            renderTaskRef.current = null;
        }

        let isLatestRender = true;

        const renderPage = async () => {
            if (!pdf || !canvasRef.current || !isMountedRef.current || !isLatestRender) return;

            try {
                const page = await pdf.getPage(pageData.pageIndex);
                if (!isLatestRender || !isMountedRef.current) return;

                const viewport = page.getViewport({ scale });
                
                if (!isMountedRef.current || !isLatestRender) return;
                setScaledViewport(viewport);

                const canvas = canvasRef.current;
                if (!canvas || !isMountedRef.current || !isLatestRender) return;

                const context = canvas.getContext('2d', { alpha: false });
                canvas.height = viewport.height;
                canvas.width = viewport.width;

                // Clear canvas before rendering
                context.clearRect(0, 0, canvas.width, canvas.height);
                context.fillStyle = '#ffffff';
                context.fillRect(0, 0, canvas.width, canvas.height);

                if (!isLatestRender || !isMountedRef.current) return;

                try {
                    renderTaskRef.current = page.render({
                        canvasContext: context,
                        viewport: viewport
                    });

                    await renderTaskRef.current.promise;
                } finally {
                    if (isLatestRender) {
                        renderTaskRef.current = null;
                    }
                }
            } catch (error) {
                if (error.name === 'RenderingCancelledException' || !isLatestRender) {
                    return;
                }
                console.warn(`[PDF Render] Page ${pageData.pageIndex} warning:`, error.message);
            }
        };

        renderPage();

        return () => {
            isLatestRender = false;
            if (renderTaskRef.current) {
                try {
                    renderTaskRef.current.cancel();
                } catch (e) {
                    // Ignore
                }
                renderTaskRef.current = null;
            }
        };
    }, [pdf, pageData.pageIndex, scale]);

    return (
        <div
            className="relative bg-white shadow-2xl rounded-sm ring-1 ring-slate-200"
            style={{
                width: pageData.width * scale,
                height: pageData.height * scale
            }}
        >
            <canvas ref={canvasRef} className="block w-full h-full" />

            {/* Text Overlay Layer - only in edit mode */}
            {!readOnly && (
                <div
                    className="absolute inset-0 z-30 pointer-events-none"
                    style={{ width: '100%', height: '100%' }}
                >
                    {scaledViewport && pageData.items.map((item) => (
                        <EditableText
                            key={item.id}
                            item={item}
                            scale={scale}
                            viewport={scaledViewport}
                            onUpdate={(newText) => onTextChange(pageData.pageIndex, item.id, newText)}
                        />
                    ))}
                </div>
            )}
        </div>
    );
}

function EditableText({ item, scale, viewport, onUpdate }) {
    const [isHovered, setIsHovered] = useState(false);
    const [isEditing, setIsEditing] = useState(false);
    const [tempValue, setTempValue] = useState(item.text);

    // Convert PDF coordinates (x, y) to viewport/canvas coordinates
    // convertToViewportPoint takes [x, y] and returns [x_pixel, y_pixel]
    const [x, y] = viewport.convertToViewportPoint(item.x, item.y);

    // PDF baseline handling: y in viewport is the baseline. 
    // We adjust the box to sit around the text correctly.
    const effectiveHeight = (item.height || item.fontSize || 12) * scale;
    const effectiveWidth = (item.width || 10) * scale;

    const handleBlur = () => {
        setIsEditing(false);
        if (tempValue !== item.text) {
            onUpdate(tempValue);
        }
    };

    return (
        <div
            className={`absolute pointer-events-auto transition-all cursor-text flex items-center group overflow-visible ${isEditing
                ? 'bg-white shadow-[0_0_0_3px_#3b82f6,0_10px_30px_rgba(0,0,0,0.2)] z-[100] rounded-sm'
                : item.hasChanged
                    ? 'bg-emerald-500/30 ring-2 ring-emerald-500 z-10'
                    : isHovered
                        ? 'bg-blue-500/40 ring-2 ring-blue-500 z-10'
                        : 'bg-blue-500/10 ring-1 ring-blue-500/20' // VERY VISIBLE HINT
                }`}
            style={{
                top: y - effectiveHeight,
                left: x,
                width: effectiveWidth + 2,
                height: effectiveHeight + 6,
                fontSize: item.fontSize * scale,
            }}
            onMouseEnter={() => setIsHovered(true)}
            onMouseLeave={() => setIsHovered(false)}
            onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setIsEditing(true);
            }}
        >
            {isEditing ? (
                <input
                    autoFocus
                    className="w-full bg-white border-none outline-none p-0 px-2 m-0 leading-none h-full text-slate-900 selection:bg-blue-200 font-sans font-medium"
                    value={tempValue}
                    onChange={(e) => setTempValue(e.target.value)}
                    onBlur={handleBlur}
                    onKeyDown={(e) => {
                        if (e.key === 'Enter') handleBlur();
                        if (e.key === 'Escape') {
                            setTempValue(item.text);
                            setIsEditing(false);
                        }
                    }}
                    style={{
                        fontSize: 'inherit',
                        lineHeight: '1'
                    }}
                />
            ) : (
                <div
                    className="w-full h-full flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                >
                    <Type className="w-3 h-3 text-blue-600 drop-shadow-sm" />
                </div>
            )}

            <div className="absolute -top-5 left-0 opacity-0 group-hover:opacity-100 transition-opacity bg-blue-600 text-[9px] text-white px-1.5 py-0.5 rounded shadow-sm flex items-center gap-1 z-[110] pointer-events-none whitespace-nowrap">
                <Search className="w-2.5 h-2.5" />
                <span>Edit text</span>
            </div>
        </div>
    );
}

export default InPdfEditor;
