import React, { useState } from 'react';
import { Lock, User, ShieldAlert, Languages } from 'lucide-react';
import { useTranslation } from '../lib/i18n';
import { cn } from '../lib/utils';

interface LoginProps {
  onLogin: (user: { id: string, username: string, role: string }) => void;
}

const Login: React.FC<LoginProps> = ({ onLogin }) => {
  const { t, language, setLanguage } = useTranslation();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      const data = await response.json();
      if (data.success) {
        onLogin(data.user);
      } else {
        setError(true);
        setTimeout(() => setError(false), 3000);
      }
    } catch (error) {
      setError(true);
      setTimeout(() => setError(false), 3000);
    }
  };

  return (
    <div className="min-h-screen w-full bg-[#1a1b1e] flex flex-col items-center justify-center p-4">
      <div className="absolute top-8 right-8 flex gap-2">
        <button 
          onClick={() => setLanguage('ru')}
          className={cn("px-3 py-1 rounded text-[10px] font-bold transition-all", language === 'ru' ? "bg-[#228be6] text-white" : "bg-[#25262b] text-[#5c5f66]")}
        >РУС</button>
        <button 
          onClick={() => setLanguage('en')}
          className={cn("px-3 py-1 rounded text-[10px] font-bold transition-all", language === 'en' ? "bg-[#228be6] text-white" : "bg-[#25262b] text-[#5c5f66]")}
        >ENG</button>
      </div>

      <div className="w-full max-w-md animate-in fade-in zoom-in duration-500">
        <div className="text-center mb-10">
          <div className="inline-flex items-center justify-center w-16 h-16 bg-[#228be6]/10 rounded-2xl mb-4 border border-[#228be6]/20">
            <Lock className="text-[#228be6]" size={32} />
          </div>
          <h1 className="text-4xl font-black text-white tracking-tighter uppercase italic">NetNode</h1>
          <p className="text-[#909296] text-sm font-mono mt-2">{t('authGateway')}</p>
        </div>

        <form onSubmit={handleSubmit} className="bg-[#25262b] border border-[#373a40] rounded-xl p-8 shadow-2xl space-y-6">
          {error && (
            <div className="bg-red-500/10 border border-red-500/50 p-3 rounded flex items-center gap-3 text-red-500 text-xs font-bold animate-in slide-in-from-top-2 uppercase">
              <ShieldAlert size={16} />
              {t('authFailed')}
            </div>
          )}

          <div className="space-y-2">
            <label className="text-[10px] font-bold text-[#909296] uppercase tracking-wider ml-1">{t('opId')}</label>
            <div className="relative">
              <User className="absolute left-3 top-1/2 -translate-y-1/2 text-[#5c5f66]" size={18} />
              <input 
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                className="w-full bg-[#141517] border border-[#373a40] py-3 pl-10 pr-4 rounded text-white focus:border-[#228be6] outline-none transition-all placeholder:text-[#5c5f66]"
                placeholder={t('opId')}
                required
              />
            </div>
          </div>

          <div className="space-y-2">
            <label className="text-[10px] font-bold text-[#909296] uppercase tracking-wider ml-1">{t('accToken')}</label>
            <div className="relative">
              <Lock className="absolute left-3 top-1/2 -translate-y-1/2 text-[#5c5f66]" size={18} />
              <input 
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full bg-[#141517] border border-[#373a40] py-3 pl-10 pr-4 rounded text-white focus:border-[#228be6] outline-none transition-all placeholder:text-[#5c5f66]"
                placeholder={t('accToken')}
                required
              />
            </div>
          </div>

          <button 
            type="submit"
            className="w-full bg-[#228be6] hover:bg-[#1c7ed6] text-white py-4 rounded font-bold uppercase tracking-widest text-xs transition-all shadow-lg active:scale-[0.98]"
          >
            {t('authorize')}
          </button>
        </form>

        <div className="mt-8 text-center">
          <p className="text-[10px] text-[#5c5f66] uppercase tracking-widest font-mono">
            {t('sysStatus')}: <span className="text-[#40c057]">{t('secured')}</span>
          </p>
        </div>
      </div>
    </div>
  );
};

export default Login;
