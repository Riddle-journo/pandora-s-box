// Trivial, stateless helpers shared between store.js and the store/* domain
// modules. They live HERE (not in store.js) so a store/* module can import them
// without importing store.js — store.js may depend on store/*, never the reverse.
import crypto from "node:crypto";

export const id = () => crypto.randomUUID();

export const J = (row) => (row ? JSON.parse(row.data) : null);
export const lc = (s) => String(s ?? "").toLowerCase();
