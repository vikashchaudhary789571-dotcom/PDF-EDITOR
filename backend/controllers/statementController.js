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
    if (!req.file) {
        return res.status(400).json({ success: false, message: 'No file uploaded' });
    }

    console.log('[uploadStatement] req.body:', JSON.stringify(req.body));
    console.log('[uploadStatement] req.file:', req.file.originalname);

    try {
        const filePath = path.join(__dirname, '../uploads', req.file.filename);
        let dataBuffer = fs.readFileSync(filePath);
        const password = req.body.password;
        
        console.log('[uploadStatement] Password received:', password ? 'YES (length: ' + password.length + ')' : 'NO');

        // If password is provided, try to decrypt the PDF first
        if (password) {
            try {
                const pdfDoc = await PDFDocument.load(dataBuffer, {
                    password: password,
                    ignoreEncryption: false
                });
                // Save the decrypted PDF back to buffer
                dataBuffer = await pdfDoc.save();
                
                // Overwrite the original file with the decrypted version
                fs.writeFileSync(filePath, dataBuffer);
                console.log('[uploadStatement] PDF decrypted and saved successfully');
            } catch (err) {
                console.error('[uploadStatement] Password decryption failed:', err.message);
                return res.status(400).json({
                    success: false,
                    message: 'Incorrect password or failed to decrypt PDF. Please check the password and try again.'
                });
            }
        }

        const parser = new PDFParse({ data: dataBuffer });

        const textResult = await parser.getText();
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
                            // Map row to transaction object
                            // Assuming typical statement structure: Date, Description, [optional ref], Debit, Credit, Balance
                            // We need to detect which columns are which
                            // For now, let's use a heuristic based on the length

                            let transactionDate = row[0];
                            let valueDate = row[1] || '';
                            let description = row[2] || '';
                            let reference = row[3] || '';
                            let debit = 0;
                            let credit = 0;
                            let balance = 0;

                            if (row.length >= 7) {
                                // Date, Value Date, Description, Ref, Debit, Credit, Balance
                                debit = parseFloat(String(row[4] || '').replace(/,/g, '')) || 0;
                                credit = parseFloat(String(row[5] || '').replace(/,/g, '')) || 0;
                                balance = parseFloat(String(row[6] || '').replace(/,/g, '')) || 0;
                            } else if (row.length >= 5) {
                                // Fallback to simpler structure if 7 aren't found
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

        await parser.destroy();

        res.status(200).json({
            success: true,
            message: 'File processed. Table extracted.',
            file: {
                filename: req.file.filename,
                originalName: req.file.originalname,
                fileUrl: `https://statsedit-api.onrender.com/uploads/${req.file.filename}`
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
            fileUrl: `https://statsedit-api.onrender.com/downloads/${fileName}`
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
        const urlPath = new URL(fileUrl).pathname; // e.g. /uploads/file.pdf or /downloads/file.pdf
        const fileName = path.basename(urlPath);
        const folder = urlPath.includes('/downloads/') ? 'downloads' : 'uploads';
        const filePath = path.join(__dirname, '..', folder, fileName);

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
        const urlPath = new URL(fileUrl).pathname; // e.g. /uploads/filename.pdf or /downloads/filename.pdf
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

            page.drawRectangle({
                x: maskX,
                y: maskY,
                width: maskWidth,
                height: maskH,
                color: rgb(1, 1, 1),
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
            fileUrl: `https://statsedit-api.onrender.com/downloads/${fileName}`
        });

    } catch (err) {
        console.error('[editDirect] Error:', err);
        res.status(500).json({ success: false, message: 'Failed to apply text edits: ' + err.message });
    }
};

