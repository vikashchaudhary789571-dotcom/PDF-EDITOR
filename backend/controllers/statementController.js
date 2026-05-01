const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { PDFDocument, rgb, StandardFonts, PDFName, PDFArray } = require('pdf-lib');
const { PDFParse } = require('pdf-parse');

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
                try { return zlib.inflateRawSync(rawBuf); } catch (__) {}
            }
        }
    } catch (_) {}
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
            addRgb((1-c)*(1-bk), (1-cy)*(1-bk), (1-y)*(1-bk));
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
    if (!req.file) {
        return res.status(400).json({ success: false, message: 'No file uploaded' });
    }

    try {
        const filePath = path.join(__dirname, '../uploads', req.file.filename);
        const dataBuffer = fs.readFileSync(filePath);
        const { password } = req.body;

        console.log(`[uploadStatement] New upload: ${req.file.originalname}, Password provided: ${!!password}`);

        // Pass password directly to the parser. 
        // We no longer try to decrypt/re-save with pdf-lib here because it fails on many AES-256 PDFs.
        // The parser (pdf-parse) handles decryption much better during text extraction.
        const parser = new PDFParse({ 
            data: dataBuffer,
            password: password 
        });

        let textResult;
        try {
            textResult = await parser.getText();
        } catch (parseErr) {
            console.error('[uploadStatement] PDF parsing failed:', parseErr.message);
            
            // If it's a password error, return 401
            if (parseErr.name === 'PasswordException' || parseErr.message.includes('password') || parseErr.message.includes('encrypted')) {
                return res.status(401).json({ 
                    success: false, 
                    message: 'Incorrect password or PDF is encrypted. Please check the password.' 
                });
            }

            return res.status(500).json({ 
                success: false, 
                message: 'Failed to extract text from PDF. It might be corrupted or unsupported.' 
            });
        }
        
        const text = textResult.text;

        // --- SEARCHING BALANCES ---
        // Heuristic: Match 'Opening/Closing Balance' followed by anything until we find a number
        const obMatch = text.match(/Opening Balance[^\d]*?([\d,]+\.\d{2})/i);
        const cbMatch = text.match(/Closing Balance[^\d]*?([\d,]+\.\d{2})/i);

        let openingBalance = obMatch ? parseFloat(obMatch[1].replace(/,/g, '')) : null;
        let closingBalance = cbMatch ? parseFloat(cbMatch[1].replace(/,/g, '')) : null;

        // --- EXTRACTING TABLE ---
        const tableResult = await parser.getTable();
        const transactions = [];

        if (tableResult.pages && tableResult.pages.length > 0) {
            tableResult.pages.forEach((page) => {
                page.tables.forEach((table) => {
                    table.forEach(row => {
                        // Pattern for date (covers dd/mm/yyyy, dd-mm-yyyy, dd MMM yyyy)
                        const firstCol = row[0] ? String(row[0]).trim() : '';
                        if (/^\d{1,2}[\/\-\s][a-zA-Z0-9]{2,3}[\/\-\s]\d{2,4}/.test(firstCol)) {
                            let transactionDate = row[0];
                            let valueDate = row[1] || '';
                            let description = row[2] || '';
                            let reference = row[3] || '';
                            let debit = 0;
                            let credit = 0;
                            let balance = 0;

                            if (row.length >= 7) {
                                debit = parseFloat(String(row[4] || '').replace(/,/g, '')) || 0;
                                credit = parseFloat(String(row[5] || '').replace(/,/g, '')) || 0;
                                balance = parseFloat(String(row[6] || '').replace(/,/g, '')) || 0;
                            } else if (row.length >= 5) {
                                debit = parseFloat(String(row[row.length - 3] || '').replace(/,/g, '')) || 0;
                                credit = parseFloat(String(row[row.length - 2] || '').replace(/,/g, '')) || 0;
                                balance = parseFloat(String(row[row.length - 1] || '').replace(/,/g, '')) || 0;
                            }

                            transactions.push({
                                id: Math.random().toString(36).substr(2, 9),
                                date: transactionDate,
                                valueDate,
                                description,
                                reference,
                                debit,
                                credit,
                                balance
                            });
                        }
                    });
                });
            });
        }

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

        await parser.destroy();

        res.status(200).json({
            success: true,
            message: 'File processed. Table extracted.',
            file: {
                filename: req.file.filename,
                originalName: req.file.originalname,
                fileUrl: `http://localhost:5001/uploads/${req.file.filename}`
            },
            transactions: transactions,
            openingBalance,
            closingBalance
        });

    } catch (err) {
        console.error('Extraction Error:', err);
        res.status(500).json({ success: false, message: 'Failed to extract data: ' + err.message });
    }
};

