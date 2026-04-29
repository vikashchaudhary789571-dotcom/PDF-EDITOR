const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { PDFDocument, rgb, StandardFonts, PDFName, PDFArray } = require('pdf-lib');
const qpdf = require('node-qpdf2');
// pdf-parse v2.x exports PDFParse class
const pdfParseModule = require('pdf-parse');
const PDFParse = pdfParseModule.PDFParse || pdfParseModule;

/**
 * UNIVERSAL BANK STATEMENT PARSER
 * Uses advanced heuristics to parse any bank statement format
 * Works with coordinates, patterns, and intelligent column detection
 */
function universalStatementParser(text, lines) {
    console.log('[UNIVERSAL_PARSER] Starting advanced parsing...');
    
    const transactions = [];
    
    // Enhanced date patterns covering all major formats
    const datePatterns = [
        { regex: /\b(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{4})\b/, format: 'dd/mm/yyyy' },
        { regex: /\b(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2})\b/, format: 'dd/mm/yy' },
        { regex: /\b(\d{1,2}\.\d{1,2}\.\d{4})\b/, format: 'dd.mm.yyyy' },
        { regex: /\b(\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{4})\b/i, format: 'dd Mmm yyyy' },
        { regex: /\b(\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{2})\b/i, format: 'dd Mmm yy' },
        { regex: /\b((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{1,2},?\s+\d{4})\b/i, format: 'Mmm dd, yyyy' },
        { regex: /\b(\d{4}[\/\-]\d{1,2}[\/\-]\d{1,2})\b/, format: 'yyyy/mm/dd' },
    ];
    
    // Keywords to skip (headers, footers, summaries)
    const skipKeywords = [
        'opening balance', 'closing balance', 'statement period', 'account number',
        'customer id', 'page', 'total', 'summary', 'brought forward', 'carried forward',
        'ifsc', 'branch', 'address', 'phone', 'email', 'date', 'particulars', 'description',
        'debit', 'credit', 'balance', 'withdrawal', 'deposit', 'cheque', 'ref no', 'value date'
    ];
    
    // Helper: Check if line is a header/footer
    const isSkippableLine = (line) => {
        const lower = line.toLowerCase();
        // Skip if contains skip keywords but no valid amounts
        if (skipKeywords.some(kw => lower.includes(kw))) {
            const amounts = line.match(/[\d,]+\.\d{2}/g);
            if (!amounts || amounts.length < 2) return true;
        }
        // Skip very short lines
        if (line.trim().length < 10) return true;
        return false;
    };
    
    // Helper: Extract all valid amounts from a line
    const extractAmounts = (line) => {
        const matches = [...line.matchAll(/[\d,]+\.\d{2}/g)];
        return matches
            .map(m => parseFloat(m[0].replace(/,/g, '')))
            .filter(n => n > 0 && n < 1000000000); // Reasonable range
    };
    
    // Helper: Detect debit/credit from indicators
    const detectTransactionType = (line, amount, prevBalance, currentBalance) => {
        const lower = line.toLowerCase();
        
        // Explicit indicators
        if (/\b(cr|credit|deposit|paid in|received)\b/i.test(line)) return { credit: amount, debit: 0 };
        if (/\b(dr|debit|withdrawal|paid out|payment)\b/i.test(line)) return { debit: amount, credit: 0 };
        
        // Balance-based detection
        if (prevBalance !== null && currentBalance !== null) {
            if (currentBalance > prevBalance) return { credit: amount, debit: 0 };
            if (currentBalance < prevBalance) return { debit: amount, credit: 0 };
        }
        
        // Default: assume credit
        return { credit: amount, debit: 0 };
    };
    
    // Helper: Extract description (text between date and first amount)
    const extractDescription = (line, dateMatch) => {
        const dateEnd = line.indexOf(dateMatch) + dateMatch.length;
        const firstAmountIdx = line.search(/[\d,]+\.\d{2}/);
        
        if (firstAmountIdx > dateEnd) {
            let desc = line.substring(dateEnd, firstAmountIdx).trim();
            // Clean up
            desc = desc.replace(/\s+/g, ' ')
                      .replace(/^(CR|DR|\.|\-|\s|\/)+/i, '')
                      .replace(/(CR|DR)$/i, '')
                      .trim();
            return desc.substring(0, 100) || 'Transaction';
        }
        
        return 'Transaction';
    };
    
    // Main parsing loop
    let prevBalance = null;
    
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        
        if (isSkippableLine(line)) continue;
        
        // Try to match any date pattern
        let dateMatch = null;
        let matchedPattern = null;
        
        for (const pattern of datePatterns) {
            const match = line.match(pattern.regex);
            if (match) {
                dateMatch = match[1];
                matchedPattern = pattern.format;
                break;
            }
        }
        
        if (!dateMatch) continue;
        
        // Extract amounts
        const amounts = extractAmounts(line);
        
        if (amounts.length < 2) {
            // Try multiline: collect next 2-3 lines
            let combinedLine = line;
            for (let j = 1; j <= 3 && (i + j) < lines.length; j++) {
                const nextLine = lines[i + j].trim();
                // Stop if next line has a date
                if (datePatterns.some(p => p.regex.test(nextLine))) break;
                combinedLine += ' ' + nextLine;
            }
            
            const combinedAmounts = extractAmounts(combinedLine);
            if (combinedAmounts.length >= 2) {
                amounts.push(...combinedAmounts);
            }
        }
        
        if (amounts.length < 2) continue;
        
        // Parse transaction
        const balance = amounts[amounts.length - 1];
        let debit = 0, credit = 0;
        
        if (amounts.length >= 3) {
            // Three amounts: debit, credit, balance OR amount, amount, balance
            const amt1 = amounts[amounts.length - 3];
            const amt2 = amounts[amounts.length - 2];
            
            // Check indicators
            if (/\bCR\b/i.test(line)) {
                credit = amt1;
                debit = amt2;
            } else if (/\bDR\b/i.test(line)) {
                debit = amt1;
                credit = amt2;
            } else {
                // Standard format: debit, credit, balance
                debit = amt1;
                credit = amt2;
            }
        } else if (amounts.length === 2) {
            // Two amounts: transaction amount + balance
            const amount = amounts[0];
            const type = detectTransactionType(line, amount, prevBalance, balance);
            debit = type.debit;
            credit = type.credit;
        }
        
        const description = extractDescription(line, dateMatch);
        
        // Add transaction
        transactions.push({
            id: Math.random().toString(36).substr(2, 9),
            date: dateMatch,
            valueDate: dateMatch,
            description: description,
            reference: '',
            debit: debit,
            credit: credit,
            balance: balance
        });
        
        prevBalance = balance;
        
        // Debug first few
        if (transactions.length <= 3) {
            console.log(`[UNIVERSAL_PARSER] Transaction ${transactions.length}:`, {
                date: dateMatch,
                format: matchedPattern,
                debit, credit, balance,
                desc: description.substring(0, 40)
            });
        }
    }
    
    console.log(`[UNIVERSAL_PARSER] Extracted ${transactions.length} transactions`);
    return transactions;
}

