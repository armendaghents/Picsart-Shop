// Outbound email.
//
// If SMTP_HOST is configured, mail is sent for real. If it isn't — which is the
// normal case in development — the message is printed to the server log instead,
// so verification codes and reset links are still usable without a mail account.
// Nothing else in the app needs to know which mode is active.

import nodemailer from "nodemailer";

const SMTP_HOST = process.env.SMTP_HOST;
const MAIL_FROM = process.env.MAIL_FROM || "Picsart Shop <no-reply@picsart.shop>";

let transport = null;
if (SMTP_HOST) {
  transport = nodemailer.createTransport({
    host: SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: String(process.env.SMTP_SECURE || "") === "true",
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD } : undefined,
  });
  console.log(`[mail] sending through ${SMTP_HOST}`);
} else {
  console.warn(
    "WARNING: SMTP_HOST is not set — verification codes and password reset links will be printed to this log instead of emailed."
  );
}

export const emailIsConfigured = Boolean(SMTP_HOST);

// Never let a mail failure break the request that triggered it: a customer who
// registers successfully should not see an error because the mail server blipped.
export async function sendMail({ to, subject, text }) {
  if (!transport) {
    console.log(
      ["", "──────────── email (not sent — no SMTP configured) ────────────",
       `To:      ${to}`, `Subject: ${subject}`, "", text,
       "───────────────────────────────────────────────────────────────", ""].join("\n")
    );
    return { delivered: false, logged: true };
  }

  try {
    await transport.sendMail({ from: MAIL_FROM, to, subject, text });
    return { delivered: true };
  } catch (error) {
    console.error(`[mail] failed to send "${subject}" to ${to}:`, error.message);
    return { delivered: false, error: error.message };
  }
}

// ---------------------------------------------------------------------------
// Templates. Plain text on purpose: it renders everywhere, can't carry a
// tracking pixel, and gives phishing filters nothing to object to.
// ---------------------------------------------------------------------------
export function verificationEmail(code) {
  return {
    subject: `${code} is your Picsart Shop verification code`,
    text: [
      `Your verification code is ${code}`,
      "",
      "Enter it in the shop to finish creating your account. The code expires in 15 minutes.",
      "",
      "If you didn't try to create an account, you can ignore this message — no account exists until the code is entered.",
    ].join("\n"),
  };
}

export function passwordResetEmail(code) {
  return {
    subject: `${code} is your Picsart Shop password reset code`,
    text: [
      `Your password reset code is ${code}`,
      "",
      "Enter it in the shop to choose a new password. The code expires in 15 minutes and can only be used once.",
      "",
      "If you didn't ask to reset your password, ignore this message — your password has not changed.",
    ].join("\n"),
  };
}

export function passwordChangedEmail() {
  return {
    subject: "Your Picsart Shop password was changed",
    text: [
      "The password on your Picsart Shop account was just changed, and every device signed in to it has been signed out.",
      "",
      "If this wasn't you, reset your password immediately — whoever changed it can currently sign in.",
    ].join("\n"),
  };
}

export function newSignInEmail({ when, ip, userAgent }) {
  return {
    subject: "New sign-in to your Picsart Shop account",
    text: [
      "Your Picsart Shop account was just signed in to.",
      "",
      `When:    ${when} UTC`,
      `IP:      ${ip || "unknown"}`,
      `Device:  ${userAgent || "unknown"}`,
      "",
      "If this was you, nothing to do. If it wasn't, change your password — that signs out every device.",
    ].join("\n"),
  };
}

export function twoFactorEnabledEmail(enabled) {
  return {
    subject: enabled ? "Two-step verification is on" : "Two-step verification is off",
    text: enabled
      ? "Two-step verification was turned on for your Picsart Shop account. Signing in now needs a code from your authenticator app.\n\nIf this wasn't you, change your password immediately."
      : "Two-step verification was turned off for your Picsart Shop account.\n\nIf this wasn't you, change your password immediately.",
  };
}
