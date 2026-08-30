import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * Builds the fixture repositories the evaluation cases run against.
 *
 * Two small repositories, generated rather than vendored, for three reasons:
 *   - ground truth is *authored*, so an expected answer is a fact, not an opinion
 *   - git history is backdated deterministically, so a system that reads history
 *     has something real to read (the baseline is defined not to)
 *   - fixtures stay out of version control (`fixtures/*​/` is gitignored) and are
 *     rebuilt with `pnpm fixtures:build`
 *
 * Author, email and commit dates are pinned, so the same content produces the
 * same commit hashes on every machine.
 */

const FIXTURES_ROOT = path.resolve(process.cwd(), "fixtures");

const GIT_ENV = {
  GIT_AUTHOR_NAME: "Fixture Author",
  GIT_AUTHOR_EMAIL: "fixtures@repo-archaeologist.invalid",
  GIT_COMMITTER_NAME: "Fixture Author",
  GIT_COMMITTER_EMAIL: "fixtures@repo-archaeologist.invalid",
} as const;

interface Commit {
  message: string;
  /** ISO 8601 with offset. Pinned so commit hashes are reproducible. */
  date: string;
  files: Record<string, string>;
}

interface FixtureSpec {
  name: string;
  commits: Commit[];
}

// ---------------------------------------------------------------------------
// Fixture 1 — orders-api: a JavaScript HTTP service.
// ---------------------------------------------------------------------------

const ORDERS_README = `# orders-api

The write side of the ordering system. It accepts customer orders over HTTP,
validates them, prices them, reserves inventory, and publishes an
\`order.created\` event to Kafka. Reads are served by a separate reporting
service that is not in this repository.

## Running locally

    npm install
    npm start          # listens on PORT, default 4000

A Postgres URL and a Kafka broker list are required; see \`src/config.js\`.

## Layout

- \`src/server.js\` — Express application, middleware chain, route registration
- \`src/routes/\` — HTTP handlers, one file per resource
- \`src/services/\` — business logic: pricing and inventory reservation
- \`src/lib/\` — Postgres pool, Kafka publisher, JWT helpers
- \`src/middleware/\` — authentication and the error handler

## Authentication

Every route except \`/health\` requires a bearer JWT, verified in
\`src/middleware/auth.js\` against \`JWT_SECRET\`.

## Testing

    npm test           # Vitest

Unit tests only. There are no integration tests: the Postgres and Kafka clients
are never exercised against a real broker, which is the largest gap in coverage.
`;

const ORDERS_PACKAGE_JSON = `${JSON.stringify(
  {
    name: "orders-api",
    version: "2.3.1",
    private: true,
    type: "module",
    description: "Write-side HTTP service for customer orders.",
    main: "src/server.js",
    scripts: {
      start: "node src/server.js",
      dev: "node --watch src/server.js",
      test: "vitest run",
      lint: "eslint src",
    },
    dependencies: {
      express: "^4.19.2",
      pg: "^8.11.5",
      kafkajs: "^2.2.4",
      jsonwebtoken: "^9.0.2",
      zod: "^3.23.8",
      pino: "^9.1.0",
    },
    devDependencies: {
      eslint: "^9.3.0",
      supertest: "^7.0.0",
      vitest: "^1.6.0",
    },
    engines: { node: ">=20" },
  },
  null,
  2,
)}\n`;

