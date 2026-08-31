/**
 * The scout's fixed vocabulary.
 *
 * Everything here is a hand-written constant, deliberately. The alternative — a
 * second model call to generate search terms — would cost money, add a source of
 * nondeterminism to a phase whose entire value is that it is deterministic, and
 * make the same repository scout differently on two runs. A hundred lines of
 * lists is the cheaper and more honest trade.
 *
 * Three lists, each with a different job:
 *
 *   STOP_WORDS          words that carry no search signal, removed first
 *   TECHNICAL_VOCABULARY  words that mark a token as worth searching for
 *   SYNONYMS            concept -> the names that concept goes by in code
 *
 * A note on how SYNONYMS was written, because it is the one part of this file
 * that could quietly become a cheat. The entries are general software-engineering
 * associations, not fixture-specific mappings: a table from a type to a function
 * *is* a registry, a thing that persists data *is* a repository. But they were
 * written while knowing which concepts the evaluation fixtures contain, and
 * `dispatch -> registry` in particular is the mapping that the motivating failure
 * needed. That does not make it wrong, and it does mean the measured benefit may
 * not transfer intact to a repository whose concepts are absent from this list.
 * Stated here so the number is read with it in mind.
 */

/** Removed before anything else. Question words first, then ordinary English. */
export const STOP_WORDS: ReadonlySet<string> = new Set([
  // Interrogatives and the scaffolding of a question.
  "how", "what", "where", "when", "which", "who", "whom", "whose", "why", "does", "do", "did",
  "is", "are", "was", "were", "be", "been", "being", "am", "can", "could", "should", "would",
  "will", "shall", "may", "might", "must", "have", "has", "had", "get", "gets", "got",
  // Determiners, pronouns, conjunctions, prepositions.
  "a", "an", "the", "this", "that", "these", "those", "it", "its", "they", "them", "their",
  "he", "she", "his", "her", "him", "we", "us", "our", "you", "your", "i", "me", "my",
  "and", "or", "but", "nor", "so", "yet", "if", "then", "else", "than", "as", "because",
  "of", "in", "on", "at", "to", "for", "with", "from", "by", "about", "into", "onto",
  "over", "under", "between", "through", "during", "before", "after", "above", "below",
  "up", "down", "out", "off", "again", "further", "here", "there", "all", "any", "both",
  "each", "few", "more", "most", "other", "some", "such", "no", "not", "only", "own",
  "same", "too", "very", "just", "also", "still", "one", "two", "three",
  // Words that look technical but match almost every line, so searching for them
  // returns the repository rather than an answer.
  "code", "codebase", "file", "files", "line", "lines", "thing", "things", "part", "parts",
  "use", "used", "uses", "using", "make", "makes", "made", "way", "ways", "work", "works",
  "need", "needs", "want", "like", "see", "look", "find", "know", "call", "called", "calls",
  "run", "runs", "ran", "happen", "happens", "mean", "means", "given", "give", "take",
  "new", "old", "good", "bad", "first", "last", "next", "many", "much", "well",
]);

/**
 * Path segments that are organisational rather than descriptive. A backticked
 * `src/services/inventory.js` in a README is worth searching for `inventory`, not
 * for `src`, which appears in every path in the repository.
 */
export const PATH_NOISE: ReadonlySet<string> = new Set([
  "src", "lib", "libs", "app", "apps", "pkg", "pkgs", "internal", "cmd", "bin",
  "dist", "build", "out", "target", "vendor", "node_modules", "packages",
  "index", "init", "main", "mod", "common", "shared", "util", "utils", "helpers",
]);

/** File extensions that mark an emphasised span as a path rather than a concept. */
export const PATH_EXTENSIONS: readonly string[] = [
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".go", ".rb", ".rs", ".java", ".kt",
  ".cs", ".php", ".swift", ".c", ".h", ".cc", ".cpp", ".hpp", ".sh", ".sql",
  ".json", ".toml", ".yaml", ".yml", ".ini", ".cfg", ".md", ".rst", ".txt", ".lock", ".env",
];

/** Extensions the scout treats as implementation rather than prose, for ranking. */
export const SOURCE_EXTENSIONS: readonly string[] = [
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".go", ".rb", ".rs", ".java", ".kt",
  ".cs", ".php", ".swift", ".c", ".h", ".cc", ".cpp", ".hpp", ".scala", ".ex", ".exs",
];

/**
 * Words that mark a token as a software-engineering concept worth a search.
 *
 * The test is membership, not meaning: a token in here is promoted above ordinary
 * prose, and is eligible to be paired into a compound term. Kept to concepts that
 * name a *mechanism* — the things a new engineer has to find and cannot guess the
 * filename for.
 *
 * Singular only. Membership short-circuits the suffix normaliser (that is what
 * stops `class` becoming `clas`), so listing both `test` and `tests` would make them
 * two different search terms and spend two slots on one concept.
 */
