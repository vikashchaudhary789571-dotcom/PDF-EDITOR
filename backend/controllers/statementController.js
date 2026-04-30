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

        if (password) {
            try {
                const testParser = new PDFParse({ data: dataBuffer, password: password });
                await testParser.getText(); 
                console.log('[uploadStatement] Password validated successfully');
            } catch (validErr) {
                return res.status(400).json({ success: false, message: 'Incorrect password.' });
            }
        }

        let text = '';
        try {
            const parser = new PDFParse({ data: dataBuffer, password: password || '' });
            const textResult = await parser.getText();
            text = textResult.text || '';
        } catch (parseErr) {
            return res.status(500).json({ success: false, message: 'Failed to parse PDF.' });
        }

        // --- SEARCHING BALANCES ---
        let obMatch = text.match(/Opening Balance[^\d]*?([\d,]+\.\d{2})/i);
        let cbMatch = text.match(/Closing Balance[^\d]*?([\d,]+\.\d{2})/i);
        let openingBalance = obMatch ? parseFloat(obMatch[1].replace(/,/g, '')) : null;
        let closingBalance = cbMatch ? parseFloat(cbMatch[1].replace(/,/g, '')) : null;
        
        console.log(`[BALANCE_DEBUG] Extracted: Opening=${openingBalance}, Closing=${closingBalance}`);

        // --- BANK DETECTION ---
        const isAU = text.toLowerCase().includes('au small finance bank') || 
                     text.toLowerCase().includes('au bank') || 
                     text.toLowerCase().includes('aubank.in') ||
                     text.includes('19A, DHULESHWAR GARDEN, AJMER ROAD, JAIPUR');
        
        const isSBI = !isAU && (text.includes('STATE BANK OF INDIA') || text.includes('State Bank of India'));

        console.log(`[BANK_DETECT] SBI: ${isSBI}, AU: ${isAU}`);

        const transactions = [];
        const lines = text.split('\n').filter(line => line.trim());

        // ==================== AU SMALL FINANCE BANK SPECIALIZED PARSER v3.0 (IRONCLAD) ====================
        if (isAU) {
            console.log('[AU_BANK_PARSER_v3] 🚀 Starting Ironclad Parsing...');
            const dateRegex = /^(\d{1,2}\s+[A-Za-z]{3}\s+\d{4})/;
            const amountRegex = /(-?[\d,]+\.\d{2})/g;
            
            const rawLines = text.split('\n').map(l => l.trim()).filter(l => l);
            const txnBlocks = [];
            let activeBlock = null;

            for (let line of rawLines) {
                // Ignore obvious headers/footers/metadata
                if (line.toLowerCase().includes('statement date') || 
                    line.toLowerCase().includes('page') || 
                    line.toLowerCase().includes('customer id') ||
                    line.toLowerCase().includes('account no') ||
                    line.toLowerCase().includes('closing balance') ||
                    line.toLowerCase().includes('opening balance') ||
                    line.toLowerCase().includes('brought forward')) {
                    if (activeBlock) { txnBlocks.push(activeBlock); activeBlock = null; }
                    continue;
                }

                const dateMatch = line.match(dateRegex);
                if (dateMatch) {
                    // New transaction starts
                    if (activeBlock) txnBlocks.push(activeBlock);
                    activeBlock = {
                        date: dateMatch[1],
                        fullText: line,
                        amounts: []
                    };
                } else if (activeBlock) {
                    activeBlock.fullText += " " + line;
                }
            }
            if (activeBlock) txnBlocks.push(activeBlock);

            console.log(`[AU_BANK_PARSER_v3] Found ${txnBlocks.length} potential blocks`);

            let runningBal = openingBalance;
            for (const block of txnBlocks) {
                // Extract amounts from the entire block
                // We must be careful: ignore long numeric strings that aren't actually amounts
                const allNumbers = [...block.fullText.matchAll(amountRegex)].map(m => m[1]);
                const validAmounts = allNumbers.filter(numStr => {
                    const clean = numStr.replace(/,/g, '');
                    // Valid amounts usually aren't 12+ digits long (that's an account/ref number)
                    return clean.replace('.', '').length < 11;
                }).map(numStr => parseFloat(numStr.replace(/,/g, '')));

                if (validAmounts.length < 2) continue;

                // In AU Bank, the Balance is always the LAST valid amount in the block
                const balance = validAmounts[validAmounts.length - 1];
                let debit = 0, credit = 0;

                if (runningBal !== null) {
                    const delta = parseFloat((balance - runningBal).toFixed(2));
                    // Check if any of the other amounts in the block matches this delta
                    let foundMatch = false;
                    for (let j = 0; j < validAmounts.length - 1; j++) {
                        const amt = validAmounts[j];
                        if (Math.abs(amt - Math.abs(delta)) < 0.05) {
                            if (delta > 0) { credit = amt; debit = 0; }
                            else { debit = amt; credit = 0; }
                            foundMatch = true;
                            break;
                        }
                    }

                    if (!foundMatch) {
                        // If no specific amount matches the delta (rarely happens if split across lines)
                        // fallback to the delta itself
                        if (delta > 0) { credit = delta; debit = 0; }
                        else { debit = Math.abs(delta); credit = 0; }
                    }
                } else {
                    // First transaction fallback
                    const amt = validAmounts[0];
                    if (block.fullText.toLowerCase().includes('cr') || /NEFT CR|UPI CR/i.test(block.fullText)) {
                        credit = amt;
                    } else {
                        debit = amt;
                    }
                }

                // Extract Description: everything between the dates and the first amount
                // AU Bank often has two dates at the start (Txn Date and Value Date)
                let desc = block.fullText
                    .replace(/^\d{1,2}\s+[A-Za-z]{3}\s+\d{4}/, '') // Remove Txn Date
                    .replace(/^\s*\d{1,2}\s+[A-Za-z]{3}\s+\d{4}/, '') // Remove Value Date if present
                    .split(/[\d,]+\.\d{2}/)[0] // Take everything before the first amount
                    .replace(/\s+/g, ' ')
                    .trim();

                if (desc.length < 2) desc = "Transaction";

                transactions.push({
                    id: 'au_v3_' + Math.random().toString(36).substr(2, 9),
                    date: block.date,
                    valueDate: block.date, // Simplification for UI
                    description: desc.substring(0, 150),
                    reference: '',
                    debit: parseFloat(debit.toFixed(2)),
                    credit: parseFloat(credit.toFixed(2)),
                    balance: parseFloat(balance.toFixed(2))
                });
                runningBal = balance;
            }
            console.log(`[AU_BANK_PARSER_v3] ✅ Final Extraction: ${transactions.length} rows`);
        } 
        else {
            console.log('[UNIVERSAL_PARSER] Running universal parser...');
            const universalTxns = universalStatementParser(text, lines);
            transactions.push(...universalTxns);
        }

        // --- GLOBAL POST-PROCESSING: Balance continuity check ---
        if (transactions.length > 0 && openingBalance !== null) {
            let running = parseFloat(openingBalance);
            for (let t of transactions) {
                const actual = parseFloat(t.balance);
                const expected = running + (parseFloat(t.credit) || 0) - (parseFloat(t.debit) || 0);
                if (Math.abs(actual - expected) > 1) {
                    const delta = actual - running;
                    if (delta > 0) { t.credit = delta; t.debit = 0; }
                    else { t.debit = Math.abs(delta); t.credit = 0; }
                }
                running = actual;
            }
        }

        if (openingBalance === null && transactions.length > 0) {
            const first = transactions[0];
            openingBalance = (first.balance || 0) - (first.credit || 0) + (first.debit || 0);
        }
        if (closingBalance === null && transactions.length > 0) {
            closingBalance = transactions[transactions.length - 1].balance;
        }

        res.status(200).json({
            success: true,
            file: {
                filename: req.file.filename,
                originalName: req.file.originalname,
                fileUrl: `/uploads/${req.file.filename}`,
                password: password || null
            },
            transactions,
            openingBalance: openingBalance || 0,
            closingBalance: closingBalance || 0
        });

    } catch (err) {
        console.error('Extraction Error:', err);
        res.status(500).json({ success: false, message: 'Failed to extract data.' });
    }
};

