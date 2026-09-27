import { config as loadDotenv } from "dotenv";
import { boot } from "./boot/boot.js";

loadDotenv();

const handle = await boot();

const graceful = (signal: string) => {
  console.log(`[main] ${signal} recibido: apagando limpio...`);
  handle
    .stop()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("[main] error apagando:", err);
      process.exit(1);
    });
  // hard kill si el apagado se traba
  setTimeout(() => process.exit(0), 5000).unref();
};

process.on("SIGINT", () => graceful("SIGINT"));
process.on("SIGTERM", () => graceful("SIGTERM"));

process.on("unhandledRejection", (err) => {
  console.error("[main] unhandledRejection:", err);
});
process.on("uncaughtException", (err) => {
  console.error("[main] uncaughtException:", err);
  graceful("uncaughtException");
});

console.log("[main] bot corriendo. Ctrl-C para apagar.");