const ORDERS_API: FixtureSpec = {
  name: "orders-api",
  commits: [
    {
      message: "Initial service skeleton",
      date: "2025-02-11T09:14:00+00:00",
      files: {
        "README.md": `# orders-api\n\nWrite-side HTTP service for customer orders.\n`,
        "package.json": ORDERS_PACKAGE_JSON,
        ".gitignore": "node_modules/\n.env\ncoverage/\n",
        "src/config.js": `const required = ["DATABASE_URL", "KAFKA_BROKERS", "JWT_SECRET"];

export function loadConfig(env = process.env) {
  const missing = required.filter((key) => !env[key]);
  if (missing.length > 0) {
    throw new Error(\`Missing required configuration: \${missing.join(", ")}\`);
  }
  return {
    port: Number(env.PORT ?? 4000),
    databaseUrl: env.DATABASE_URL,
    kafkaBrokers: env.KAFKA_BROKERS.split(","),
    jwtSecret: env.JWT_SECRET,
    logLevel: env.LOG_LEVEL ?? "info",
  };
}
`,
        "src/server.js": `import express from "express";
import pino from "pino";
import { loadConfig } from "./config.js";
import { authenticate } from "./middleware/auth.js";
import { errorHandler } from "./middleware/error-handler.js";
import { healthRouter } from "./routes/health.js";
import { ordersRouter } from "./routes/orders.js";

const config = loadConfig();
const log = pino({ level: config.logLevel });

export function createApp() {
  const app = express();
  app.use(express.json({ limit: "1mb" }));

  // /health is mounted before authenticate so load balancers can probe it.
  app.use("/health", healthRouter);
  app.use(authenticate(config.jwtSecret));
  app.use("/orders", ordersRouter);
  app.use(errorHandler(log));

  return app;
}

if (process.env.NODE_ENV !== "test") {
  createApp().listen(config.port, () => log.info({ port: config.port }, "orders-api listening"));
}
`,
        "src/routes/health.js": `import { Router } from "express";

export const healthRouter = Router();

healthRouter.get("/", (_request, response) => {
  response.json({ status: "ok" });
});
`,
      },
    },
    {
      message: "Add order creation flow: validate, price, reserve, publish",
      date: "2025-03-04T15:42:00+00:00",
      files: {
        "src/routes/orders.js": `import { Router } from "express";
import { z } from "zod";
import { publishOrderCreated } from "../lib/events.js";
import { reserveInventory } from "../services/inventory.js";
import { priceOrder } from "../services/pricing.js";
import { insertOrder } from "../lib/db.js";

const OrderRequest = z.object({
  customerId: z.string().uuid(),
  currency: z.enum(["USD", "EUR", "GBP"]),
  lines: z
    .array(z.object({ sku: z.string().min(1), quantity: z.number().int().positive() }))
    .min(1),
});

export const ordersRouter = Router();

// POST /orders is the only write path in the service. The order of operations
// matters: inventory is reserved before the row is inserted, so a reservation
// failure never leaves a persisted order that was never fulfillable.
ordersRouter.post("/", async (request, response, next) => {
  try {
    const order = OrderRequest.parse(request.body);
    const priced = await priceOrder(order);
    const reservation = await reserveInventory(priced.lines);
    const stored = await insertOrder({ ...priced, reservationId: reservation.id, customerId: order.customerId });
    await publishOrderCreated(stored);
    response.status(201).json(stored);
  } catch (error) {
    next(error);
  }
});
`,
        "src/services/pricing.js": `import { getSkuPrices } from "../lib/db.js";

/**
 * Prices an order. Line totals are computed in minor units (cents) to avoid
 * floating point drift, and the order total is the sum of the line totals.
 */
export async function priceOrder(order) {
  const prices = await getSkuPrices(order.lines.map((line) => line.sku));
  const lines = order.lines.map((line) => {
    const unitAmount = prices.get(line.sku);
    if (unitAmount === undefined) {
      const error = new Error(\`Unknown sku: \${line.sku}\`);
      error.status = 422;
      throw error;
    }
    return { ...line, unitAmount, lineTotal: unitAmount * line.quantity };
  });
  return {
    currency: order.currency,
    lines,
    totalAmount: lines.reduce((total, line) => total + line.lineTotal, 0),
  };
}
`,
        "src/services/inventory.js": `import { withTransaction } from "../lib/db.js";

/**
 * Reserves stock for every line, or none of them. The SELECT ... FOR UPDATE is
 * what makes concurrent reservations safe; removing it reintroduces oversell.
 */
export async function reserveInventory(lines) {
  return withTransaction(async (client) => {
    for (const line of lines) {
      const { rows } = await client.query(
        "SELECT available FROM inventory WHERE sku = $1 FOR UPDATE",
        [line.sku],
      );
      const available = rows[0]?.available ?? 0;
      if (available < line.quantity) {
        const error = new Error(\`Insufficient stock for \${line.sku}\`);
        error.status = 409;
        throw error;
      }
      await client.query("UPDATE inventory SET available = available - $1 WHERE sku = $2", [
        line.quantity,
        line.sku,
      ]);
    }
    const { rows } = await client.query("INSERT INTO reservations DEFAULT VALUES RETURNING id");
    return { id: rows[0].id };
  });
}
`,
        "src/lib/db.js": `import pg from "pg";
import { loadConfig } from "../config.js";

const pool = new pg.Pool({ connectionString: loadConfig().databaseUrl, max: 10 });

export async function withTransaction(handler) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await handler(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function getSkuPrices(skus) {
  const { rows } = await pool.query("SELECT sku, unit_amount FROM prices WHERE sku = ANY($1)", [skus]);
  return new Map(rows.map((row) => [row.sku, row.unit_amount]));
}

export async function insertOrder(order) {
  const { rows } = await pool.query(
    "INSERT INTO orders (customer_id, currency, total_amount, reservation_id) VALUES ($1, $2, $3, $4) RETURNING *",
    [order.customerId, order.currency, order.totalAmount, order.reservationId],
  );
  return { ...rows[0], lines: order.lines };
}
`,
        "src/lib/events.js": `import { Kafka } from "kafkajs";
import { loadConfig } from "../config.js";

const producer = new Kafka({ clientId: "orders-api", brokers: loadConfig().kafkaBrokers }).producer();
let connected = false;

/** Publishes order.created. Fire-and-forget failures are deliberately not swallowed. */
export async function publishOrderCreated(order) {
  if (!connected) {
    await producer.connect();
    connected = true;
  }
  await producer.send({
    topic: "order.created",
    messages: [{ key: String(order.id), value: JSON.stringify(order) }],
  });
}
`,
      },
    },
    {
      message: "Add JWT authentication middleware and error handler",
      date: "2025-04-22T11:05:00+00:00",
      files: {
        "src/middleware/auth.js": `import jwt from "jsonwebtoken";

/**
 * Verifies the bearer token on every request that reaches it. Mounted after
 * /health, so the probe endpoint stays public.
 */
export function authenticate(secret) {
  return (request, response, next) => {
    const header = request.header("authorization") ?? "";
    const [scheme, token] = header.split(" ");
    if (scheme !== "Bearer" || !token) {
      response.status(401).json({ error: "missing bearer token" });
      return;
    }
    try {
      request.user = jwt.verify(token, secret);
      next();
    } catch {
      response.status(401).json({ error: "invalid token" });
    }
  };
}
`,
        "src/middleware/error-handler.js": `/** Maps thrown errors to responses. Anything without a status is a 500. */
export function errorHandler(log) {
  // eslint-disable-next-line no-unused-vars
  return (error, _request, response, _next) => {
    const status = error.status ?? (error.name === "ZodError" ? 400 : 500);
    if (status >= 500) log.error({ err: error }, "unhandled error");
    response.status(status).json({ error: error.message ?? "internal error" });
  };
}
`,
      },
    },
    {
      message: "Cover pricing and order validation with unit tests",
      date: "2025-06-09T08:31:00+00:00",
      files: {
        "README.md": ORDERS_README,
        "test/pricing.test.js": `import { describe, expect, it, vi } from "vitest";
import { priceOrder } from "../src/services/pricing.js";

vi.mock("../src/lib/db.js", () => ({
  getSkuPrices: async () => new Map([["sku-1", 1250]]),
}));

describe("priceOrder", () => {
  it("sums line totals in minor units", async () => {
    const priced = await priceOrder({ currency: "USD", lines: [{ sku: "sku-1", quantity: 3 }] });
    expect(priced.totalAmount).toBe(3750);
  });

  it("rejects an unknown sku with 422", async () => {
    await expect(priceOrder({ currency: "USD", lines: [{ sku: "nope", quantity: 1 }] })).rejects.toThrow(
      /Unknown sku/,
    );
  });
});
`,
        "test/orders.test.js": `import { describe, expect, it } from "vitest";
import request from "supertest";

// Integration coverage stops here: the app is never booted against a real
// Postgres or Kafka, so db.js and events.js are untested.
describe("POST /orders", () => {
  it("rejects an unauthenticated request", async () => {
    const { createApp } = await import("../src/server.js");
    const response = await request(createApp()).post("/orders").send({});
    expect(response.status).toBe(401);
  });
});
`,
      },
    },
    {
      message: "Fix oversell under concurrent reservations by locking inventory rows",
      date: "2025-08-18T17:20:00+00:00",
      files: {
        "docs/incidents/2025-08-oversell.md": `# 2025-08 oversell incident

Two concurrent orders for the same sku both passed the availability check and
both decremented stock, taking \`available\` negative for 40 minutes.

Cause: \`reserveInventory\` read availability without locking the row.
Fix: \`SELECT available FROM inventory WHERE sku = $1 FOR UPDATE\` inside the
existing transaction.

Follow-up not yet done: there is no integration test that runs two reservations
concurrently, so the regression is only prevented by review.
`,
      },
    },
  ],
};

