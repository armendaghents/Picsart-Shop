import { useEffect, useRef, useState } from "react";
import {
  fetchAuthProviders,
  forgotPassword,
  login,
  lookupEmail,
  register,
  resendCode,
  resetPassword,
  verifyEmail,
  verifyTwoFactor,
} from "../api";

// The sign-in flow, as one modal that walks through steps:
//
//   email ──┬─► password ──┬─► (done)
//           │              └─► twoFactor ─► (done)
//           ├─► register ──► verify ─► (done)
//           └─► forgot ────► reset ──► (done)
//
// Identifying and authenticating are deliberately separate, the way Amazon and
// most large shops do it: the server is asked whether the address has an
// account, and the form then goes down the right branch instead of making
// people pick "sign in" or "register" before they've typed anything.
export default function AuthModal({ t, onClose, onAuthenticated, initialError = "" }) {
  const [step, setStep] = useState("email");
  const [googleEnabled, setGoogleEnabled] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [remember, setRemember] = useState(true);
  const [error, setError] = useState(initialError);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const firstFieldRef = useRef(null);

  // Skipped on the very first render so an error carried in from a failed
  // redirect sign-in survives long enough to be read.
  const firstRender = useRef(true);
  useEffect(() => {
    firstFieldRef.current?.focus();
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    setError("");
  }, [step]);

  useEffect(() => {
    fetchAuthProviders()
      .then((providers) => setGoogleEnabled(Boolean(providers?.google)))
      .catch(() => setGoogleEnabled(false));
  }, []);

  useEffect(() => {
    function onKeyDown(event) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  // Every step submits through here, so error handling and the busy state are
  // written once.
  function submitter(handler) {
    return async (event) => {
      event.preventDefault();
      setBusy(true);
      setError("");
      setNotice("");
      try {
        await handler();
      } catch (submitError) {
        // A half-finished registration is a step, not a failure: send them to
        // the code screen instead of showing an error.
        if (submitError.code === "verification_required") {
          setStep("verify");
          setNotice(submitError.message);
        } else {
          setError(submitError.message);
        }
      } finally {
        setBusy(false);
      }
    };
  }

  const handleEmail = submitter(async () => {
    const { exists, pendingVerification } = await lookupEmail(email);
    if (pendingVerification) {
      await resendCode({ email, purpose: "verify" });
      setStep("verify");
    } else {
      setStep(exists ? "password" : "register");
    }
  });

  const handlePassword = submitter(async () => {
    const result = await login({ email, password, remember });
    if (result.requiresTwoFactor) {
      setCode("");
      setStep("twoFactor");
      return;
    }
    onAuthenticated(result.user);
  });

  const handleRegister = submitter(async () => {
    await register({ email, password, name });
    setStep("verify");
  });

  const handleVerify = submitter(async () => {
    const result = await verifyEmail({ email, code, remember });
    onAuthenticated(result.user);
  });

  const handleTwoFactor = submitter(async () => {
    const result = await verifyTwoFactor(code);
    onAuthenticated(result.user);
  });

  const handleForgot = submitter(async () => {
    await forgotPassword(email);
    setCode("");
    setPassword("");
    setStep("reset");
  });

  const handleReset = submitter(async () => {
    const result = await resetPassword({ email, code, password });
    onAuthenticated(result.user);
  });

  const handleResend = submitter(async () => {
    await resendCode({ email, purpose: step === "reset" ? "reset" : "verify" });
    setNotice(t.codeResent);
  });

  const titles = {
    email: [t.emailStepTitle, t.emailStepSubtitle],
    password: [t.passwordStepTitle, email],
    register: [t.registerTitle, t.newAccountFor(email)],
    verify: [t.verifyTitle, t.verifySubtitle(email)],
    twoFactor: [t.twoFactorTitle, t.twoFactorSubtitle],
    forgot: [t.forgotTitle, t.forgotSubtitle],
    reset: [t.resetTitle, t.resetSubtitle(email)],
  };
  const [title, subtitle] = titles[step];

  const codeField = (
    <label>
      {step === "twoFactor" ? t.verificationCode : t.verificationCode}
      <input
        ref={firstFieldRef}
        className="code-input"
        value={code}
        onChange={(event) => setCode(event.target.value)}
        inputMode={step === "twoFactor" ? "text" : "numeric"}
        autoComplete="one-time-code"
        maxLength={step === "twoFactor" ? 11 : 6}
        required
      />
    </label>
  );

  const passwordField = (label, autoComplete, ref) => (
    <label>
      {label}
      <input
        ref={ref}
        type="password"
        value={password}
        onChange={(event) => setPassword(event.target.value)}
        autoComplete={autoComplete}
        minLength={8}
        required
      />
    </label>
  );

  const rememberField = (
    <label className="auth-check">
      <input type="checkbox" checked={remember} onChange={(event) => setRemember(event.target.checked)} />
      <span>{t.keepSignedIn}</span>
    </label>
  );

  const forms = {
    email: (
      <form onSubmit={handleEmail}>
        <label>
          {t.email}
          <input
            ref={firstFieldRef}
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            autoComplete="email"
            required
          />
        </label>
        <Submit busy={busy} t={t} label={t.continueLabel} />
      </form>
    ),
    password: (
      <form onSubmit={handlePassword}>
        {passwordField(t.password, "current-password", firstFieldRef)}
        {rememberField}
        <Submit busy={busy} t={t} label={t.signIn} />
        <button className="auth-link" type="button" onClick={() => setStep("forgot")}>
          {t.forgotPassword}
        </button>
      </form>
    ),
    register: (
      <form onSubmit={handleRegister}>
        <label>
          {t.nameOptional}
          <input ref={firstFieldRef} value={name} onChange={(event) => setName(event.target.value)} autoComplete="name" maxLength={100} />
        </label>
        {passwordField(t.password, "new-password")}
        <p className="auth-hint">{t.passwordHint}</p>
        {rememberField}
        <Submit busy={busy} t={t} label={t.createAccount} />
      </form>
    ),
    verify: (
      <form onSubmit={handleVerify}>
        {codeField}
        <Submit busy={busy} t={t} label={t.continueLabel} />
        <button className="auth-link" type="button" onClick={handleResend} disabled={busy}>
          {t.resendCode}
        </button>
      </form>
    ),
    twoFactor: (
      <form onSubmit={handleTwoFactor}>
        {codeField}
        <Submit busy={busy} t={t} label={t.continueLabel} />
      </form>
    ),
    forgot: (
      <form onSubmit={handleForgot}>
        <label>
          {t.email}
          <input ref={firstFieldRef} type="email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="email" required />
        </label>
        <Submit busy={busy} t={t} label={t.sendResetCode} />
      </form>
    ),
    reset: (
      <form onSubmit={handleReset}>
        {codeField}
        {passwordField(t.newPassword, "new-password")}
        <p className="auth-hint">{t.passwordHint}</p>
        <Submit busy={busy} t={t} label={t.savePassword} />
        <button className="auth-link" type="button" onClick={handleResend} disabled={busy}>
          {t.resendCode}
        </button>
      </form>
    ),
  };

  return (
    <div className="modal-overlay" onClick={(event) => event.target === event.currentTarget && onClose()}>
      <div className="auth-modal" role="dialog" aria-modal="true" aria-label={title}>
        <button className="modal-close" type="button" onClick={onClose} aria-label={t.close}>
          ×
        </button>

        <h2>{title}</h2>
        <p className="auth-subtitle">{subtitle}</p>

        {notice && <p className="auth-notice">{notice}</p>}
        {error && <p className="auth-error">{error}</p>}

        {forms[step]}

        {/* Offered on the first step only: once the flow has branched into a
            password, a code, or a reset, switching identity mid-way would be
            more confusing than helpful. A plain link, not a script-driven
            widget, so the page's Content-Security-Policy stays untouched. */}
        {step === "email" && googleEnabled && (
          <>
            <div className="auth-separator">
              <span>{t.orSeparator}</span>
            </div>
            <a
              className="auth-google"
              href={`/api/auth/google${email ? `?email=${encodeURIComponent(email)}` : ""}`}
            >
              <svg viewBox="0 0 18 18" aria-hidden="true" focusable="false">
                <path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62Z" />
                <path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.94v2.33A9 9 0 0 0 9 18Z" />
                <path fill="#FBBC05" d="M3.97 10.72a5.4 5.4 0 0 1 0-3.44V4.95H.94a9 9 0 0 0 0 8.1l3.03-2.33Z" />
                <path fill="#EA4335" d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.59C13.46.89 11.43 0 9 0A9 9 0 0 0 .94 4.95l3.03 2.33C4.68 5.16 6.66 3.58 9 3.58Z" />
              </svg>
              {t.continueWithGoogle}
            </a>
          </>
        )}

        {step !== "email" && (
          <button
            className="auth-back"
            type="button"
            onClick={() => {
              setStep("email");
              setPassword("");
              setCode("");
            }}
          >
            ← {t.back}
          </button>
        )}
      </div>
    </div>
  );
}

function Submit({ busy, t, label }) {
  return (
    <button className="auth-submit" type="submit" disabled={busy}>
      {busy ? t.working : label}
    </button>
  );
}