exports.saveTransactions = (req, res) => {
    res.status(200).json({ success: true, message: 'Saved successfully' });
};

exports.regeneratePdf = async (req, res) => {
    const { transactions, originalFile } = req.body;
    try {
        const urlParts = originalFile.split('/');
        const originalFilename = urlParts[urlParts.length - 1];
        const originalPath = path.join(__dirname, '../uploads', originalFilename);
        if (!fs.existsSync(originalPath)) throw new Error('File missing.');

        const pdfDoc = await PDFDocument.load(fs.readFileSync(originalPath));
        const firstPage = pdfDoc.getPages()[0];
        const { width, height } = firstPage.getSize();
        const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
        const boldFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

        const formatCurrency = (val) => Number(val).toLocaleString(undefined, {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2
        });

        // Summary totals
        const totals = transactions.reduce((acc, curr) => {
            acc.debit += Number(curr.debit) || 0;
            acc.credit += Number(curr.credit) || 0;
            return acc;
        }, { debit: 0, credit: 0 });

        const openingBalance = Number(transactions[0]?.balance || 0);
        const closingBalance = Number(transactions[transactions.length - 1]?.balance || 0);

        const summaryXEnd = 568;
        const summaryYBase = 715; 
        const summarySpacing = 16.5;

        [openingBalance, totals.credit, totals.debit, closingBalance].forEach((val, i) => {
            const text = formatCurrency(val);
            const y = summaryYBase - (i * summarySpacing);
            const isBold = (i === 0 || i === 3);
            const currentFont = isBold ? boldFont : font;
            const textWidth = currentFont.widthOfTextAtSize(text, 8);

            firstPage.drawRectangle({ x: 470, y: y - 4, width: 110, height: 14, color: rgb(1, 1, 1) });
            firstPage.drawText(':', { x: 478, y, size: 8, font });
            firstPage.drawText(text, { x: summaryXEnd - textWidth, y, size: 8, font: currentFont });
        });

        // Rows
        const startY = 538;
        const rowHeight = 21.6;

        transactions.forEach((t, i) => {
            const y = startY - (i * rowHeight);
            if (y < 40) return;

            firstPage.drawRectangle({ x: 40, y: y - 7, width: width - 80, height: 19, color: rgb(1, 1, 1) });

            const col = { date: 48, vDate: 105, desc: 165, ref: 360 };
            const fontSize = 7.5;

            if (t.date) firstPage.drawText(String(t.date), { x: col.date, y, size: fontSize, font });
            if (t.valueDate) firstPage.drawText(String(t.valueDate), { x: col.vDate, y, size: fontSize, font });
            const desc = String(t.description || '').substring(0, 50);
            firstPage.drawText(desc, { x: col.desc, y, size: fontSize, font });

            const drTxt = Number(t.debit) > 0 ? formatCurrency(t.debit) : '-';
            const drW = font.widthOfTextAtSize(drTxt, fontSize);
            firstPage.drawText(drTxt, { x: 465 - drW, y, size: fontSize, font });

            const crTxt = Number(t.credit) > 0 ? formatCurrency(t.credit) : '-';
            const crW = font.widthOfTextAtSize(crTxt, fontSize);
            firstPage.drawText(crTxt, { x: 525 - crW, y, size: fontSize, font });

            const balTxt = formatCurrency(t.balance);
            const balW = font.widthOfTextAtSize(balTxt, fontSize);
            firstPage.drawText(balTxt, { x: 585 - balW, y, size: fontSize, font });
        });

        const pdfBytes = await pdfDoc.save();
        const fileName = `accuracy_confirmed_${Date.now()}.pdf`;
        const filePath = path.join(__dirname, '../downloads', fileName);
        if (!fs.existsSync(path.join(__dirname, '../downloads'))) fs.mkdirSync(path.join(__dirname, '../downloads'));
        fs.writeFileSync(filePath, pdfBytes);

        res.status(200).json({ success: true, fileUrl: `/downloads/${fileName}` });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Failed to regenerate PDF' });
    }
};

