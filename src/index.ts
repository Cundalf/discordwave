import { config as loadDotenv } from "dotenv";
import { boot } from "./boot/boot.js";

loadDotenv();

const handle = await boot();

const graceful = (signal: string, exitCode = 0) => {
  console.log(`[main] ${signal} recibido: apagando limpio...`);
  handle
    .stop()
    .then(() => process.exit(exitCode))
    .catch((err) => {
      console.error("[main] error apagando:", err);
      process.exit(1);
    });
  // hard kill si el apagado se traba
  setTimeout(() => process.exit(exitCode), 5000).unref();
};

process.on("SIGINT", () => graceful("SIGINT"));
process.on("SIGTERM", () => graceful("SIGTERM"));

process.on("unhandledRejection", (err) => {
  console.error("[main] unhandledRejection:", err);
});
process.on("uncaughtException", (err) => {
  console.error("[main] uncaughtException:", err);
  graceful("uncaughtException", 1); // crash ≠ apagado limpio
});

console.log("[main] bot corriendo. Ctrl-C para apagar.");
