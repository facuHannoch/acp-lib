import { SqliteAgentPersistence } from "../../src/persistence/sqlite-backend.ts";

const databasePath = process.argv[2];
const readyPath = process.argv[3];
if (!databasePath || !readyPath) throw new Error("expected database and ready paths");

const persistence = await SqliteAgentPersistence.open({ path: databasePath });
await Bun.write(readyPath, "ready");

await new Promise<void>((resolve) => {
  process.once("SIGINT", resolve);
  process.once("SIGTERM", resolve);
});
await persistence.close();
