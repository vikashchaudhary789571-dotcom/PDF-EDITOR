import React, { useState } from 'react';
import { Shield, RefreshCw, Home, FileText, Layout } from 'lucide-react';
import { FileUploader } from './components/FileUploader';
import { InPdfEditor } from './components/InPdfEditor';
import { LoginPage } from './components/LoginPage';
import { Header } from './components/layout/Header';
import { SectionPlaceholder } from './components/common/SectionPlaceholder';
import { FeatureCard } from './components/common/FeatureCard';
import { motion, AnimatePresence } from 'framer-motion';

function App() {
  const [isAuthenticated, setIsAuthenticated] = useState(() => {
    return localStorage.getItem('fin_auth') === 'true';
  });
  const [step, setStep] = useState(() => {
    return sessionStorage.getItem('pdf_step') || 'upload';
  });
  const [uploadedFileUrl, setUploadedFileUrl] = useState(() => {
    return sessionStorage.getItem('pdf_fileUrl') || null;
  });
  const [pdfPassword, setPdfPassword] = useState(() => {
    return sessionStorage.getItem('pdf_password') || null;
  });
  const [currentTransactions, setCurrentTransactions] = useState(() => {
    try { return JSON.parse(sessionStorage.getItem('pdf_transactions')) || []; } catch { return []; }
  });
  const [balances, setBalances] = useState(() => {
    try { return JSON.parse(sessionStorage.getItem('pdf_balances')) || { opening: 0, closing: 0 }; } catch { return { opening: 0, closing: 0 }; }
  });

  // Persist editor state to sessionStorage
  React.useEffect(() => {
    sessionStorage.setItem('pdf_step', step);
  }, [step]);

  React.useEffect(() => {
    if (uploadedFileUrl) sessionStorage.setItem('pdf_fileUrl', uploadedFileUrl);
    else sessionStorage.removeItem('pdf_fileUrl');
  }, [uploadedFileUrl]);

  React.useEffect(() => {
    if (pdfPassword) sessionStorage.setItem('pdf_password', pdfPassword);
    else sessionStorage.removeItem('pdf_password');
  }, [pdfPassword]);

  React.useEffect(() => {
    sessionStorage.setItem('pdf_transactions', JSON.stringify(currentTransactions));
  }, [currentTransactions]);

  React.useEffect(() => {
    sessionStorage.setItem('pdf_balances', JSON.stringify(balances));
  }, [balances]);

  // If step is 'edit' but there's no file URL (e.g. corrupted storage), fall back to upload
  React.useEffect(() => {
    if (step === 'edit' && !uploadedFileUrl) setStep('upload');
  }, []);

  const handleLogin = (authData) => {
    setIsAuthenticated(true);
  };

  const handleLogout = () => {
    localStorage.removeItem('fin_auth');
    localStorage.removeItem('fin_auth_data');
    sessionStorage.removeItem('pdf_step');
    sessionStorage.removeItem('pdf_fileUrl');
    sessionStorage.removeItem('pdf_password');
    sessionStorage.removeItem('pdf_transactions');
    sessionStorage.removeItem('pdf_balances');
    setIsAuthenticated(false);
    setStep('upload');
    setUploadedFileUrl(null);
    setPdfPassword(null);
    setCurrentTransactions([]);
    setBalances({ opening: 0, closing: 0 });
  };

  React.useEffect(() => {
    const handleNav = () => {
      setStep('upload');
      setUploadedFileUrl(null);
      setCurrentTransactions([]);
      setBalances({ opening: 0, closing: 0 });
    };
    window.addEventListener('nav-to-upload', handleNav);
    return () => window.removeEventListener('nav-to-upload', handleNav);
  }, []);

  const handleUpload = (file, fileUrl, transactions, openingBalance, closingBalance, password) => {
    // If backend returns a URL, use it, otherwise fallback to local blob for preview
    const finalUrl = fileUrl || URL.createObjectURL(file);
    setUploadedFileUrl(finalUrl);
    setPdfPassword(password || null);
    setCurrentTransactions(transactions || []);
    setBalances({ 
      opening: openingBalance || 0, 
      closing: closingBalance || 0 
    });
    setStep('edit');
  };

  const navItems = [
    { id: 'upload', label: 'Home', icon: <Home className="w-4 h-4" />, action: () => setStep('upload'), active: step === 'upload' || step === 'edit' },
    { id: 'statements', label: 'My Statements', icon: <FileText className="w-4 h-4" />, action: () => setStep('statements'), active: step === 'statements' },
  ];

  if (!isAuthenticated) {
    return <LoginPage onLogin={handleLogin} />;
  }

  const renderContent = () => {
    switch (step) {
      case 'upload':
        return (
          <motion.div
            key="upload-page"
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            className="py-12"
          >
            <div className="text-center mb-12">
              <h1 className="text-4xl md:text-5xl font-extrabold text-slate-900 mb-4 tracking-tight">
                Regenerate <span className="gradient-text">Financial Accuracy</span>
              </h1>
              <p className="text-lg text-slate-500 max-w-2xl mx-auto leading-relaxed">
                Transform static PDF statements into editable data engines. Correct values, add missing entries, and maintain pixel-perfect formatting.
              </p>
            </div>

            <FileUploader onUpload={handleUpload} />

            <div className="grid grid-cols-1 md:grid-cols-3 gap-8 mt-24">
              <FeatureCard
                icon={<RefreshCw className="w-6 h-6 text-blue-600" />}
                title="Auto-Recalculation"
                description="Modify any debit or credit value and watch every subsequent running balance update instantly."
              />
              <FeatureCard
                icon={<Layout className="w-6 h-6 text-emerald-600" />}
                title="Layout Preservation"
                description="Engineered to retain precise spacing, font weights, and table alignments of the original statement."
              />
              <FeatureCard
                icon={<Shield className="w-6 h-6 text-purple-600" />}
                title="Audit Friendly"
                description="Full transparency into modifications with a structured export process for professional reporting."
              />
            </div>
          </motion.div>
        );
      case 'edit':
        return (
          <motion.div
            key="edit-page"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="w-full h-full"
          >
            <InPdfEditor
              fileUrl={uploadedFileUrl}
              password={pdfPassword}
              onUpdateFileUrl={setUploadedFileUrl}
              initialTransactions={currentTransactions}
              initialBalances={balances}
            />
          </motion.div>
        );
      case 'statements':
        return (
          <SectionPlaceholder
            title="My Statements"
            description="Access your library of processed and saved financial statements."
            icon={<FileText className="w-12 h-12 text-emerald-500" />}
          />
        );
      default:
        return null;
    }
  };

  return (
    <div className="min-h-screen bg-slate-50 font-sans text-slate-900 selection:bg-blue-100 selection:text-blue-900 flex flex-col">
      <Header navItems={navItems} onLogout={handleLogout} />

      {/* Main Content Area */}
      <main className="flex-1 overflow-hidden flex flex-col">
        <div className={`flex-1 ${step === 'edit' ? 'w-full' : 'max-w-7xl mx-auto p-4 md:p-8 w-full'}`}>
          <AnimatePresence mode="wait">
            {renderContent()}
          </AnimatePresence>
        </div>
      </main>
    </div>
  );
}

export default App;
