import { useEffect, useRef, useState } from "react";
import {
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
export default function AuthModal({ t, onClose, onAuthenticated }) {
  const [step, setStep] = useState("email");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [remember, setRemember] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const firstFieldRef = useRef(null);

  useEffect(() => {
    firstFieldRef.current?.focus();
    setError("");
  }, [step]);

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
