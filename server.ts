import * as dotenv from "dotenv";
import { hydrateProcessEnvFromInstanceFileSync } from "./server/setup/instanceFile.js";

dotenv.config();
hydrateProcessEnvFromInstanceFileSync();

import { startServer } from "./server/netnodeServer.js";

void startServer();
