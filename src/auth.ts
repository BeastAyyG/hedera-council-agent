// Fresh code, written 2026-11-06 for ETHGlobal Mumbai.
// API key guard for the state-changing routes. COUNCIL_API_KEY set: the
// request must carry it as `Authorization: Bearer <key>` or `x-api-key`.
// Unset: the routes stay open (demo and tests) and /health says so.

import { createHash, timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";

const digest = (v: string) => createHash("sha256").update(v).digest();

export interface ApiAuth {
  enabled: boolean;
  // Express middleware: 401 with no hint when the key is missing or wrong.
  require: (req: Request, res: Response, next: NextFunction) => void;
}

export function loadApiAuth(env: NodeJS.ProcessEnv): ApiAuth {
  const key = (env.COUNCIL_API_KEY ?? "").trim();
  if (!key) return { enabled: false, require: (_req, _res, next) => next() };
  const want = digest(key);
  return {
    enabled: true,
    require(req, res, next) {
      const bearer = /^Bearer (.+)$/i.exec(req.headers.authorization ?? "")?.[1];
      const header = req.headers["x-api-key"];
      const given = bearer ?? (typeof header === "string" ? header : "");
      // Equal-length digests, so the comparison never leaks the key length.
      if (given && timingSafeEqual(digest(given), want)) return next();
      res.status(401).json({ error: "Unauthorized" });
    },
  };
}
