require('dotenv').config({ quiet: true });
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const mongoose = require('mongoose');
const morgan = require('morgan');

const authRoutes = require('./routes/authRoutes');
const statementRoutes = require('./routes/statementRoutes');

const app = express();
const port = process.env.PORT || 5000;

// Middleware
app.use(cors({
    origin: '*', // Allow all for debugging, or specifically 'http://localhost:5173'
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json({ limit: process.env.UPLOAD_LIMIT || '50mb' }));
app.use(express.urlencoded({ extended: true, limit: process.env.UPLOAD_LIMIT || '50mb' }));
app.use(morgan('dev')); // Log every request to terminal

// Database Connection
if (process.env.MONGO_URI) {
    mongoose.connect(process.env.MONGO_URI)
        .then(() => console.log('Connected to MongoDB safely.'))
        .catch(err => {
            console.error('MongoDB connection error. Please check your network or URI.');
            console.error(err.message);
        });
} else {
    console.log('No MONGO_URI found in .env. Running without database.');
}

// Ensure uploads and downloads directories exist
const uploadDir = path.join(__dirname, 'uploads');
const downloadDir = path.join(__dirname, 'downloads');
[uploadDir, downloadDir].forEach(dir => {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir);
    }
});

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/statements', statementRoutes);

// Serve files as static
app.use('/uploads', express.static(uploadDir));
app.use('/downloads', express.static(downloadDir));

// Start server with robust error handling
const server = app.listen(port, () => {
    console.log(`Backend server ACTIVE at http://localhost:${port} (Port: ${port})`);
    console.log(`Backend API: http://localhost:${port}/api`);
    console.log(`File uploads available at: http://localhost:${port}/uploads`);
    console.log('Press Ctrl+C to stop the server.');
});

// Port conflict handling
server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
        console.error(`Error: Port ${port} is already in use by another application.`);
        process.exit(1);
    } else {
        console.error('An unexpected server error occurred:', err);
    }
});

// Global Error Handlers - To catch why it exits
process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (err) => {
    console.error('Uncaught Exception thrown:', err);
    process.exit(1);
});