// ---------------------------------------------------------------------------
// Fixture 2 — pyflow: a Python CLI, no readme in the first commits.
// ---------------------------------------------------------------------------

const PYFLOW_README = `# pyflow

A command line ETL runner. \`pyflow run pipeline.yaml\` loads a pipeline
definition, resolves each step's dependencies, executes the steps in
topological order, and records every step outcome in a local SQLite store.

## Install

    pip install -e .
    pyflow run examples/daily.yaml

## How a run works

1. \`pyflow/cli.py\` parses arguments with Click and loads the YAML file.
2. \`pyflow/pipeline.py\` builds a dependency graph and topologically sorts it.
   A cycle raises \`PipelineError\` before any step runs.
3. Each step is dispatched by type to \`pyflow/steps/\` — \`extract\`,
   \`transform\` or \`load\`.
4. \`pyflow/store.py\` writes one row per step attempt to \`.pyflow/state.db\`.

Steps run in a single process, one at a time. There is no scheduler, no retry
policy, and no distributed execution.

## Testing

    pytest

\`tests/test_pipeline.py\` covers graph ordering and cycle detection.
\`tests/test_steps.py\` covers the transform step only; extract and load talk to
the filesystem and the database and are not covered.
`;

const PYFLOW: FixtureSpec = {
  name: "pyflow",
  commits: [
    {
      message: "Add pipeline loader and topological sort",
      date: "2025-01-19T13:02:00+00:00",
      files: {
        "pyproject.toml": `[project]
name = "pyflow"
version = "0.4.2"
description = "A command line ETL runner with a SQLite state store."
requires-python = ">=3.11"
dependencies = [
    "click>=8.1",
    "pyyaml>=6.0",
    "sqlalchemy>=2.0",
    "rich>=13.7",
]

[project.optional-dependencies]
dev = ["pytest>=8.2", "mypy>=1.10", "ruff>=0.4"]

[project.scripts]
pyflow = "pyflow.cli:main"

[build-system]
requires = ["setuptools>=69"]
build-backend = "setuptools.build_meta"

[tool.mypy]
strict = true

[tool.ruff]
line-length = 100
`,
        ".gitignore": "__pycache__/\n*.egg-info/\n.pyflow/\n.venv/\n",
        "pyflow/__init__.py": `"""pyflow — a small ETL runner."""

__version__ = "0.4.2"
`,
        "pyflow/pipeline.py": `"""Pipeline loading and ordering.

A pipeline is a mapping of step name to step definition. Each definition has a
a "type" and an optional "needs" list. Ordering is a Kahn topological sort;
a cycle is an error raised before any step executes.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

import yaml


class PipelineError(RuntimeError):
    """Raised for a malformed pipeline: unknown dependency, or a cycle."""


@dataclass(frozen=True)
class Step:
    name: str
    type: str
    needs: tuple[str, ...] = ()
    options: dict[str, object] = field(default_factory=dict)


def load_pipeline(path: Path) -> list[Step]:
    raw = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    steps = [
        Step(
            name=name,
            type=str(definition["type"]),
            needs=tuple(definition.get("needs", ())),
            options={k: v for k, v in definition.items() if k not in {"type", "needs"}},
        )
        for name, definition in (raw.get("steps") or {}).items()
    ]
    return topological_order(steps)


def topological_order(steps: list[Step]) -> list[Step]:
    by_name = {step.name: step for step in steps}
    for step in steps:
        for dependency in step.needs:
            if dependency not in by_name:
                raise PipelineError(f"step {step.name!r} needs unknown step {dependency!r}")

    ordered: list[Step] = []
    remaining = {step.name: set(step.needs) for step in steps}
    while remaining:
        ready = sorted(name for name, needs in remaining.items() if not needs)
        if not ready:
            raise PipelineError(f"cycle detected among steps: {sorted(remaining)}")
        for name in ready:
            ordered.append(by_name[name])
            del remaining[name]
        for needs in remaining.values():
            needs.difference_update(ready)
    return ordered
`,
      },
    },
    {
      message: "Add step implementations and the SQLite state store",
      date: "2025-03-27T10:48:00+00:00",
      files: {
        "pyflow/steps/__init__.py": `"""Step implementations, dispatched by the "type" field of a step."""

from pyflow.steps.extract import extract
from pyflow.steps.load import load
from pyflow.steps.transform import transform

REGISTRY = {"extract": extract, "transform": transform, "load": load}
`,
        "pyflow/steps/extract.py": `"""Read rows from a CSV file on disk."""

from __future__ import annotations

import csv
from pathlib import Path


def extract(options: dict[str, object]) -> list[dict[str, str]]:
    source = Path(str(options["path"]))
    with source.open(newline="", encoding="utf-8") as handle:
        return list(csv.DictReader(handle))
`,
        "pyflow/steps/transform.py": `"""Row-level transforms. Pure functions, which is why this is the tested step."""

from __future__ import annotations

from typing import Iterable


def transform(options: dict[str, object], rows: Iterable[dict[str, str]] | None = None) -> list[dict[str, str]]:
    rename = {str(k): str(v) for k, v in dict(options.get("rename") or {}).items()}
    drop = {str(column) for column in (options.get("drop") or ())}
    output = []
    for row in rows or ():
        renamed = {rename.get(key, key): value for key, value in row.items() if key not in drop}
        output.append(renamed)
    return output
`,
        "pyflow/steps/load.py": `"""Write rows into the configured SQLAlchemy table."""

from __future__ import annotations

from typing import Iterable

from sqlalchemy import text

from pyflow.store import engine_for


def load(options: dict[str, object], rows: Iterable[dict[str, str]] | None = None) -> int:
    table = str(options["table"])
    engine = engine_for(str(options.get("url", "sqlite:///.pyflow/state.db")))
    written = 0
    with engine.begin() as connection:
        for row in rows or ():
            columns = ", ".join(row)
            placeholders = ", ".join(f":{column}" for column in row)
            connection.execute(text(f"INSERT INTO {table} ({columns}) VALUES ({placeholders})"), row)
            written += 1
    return written
`,
        "pyflow/store.py": `"""The state store: one row per step attempt, in SQLite via SQLAlchemy."""

from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import Engine, create_engine, text

_SCHEMA = """
CREATE TABLE IF NOT EXISTS step_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pipeline TEXT NOT NULL,
    step TEXT NOT NULL,
    status TEXT NOT NULL,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    error TEXT
)
"""


def engine_for(url: str) -> Engine:
    engine = create_engine(url, future=True)
    with engine.begin() as connection:
        connection.execute(text(_SCHEMA))
    return engine


def record_step(engine: Engine, pipeline: str, step: str, status: str, error: str | None = None) -> None:
    now = datetime.now(timezone.utc).isoformat()
    with engine.begin() as connection:
        connection.execute(
            text(
                "INSERT INTO step_runs (pipeline, step, status, started_at, finished_at, error)"
                " VALUES (:pipeline, :step, :status, :now, :now, :error)"
            ),
            {"pipeline": pipeline, "step": step, "status": status, "now": now, "error": error},
        )
`,
      },
    },
    {
      message: "Add the Click command line entry point",
      date: "2025-05-14T16:27:00+00:00",
      files: {
        "pyflow/cli.py": `"""Command line entry point: pyflow run <pipeline.yaml>."""

from __future__ import annotations

from pathlib import Path

import click
from rich.console import Console

from pyflow.pipeline import PipelineError, load_pipeline
from pyflow.steps import REGISTRY
from pyflow.store import engine_for, record_step

console = Console()


@click.group()
@click.version_option()
def main() -> None:
    """pyflow — run a declarative ETL pipeline."""


@main.command()
@click.argument("pipeline", type=click.Path(exists=True, dir_okay=False, path_type=Path))
@click.option("--state-url", default="sqlite:///.pyflow/state.db", show_default=True)
def run(pipeline: Path, state_url: str) -> None:
    """Execute every step in PIPELINE, in dependency order."""
    try:
        steps = load_pipeline(pipeline)
    except PipelineError as error:
        raise click.ClickException(str(error)) from error

    engine = engine_for(state_url)
    rows: list[dict[str, str]] | None = None
    for step in steps:
        handler = REGISTRY.get(step.type)
        if handler is None:
            record_step(engine, pipeline.name, step.name, "failed", f"unknown step type {step.type!r}")
            raise click.ClickException(f"unknown step type {step.type!r} in step {step.name!r}")
        console.print(f"[bold]{step.name}[/] ({step.type})")
        try:
            rows = handler(step.options) if step.type == "extract" else handler(step.options, rows)
        except Exception as error:  # noqa: BLE001 - recorded, then re-raised as CLI error
            record_step(engine, pipeline.name, step.name, "failed", str(error))
            raise click.ClickException(f"step {step.name!r} failed: {error}") from error
        record_step(engine, pipeline.name, step.name, "succeeded")
`,
      },
    },
    {
      message: "Document the runner and cover ordering with tests",
      date: "2025-07-02T09:55:00+00:00",
      files: {
        "README.md": PYFLOW_README,
        "tests/test_pipeline.py": `from pathlib import Path

import pytest

from pyflow.pipeline import PipelineError, Step, load_pipeline, topological_order


def test_orders_dependencies_before_dependents() -> None:
    steps = [Step(name="load", type="load", needs=("extract",)), Step(name="extract", type="extract")]
    assert [step.name for step in topological_order(steps)] == ["extract", "load"]


def test_rejects_a_cycle() -> None:
    steps = [Step(name="a", type="transform", needs=("b",)), Step(name="b", type="transform", needs=("a",))]
    with pytest.raises(PipelineError, match="cycle detected"):
        topological_order(steps)


def test_rejects_unknown_dependency(tmp_path: Path) -> None:
    pipeline = tmp_path / "p.yaml"
    pipeline.write_text("steps:\\n  a:\\n    type: transform\\n    needs: [missing]\\n", encoding="utf-8")
    with pytest.raises(PipelineError, match="unknown step"):
        load_pipeline(pipeline)
`,
        "tests/test_steps.py": `from pyflow.steps.transform import transform


def test_renames_and_drops_columns() -> None:
    rows = [{"old": "1", "junk": "x"}]
    assert transform({"rename": {"old": "new"}, "drop": ["junk"]}, rows) == [{"new": "1"}]
`,
        "examples/daily.yaml": `steps:
  extract_orders:
    type: extract
    path: data/orders.csv
  clean:
    type: transform
    needs: [extract_orders]
    rename:
      order_id: id
    drop: [internal_note]
  write:
    type: load
    needs: [clean]
    table: orders
`,
      },
    },
  ],
};