/**
 * Decode a pdf-lib stream object's raw bytes.
 * Handles FlateDecode (zlib) compression which is used by most bank PDFs.
 */
function decodeStreamObj(streamObj) {
    if (!streamObj || !streamObj.contents) return null;
    const rawBuf = Buffer.from(streamObj.contents);
    try {
        const filterEntry = streamObj.dict ? streamObj.dict.get(PDFName.of('Filter')) : null;
        if (filterEntry && String(filterEntry).includes('FlateDecode')) {
            try { return zlib.inflateSync(rawBuf); } catch (_) {
                try { return zlib.inflateRawSync(rawBuf); } catch (__) { }
            }
        }
    } catch (_) { }
    return rawBuf;
}

/**
 * Extract the dominant text fill color from a PDF page's content stream.
 * Parses rg (RGB), g (grayscale), k (CMYK), and sc/scn operators.
 */
function extractPageTextColor(pdfDoc, page) {
    try {
        const contents = page.node.get(PDFName.of('Contents'));
        if (!contents) return null;

        const refs = contents instanceof PDFArray ? contents.asArray() : [contents];
        const context = pdfDoc.context;
        let streamData = '';

        for (const ref of refs) {
            const streamObj = context.lookup(ref);
            const decoded = decodeStreamObj(streamObj);
            if (decoded) streamData += decoded.toString('latin1');
        }

        if (!streamData) return null;

        const rgbCounts = {};
        const grayCounts = {};
        const addRgb = (r, g, b) => {
            if (r > 0.95 && g > 0.95 && b > 0.95) return; // skip white
            const k = `${r.toFixed(4)},${g.toFixed(4)},${b.toFixed(4)}`;
            rgbCounts[k] = (rgbCounts[k] || 0) + 1;
        };
        const addGray = (v) => {
            if (v > 0.95) return; // skip white
            const k = `${v.toFixed(4)},${v.toFixed(4)},${v.toFixed(4)}`;
            grayCounts[k] = (grayCounts[k] || 0) + 1;
        };

        // rg — RGB fill: "R G B rg"
        for (const m of streamData.matchAll(/(-?[0-9.]+)\s+(-?[0-9.]+)\s+(-?[0-9.]+)\s+rg(?=[^a-zA-Z]|$)/g))
            addRgb(+m[1], +m[2], +m[3]);

        // g — grayscale fill: "V g" — kept SEPARATE to avoid table-border noise polluting RGB text colors
        for (const m of streamData.matchAll(/(?<![a-zA-Z])([0-9.]+)\s+g(?=[^a-zA-Z0-9]|$)/g))
            addGray(+m[1]);

        // k — CMYK fill
        for (const m of streamData.matchAll(/(-?[0-9.]+)\s+(-?[0-9.]+)\s+(-?[0-9.]+)\s+(-?[0-9.]+)\s+k(?=[^a-zA-Z]|$)/g)) {
            const c = +m[1], cy = +m[2], y = +m[3], bk = +m[4];
            addRgb((1 - c) * (1 - bk), (1 - cy) * (1 - bk), (1 - y) * (1 - bk));
        }

        // Pick winner: prefer most-frequent RGB color (ignores grayscale table-border noise).
        // Fall back to grayscale only when no RGB colors exist.
        const counts = Object.keys(rgbCounts).length > 0 ? rgbCounts : grayCounts;
        let bestKey = null, bestCount = 0;
        for (const [k, n] of Object.entries(counts)) {
            if (n > bestCount) { bestCount = n; bestKey = k; }
        }

        if (bestKey) {
            const [r, g, b] = bestKey.split(',').map(Number);
            console.log(`[editDirect] Backend extracted color: rgb(${r.toFixed(4)}, ${g.toFixed(4)}, ${b.toFixed(4)}) [${bestCount} uses]`);
            return { r, g, b };
        }
    } catch (e) {
        console.warn('[editDirect] Backend color extraction error:', e.message);
    }
    return null;
}

