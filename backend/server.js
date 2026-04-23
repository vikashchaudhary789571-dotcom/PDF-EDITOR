// require('dotenv').config({ quiet: true });
// const express = require('express');
// const cors = require('cors');
// const path = require('path');
// const fs = require('fs');
// const mongoose = require('mongoose');
// const morgan = require('morgan');

// const authRoutes = require('./routes/authRoutes');
// const statementRoutes = require('./routes/statementRoutes');

// const app = express();
// const port = process.env.PORT || 5000;

// // Middleware
// const corsOptions = {
//   origin: "https://editbank.onrender.com",
//   methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
//   allowedHeaders: ["Content-Type", "Authorization"],
// };

// app.use(cors(corsOptions));
// app.options("*", cors(corsOptions));
// app.use(express.json({ limit: process.env.UPLOAD_LIMIT || '50mb' }));
// app.use(express.urlencoded({ extended: true, limit: process.env.UPLOAD_LIMIT || '50mb' }));
// app.use(morgan('dev')); // Log every request to terminal

// // Database Connection
// if (process.env.MONGO_URI) {
//     mongoose.connect(process.env.MONGO_URI)
//         .then(() => console.log('Connected to MongoDB safely.'))
//         .catch(err => {
//             console.error('MongoDB connection error. Please check your network or URI.');
//             console.error(err.message);
//         });
// } else {
//     console.log('No MONGO_URI found in .env. Running without database.');
// }

// // Ensure uploads and downloads directories exist
// const uploadDir = path.join(__dirname, 'uploads');
// const downloadDir = path.join(__dirname, 'downloads');
// [uploadDir, downloadDir].forEach(dir => {
//     if (!fs.existsSync(dir)) {
//         fs.mkdirSync(dir);
//     }
// });

// // Routes
// app.use('/api/auth', authRoutes);
// app.use('/api/statements', statementRoutes);

// // Serve files as static
// app.use('/uploads', express.static(uploadDir));
// app.use('/downloads', express.static(downloadDir));

// // Start server with robust error handling
// const server = app.listen(port, () => {
//     console.log(`Backend server ACTIVE at http://127.0.0.1:${port}`);
//     console.log('Press Ctrl+C to stop the server.');
// });

// // Port conflict handling
// server.on('error', (err) => {
//     if (err.code === 'EADDRINUSE') {
//         console.error(`Error: Port ${port} is already in use by another application.`);
//         process.exit(1);
//     } else {
//         console.error('An unexpected server error occurred:', err);
//     }
// });

// // Global Error Handlers - To catch why it exits
// process.on('unhandledRejection', (reason, promise) => {
//     console.error('Unhandled Rejection at:', promise, 'reason:', reason);
// });

// process.on('uncaughtException', (err) => {
//     console.error('Uncaught Exception thrown:', err);
//     process.exit(1);
// });
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const mongoose = require('mongoose');
const morgan = require('morgan');

const authRoutes = require('./routes/authRoutes');
const statementRoutes = require('./routes/statementRoutes');

const app = express();
const PORT = process.env.PORT || 5000;

/* =========================
   CORS CONFIG (STRICT + SAFE)
========================= */
const corsOptions = {
    origin: ["https://editbank.onrender.com"], // allow your frontend
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    credentials: true,
};

app.use(cors(corsOptions));
app.options('*', cors(corsOptions));


/* =========================
   MIDDLEWARE
========================= */
app.use(express.json({ limit: process.env.UPLOAD_LIMIT || '50mb' }));
app.use(express.urlencoded({ extended: true, limit: process.env.UPLOAD_LIMIT || '50mb' }));
app.use(morgan('dev'));

/* =========================
   DATABASE CONNECTION
========================= */
const connectDB = async () => {
    if (!process.env.MONGO_URI) {
        console.warn("⚠️ No MONGO_URI found. Running without DB.");
        return;
    }

    try {
        await mongoose.connect(process.env.MONGO_URI);
        console.log("✅ MongoDB Connected");
    } catch (err) {
        console.error("❌ MongoDB connection failed:", err.message);
        process.exit(1); // crash early (better than silent failure)
    }
};

connectDB();

/* =========================
   DIRECTORIES SETUP
========================= */
const ensureDir = (dirPath) => {
    if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
    }
};

const uploadDir = path.join(__dirname, 'uploads');
const downloadDir = path.join(__dirname, 'downloads');

ensureDir(uploadDir);
ensureDir(downloadDir);

/* =========================
   ROUTES
========================= */
app.use('/api/auth', authRoutes);
app.use('/api/statements', statementRoutes);

/* =========================
   STATIC FILES
========================= */
app.use('/uploads', express.static(uploadDir));
app.use('/downloads', express.static(downloadDir));

/* =========================
   HEALTH CHECK (IMPORTANT)
========================= */
app.get('/', (req, res) => {
    res.send('API is running...');
});

/* =========================
   GLOBAL ERROR HANDLER
   Express 5 needs this to catch async errors
   and return a proper 500 instead of connection reset.
========================= */
app.use((err, req, res, next) => {
    console.error('❌ Global error handler caught:', err.message || err);
    if (res.headersSent) {
        return next(err);
    }
    res.status(err.status || 500).json({
        success: false,
        message: err.message || 'Internal server error'
    });
});

/* =========================
   START SERVER
========================= */
const server = app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
});

// Increase timeouts for large file uploads (5 minutes)
server.timeout = 300000;
server.keepAliveTimeout = 120000;
server.headersTimeout = 120000;

/* =========================
   ERROR HANDLING
========================= */
server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
        console.error(`❌ Port ${PORT} already in use`);
    } else {
        console.error('❌ Server error:', err);
    }
    process.exit(1);
});

process.on('unhandledRejection', (reason) => {
    console.error('❌ Unhandled Rejection:', reason);
});

process.on('uncaughtException', (err) => {
    console.error('❌ Uncaught Exception:', err);
    process.exit(1);
}); 