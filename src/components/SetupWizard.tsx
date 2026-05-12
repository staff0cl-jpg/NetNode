import React, { useState } from "react";
import { Database, Languages, Lock, Server, User } from "lucide-react";
import { useTranslation } from "../lib/i18n";
import { cn } from "../lib/utils";

const SetupWizard: React.FC = () => {
  const { t, language, setLanguage } = useTranslation();
  const [siteLabel, setSiteLabel] = useState("");
  const [productName, setProductName] = useState("NETNODE");
  const [pgHost, setPgHost] = useState("localhost");
  const [pgPort, setPgPort] = useState("5432");
  const [pgDatabase, setPgDatabase] = useState("netnode");
  const [pgUser, setPgUser] = useState("netnode");
  const [pgPassword, setPgPassword] = useState("");
  const [amqpUrl, setAmqpUrl] = useState("");
  const [adminUsername, setAdminUsername] = useState("admin");
  const [adminPassword, setAdminPassword] = useState("");
  const [busy, setBusy] = useState<"idle" | "test" | "apply">("idle");
  const [message, setMessage] = useState<{ type: "ok" | "err"; text: string } | null>(null);

  const postgresBody = () => ({
    postgres: {
      host: pgHost.trim(),
      port: Number(pgPort) || 5432,
      database: pgDatabase.trim(),
      user: pgUser.trim(),
      password: pgPassword,
    },
  });

  const testDb = async () => {
    setBusy("test");
    setMessage(null);
    try {
      const r = await fetch("/api/setup/test-db", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(postgresBody()),
      });
      const j = (await r.json()) as { ok?: boolean; error?: string };
      if (!r.ok || !j.ok) {
        setMessage({ type: "err", text: j.error || t("setupTestFailed") });
      } else {
        setMessage({ type: "ok", text: t("setupTestOk") });
      }
    } catch {
      setMessage({ type: "err", text: t("setupTestFailed") });
    } finally {
      setBusy("idle");
    }
  };

  const apply = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy("apply");
    setMessage(null);
    try {
      const r = await fetch("/api/setup/apply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...postgresBody(),
          siteLabel: siteLabel.trim() || "UNSET",
          productName: productName.trim() || "NETNODE",
          amqpUrl: amqpUrl.trim() || undefined,
          adminUsername: adminUsername.trim(),
          adminPassword,
        }),
      });
      const j = (await r.json()) as { ok?: boolean; error?: string };
      if (!r.ok || !j.ok) {
        setMessage({ type: "err", text: j.error || t("setupApplyFailed") });
        setBusy("idle");
        return;
      }
      setMessage({ type: "ok", text: t("setupApplyOk") });
      window.setTimeout(() => window.location.reload(), 800);
    } catch {
      setMessage({ type: "err", text: t("setupApplyFailed") });
      setBusy("idle");
    }
  };

  return (
    <div className="min-h-screen w-full bg-[#1a1b1e] flex flex-col items-center justify-center p-4">
      <div className="absolute top-8 right-8 flex gap-2">
        <button
          type="button"
          onClick={() => setLanguage("ru")}
          className={cn(
            "px-3 py-1 rounded text-[10px] font-bold transition-all",
            language === "ru" ? "bg-[#228be6] text-white" : "bg-[#25262b] text-[#5c5f66]"
          )}
        >
          РУС
        </button>
        <button
          type="button"
          onClick={() => setLanguage("en")}
          className={cn(
            "px-3 py-1 rounded text-[10px] font-bold transition-all",
            language === "en" ? "bg-[#228be6] text-white" : "bg-[#25262b] text-[#5c5f66]"
          )}
        >
          ENG
        </button>
      </div>

      <div className="w-full max-w-lg animate-in fade-in zoom-in duration-500">
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-16 h-16 bg-[#40c057]/10 rounded-2xl mb-4 border border-[#40c057]/25">
            <Server className="text-[#40c057]" size={32} />
          </div>
          <h1 className="text-2xl font-black text-white tracking-tight uppercase">{t("setupTitle")}</h1>
          <p className="text-[#909296] text-xs font-mono mt-2">{t("setupSubtitle")}</p>
        </div>

        <form onSubmit={apply} className="bg-[#25262b] border border-[#373a40] rounded-xl p-6 shadow-2xl space-y-5">
          {message && (
            <div
              className={cn(
                "p-3 rounded text-xs font-bold border",
                message.type === "ok"
                  ? "bg-emerald-500/10 border-emerald-500/40 text-emerald-400"
                  : "bg-red-500/10 border-red-500/50 text-red-400"
              )}
            >
              {message.text}
            </div>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="space-y-1">
              <label className="text-[10px] font-bold text-[#909296] uppercase tracking-wider">{t("setupSiteLabel")}</label>
              <input
                value={siteLabel}
                onChange={(e) => setSiteLabel(e.target.value)}
                className="w-full bg-[#141517] border border-[#373a40] py-2 px-3 rounded text-white text-sm outline-none focus:border-[#228be6]"
                placeholder="NOC"
              />
            </div>
            <div className="space-y-1">
              <label className="text-[10px] font-bold text-[#909296] uppercase tracking-wider">{t("setupProductName")}</label>
              <input
                value={productName}
                onChange={(e) => setProductName(e.target.value)}
                className="w-full bg-[#141517] border border-[#373a40] py-2 px-3 rounded text-white text-sm outline-none focus:border-[#228be6]"
                required
              />
            </div>
          </div>

          <div className="border-t border-[#373a40] pt-4 space-y-3">
            <div className="flex items-center gap-2 text-[#c1c2c5] text-xs font-bold uppercase tracking-wider">
              <Database size={14} className="text-[#228be6]" />
              {t("setupPostgresSection")}
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1 col-span-2 sm:col-span-1">
                <label className="text-[10px] font-bold text-[#909296] uppercase">{t("setupPgHost")}</label>
                <input
                  value={pgHost}
                  onChange={(e) => setPgHost(e.target.value)}
                  className="w-full bg-[#141517] border border-[#373a40] py-2 px-3 rounded text-white text-sm outline-none focus:border-[#228be6]"
                  required
                />
              </div>
              <div className="space-y-1">
                <label className="text-[10px] font-bold text-[#909296] uppercase">{t("setupPgPort")}</label>
                <input
                  value={pgPort}
                  onChange={(e) => setPgPort(e.target.value)}
                  className="w-full bg-[#141517] border border-[#373a40] py-2 px-3 rounded text-white text-sm outline-none focus:border-[#228be6]"
                  required
                />
              </div>
              <div className="space-y-1 col-span-2">
                <label className="text-[10px] font-bold text-[#909296] uppercase">{t("setupPgDatabase")}</label>
                <input
                  value={pgDatabase}
                  onChange={(e) => setPgDatabase(e.target.value)}
                  className="w-full bg-[#141517] border border-[#373a40] py-2 px-3 rounded text-white text-sm outline-none focus:border-[#228be6]"
                  required
                />
              </div>
              <div className="space-y-1 col-span-2 sm:col-span-1">
                <label className="text-[10px] font-bold text-[#909296] uppercase">{t("setupPgUser")}</label>
                <input
                  value={pgUser}
                  onChange={(e) => setPgUser(e.target.value)}
                  className="w-full bg-[#141517] border border-[#373a40] py-2 px-3 rounded text-white text-sm outline-none focus:border-[#228be6]"
                  autoComplete="off"
                  required
                />
              </div>
              <div className="space-y-1 col-span-2 sm:col-span-1">
                <label className="text-[10px] font-bold text-[#909296] uppercase">{t("setupPgPassword")}</label>
                <input
                  type="password"
                  value={pgPassword}
                  onChange={(e) => setPgPassword(e.target.value)}
                  className="w-full bg-[#141517] border border-[#373a40] py-2 px-3 rounded text-white text-sm outline-none focus:border-[#228be6]"
                  autoComplete="new-password"
                />
              </div>
            </div>
            <button
              type="button"
              onClick={testDb}
              disabled={busy !== "idle"}
              className="w-full py-2 rounded border border-[#373a40] text-[11px] font-bold uppercase tracking-wider text-[#c1c2c5] hover:bg-[#2c2e33] disabled:opacity-50"
            >
              {busy === "test" ? t("setupTesting") : t("setupTestConnection")}
            </button>
          </div>

          <div className="border-t border-[#373a40] pt-4 space-y-1">
            <label className="text-[10px] font-bold text-[#909296] uppercase tracking-wider flex items-center gap-2">
              <Languages size={12} />
              {t("setupAmqpOptional")}
            </label>
            <input
              value={amqpUrl}
              onChange={(e) => setAmqpUrl(e.target.value)}
              className="w-full bg-[#141517] border border-[#373a40] py-2 px-3 rounded text-white text-sm outline-none focus:border-[#228be6] font-mono text-xs"
              placeholder="amqp://user:pass@localhost:5672/"
            />
          </div>

          <div className="border-t border-[#373a40] pt-4 space-y-3">
            <div className="flex items-center gap-2 text-[#c1c2c5] text-xs font-bold uppercase tracking-wider">
              <User size={14} className="text-[#228be6]" />
              {t("setupAdminSection")}
            </div>
            <div className="space-y-1">
              <label className="text-[10px] font-bold text-[#909296] uppercase">{t("setupAdminUsername")}</label>
              <input
                value={adminUsername}
                onChange={(e) => setAdminUsername(e.target.value)}
                className="w-full bg-[#141517] border border-[#373a40] py-2 px-3 rounded text-white text-sm outline-none focus:border-[#228be6]"
                autoComplete="username"
                required
              />
            </div>
            <div className="space-y-1">
              <label className="text-[10px] font-bold text-[#909296] uppercase flex items-center gap-1">
                <Lock size={10} />
                {t("setupAdminPassword")}
              </label>
              <input
                type="password"
                value={adminPassword}
                onChange={(e) => setAdminPassword(e.target.value)}
                className="w-full bg-[#141517] border border-[#373a40] py-2 px-3 rounded text-white text-sm outline-none focus:border-[#228be6]"
                autoComplete="new-password"
                minLength={10}
                required
              />
              <p className="text-[10px] text-[#5c5f66]">{t("setupAdminPasswordHint")}</p>
            </div>
          </div>

          <button
            type="submit"
            disabled={busy !== "idle"}
            className="w-full py-3 rounded-lg bg-[#228be6] hover:bg-[#1c7ed6] text-white text-xs font-black uppercase tracking-widest disabled:opacity-50"
          >
            {busy === "apply" ? t("setupApplying") : t("setupFinish")}
          </button>
        </form>
      </div>
    </div>
  );
};

export default SetupWizard;
