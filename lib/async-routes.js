// ---------------------------------------------------------------------------
// Async-safe route registration
//
// Express 4 does not catch exceptions thrown inside async handlers: an
// unhandled rejection in any single route takes the entire process down, so one
// malformed request could close the shop. Wrapping registration once gives
// every handler the same safety net, and a failure becomes a 500 for that one
// request instead of an outage.
//
// Applied to each Router rather than only to the app, because a Router
// registers its own handlers and would otherwise miss the net entirely — the
// kind of gap that stays invisible until the first rejection in production.
// ---------------------------------------------------------------------------

import express from "express";

const METHODS = ["get", "post", "put", "patch", "delete"];

function wrap(handler) {
  // Arity 4 means (error, request, response, next) — an error handler, which
  // must keep its shape or Express stops recognising it as one.
  if (typeof handler !== "function" || handler.length >= 4) return handler;
  return function wrapped(request, response, next) {
    try {
      const result = handler(request, response, next);
      if (result && typeof result.catch === "function") result.catch(next);
      return result;
    } catch (error) {
      return next(error);
    }
  };
}

export function withAsyncErrors(target) {
  for (const method of METHODS) {
    const register = target[method].bind(target);
    target[method] = (routePath, ...handlers) => register(routePath, ...handlers.map(wrap));
  }
  return target;
}

// The Router every route module should build on.
export function asyncRouter() {
  return withAsyncErrors(express.Router());
}