// ---------------------------------------------------------------------------

function git(cwd: string, args: string[], env: Record<string, string> = {}): void {
  execFileSync("git", args, {
    cwd,
    stdio: ["ignore", "ignore", "pipe"],
    env: { ...process.env, ...GIT_ENV, ...env },
  });
}

function buildFixture(spec: FixtureSpec): { path: string; commits: number; files: number } {
  const root = path.join(FIXTURES_ROOT, spec.name);
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });

  git(root, ["init", "--quiet", "--initial-branch=main"]);
  git(root, ["config", "user.name", GIT_ENV.GIT_AUTHOR_NAME]);
  git(root, ["config", "user.email", GIT_ENV.GIT_AUTHOR_EMAIL]);
  git(root, ["config", "commit.gpgsign", "false"]);

  const written = new Set<string>();
  for (const commit of spec.commits) {
    for (const [relativePath, contents] of Object.entries(commit.files)) {
      const target = path.join(root, relativePath);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, contents, "utf8");
      written.add(relativePath);
    }
    git(root, ["add", "--all"]);
    git(root, ["commit", "--quiet", "--message", commit.message], {
      GIT_AUTHOR_DATE: commit.date,
      GIT_COMMITTER_DATE: commit.date,
    });
  }

  return { path: path.relative(process.cwd(), root), commits: spec.commits.length, files: written.size };
}

function main(): void {
  mkdirSync(FIXTURES_ROOT, { recursive: true });
  for (const spec of [ORDERS_API, PYFLOW]) {
    const built = buildFixture(spec);
    process.stdout.write(`built ${built.path}: ${built.files} files, ${built.commits} commits\n`);
  }
  process.stdout.write(
    "\nFixtures are gitignored and rebuilt by `pnpm fixtures:build`.\n" +
      "Evaluation cases reference them by relative path, so run this before `pnpm evaluate:baseline`.\n",
  );
}

main();