const STATEMENTS_FILE = path.join(__dirname, '../statements.json');
const readStatements = () => {
    if (!fs.existsSync(STATEMENTS_FILE)) return [];
    try { return JSON.parse(fs.readFileSync(STATEMENTS_FILE, 'utf8')); } catch { return []; }
};
const writeStatements = (data) => fs.writeFileSync(STATEMENTS_FILE, JSON.stringify(data, null, 2), 'utf8');

exports.getStatements = (req, res) => res.status(200).json({ success: true, data: readStatements() });

exports.saveStatement = (req, res) => {
    const { fileUrl, originalName, size } = req.body;
    const statements = readStatements();
    const newEntry = { id: Date.now().toString(), originalName, fileUrl, size: size || 'N/A', uploadDate: new Date().toISOString() };
    statements.unshift(newEntry);
    writeStatements(statements);
    res.status(200).json({ success: true, data: newEntry });
};

exports.deleteStatement = (req, res) => {
    const { id } = req.params;
    const statements = readStatements();
    writeStatements(statements.filter(s => s.id !== id));
    res.status(200).json({ success: true });
};

exports.downloadFile = (req, res) => {
    const { fileUrl } = req.query;
    const fileName = path.basename(fileUrl);
    const folder = fileUrl.includes('/downloads/') ? 'downloads' : 'uploads';
    const filePath = path.join(__dirname, '..', folder, fileName);
    if (!fs.existsSync(filePath)) return res.status(404).json({ success: false });
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.setHeader('Content-Type', 'application/pdf');
    res.sendFile(filePath);
};