exports.saveTransactions = (req, res) => {
    const { transactions, filename } = req.body;
    console.log(`Saving ${transactions?.length} transactions for file ${filename}`);
    res.status(200).json({ success: true, message: 'Transactions saved successfully' });
};

exports.regeneratePdf = async (req, res) => {
    const { transactions, originalFile, password } = req.body;

    try {
        const urlParts = originalFile.split('/');
        const originalFilename = urlParts[urlParts.length - 1];
        const originalPath = path.join(__dirname, '../uploads', originalFilename);

        if (!fs.existsSync(originalPath)) throw new Error('Original file missing.');

        // pdf-lib cannot decrypt AES-256 PDFs — always use ignoreEncryption
        const pdfDoc = await PDFDocument.load(fs.readFileSync(originalPath), { ignoreEncryption: true });
        // Strip encryption dictionary so the saved PDF is clean and can be re-loaded freely
        if (pdfDoc.context.trailerInfo.Encrypt) delete pdfDoc.context.trailerInfo.Encrypt;
        const firstPage = pdfDoc.getPages()[0];

        const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
        const boldFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

        const formatCurrency = (val) => Number(val).toLocaleString(undefined, {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2
        });

        // --- STEP 1: SUMMARY TOTALS ---
        const totals = transactions.reduce((acc, curr) => {
            acc.debit += Number(curr.debit) || 0;
            acc.credit += Number(curr.credit) || 0;
            return acc;
        }, { debit: 0, credit: 0 });

        const openingBalance = Number(transactions[0]?.balance) || 0;
        const closingBalance = Number(transactions[transactions.length - 1]?.balance) || 0;

        const summaryXEnd = 568;
        const summaryYBase = 715; 
        const summarySpacing = 16.5;

        const summaryValues = [
            formatCurrency(openingBalance),
            formatCurrency(totals.credit),
            formatCurrency(totals.debit),
            formatCurrency(closingBalance)
        ];

        summaryValues.forEach((text, i) => {
            const y = summaryYBase - (i * summarySpacing);
            const isBold = (i === 0 || i === 3);
            const currentFont = isBold ? boldFont : font;
            const textWidth = currentFont.widthOfTextAtSize(text, 8);

            firstPage.drawRectangle({
                x: 480,
                y: y - 2,
                width: 90,
                height: 10,
                color: rgb(1, 1, 1),
            });

            firstPage.drawText(text, {
                x: summaryXEnd - textWidth,
                y: y,
                size: 8,
                font: currentFont,
                color: rgb(0, 0, 0),
            });
        });

        // --- STEP 2: TABLE RE-RENDERING ---
        const tableYStart = 574;
        const rowHeight = 15.6;

        transactions.forEach((txn, i) => {
            const y = tableYStart - (i * rowHeight);

            firstPage.drawRectangle({ x: 420, y: y - 2, width: 55, height: 10, color: rgb(1, 1, 1) });
            firstPage.drawRectangle({ x: 478, y: y - 2, width: 55, height: 10, color: rgb(1, 1, 1) });
            firstPage.drawRectangle({ x: 535, y: y - 2, width: 55, height: 10, color: rgb(1, 1, 1) });

            const debitText = Number(txn.debit) > 0 ? formatCurrency(txn.debit) : '';
            const creditText = Number(txn.credit) > 0 ? formatCurrency(txn.credit) : '';
            const balanceText = formatCurrency(txn.balance);

            if (debitText) {
                const w = font.widthOfTextAtSize(debitText, 7);
                firstPage.drawText(debitText, { x: 472 - w, y, size: 7, font });
            }
            if (creditText) {
                const w = font.widthOfTextAtSize(creditText, 7);
                firstPage.drawText(creditText, { x: 530 - w, y, size: 7, font });
            }
            const bw = font.widthOfTextAtSize(balanceText, 7);
            firstPage.drawText(balanceText, { x: 588 - bw, y, size: 7, font });
        });

        const pdfBytes = await pdfDoc.save();
        const fileName = `regenerated_${Date.now()}_${originalFilename}`;
        const filePath = path.join(__dirname, '../downloads', fileName);

        fs.writeFileSync(filePath, pdfBytes);

        res.status(200).json({
            success: true,
            fileUrl: `http://localhost:5001/downloads/${fileName}`
        });
    } catch (err) {
        console.error('Regeneration Error:', err);
        res.status(500).json({ success: false, message: err.message });
    }
};

