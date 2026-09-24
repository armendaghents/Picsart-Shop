// Outbound email.
//
// If SMTP_HOST is configured, mail is sent for real. If it isn't — which is the
// normal case in development — the message is printed to the server log instead,
// so verification codes and reset links are still usable without a mail account.
// Nothing else in the app needs to know which mode is active.

import nodemailer from "nodemailer";

const SMTP_HOST = process.env.SMTP_HOST;
const MAIL_FROM = process.env.MAIL_FROM || "Picsart Shop <no-reply@picsart.shop>";

// Refuse to run in production without a mail server. The fallback below prints
// whatever it was asked to send, so an unset (or misspelled) SMTP_HOST would
// write every verification and password-reset code to the log in plaintext —
// anyone who can read logs could then take over any account. Development is
// unaffected: NODE_ENV is unset there, so the fallback stays available.
if (!SMTP_HOST && process.env.NODE_ENV === "production") {
  console.error(
    [
      "",
      "FATAL: SMTP_HOST is not set, but NODE_ENV=production.",
      "",
      "Verification and password-reset codes would be written to this log in",
      "plaintext instead of being emailed, which would let anyone with log",
      "access take over any account. Refusing to start.",
      "",
      "Set SMTP_HOST (and SMTP_USER / SMTP_PASSWORD / MAIL_FROM), or unset",
      "NODE_ENV to run in development mode.",
      "",
    ].join("\n")
  );
  process.exit(1);
}

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

// Reports what happened rather than throwing, so each caller can decide. Codes
// the customer must receive (verification, password reset) surface a failure via
// deliverCode in server.js; pure notifications (new sign-in, password changed)
// stay fire-and-forget, since a mail blip shouldn't fail the action itself.
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

// ---------------------------------------------------------------------------
// Orders
// ---------------------------------------------------------------------------

// The address block, laid out the way it would be written on a parcel.
function deliveryBlock(delivery) {
  if (!delivery) return [];
  if (delivery.method === "pickup") {
    return [
      "Collecting in person:",
      `  ${delivery.name}`,
      `  ${delivery.phone}`,
      "",
      "We'll call you when it's ready to collect.",
    ];
  }
  const lines = [
    delivery.name,
    delivery.phone,
    delivery.line1,
    delivery.line2,
    [delivery.postalCode, delivery.city].filter(Boolean).join(" "),
    delivery.country,
  ].filter(Boolean);
  return ["Delivering to:", ...lines.map((line) => `  ${line}`)];
}

// Sent the moment an order is placed.
//
// NOTE: it deliberately does not say anything about payment, because checkout
// does not take any — saying "payment received" would be a lie the shop cannot
// back up. Once payments land, either move this send to the 'paid' transition
// or add a second message for it.
export function orderConfirmationEmail({ orderNumber, placedAt, lines, total, delivery }) {
  const items = lines.map((line) => `  ${line.quantity} × ${line.name} — ${line.lineTotal}`);
  const notes = delivery?.notes ? ["", `Your note: ${delivery.notes}`] : [];

  return {
    // The order number is in the subject so the customer can find this message
    // again by searching their inbox for the number support asks them for.
    subject: `Your Picsart Shop order ${orderNumber}`,
    text: [
      "Thanks for your order — here's what we've got.",
      "",
      `Order:  ${orderNumber}`,
      `Placed: ${placedAt} UTC`,
      "",
      ...items,
      "",
      `Total:  ${total}`,
      "",
      ...deliveryBlock(delivery),
      ...notes,
      "",
      "We'll email you again when it's on its way.",
    ].join("\n"),
  };
}

// Sent when staff move an order along. Only the transitions a customer needs to
// hear about: 'paid' is deliberately absent, because until a payment provider
// confirms it, marking an order paid is an internal bookkeeping step and not
// something to tell a customer their money has been taken for.
const STATUS_MESSAGES = {
  shipped: {
    subject: (number) => `Your Picsart Shop order ${number} is on its way`,
    body: "Your order has been handed to the courier and is on its way to you.",
  },
  cancelled: {
    subject: (number) => `Your Picsart Shop order ${number} was cancelled`,
    body: "Your order has been cancelled and nothing will be sent. If you didn't ask for this, reply to this message and we'll look into it.",
  },
  refunded: {
    subject: (number) => `Your Picsart Shop order ${number} was refunded`,
    body: "Your order has been refunded. Depending on your bank, the money can take a few working days to appear.",
  },
};

export function orderStatusEmail({ orderNumber, status }) {
  const message = STATUS_MESSAGES[status];
  if (!message) return null;
  return {
    subject: message.subject(orderNumber),
    text: [message.body, "", `Order: ${orderNumber}`].join("\n"),
  };
}
