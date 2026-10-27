import { readTestDatabase } from './test-database.mjs';

// Runs before test modules load, including their imports that may create pg clients.
readTestDatabase();