exports.uploadStatement = async (req, res) => {
    console.log('[uploadStatement] FUNCTION CALLED - checking req.file:', !!req.file);
    
    if (!req.file) {
        console.log('[uploadStatement] ERROR: No file in req.file');
        return res.status(400).json({ success: false, message: 'No file uploaded' });
    }

    try {
        const filePath = path.join(__dirname, '../uploads', req.file.filename);
        console.log('[uploadStatement] File path:', filePath);
        
        let dataBuffer = fs.readFileSync(filePath);
        const password = req.body.password;

        console.log('[uploadStatement] Starting PDF processing, password provided:', !!password);
        console.log('[uploadStatement] File size:', dataBuffer.length, 'bytes');

        // NOTE: If a password is provided, we validate it first using pdf-parse.
        // We do NOT decrypt the file on disk — the frontend pdfjs viewer handles
        // the encrypted file natively using the password passed from props.
        // This avoids dependency on qpdf binary or pdf-lib's broken decryption.
        if (password) {
            try {
                const testParser = new PDFParse({ data: dataBuffer, password: password });
                await testParser.getText(); // Will throw PasswordException if wrong password
                console.log('[uploadStatement] Password validated successfully via pdf-parse');
            } catch (validErr) {
                const msg = validErr.message || '';
                if (msg.toLowerCase().includes('password') || msg.toLowerCase().includes('encrypt')) {
                    console.error('[uploadStatement] Wrong password:', msg);
                    return res.status(400).json({
                        success: false,
                        message: 'Incorrect password or failed to decrypt PDF.'
                    });
                }
                // Other parse error — not a password issue, continue anyway
                console.warn('[uploadStatement] Non-password parse error during validation, continuing:', msg);
            }
        }

        // Now parse the (decrypted) PDF
        let parser;
        let text = '';
        let tableResult = null;

        try {
            console.log('[uploadStatement] Creating PDFParse with buffer size:', dataBuffer.length);
            
            // The dataBuffer is now ready; pass password if provided so pdf-parse can decrypt
            const parseOptions = { data: dataBuffer, password: password || '' };
            
            parser = new PDFParse(parseOptions);
            const textResult = await parser.getText();
            text = textResult.text || '';
            console.log(`[uploadStatement] PDFParse getText successful, text length: ${text.length}`);
            console.log(`[uploadStatement] Text sample (first 500 chars): ${text.substring(0, 500)}`);
            console.log(`[uploadStatement] Text sample (last 500 chars): ${text.substring(text.length - 500)}`);
            
            // CRITICAL DEBUG: Log all extracted amounts before filtering
            const allAmountsInText = [...text.matchAll(/[\d,]+\.\d{2}/g)].map(m => m[0]);
            console.log(`[CRITICAL_DEBUG] All amounts in raw text (${allAmountsInText.length} found):`);
            console.log(allAmountsInText.slice(0, 20).join(', '));
        } catch (parseErr) {
            console.error('[uploadStatement] PDFParse error:', parseErr);
            const errMsg = parseErr.message || '';
            // PasswordException means either no password given or wrong one
            if (errMsg.toLowerCase().includes('password') || errMsg.toLowerCase().includes('encrypt') || parseErr.name === 'PasswordException') {
                return res.status(400).json({
                    success: false,
                    message: 'This PDF is password-protected. Please enter the password to process it.'
                });
            }
            return res.status(500).json({
                success: false,
                message: 'Failed to parse PDF: ' + errMsg
            });
        }

        // --- SEARCHING BALANCES ---
        // Heuristic: Match 'Opening/Closing Balance' followed by anything until we find a number
        const obMatch = text.match(/Opening Balance[^\d]*?([\d,]+\.\d{2})/i);
        const cbMatch = text.match(/Closing Balance[^\d]*?([\d,]+\.\d{2})/i);

        let openingBalance = obMatch ? parseFloat(obMatch[1].replace(/,/g, '')) : null;
        let closingBalance = cbMatch ? parseFloat(cbMatch[1].replace(/,/g, '')) : null;

        // --- EXTRACTING TRANSACTIONS FROM TEXT ---
        // pdf-parse v2.x doesn't have getTable() - parse from text instead
        const transactions = [];

        // Detect bank type from text
        const isSBI = text.toLowerCase().includes('state bank of india') || text.toLowerCase().includes('sbi');
        const isAU = text.toLowerCase().includes('au small finance bank') || text.toLowerCase().includes('au bank');

        console.log(`[BANK_DETECT] SBI: ${isSBI}, AU: ${isAU}`);

        // Parse transactions from text lines
        // Support multiple date formats: dd/mm/yy, dd-mm-yyyy, dd.mm.yyyy, dd Mmm yy, etc.
        const lines = text.split('\n').filter(line => line.trim());

        // ENHANCED: More comprehensive date patterns covering all major banks
        const datePatterns = [
            /(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{4})/,     // dd/mm/yyyy (SBI, HDFC, ICICI)
            /(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2})/,     // dd/mm/yy
            /(\d{1,2}\.\d{1,2}\.\d{4})/,            // dd.mm.yyyy
            /(\d{1,2}\s+[A-Za-z]{3}\s+\d{4})/,      // 26 Apr 2024 (AU Bank)
            /(\d{1,2}\s+[A-Za-z]{3,}\s+\d{2,4})/,   // 26 April 2024
            /(\d{4}[\/\-]\d{1,2}[\/\-]\d{1,2})/,    // yyyy/mm/dd
            /(\d{1,2}\s+[A-Za-z]{3}\s+\d{2})/,      // 26 Apr 24
            /([A-Za-z]{3}\s+\d{1,2},?\s+\d{4})/,    // Apr 26, 2024
        ];
        
        const amountPattern = /[\d,]+\.\d{2}/g;

        // PRIORITY: If SBI bank detected, try SBI parser FIRST
        if (isSBI) {
            console.log('[uploadStatement] SBI Bank detected - trying SBI-specific parser FIRST...');

            const sbiDatePattern = /\b(\d{1,2}\/\d{1,2}\/\d{4})\b/;

            for (let i = 0; i < lines.length; i++) {
                const line = lines[i].trim();

                // Check for SBI date format: "01/01/2024"
                const dateMatch = line.match(sbiDatePattern);

                if (dateMatch) {
                    // Skip header lines
                    const lineLower = line.toLowerCase();
                    if (lineLower.includes('opening balance') ||
                        lineLower.includes('closing balance') ||
                        lineLower.includes('statement period') ||
                        lineLower.includes('account number') ||
                        lineLower.includes('customer id') ||
                        lineLower.includes('branch') ||
                        lineLower.includes('ifsc') ||
                        lineLower.includes('page') ||
                        lineLower.includes('txn date') ||
                        lineLower.includes('value date') ||
                        lineLower.includes('description') ||
                        lineLower.includes('cheque') ||
                        lineLower.includes('ref no')) {
                        continue;
                    }

                    // SBI multiline support: collect next 2-3 lines
                    let combinedLine = line;
                    let lookAhead = i + 1;
                    
                    while (lookAhead < Math.min(i + 4, lines.length)) {
                        const nextLine = lines[lookAhead].trim();
                        // Stop if we hit another date
                        if (sbiDatePattern.test(nextLine)) break;
                        // Stop if we hit page footer
                        if (nextLine.toLowerCase().includes('page') || 
                            nextLine.toLowerCase().includes('continued') ||
                            nextLine.length < 5) break;
                        combinedLine += ' ' + nextLine;
                        lookAhead++;
                    }

                    // Extract amounts from combined line
                    const allAmountMatches = [...combinedLine.matchAll(/[\d,]+\.\d{2}/g)];
                    const amounts = [];

                    for (const match of allAmountMatches) {
                        const num = parseFloat(match[0].replace(/,/g, ''));
                        if (num > 0 && num < 1000000000) {
                            amounts.push(num);
                        }
                    }

                    if (amounts.length >= 2) {
                        if (transactions.length < 5) {
                            console.log(`[SBI_DEBUG] Line ${i}: "${combinedLine.substring(0, 100)}..."`);
                            console.log(`[SBI_DEBUG] Amounts found: ${amounts.join(', ')}`);
                        }

                        // SBI format: typically [debit] [credit] [balance] OR [amount] [balance]
                        const balance = amounts[amounts.length - 1];
                        let debit = 0, credit = 0;

                        // Check for CR/DR indicators
                        const hasCR = /\b(CR|Cr|cr)\b/.test(combinedLine);
                        const hasDR = /\b(DR|Dr|dr)\b/.test(combinedLine);

                        if (amounts.length === 2) {
                            // Format: amount, balance
                            const amount = amounts[0];
                            
                            // ENHANCED: Check for transaction type keywords
                            const isWithdrawal = /\b(ATM WDL|WITHDRAWAL|WDL|CASH WITHDRAWAL|ATM CASH|DEBIT|DR)\b/i.test(combinedLine);
                            const isDeposit = /\b(DEPOSIT|DEP BY|CREDIT|CR|NEFT CR|IMPS CR|UPI CR|RTGS CR)\b/i.test(combinedLine);
                            
                            if (isWithdrawal) {
                                debit = amount;
                                credit = 0;
                            } else if (isDeposit) {
                                credit = amount;
                                debit = 0;
                            } else {
                                // Check for CR/DR indicators
                                const hasCR = /\b(CR|Cr|cr)\b/.test(combinedLine);
                                const hasDR = /\b(DR|Dr|dr)\b/.test(combinedLine);
                                
                                if (hasCR) {
                                    credit = amount;
                                } else if (hasDR) {
                                    debit = amount;
                                } else {
                                    // Determine from balance change
                                    let prevBalance = null;
                                    if (transactions.length > 0) {
                                        prevBalance = parseFloat(transactions[transactions.length - 1].balance);
                                    } else if (openingBalance !== null) {
                                        prevBalance = parseFloat(openingBalance);
                                    }

                                    if (prevBalance !== null) {
                                        const diff = balance - prevBalance;
                                        if (Math.abs(diff - amount) < 1) {
                                            credit = amount;
                                        } else if (Math.abs(diff + amount) < 1) {
                                            debit = amount;
                                        } else {
                                            if (balance > prevBalance) {
                                                credit = amount;
                                            } else {
                                                debit = amount;
                                            }
                                        }
                                    } else {
                                        credit = amount;
                                    }
                                }
                            }
                        } else if (amounts.length >= 3) {
                            // Format: debit, credit, balance
                            const amt1 = amounts[amounts.length - 3];
                            const amt2 = amounts[amounts.length - 2];
                            
                            if (hasCR) {
                                credit = amt1;
                                debit = amt2;
                            } else if (hasDR) {
                                debit = amt1;
                                credit = amt2;
                            } else {
                                debit = amt1;
                                credit = amt2;
                            }
                        }

                        // Extract description
                        const dateEnd = combinedLine.indexOf(dateMatch[0]) + dateMatch[0].length;
                        const firstAmountIdx = combinedLine.search(/[\d,]+\.\d{2}/);
                        let description = '';

                        if (firstAmountIdx > dateEnd) {
                            description = combinedLine.substring(dateEnd, firstAmountIdx).trim();
                        }

                        description = description
                            .replace(/\s+/g, ' ')
                            .replace(/^(CR|DR|\.|\-|\s)+/i, '')
                            .substring(0, 100);

                        if (description.length > 2 || amounts.length >= 2) {
                            transactions.push({
                                id: Math.random().toString(36).substr(2, 9),
                                date: dateMatch[0],
                                valueDate: dateMatch[0],
                                description: description || 'Transaction',
                                reference: '',
                                debit: debit,
                                credit: credit,
                                balance: balance
                            });

                            if (transactions.length <= 5) {
                                console.log(`[SBI_DEBUG] Added: Debit=${debit}, Credit=${credit}, Balance=${balance}, Desc="${description.substring(0, 30)}"`);
                            }
                        }
                    }
                }
            }
            
            console.log(`[uploadStatement] SBI parser extracted ${transactions.length} transactions`);
        }

        // Generic parser for non-SBI banks or as fallback
        if (!isSBI || transactions.length === 0) {
            console.log('[uploadStatement] Running generic parser...');
            
            for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            
            // Try all date patterns
            let dateMatch = null;
            for (const pattern of datePatterns) {
                dateMatch = line.match(pattern);
                if (dateMatch) break;
            }

            if (dateMatch) {
                // Extract all amounts from this line - but filter out reference numbers
                const allAmountMatches = [...line.matchAll(amountPattern)];
                const amounts = [];
                
                for (const match of allAmountMatches) {
                    const num = parseFloat(match[0].replace(/,/g, ''));
                    // Filter: amounts should be between 0 and 100 crore (reasonable transaction range)
                    if (num > 0 && num < 1000000000) {
                        amounts.push(num);
                    }
                }

                // DEBUG: Log each date line and extracted amounts
                if (amounts.length >= 2 && transactions.length < 5) {
                    console.log(`[DEBUG] Line ${i}: "${line.substring(0, 80)}..."`);
                    console.log(`[DEBUG]   Date match: ${dateMatch[0]}`);
                    console.log(`[DEBUG]   Raw amounts found: ${allAmountMatches.map(m => m[0]).join(', ')}`);
                    console.log(`[DEBUG]   Filtered amounts: ${amounts.join(', ')}`);
                }

                if (amounts.length >= 2) {
                    // Last amount is typically balance
                    const balance = amounts[amounts.length - 1];
                    
                    // For bank statements, typically we have: [debit] [credit] [balance] or [amount] [balance]
                    let debit = 0, credit = 0;
                    
                    const lineLower = line.toLowerCase();
                    // Check for CR/DR indicators in description (NEFT CR-, NEFT DR-, etc.) using word boundaries
                    const hasCR = /\b(cr|credit|cr\-)\b/.test(lineLower);
                    const hasDR = /\b(dr|debit|dr\-)\b/.test(lineLower);
                    
                    // DEBUG: Log CR/DR detection
                    if (transactions.length < 5) {
                        console.log(`[DEBUG]   hasCR: ${hasCR}, hasDR: ${hasDR}, amounts.length: ${amounts.length}`);
                    }
                    
                    if (amounts.length >= 3) {
                        // Format: debit, credit, balance
                        // Check CR/DR indicators to determine which is which
                        if (hasCR && !hasDR) {
                            // Credit transaction - amount before balance is the credit
                            credit = amounts[amounts.length - 3];
                            debit = amounts[amounts.length - 2];
                        } else if (hasDR && !hasCR) {
                            // Debit transaction
                            debit = amounts[amounts.length - 3];
                            credit = amounts[amounts.length - 2];
                        } else {
                            // Default: assume debit, credit, balance order
                            debit = amounts[amounts.length - 3];
                            credit = amounts[amounts.length - 2];
                        }
                    } else if (amounts.length === 2) {
                        // Format: amount, balance - need to determine if debit or credit
                        const amount = amounts[0];
                        if (hasCR) {
                            credit = amount;
                        } else if (hasDR) {
                            debit = amount;
                        } else {
                            // Default: check if balance increased or decreased from previous transaction
                            let prevBalance = null;
                            if (transactions.length > 0) {
                                prevBalance = parseFloat(String(transactions[transactions.length - 1].balance).replace(/,/g, ''));
                            } else if (openingBalance !== null) {
                                prevBalance = openingBalance;
                            }
                            
                            if (prevBalance !== null) {
                                // If current balance > prev balance, it's a credit
                                if (balance > prevBalance) {
                                    credit = amount;
                                } else {
                                    debit = amount;
                                }
                            } else {
                                // Ultimate fallback
                                credit = amount;
                            }
                        }
                    }

                    // DEBUG: Log extracted transaction details
                    if (transactions.length < 5) {
                        console.log(`[DEBUG]   Extracted -> Debit: ${debit}, Credit: ${credit}, Balance: ${balance}`);
                    }

                    // Extract description (everything between date and first amount)
                    const dateEnd = line.indexOf(dateMatch[0]) + dateMatch[0].length;
                    const firstAmountIdx = line.search(amountPattern);
                    let description = '';
                    
                    if (firstAmountIdx > dateEnd) {
                        description = line.substring(dateEnd, firstAmountIdx).trim();
                    }

                    // Clean up description - remove common non-description text
                    description = description
                        .replace(/\s+/g, ' ')
                        .replace(/^(\.|\-|\s)+/, '')
                        .substring(0, 100);

                    // Only add if we have a valid description or the line has meaningful content
                    if (description.length > 2 || amounts.length >= 2) {
                        transactions.push({
                            id: Math.random().toString(36).substr(2, 9),
                            date: dateMatch[0],
                            valueDate: dateMatch[0],
                            description: description || 'Transaction',
                            reference: '',
                            debit: debit,
                            credit: credit,
                            balance: balance
                        });
                    }
                }
            }
        }

        console.log(`[uploadStatement] Extracted ${transactions.length} transactions from text`);
        
        // DEBUG: Log first few transactions to verify extraction
        if (transactions.length > 0) {
            console.log('[uploadStatement] First 3 extracted transactions:');
            transactions.slice(0, 3).forEach((t, i) => {
                console.log(`  [${i+1}] Date: ${t.date}, Debit: ${t.debit}, Credit: ${t.credit}, Balance: ${t.balance}`);
                console.log(`      Desc: ${t.description?.substring(0, 50)}`);
            });
        }
        }
        
        // If no transactions found or very few, try universal parser
        if (transactions.length < 3) {
            console.log('[uploadStatement] Standard parsers failed, trying UNIVERSAL PARSER...');
            const universalTransactions = universalStatementParser(text, lines);
            
            if (universalTransactions.length > transactions.length) {
                console.log(`[uploadStatement] Universal parser succeeded! Found ${universalTransactions.length} transactions`);
                transactions.length = 0;
                transactions.push(...universalTransactions);
            }
        }
        
        // If no transactions found or very few, try AU Bank specific parsing
        if (transactions.length === 0 || transactions.length < 3) {
            if (!isSBI && isAU) {
                console.log('[uploadStatement] Trying AU Bank specific parsing...');
                
                // Clear previous transactions
                transactions.length = 0;
                
                // AU Bank format: "01 Aug 2025" date pattern
                const auDatePattern = /(\d{1,2}\s+[A-Za-z]{3}\s+\d{4})/;
                
                // First pass: collect all potential transaction lines
                const potentialTxns = [];
                
                for (let i = 0; i < lines.length; i++) {
                    const line = lines[i].trim();
                    const dateMatch = line.match(auDatePattern);
                    
                    if (dateMatch) {
                        // Skip headers
                        const lineLower = line.toLowerCase();
                        if (lineLower.includes('statement period') || 
                            lineLower.includes('opening balance') || 
                            lineLower.includes('closing balance') ||
                            lineLower.includes('account number') ||
                            lineLower.includes('customer id') ||
                            lineLower.includes('transaction date')) {
                            continue;
                        }
                        
                        // Collect this line and next few lines
                        let combinedText = line;
                        let lookAhead = i + 1;
                        
                        while (lookAhead < Math.min(i + 6, lines.length)) {
                            const nextLine = lines[lookAhead].trim();
                            if (nextLine.match(auDatePattern) || 
                                nextLine.includes('Page') || 
                                nextLine.includes('Reg. office') ||
                                nextLine.includes('AU SMALL')) {
                                break;
                            }
                            combinedText += ' ' + nextLine;
                            lookAhead++;
                        }
                        
                        potentialTxns.push({
                            date: dateMatch[0],
                            text: combinedText,
                            lineIndex: i
                        });
                        
                        i = lookAhead - 1;
                    }
                }
                
                console.log(`[AU_BANK_V2] Found ${potentialTxns.length} potential transactions`);
                
                // Second pass: extract amounts from each transaction
                for (const txn of potentialTxns) {
                    // Extract ALL amounts (with commas like 8,300.00)
                    const amountMatches = [...txn.text.matchAll(/[\d,]+\.\d{2}/g)];
                    const amounts = amountMatches.map(m => ({
                        str: m[0],
                        num: parseFloat(m[0].replace(/,/g, '')),
                        hasComma: m[0].includes(',')
                    }));
                    
                    // Filter: amounts must have comma (AU Bank format) and be reasonable
                    const validAmounts = amounts.filter(a => 
                        a.hasComma && a.num > 0 && a.num < 10000000
                    );
                    
                    if (validAmounts.length >= 2) {
                        // Last amount is always balance
                        const balance = validAmounts[validAmounts.length - 1].num;
                        
                        // For transaction amount, look at the pattern
                        // AU Bank: if only 2 amounts, one is transaction amount, one is balance
                        // If 3 amounts, could be debit, credit, balance
                        let debit = 0, credit = 0;
                        
                        if (validAmounts.length === 2) {
                            // Simple case: amount and balance
                            const amount = validAmounts[0].num;
                            // Determine if debit or credit based on balance change
                            // We'll validate after
                            credit = amount; // Default to credit, will validate
                        } else if (validAmounts.length >= 3) {
                            // Has both debit and credit columns
                            // Check text indicators
                            const textUpper = txn.text.toUpperCase();
                            const hasDR = textUpper.includes(' DR') || textUpper.includes('DEBIT');
                            const hasCR = textUpper.includes(' CR') || textUpper.includes('CREDIT');
                            
                            if (hasDR && !hasCR) {
                                // Debit transaction
                                debit = validAmounts[validAmounts.length - 2].num;
                            } else if (hasCR && !hasDR) {
                                // Credit transaction
                                credit = validAmounts[validAmounts.length - 2].num;
                            } else {
                                // Ambiguous - take the larger amount as transaction
                                const amt1 = validAmounts[validAmounts.length - 3].num;
                                const amt2 = validAmounts[validAmounts.length - 2].num;
                                if (amt1 > 0) credit = amt1; // Default guess
                            }
                        }
                        
                        // Extract description (everything after date, before amounts)
                        let description = txn.text
                            .replace(txn.date, '')
                            .replace(/[\d,]+\.\d{2}/g, ' ')
                            .replace(/\s+/g, ' ')
                            .trim()
                            .substring(0, 100);
                        
                        if (!description || description.length < 3) {
                            description = 'Transaction';
                        }
                        
                        transactions.push({
                            id: Math.random().toString(36).substr(2, 9),
                            date: txn.date,
                            valueDate: txn.date,
                            description: description,
                            reference: '',
                            debit: debit,
                            credit: credit,
                            balance: balance
                        });
                    }
                }
                
                // Third pass: validate and fix using balance continuity
                if (transactions.length > 0 && openingBalance !== null) {
                    let runningBalance = openingBalance;
                    
                    for (let i = 0; i < transactions.length; i++) {
                        const txn = transactions[i];
                        const expectedBalance = runningBalance + txn.credit - txn.debit;
                        const actualBalance = txn.balance;
                        
                        // If mismatch, try to fix
                        if (Math.abs(expectedBalance - actualBalance) > 1) {
                            // Try: was it actually credit instead of debit?
                            const expectedIfCredit = runningBalance + txn.debit; // debit was actually credit
                            const expectedIfDebit = runningBalance - txn.credit; // credit was actually debit
                            
                            if (Math.abs(expectedIfCredit - actualBalance) < 1) {
                                // Swap - it was a credit
                                const temp = txn.debit;
                                txn.debit = 0;
                                txn.credit = temp;
                            } else if (Math.abs(expectedIfDebit - actualBalance) < 1) {
                                // Swap - it was a debit
                                const temp = txn.credit;
                                txn.credit = 0;
                                txn.debit = temp;
                            } else {
                                // Calculate what the transaction amount should have been
                                const neededChange = actualBalance - runningBalance;
                                if (neededChange > 0) {
                                    txn.credit = neededChange;
                                    txn.debit = 0;
                                } else {
                                    txn.debit = Math.abs(neededChange);
                                    txn.credit = 0;
                                }
                            }
                        }
                        
                        // Recalculate running balance
                        runningBalance = runningBalance + txn.credit - txn.debit;
                    }
                }
                
                console.log(`[AU_BANK_V2] Extracted ${transactions.length} transactions`);
                if (transactions.length > 0) {
                    console.log(`[AU_BANK_V2] First 3:`, transactions.slice(0, 3));
                }
            }
        }

        // --- FALLBACKS ---
        // If openingBalance is null, try to deduce it from the first transaction
        if (openingBalance === null && transactions.length > 0) {
            const first = transactions[0];
            openingBalance = (parseFloat(first.balance) || 0) - (parseFloat(first.credit) || 0) + (parseFloat(first.debit) || 0);
        } else if (openingBalance === null) {
            openingBalance = 0;
        }

        if (closingBalance === null && transactions.length > 0) {
            const last = transactions[transactions.length - 1];
            closingBalance = parseFloat(last.balance) || 0;
        } else if (closingBalance === null) {
            closingBalance = 0;
        }

        // pdf-parse v2.x doesn't have destroy method
        if (parser && typeof parser.destroy === 'function') {
            await parser.destroy();
        }

        // CRITICAL DEBUG: Log final extracted data before sending
        console.log(`[CRITICAL_DEBUG] FINAL RESULT: ${transactions.length} transactions`);
        console.log(`[CRITICAL_DEBUG] Opening: ${openingBalance}, Closing: ${closingBalance}`);
        if (transactions.length > 0) {
            console.log(`[CRITICAL_DEBUG] First 3 transactions:`, transactions.slice(0, 3));
        }

        res.status(200).json({
            success: true,
            message: 'File processed. Table extracted.',
            file: {
                filename: req.file.filename,
                originalName: req.file.originalname,
                fileUrl: `https://pdf-editor-ax8j.onrender.com/uploads/${req.file.filename}`,
                password: password || null  // Pass password to frontend for PDF.js
            },
            transactions: transactions,
            openingBalance,
            closingBalance
        });

    } catch (err) {
        console.error('Extraction Error:', err);
        res.status(500).json({
            success: false,
            message: 'Failed to extract data: ' + err.message
        });
    }
};

