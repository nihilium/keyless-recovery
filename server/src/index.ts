import express from "express";
import cors from "cors";
import { config } from "./config.js";
import { relayRouter } from "./routes/relay.js";
import { adminRouter } from "./routes/admin.js";
import { sealsRouter } from "./routes/seals.js";
import { accountsRouter } from "./routes/accounts.js";
import { relayerAddress, guardianAddresses } from "./chain.js";
import { logError, logInfo } from "./log.js";

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" })); // seals carry per-share proof material

// One line in, one line out, with the status and how long it took.
app.use((req, res, next) => {
  const at = Date.now();
  res.on("finish", () => {
    const line = `${req.method} ${req.originalUrl} -> ${res.statusCode} (${Date.now() - at}ms)`;
    if (res.statusCode >= 400) logInfo("http", `FAILED ${line}`);
    else logInfo("http", line);
  });
  next();
});

app.use("/api/relay", relayRouter);
app.use("/api/seals", sealsRouter);
app.use("/api/accounts", accountsRouter);
app.use("/api/admin", adminRouter);

app.get("/health", (_req, res) => res.json({ ok: true }));

// Anything that escaped a route handler still gets logged rather than vanishing into a bare 500.
app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  logError("http", "unhandled error in request", err);
  res.status(500).json({ error: (err as Error)?.message ?? "Internal error" });
});

process.on("unhandledRejection", (reason) => logError("process", "unhandled promise rejection", reason));
process.on("uncaughtException", (err) => logError("process", "uncaught exception", err));

app.listen(config.port, () => {
  logInfo("boot", `relayer listening on :${config.port}`, {
    chain: config.networkId,
    module: "0x00339522A395f0d0838Ad5cf979fAdc8B9c6269B",
  });
  logInfo("boot", "signers", {
    relayer: relayerAddress,
    pause: guardianAddresses.pause,
    abort: guardianAddresses.abort,
    resume: guardianAddresses.resume,
  });
  logInfo("boot", "set LOG_STACKS=1 for full stack traces");
});
