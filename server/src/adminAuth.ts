import type { NextFunction, Request, Response } from "express";
import { config } from "./config.js";

export function requireAdminToken(req: Request, res: Response, next: NextFunction) {
  if (req.header("x-admin-token") !== config.adminToken) {
    res.status(401).json({ error: "Invalid admin token." });
    return;
  }
  next();
}