exports.saveTransactions = (req, res) => {
    const { transactions, filename } = req.body;
    console.log(`Saving ${transactions?.length} transactions for file ${filename}`);
    res.status(200).json({
        success: true,
        message: 'Transactions saved successfully'
    });
};

exports.regeneratePdf = async (req, res) => {
    const { transactions, originalFile } = req.body;

    try {
        const urlParts = originalFile.split('/');
        const originalFilename = urlParts[urlParts.length - 1];
        const originalPath = path.join(__dirname, '../uploads', originalFilename);

        if (!fs.existsSync(originalPath)) throw new Error('Original file missing.');

        const pdfDoc = await PDFDocument.load(fs.readFileSync(originalPath));
        const firstPage = pdfDoc.getPages()[0];
        const { width, height } = firstPage.getSize();

        const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
        const boldFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

        const formatCurrency = (val) => Number(val).toLocaleString(undefined, {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2
        });

        // --- STEP 1: SUMMARY TOTALS (Aligned with labels) ---
        const totals = transactions.reduce((acc, curr) => {
            acc.debit += Number(curr.debit) || 0;
            acc.credit += Number(curr.credit) || 0;
            return acc;
        }, { debit: 0, credit: 0 });

        const openingBalance = Number(transactions[0]?.balance) || 0;
        const closingBalance = Number(transactions[transactions.length - 1]?.balance) || 0;

        const summaryXEnd = 568;
        const summaryYBase = 715; // Raised from 683 to hit labels
        const summarySpacing = 16.5;

        const summaryValues = [
            formatCurrency(openingBalance),
            formatCurrency(totals.credit),
            formatCurrency(totals.debit),
            formatCurrency(closingBalance)
        ];

        summaryValues.forEach((text, i) => {
            const y = summaryYBase - (i * summarySpacing);
            // Both Opening and Closing Balances usually bold in summary section
            const isBold = (i === 0 || i === 3);
            const currentFont = isBold ? boldFont : font;
            const textWidth = currentFont.widthOfTextAtSize(text, 8);

            // Mask to clear old totals and colons
            firstPage.drawRectangle({
                x: 470, y: y - 4, width: 110, height: 14,
                color: rgb(1, 1, 1)
            });
            // Draw aligned colon for all summary items
            firstPage.drawText(':', { x: 478, y, size: 8, font });
            // Draw the actual amount
            firstPage.drawText(text, { x: summaryXEnd - textWidth, y, size: 8, font: currentFont });
        });

        // Number of Transactions line
        const numTransactions = String(transactions.length - 1);
        const numY = summaryYBase - (5 * summarySpacing) - 1.2;
        const numWidth = font.widthOfTextAtSize(numTransactions, 8);
        firstPage.drawRectangle({ x: 485, y: numY - 3, width: 95, height: 13, color: rgb(1, 1, 1) });
        firstPage.drawText(numTransactions, { x: summaryXEnd - numWidth, y: numY, size: 8, font });

        // --- STEP 2: TRANSACTION ROWS (Aligned with Original Table Grid) ---
        const startY = 538; // Raised from 514 to hit original table rows
        const rowHeight = 21.6; // Matches original density

        transactions.forEach((t, i) => {
            const y = startY - (i * rowHeight);
            if (y < 40) return;

            // CLEAN REPLACEMENT: Wipe original row area
            firstPage.drawRectangle({
                x: 40, y: y - 7, width: width - 80, height: 19,
                color: rgb(1, 1, 1)
            });

            const col = { date: 48, vDate: 105, desc: 165, ref: 360 };
            const fontSize = 7.5; // Slightly smaller to fit more columns

            // Transaction Date
            if (t.date) {
                firstPage.drawText(String(t.date), { x: col.date, y, size: fontSize, font });
            }

            // Value Date
            if (t.valueDate) {
                firstPage.drawText(String(t.valueDate), { x: col.vDate, y, size: fontSize, font });
            }

            // Description (Truncate if too long)
            const desc = String(t.description || '').substring(0, 50);
            firstPage.drawText(desc, { x: col.desc, y, size: fontSize, font });

            // Reference No
            if (t.reference) {
                firstPage.drawText(String(t.reference).substring(0, 20), { x: col.ref, y, size: fontSize, font });
            }

            // Amounts (Right Aligned in original columns)
            if (Number(t.debit) > 0) {
                const txt = formatCurrency(t.debit);
                const w = font.widthOfTextAtSize(txt, fontSize);
                firstPage.drawText(txt, { x: 465 - w, y, size: fontSize, font });
            } else {
                // If 0, draw dash as per requirement
                const w = font.widthOfTextAtSize('-', fontSize);
                firstPage.drawText('-', { x: 465 - w, y, size: fontSize, font });
            }

            if (Number(t.credit) > 0) {
                const txt = formatCurrency(t.credit);
                const w = font.widthOfTextAtSize(txt, fontSize);
                firstPage.drawText(txt, { x: 525 - w, y, size: fontSize, font });
            } else {
                // If 0, draw dash as per requirement
                const w = font.widthOfTextAtSize('-', fontSize);
                firstPage.drawText('-', { x: 525 - w, y, size: fontSize, font });
            }

            // Balance (Regular & Right Aligned to match Debit/Credit)
            const balTxt = formatCurrency(t.balance);
            const balW = font.widthOfTextAtSize(balTxt, fontSize);
            firstPage.drawText(balTxt, { x: 585 - balW, y, size: fontSize, font: font });
        });

        const pdfBytes = await pdfDoc.save();
        const fileName = `accuracy_confirmed_${Date.now()}.pdf`;
        const filePath = path.join(__dirname, '../downloads', fileName);
        fs.writeFileSync(filePath, pdfBytes);

        res.status(200).json({
            success: true,
            message: 'All values aligned and replaced.',
            fileUrl: `https://pdf-editor-ax8j.onrender.com/downloads/${fileName}`
        });

    } catch (err) {
        console.error('PDF Precision Issue:', err);
        res.status(500).json({ success: false, message: 'Alignment failed' });
    }
};

