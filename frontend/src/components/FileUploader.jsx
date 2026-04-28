import React, { useState } from 'react';
import { Upload, FileText, X, CheckCircle2, Loader2, Lock } from 'lucide-react';
import { Button } from './ui/Button';
import { Card, CardContent } from './ui/Card';
import { motion, AnimatePresence } from 'framer-motion';
import { statementService } from '../services/api';

export function FileUploader({ onUpload }) {
    const [dragActive, setDragActive] = useState(false);
    const [file, setFile] = useState(null);
    const [password, setPassword] = useState('');
    const [showPassword, setShowPassword] = useState(false);
    const [isPasswordRequired, setIsPasswordRequired] = useState(false);
    const [uploadAttempted, setUploadAttempted] = useState(false);

    const handleDrag = (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (e.type === "dragenter" || e.type === "dragover") {
            setDragActive(true);
        } else if (e.type === "dragleave") {
            setDragActive(false);
        }
    };

    const handleDrop = (e) => {
        e.preventDefault();
        e.stopPropagation();
        setDragActive(false);
        if (e.dataTransfer.files && e.dataTransfer.files[0]) {
            setFile(e.dataTransfer.files[0]);
        }
    };

    const handleChange = (e) => {
        e.preventDefault();
        if (e.target.files && e.target.files[0]) {
            setFile(e.target.files[0]);
        }
    };

    const removeFile = () => {
        setFile(null);
        setPassword('');
        setIsPasswordRequired(false);
        setUploadAttempted(false);
    };

    const [isLoading, setIsLoading] = useState(false);

    const handleProcess = async () => {
        if (file) {
            setIsLoading(true);
            setUploadAttempted(true);
            try {
                // First attempt: try without password if not already marked as required
                const pwdToSend = isPasswordRequired ? password : undefined;
                
                console.log('[FileUploader] Uploading with password:', pwdToSend ? 'YES' : 'NO');
                console.log('[FileUploader] Password value:', pwdToSend);
                console.log('[FileUploader] isPasswordRequired:', isPasswordRequired);
                
                const response = await statementService.upload(file, pwdToSend);
                
                if (response.success) {
                    // Success! Reset states and proceed
                    console.log('[FileUploader] Upload successful!');
                    console.log('[FileUploader] Transactions received:', response.transactions?.length || 0);
                    console.log('[FileUploader] Password in response:', !!response.file?.password);
                    setIsPasswordRequired(false);
                    onUpload(file, response.file.fileUrl, response.transactions, response.openingBalance, response.closingBalance, response.file?.password);
                } else {
                    console.error('[FileUploader] Upload failed:', response.message);
                    // Check if backend says password is required
                    if (response.message && (response.message.includes('password') || response.message.includes('Password') || response.message.includes('encrypt'))) {
                        setIsPasswordRequired(true);
                        alert('This PDF is password-protected. Please enter the password to continue.');
                    } else {
                        alert('Upload failed: ' + response.message);
                    }
                }
            } catch (error) {
                console.error('[FileUploader] Upload error:', error);
                console.error('[FileUploader] Error response:', error.response?.data);
                
                // Check if error indicates password protection
                const errorMessage = error.response?.data?.message || error.message || '';
                if (errorMessage.includes('password') || errorMessage.includes('Password') || errorMessage.includes('encrypt')) {
                    setIsPasswordRequired(true);
                    alert('This PDF is password-protected. Please enter the password to continue.');
                } else {
                    alert('Upload Error: ' + (error.response?.data?.message || error.message || 'Connection to backend failed.'));
                }
            } finally {
                setIsLoading(false);
            }
        }
    };

    return (
        <div className="w-full max-w-2xl mx-auto py-12 px-4">
            <AnimatePresence mode="wait">
                {!file ? (
                    <motion.div
                        key="uploader"
                        initial={{ opacity: 0, y: 20 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, scale: 0.95 }}
                    >
                        <Card
                            className={`relative border-2 border-dashed transition-all cursor-pointer ${dragActive ? "border-brand-secondary bg-blue-50/50" : "border-slate-300 hover:border-brand-secondary/50"
                                }`}
                            onDragEnter={handleDrag}
                            onDragLeave={handleDrag}
                            onDragOver={handleDrag}
                            onDrop={handleDrop}
                            onClick={() => document.getElementById('file-upload').click()}
                        >
                            <CardContent className="flex flex-col items-center justify-center min-h-[300px] text-center">
                                <div className="w-16 h-16 rounded-full bg-blue-50 flex items-center justify-center mb-4">
                                    <Upload className="w-8 h-8 text-brand-secondary" />
                                </div>
                                <h3 className="text-xl font-semibold mb-2">Upload Financial Statement</h3>
                                <p className="text-slate-500 mb-6 max-w-sm">
                                    Drag and drop your PDF statement here, or click to browse files from your computer.
                                </p>
                                <input
                                    id="file-upload"
                                    type="file"
                                    className="hidden"
                                    accept=".pdf"
                                    onChange={handleChange}
                                />
                                <Button variant="primary">Select PDF File</Button>
                            </CardContent>
                        </Card>
                    </motion.div>
                ) : (
                    <motion.div
                        key="preview"
                        initial={{ opacity: 0, scale: 0.95 }}
                        animate={{ opacity: 1, scale: 1 }}
                    >
                        <Card className="border-brand-secondary bg-white">
                            <CardContent className="p-4 md:p-8">
                                <div className="flex flex-col md:flex-row items-center md:items-center gap-4 md:gap-6">
                                    <div className="w-16 h-16 rounded-2xl bg-blue-50 flex items-center justify-center shrink-0">
                                        <FileText className="w-8 h-8 text-brand-secondary" />
                                    </div>
                                    <div className="flex-1 text-center md:text-left min-w-0 w-full">
                                        <h4 className="font-semibold text-lg truncate w-full">{file.name}</h4>
                                        <p className="text-slate-500 text-sm">{(file.size / 1024 / 1024).toFixed(2)} MB • PDF Document</p>
                                    </div>
                                    <div className="flex flex-col sm:flex-row items-center gap-3 w-full md:w-auto mt-2 md:mt-0">
                                        <Button variant="ghost" size="sm" onClick={removeFile} className="w-full sm:w-auto" disabled={isLoading}>
                                            <X className="w-4 h-4 mr-2" /> Cancel
                                        </Button>
                                        <Button
                                            variant="primary"
                                            onClick={handleProcess}
                                            className="w-full sm:w-auto"
                                            disabled={isLoading}
                                        >
                                            {isLoading ? (
                                                <>
                                                    <Loader2 className="w-4 h-4 mr-2 animate-spin" /> Processing...
                                                </>
                                            ) : (
                                                "Process Statement"
                                            )}
                                        </Button>
                                    </div>
                                </div>

                                <div className="mt-6 md:mt-8 pt-6 md:pt-8 border-t border-slate-100 flex items-start gap-4 text-emerald-600 bg-emerald-50/50 p-4 rounded-xl">
                                    <CheckCircle2 className="w-5 h-5 mt-0.5 shrink-0" />
                                    <p className="text-sm">
                                        File ready for processing. Our AI engine will extract structured transaction data, allowing you to edit values and recalculate balances in the next step.
                                    </p>
                                </div>

                                {/* Password Input - Only show if PDF is password-protected */}
                                {isPasswordRequired && (
                                    <motion.div
                                        initial={{ opacity: 0, height: 0 }}
                                        animate={{ opacity: 1, height: 'auto' }}
                                        className="mt-4 pt-4 border-t border-slate-100"
                                    >
                                        <div className="flex items-start gap-3 text-slate-600 bg-amber-50/50 p-4 rounded-xl border border-amber-200">
                                            <Lock className="w-5 h-5 mt-0.5 shrink-0 text-amber-600" />
                                            <div className="flex-1">
                                                <p className="text-sm font-medium text-amber-800 mb-2">Password Required</p>
                                                <p className="text-xs text-amber-700 mb-3">
                                                    This PDF is password-protected. Please enter the password to unlock and process it.
                                                </p>
                                                <div className="relative">
                                                    <input
                                                        type={showPassword ? "text" : "password"}
                                                        value={password}
                                                        onChange={(e) => setPassword(e.target.value)}
                                                        placeholder="Enter PDF password"
                                                        className="w-full px-3 py-2 pr-10 text-sm border border-amber-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-amber-500 focus:border-transparent bg-white"
                                                        autoFocus
                                                    />
                                                    <button
                                                        type="button"
                                                        onClick={() => setShowPassword(!showPassword)}
                                                        className="absolute right-2 top-1/2 -translate-y-1/2 text-amber-600 hover:text-amber-700 p-1"
                                                        title={showPassword ? "Hide password" : "Show password"}
                                                    >
                                                        {showPassword ? (
                                                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21" />
                                                            </svg>
                                                        ) : (
                                                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                                                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                                                            </svg>
                                                        )}
                                                    </button>
                                                </div>
                                            </div>
                                        </div>
                                    </motion.div>
                                )}
                            </CardContent>
                        </Card>
                    </motion.div>
                )}
            </AnimatePresence>
        </div>
    );
}
