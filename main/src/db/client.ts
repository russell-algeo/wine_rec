import fs from "node:fs";
import path from "node:path";

import { DatabaseSync } from "node:sqlite";

import { appConfig } from "../config.js";

const databaseDir = path.dirname(appConfig.databaseUrl);
fs.mkdirSync(databaseDir, { recursive: true });

export const sqlite = new DatabaseSync(appConfig.databaseUrl);
sqlite.exec("PRAGMA journal_mode = WAL;");