const STATEMENTS_FILE = path.join(__dirname, '../statements.json');

const readStatements = () => {
    if (!fs.existsSync(STATEMENTS_FILE)) return [];
    try {
        return JSON.parse(fs.readFileSync(STATEMENTS_FILE, 'utf8'));
    } catch {
        return [];
    }
};

const writeStatements = (data) => {
    fs.writeFileSync(STATEMENTS_FILE, JSON.stringify(data, null, 2), 'utf8');
};

exports.getStatements = (req, res) => {
    const data = readStatements();
    res.status(200).json({ success: true, data });
};

exports.saveStatement = (req, res) => {
    const { fileUrl, originalName, size } = req.body;
    if (!fileUrl || !originalName) {
        return res.status(400).json({ success: false, message: 'fileUrl and originalName are required.' });
    }
    const statements = readStatements();
    const newEntry = {
        id: Date.now().toString(),
        originalName,
        fileUrl,
        size: size || 'N/A',
        uploadDate: new Date().toISOString()
    };
    statements.unshift(newEntry);
    writeStatements(statements);
    res.status(200).json({ success: true, data: newEntry });
};

exports.deleteStatement = (req, res) => {
    const { id } = req.params;
    if (!id) return res.status(400).json({ success: false, message: 'id is required.' });
    const statements = readStatements();
    const updated = statements.filter(s => s.id !== id);
    writeStatements(updated);
    res.status(200).json({ success: true });
};

