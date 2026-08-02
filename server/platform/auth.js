import crypto from "node:crypto";

export function requireAdmin(req, res, next) {
  const token = req.headers["x-admin-token"] || "";
  const expected = process.env.ADMIN_TOKEN || "";
  const ok =
    expected.length > 0 &&
    token.length === expected.length &&
    crypto.timingSafeEqual(Buffer.from(token), Buffer.from(expected));
  if (!ok) return res.status(401).json({ error: "unauthorized" });
  next();
}