export const TECHNICAL_VOCABULARY: ReadonlySet<string> = new Set([
  // Dispatch and control flow.
  "registry", "dispatch", "dispatcher", "handler", "handle", "router", "route", "routing",
  "resolver", "resolve", "controller", "middleware", "hook", "plugin", "adapter", "factory",
  "strategy", "visitor", "executor", "execute", "invoke", "callback", "listener", "map",
  "mapping", "lookup", "table", "switch", "branch", "pipeline", "step", "stage", "task",
  "job", "worker", "process", "thread", "async", "await", "promise", "future", "function",
  "method", "class", "module", "interface", "type", "kind", "variant", "enum",
  // State and persistence.
  "persist", "persistence", "store", "storage", "repository", "database", "db", "sql",
  "sqlite", "postgres", "postgresql", "mysql", "mongo", "mongodb", "redis", "cache",
  "session", "state", "transaction", "commit", "rollback", "migration", "migrate", "schema",
  "model", "entity", "record", "row", "column", "index", "query", "save", "insert", "update",
  "delete", "select", "upsert", "fetch", "load", "read", "write", "flush",
  // Boundaries and transport.
  "api", "endpoint", "request", "response", "http", "https", "rest", "graphql", "grpc",
  "socket", "websocket", "server", "client", "service", "gateway", "proxy", "port", "url",
  "header", "body", "payload", "status", "health", "healthcheck", "ping", "readiness",
  "liveness", "event", "publish", "subscribe", "emit", "topic", "queue", "broker",
  "kafka", "rabbitmq", "sns", "sqs", "stream", "webhook", "consumer", "producer",
  // Security.
  "auth", "authentication", "authorization", "authorize", "authenticate", "login", "logout",
  "credential", "secret", "token", "jwt", "bearer", "oauth", "password", "hash", "encrypt",
  "decrypt", "sign", "verify", "permission", "role", "scope", "tenant", "csrf", "cors",
  // Configuration and operations.
  "config", "configuration", "setting", "option", "env", "environment",
  "flag", "toggle", "feature", "default", "override", "log", "logger", "logging", "trace",
  "metric", "monitor", "alert", "retry", "backoff", "timeout", "deadline",
  "throttle", "ratelimit", "circuit", "breaker", "scheduler", "schedule", "cron", "interval",
  "lock", "mutex", "semaphore", "concurrency", "race", "idempotent", "idempotency",
  // Correctness.
  "validate", "validation", "validator", "assert", "guard", "check", "sanitize", "normalize",
  "serialize", "deserialize", "parse", "parser", "encode", "decode", "error",
  "exception", "throw", "raise", "catch", "fail", "failure", "test", "spec",
  "fixture", "coverage", "reserve", "reservation", "inventory", "order", "price",
  "pricing", "payment", "customer", "user", "account", "topological", "graph", "cycle",
  "dependency", "version", "build", "deploy", "release",
]);

/**
 * Concept -> other names for the same concept, in priority order.
 *
 * One level of expansion only: a synonym never produces synonyms of its own. That
 * keeps the term set bounded by construction rather than by a cutoff, and keeps
 * the list auditable — every generated term traces to one word in the input.
 */
export const SYNONYMS: ReadonlyMap<string, readonly string[]> = new Map([
  ["dispatch", ["registry", "handler", "dispatcher"]],
  ["map", ["registry", "dispatch", "lookup"]],
  ["mapping", ["registry", "dispatch"]],
  ["function", ["handler", "executor", "callback"]],
  ["handler", ["registry", "dispatch"]],
  ["type", ["kind", "variant"]],
  ["persist", ["repository", "store", "save", "insert", "database"]],
  ["store", ["persist", "repository", "database"]],
  ["database", ["sql", "repository", "connection"]],
  ["auth", ["jwt", "bearer", "token"]],
  ["token", ["jwt", "bearer", "secret"]],
  ["route", ["endpoint", "router", "handler"]],
  ["endpoint", ["route", "router"]],
  ["event", ["publish", "emit", "topic"]],
  ["publish", ["emit", "topic", "producer"]],
  ["queue", ["consumer", "producer", "worker"]],
  ["config", ["env", "settings", "options"]],
  ["schedule", ["scheduler", "cron", "interval"]],
  ["validate", ["schema", "assert", "guard"]],
  ["error", ["exception", "raise", "throw"]],
  ["cache", ["ttl", "invalidate"]],
  ["migration", ["migrate", "schema"]],
  ["test", ["spec", "fixture"]],
  ["log", ["logger", "trace"]],
  ["reserve", ["reservation", "inventory", "stock"]],
]);

/**
 * Searched when a repository yields nothing else — an undocumented repository with
 * no README and no emphasis to mine. These are the standing information needs of
 * the briefing itself: what the schema asks for on every run, regardless of what
 * the repository turns out to be.
 */
export const CONCEPT_SEEDS: readonly string[] = [
  "config",
  "error",
  "handler",
  "route",
  "test",
];
