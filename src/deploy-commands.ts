/**
 * Registra los slash commands.
 * Global si no hay GUILD_ID; instantáneo por-server si lo hay.
 */
import { config as loadDotenv } from "dotenv";
import { REST, Routes } from "discord.js";
import { loadConfig } from "./config/index.js";
import { commands } from "./commands/index.js";

loadDotenv();

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const rest = new REST().setToken(config.discord.token);
  const body = commands.map((c) => c.data.toJSON());

  const route = config.guildId
    ? Routes.applicationGuildCommands(config.discord.clientId, config.guildId)
    : Routes.applicationCommands(config.discord.clientId);

  console.log(`[deploy] registrando ${body.length} comandos ${config.guildId ? `en guild ${config.guildId}` : "globalmente"}...`);
  const res = (await rest.put(route, { body })) as unknown[];
  console.log(`[deploy] OK: ${res.length} comandos registrados.`);
}

main().catch((err) => {
  console.error("[deploy] falló:", err);
  process.exit(1);
});
