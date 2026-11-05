import "server-only";

// Compatibility barrel for server-side callers and the validation test suite.
// Browser clients import only `env/public` so secret-key validation stays out
// of the client dependency graph.
export { validateSupabasePublicEnv } from "./env/public";
export { validateSupabaseAdminEnv } from "./env/admin";
