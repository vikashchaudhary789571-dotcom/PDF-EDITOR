const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const statementController = require('../controllers/statementController');

// Ensure uploads directory exists
const uploadDir = path.join(__dirname, '../uploads');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}

// Multer configuration for file uploads
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
        cb(null, Date.now() + '-' + file.originalname);
    }
});

const upload = multer({ storage: storage });

router.post('/upload', upload.single('file'), statementController.uploadStatement);
router.post('/regenerate', statementController.regeneratePdf);
router.post('/edit-direct', statementController.editDirect);
router.post('/save-file', statementController.saveStatement);
router.get('/download-file', statementController.downloadFile);
router.delete('/:id', statementController.deleteStatement);
router.get('/', statementController.getStatements);

module.exports = router;