exports.saveStatement = (req, res) => {
    res.status(200).json({ success: true, message: 'Statement saved' });
};

exports.getStatements = (req, res) => {
    res.status(200).json({ success: true, statements: [] });
};

exports.deleteStatement = (req, res) => {
    res.status(200).json({ success: true, message: 'Statement deleted' });
};

exports.downloadFile = (req, res) => {
    const { fileUrl } = req.query;
    try {
        const urlPath = new URL(fileUrl).pathname;
        const segments = urlPath.split('/');
        const fileName = segments[segments.length - 1];
        const isDownload = urlPath.includes('/downloads/');
        const baseDir = isDownload ? path.join(__dirname, '../downloads') : path.join(__dirname, '../uploads');
        const filePath = path.join(baseDir, fileName);

        if (!fs.existsSync(filePath)) return res.status(404).send('File not found');
        res.download(filePath);
    } catch (err) {
        res.status(500).send('Error serving file');
    }
};

exports.editDirect = async (req, res) => {
    const { fileUrl, changes, pageColors, password } = req.body;

    if (!fileUrl) return res.status(400).json({ success: false, message: 'fileUrl is required.' });
    if (!Array.isArray(changes) || changes.length === 0) return res.status(400).json({ success: false, message: 'No changes provided.' });

    try {
        console.log(`[editDirect] ▶ Starting transformation with ${changes.length} changes. Password provided: ${!!password}`);
        
        const urlPath = new URL(fileUrl).pathname;
        const segments = urlPath.split('/');
        const originalFilename = segments[segments.length - 1];
        const isDownload = urlPath.includes('/downloads/');
        const baseDir = isDownload ? path.join(__dirname, '../downloads') : path.join(__dirname, '../uploads');
        const originalPath = path.join(baseDir, originalFilename);

        console.log(`[editDirect] Original filename: ${originalFilename}`);
        console.log(`[editDirect] Is download: ${isDownload}`);
        console.log(`[editDirect] Base dir: ${baseDir}`);
        console.log(`[editDirect] Full path: ${originalPath}`);

        if (!fs.existsSync(originalPath)) {
            console.error(`[editDirect] ✗ File not found at: ${originalPath}`);
            return res.status(404).json({ success: false, message: 'File not found' });
        }

        console.log(`[editDirect] ✓ File exists at: ${originalPath}`);
        console.log(`[editDirect] File size: ${fs.statSync(originalPath).size} bytes`);
        
        // pdf-lib cannot decrypt AES-256 PDFs — always use ignoreEncryption
        let pdfDoc;
        try {
            pdfDoc = await PDFDocument.load(fs.readFileSync(originalPath), { 
                ignoreEncryption: true,
                updateMetadata: false
            });
            console.log(`[editDirect] ✓ PDF loaded successfully (${pdfDoc.getPageCount()} pages)`);
        } catch (loadErr) {
            console.error(`[editDirect] ✗ Failed to load PDF:`, loadErr.message);
            throw new Error(`PDF loading failed: ${loadErr.message}`);
        }
        
        // Strip encryption dictionary so the saved PDF is clean and can be re-loaded freely
        if (pdfDoc.context.trailerInfo.Encrypt) {
            delete pdfDoc.context.trailerInfo.Encrypt;
            console.log(`[editDirect] ✓ Stripped encryption from PDF`);
        }
        
        const pages = pdfDoc.getPages();
        let font, boldFont;
        
        try {
            font = await pdfDoc.embedFont(StandardFonts.Helvetica);
            boldFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
            console.log(`[editDirect] ✓ Fonts embedded successfully`);
        } catch (fontErr) {
            console.error(`[editDirect] ✗ Font embedding failed:`, fontErr.message);
            throw new Error(`Font embedding failed: ${fontErr.message}`);
        }

        const pageTextColors = {};
        if (pageColors && typeof pageColors === 'object') {
            for (const [pageIdx, color] of Object.entries(pageColors)) {
                if (color) pageTextColors[pageIdx] = rgb(color.r, color.g, color.b);
            }
        }

        pages.forEach((page, idx) => {
            const key = String(idx + 1);
            if (!pageTextColors[key]) {
                const c = extractPageTextColor(pdfDoc, page);
                if (c) pageTextColors[key] = rgb(c.r, c.g, c.b);
            }
        });

        console.log(`[editDirect] ✓ Extracted text colors for ${Object.keys(pageTextColors).length} pages`);

        let appliedChanges = 0;
        changes.forEach((change, idx) => {
            const page = pages[change.pageIndex - 1];
            if (!page) {
                console.warn(`[editDirect] ⚠ Page ${change.pageIndex} not found (out of ${pages.length} pages)`);
                return;
            }

            try {
                const fontSize = Math.max(change.fontSize || 8, 5);
                const textStr = String(change.newText);
                const currentFont = change.isBold ? boldFont : font;
                const textWidth = currentFont.widthOfTextAtSize(textStr, fontSize);
                const cellWidth = change.width || textWidth;

                let drawX = change.x;
                if (change.isNumeric && change.width) {
                    drawX = (change.x + change.width) - textWidth;
                }
                if (change.isSummaryItem && change.minDrawX != null && drawX < change.minDrawX) {
                    drawX = change.minDrawX;
                }

                const isTable = change.isTableItem === true;
                const hPaddingRight = isTable ? 2 : 6;
                const hPaddingLeft = isTable ? 2 : 0;
                const maskX = Math.min(change.x, drawX) - hPaddingLeft;
                const maskWidth = Math.max(change.x + cellWidth, drawX + textWidth) - maskX + hPaddingRight;

                let maskColor = rgb(1, 1, 1);
                if (change.maskColor && Array.isArray(change.maskColor)) {
                    maskColor = rgb(change.maskColor[0]/255, change.maskColor[1]/255, change.maskColor[2]/255);
                }

                page.drawRectangle({
                    x: maskX,
                    y: change.y - 4,
                    width: maskWidth,
                    height: fontSize + 8,
                    color: maskColor,
                });

                const textColor = pageTextColors[change.pageIndex] || rgb(0, 0, 0);
                page.drawText(textStr, {
                    x: drawX,
                    y: change.y,
                    size: fontSize,
                    font: currentFont,
                    color: textColor,
                });

                appliedChanges++;
            } catch (changeErr) {
                console.warn(`[editDirect] ⚠ Failed to apply change ${idx}:`, changeErr.message);
            }
        });

        console.log(`[editDirect] ✓ Applied ${appliedChanges} out of ${changes.length} changes`);

        let pdfBytes;
        try {
            pdfBytes = await pdfDoc.save({ 
                useObjectStreams: false,
                addDefaultPage: false
            });
            console.log(`[editDirect] ✓ PDF saved successfully (${pdfBytes.length} bytes)`);
        } catch (saveErr) {
            console.error(`[editDirect] ✗ PDF save failed:`, saveErr.message);
            throw new Error(`PDF save failed: ${saveErr.message}`);
        }

        const fileName = `transformed_${Date.now()}_${originalFilename}`;
        const filePath = path.join(__dirname, '../downloads', fileName);
        
        const downloadsDir = path.join(__dirname, '../downloads');
        if (!fs.existsSync(downloadsDir)) {
            fs.mkdirSync(downloadsDir, { recursive: true });
            console.log(`[editDirect] ✓ Created downloads directory`);
        }
        
        try {
            fs.writeFileSync(filePath, pdfBytes);
            console.log(`[editDirect] ✓ File written to: ${filePath}`);
            console.log(`[editDirect] ✓ File size: ${fs.statSync(filePath).size} bytes`);
        } catch (writeErr) {
            console.error(`[editDirect] ✗ File write failed:`, writeErr.message);
            throw new Error(`File write failed: ${writeErr.message}`);
        }

        const responseUrl = `http://localhost:5001/downloads/${fileName}`;
        console.log(`[editDirect] ✓ Transform complete! URL: ${responseUrl}`);

        res.status(200).json({
            success: true,
            message: 'Text edits applied successfully.',
            fileUrl: responseUrl,
            stats: {
                changesApplied: appliedChanges,
                totalChanges: changes.length,
                fileSize: pdfBytes.length
            }
        });
    } catch (err) {
        console.error('[editDirect] ✗ TRANSFORMATION ERROR:', err.message);
        console.error('[editDirect] Stack:', err.stack);
        
        let userMessage = err.message;
        if (err.message.includes('encrypted') || err.message.includes('password')) {
            userMessage = `PDF encryption error: ${err.message}. Try re-uploading with the correct password.`;
        }
        
        res.status(500).json({ success: false, message: userMessage });
    }
};
