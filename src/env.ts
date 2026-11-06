// Loads .env into process.env for the CLI entry points (server, demo,
// preflight). Real environment variables win over the file.
import { existsSync } from "node:fs";

if (existsSync(".env")) process.loadEnvFile(".env");