exports.editDirect = async (req, res) => {
    const { fileUrl, changes, pageColors, password } = req.body;
    try {
        let urlPath = fileUrl.startsWith('http') ? new URL(fileUrl).pathname : fileUrl;
        const fileName = path.basename(urlPath);
        const isDownload = urlPath.includes('/downloads/');
        const originalPath = path.join(__dirname, '..', isDownload ? 'downloads' : 'uploads', fileName);

        let pdfBytes = fs.readFileSync(originalPath);
        if (password) {
            try {
                const pdfDoc = await PDFDocument.load(pdfBytes, { password, ignoreEncryption: false });
                pdfBytes = await pdfDoc.save();
            } catch (e) {
                console.warn('[editDirect] Decryption failed, trying without password');
            }
        }

        const pdfDoc = await PDFDocument.load(pdfBytes);
        const pages = pdfDoc.getPages();
        const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
        const boldFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

        // Map to keep track of colors per page to avoid redundant extraction
        const resolvedPageColors = pageColors || {};

        for (const change of changes) {
            const pageIndex = change.pageIndex;
            const page = pages[pageIndex - 1];
            if (!page) continue;

            // 1. Determine Text Color (to match original look)
            let textColor = rgb(0, 0, 0); // Default black
            if (resolvedPageColors[pageIndex]) {
                const c = resolvedPageColors[pageIndex];
                textColor = rgb(c.r, c.g, c.b);
            } else {
                // Try to extract it if not provided
                const extracted = extractPageTextColor(pdfDoc, page);
                if (extracted) {
                    resolvedPageColors[pageIndex] = extracted;
                    textColor = rgb(extracted.r, extracted.g, extracted.b);
                }
            }

            // 2. Formatting & Alignment
            const fontSize = Math.max(change.fontSize || 8, 5);
            const currentFont = change.isBold ? boldFont : font;
            const textWidth = currentFont.widthOfTextAtSize(String(change.newText), fontSize);
            
            let drawX = change.x;
            if (change.isNumeric && change.width) {
                // Right-align within the original item's footprint
                drawX = change.x + change.width - textWidth;
                
                // Safety: ensure it doesn't cross the left boundary if minDrawX was provided (for summaries)
                if (change.minDrawX && drawX < change.minDrawX) {
                    drawX = change.minDrawX;
                }
            }

            // 3. Masking
            // Use provided maskColor (summary items) or default to white
            const mColor = change.maskColor && Array.isArray(change.maskColor) 
                ? rgb(change.maskColor[0], change.maskColor[1], change.maskColor[2])
                : rgb(1, 1, 1);

            // Calculate mask footprint
            const maskWidth = Math.max(change.width || 0, textWidth) + 4;
            const maskX = change.isNumeric && change.width 
                ? (change.x + change.width - maskWidth + 2) 
                : (drawX - 2);

            // Draw mask (covers old text)
            page.drawRectangle({
                x: maskX, y: change.y - 4, width: maskWidth, height: fontSize + 8,
                color: mColor
            });

            // Draw new text (uses detected page text color)
            page.drawText(String(change.newText), {
                x: drawX, y: change.y, size: fontSize, font: currentFont,
                color: textColor
            });
        }

        const finalBytes = await pdfDoc.save();
        const outName = `transformed_${Date.now()}_${fileName}`;
        const outPath = path.join(__dirname, '../downloads', outName);
        if (!fs.existsSync(path.join(__dirname, '../downloads'))) fs.mkdirSync(path.join(__dirname, '../downloads'));
        fs.writeFileSync(outPath, finalBytes);

        res.status(200).json({ success: true, fileUrl: `/downloads/${outName}` });
    } catch (err) {
        console.error('[editDirect] Error:', err);
        res.status(500).json({ success: false, message: err.message });
    }
};