exports.downloadFile = (req, res) => {
    const { fileUrl } = req.query;
    if (!fileUrl) return res.status(400).json({ success: false, message: 'fileUrl is required.' });

    try {
        // fileUrl is already a path like /downloads/file.pdf or /uploads/file.pdf
        const urlPath = fileUrl;
        const fileName = path.basename(urlPath);
        const folder = urlPath.includes('/downloads/') ? 'downloads' : 'uploads';
        const filePath = path.join(__dirname, '..', folder, fileName);
        console.log('[DOWNLOAD] fileUrl:', fileUrl);
        console.log('[DOWNLOAD] resolved path:', filePath);

        if (!fs.existsSync(filePath)) {
            return res.status(404).json({ success: false, message: 'File not found.' });
        }

        res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
        res.setHeader('Content-Type', 'application/pdf');
        res.sendFile(filePath);
    } catch (err) {
        console.error('Download file error:', err);
        res.status(500).json({ success: false, message: 'Failed to serve file.' });
    }
};

exports.editDirect = async (req, res) => {
    const { fileUrl, changes, pageColors, password } = req.body;

    console.log(`[editDirect] Called with fileUrl: ${fileUrl}`);
    console.log(`[editDirect] Number of changes: ${changes?.length}`);

    if (!fileUrl) {
        return res.status(400).json({ success: false, message: 'fileUrl is required.' });
    }
    if (!Array.isArray(changes) || changes.length === 0) {
        return res.status(400).json({ success: false, message: 'No changes provided.' });
    }

    try {
        // Parse the filename from the URL
        // Handle both relative URLs (/uploads/file.pdf) and absolute URLs (http://...)
        let urlPath;
        try {
            if (fileUrl.startsWith('http://') || fileUrl.startsWith('https://')) {
                urlPath = new URL(fileUrl).pathname;
            } else {
                // Relative URL - use it directly
                urlPath = fileUrl;
            }
        } catch (urlError) {
            // If URL parsing fails, treat as relative path
            urlPath = fileUrl;
        }
        
        const segments = urlPath.split('/');
        const originalFilename = segments[segments.length - 1];
        const isDownload = urlPath.includes('/downloads/');
        const baseDir = isDownload
            ? path.join(__dirname, '../downloads')
            : path.join(__dirname, '../uploads');
        const originalPath = path.join(baseDir, originalFilename);

        console.log(`[editDirect] Resolved file path: ${originalPath}`);

        if (!fs.existsSync(originalPath)) {
            console.error('[editDirect] File not found at:', originalPath);
            return res.status(404).json({ success: false, message: `File not found: ${originalPath}` });
        }

        let originalPdfBytes = fs.readFileSync(originalPath);
        
        // If password is provided, decrypt the PDF first
        if (password) {
            try {
                const pdfDoc = await PDFDocument.load(originalPdfBytes, {
                    password: password,
                    ignoreEncryption: false
                });
                originalPdfBytes = await pdfDoc.save();
                console.log('[editDirect] PDF decrypted successfully');
            } catch (err) {
                console.error('[editDirect] Password decryption failed:', err.message);
                return res.status(400).json({
                    success: false,
                    message: 'Incorrect password or failed to decrypt PDF.'
                });
            }
        }

        const pdfDoc = await PDFDocument.load(originalPdfBytes);
        const pages = pdfDoc.getPages();
        const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
        const boldFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

        // Build per-page text colors.
        // Primary source: frontend pdf.js extraction (handles all color spaces natively).
        // Fallback: backend zlib decompression of the raw content stream.
        const pageTextColors = {};
        if (pageColors && typeof pageColors === 'object') {
            for (const [pageIdx, color] of Object.entries(pageColors)) {
                if (color && typeof color.r === 'number') {
                    pageTextColors[pageIdx] = rgb(color.r, color.g, color.b);
                    console.log(`[editDirect] Page ${pageIdx} color (frontend): rgb(${color.r.toFixed(4)}, ${color.g.toFixed(4)}, ${color.b.toFixed(4)})`);
                }
            }
        }
        // Fill any missing pages with backend-extracted color
        pages.forEach((page, idx) => {
            const key = String(idx + 1);
            if (!pageTextColors[key]) {
                const c = extractPageTextColor(pdfDoc, page);
                if (c) {
                    pageTextColors[key] = rgb(c.r, c.g, c.b);
                    console.log(`[editDirect] Page ${key} color (backend zlib): rgb(${c.r.toFixed(4)}, ${c.g.toFixed(4)}, ${c.b.toFixed(4)})`);
                }
            }
        });

        changes.forEach((change, ci) => {
            const page = pages[change.pageIndex - 1]; // pageIndex is 1-based from frontend
            if (!page) {
                console.warn(`[editDirect] Change #${ci}: pageIndex ${change.pageIndex} out of range (total pages: ${pages.length})`);
                return;
            }

            const fontSize = Math.max(change.fontSize || 8, 5);
            const textStr = String(change.newText);

            const isBold = change.isBold === true;
            const currentFont = isBold ? boldFont : font;

            // Calculate actual text width for precise masking
            const textWidth = currentFont.widthOfTextAtSize(textStr, fontSize);
            const cellWidth = change.width || textWidth;

            const isNumeric = change.isNumeric || !isNaN(parseFloat(textStr.replace(/,/g, '')));
            let drawX = change.x;
            if (isNumeric && change.width) {
                // Right-align to original right edge
                const originalRightEdge = change.x + change.width;
                drawX = originalRightEdge - textWidth;
            }

            // For summary items (Opening/Closing Balance), enforce a minimum draw X so the
            // value never overlaps the colon when the new value is wider than the original.
            // minDrawX = colonRightEdge + gap is supplied by the frontend.
            if (change.isSummaryItem && change.minDrawX != null && drawX < change.minDrawX) {
                drawX = change.minDrawX;
            }

            // Masking Logic:
            // Table items use a tight mask to keep vertical borders intact.
            // Summary items use a wider mask to catch all ghost digits.
            const isTable = change.isTableItem === true;

            // Expand the mask to catch anti-aliasing and font-metric differences.
            // For summary items, do NOT expand leftward (hPaddingLeft=0) to avoid
            // covering adjacent elements like colons that sit just before the value.
            const hPaddingRight = isTable ? 2 : 6;
            const hPaddingLeft = isTable ? 2 : 0;
            const maskX = Math.min(change.x, drawX) - hPaddingLeft;
            const maskWidth = Math.max(change.x + cellWidth, drawX + textWidth) - maskX + hPaddingRight;

            // Taller mask to catch descenders (e.g., 9, g, y) and ascenders
            // We go 4px below the baseline and 4px above the font height
            const maskY = change.y - 4;
            const maskH = fontSize + 8;

            const maskColorRGB = change.maskColor ? rgb(change.maskColor[0], change.maskColor[1], change.maskColor[2]) : rgb(1, 1, 1);

            page.drawRectangle({
                x: maskX,
                y: maskY,
                width: maskWidth,
                height: maskH,
                color: maskColorRGB,
            });

            // Use the exact text color extracted by pdf.js on the frontend
            const textColor = pageTextColors[change.pageIndex] || rgb(0, 0, 0);

            page.drawText(String(change.newText), {
                x: drawX,
                y: change.y,
                size: fontSize,
                font: currentFont,
                color: textColor,
            });
        });

        const pdfBytes = await pdfDoc.save();
        const fileName = `transformed_${Date.now()}_${originalFilename}`;
        const filePath = path.join(__dirname, '../downloads', fileName);

        const downloadsDir = path.join(__dirname, '../downloads');
        if (!fs.existsSync(downloadsDir)) {
            fs.mkdirSync(downloadsDir, { recursive: true });
        }

        fs.writeFileSync(filePath, pdfBytes);
        console.log(`[editDirect] Saved transformed PDF to: ${filePath}`);

        res.status(200).json({
            success: true,
            message: 'Text edits applied successfully.',
            fileUrl: `https://pdf-editor-ax8j.onrender.com/downloads/${fileName}`
        });

    } catch (err) {
        console.error('[editDirect] Error:', err);
        res.status(500).json({ success: false, message: 'Failed to apply text edits: ' + err.message });
    }
};

