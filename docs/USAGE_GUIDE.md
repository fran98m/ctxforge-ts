# Context Builder — Usage Guide

## What This Tool Does

You have codebases that follow hexagonal architecture — meaning your business logic lives in TypeScript, but the actual behavior depends heavily on the database schema underneath. When you chat with Claude about these codebases, you need to give it both the **code signatures** and the **database structure** so it understands the full picture.

This tool automates that. Instead of manually running `INFORMATION_SCHEMA` queries and copy-pasting CSVs, you run one command and get a compact YAML file that contains everything Claude needs — using roughly **5-7x fewer tokens** than the CSV approach.

---

## Setup

```bash
# Install dependencies
npm install ts-morph

# If you use ts-node to run directly:
npm install -D ts-node typescript

# Add these scripts to your package.json:
```

```json
{
  "scripts": {
    "cli": "ts-node src/cli.ts"
  }
}
```

Your `src/` folder should contain these files:

```
src/
├── cli.ts            ← Entry point (routes commands)
├── search.ts         ← Scores code files against a query
├── fetcher.ts        ← Extracts signatures from scored files
├── schema.ts         ← Replays dbmate migrations → current DB state
├── schema-search.ts  ← Scores DB tables against a query
├── compactor.ts      ← Merges code + schema → compact YAML
└── tokens.ts         ← Token estimation and budget reporting
```

---

## Two Modes of Thinking

### When to use SEARCH (targeted extraction)

You have a **large codebase** (50+ files, 30+ tables) and you're asking Claude about a specific feature or domain. You don't want to blow your context window with 200 tables when you only care about orders.

```bash
# "I need to understand how order cancellation works"
npm run cli full ./src ./db/migrations "order cancellation refund"
```

This will:
1. Search your `.ts` files — find `order.service.ts`, `refund.handler.ts`, etc.
2. Search your DB tables — find `orders`, `refunds`, `order_items`, plus anything FK-connected
3. Cross-reference — if `OrderService.ts` scored high, the `orders` table gets automatically boosted even if you didn't mention it
4. Output a single `context_bundle.yml` with only the relevant stuff

### When to use DUMP (full extraction)

You have a **small codebase** (a microservice, <20 files, <15 tables) and it's worth just giving Claude everything.

```bash
# "Just give Claude the whole thing"
npm run cli dump ./src ./db/migrations
```

This skips all search logic and extracts every file with structure + every table.

---

## Command Reference

### `context` — Code Only (Targeted)

Searches your TypeScript files and extracts signatures from the top matches.

```bash
npm run cli context <code_path> <query> [--topk N]
```

**What it does (Python mental model):**
```python
# Pseudocode equivalent:
query_terms = tokenize("order payment")         # splits, stems, removes stop words
for file in all_ts_files:
    score = match(file.name, file.classes, file.jsdoc, query_terms)
    if file imports from another scored file:
        that_file.score += boost                 # import graph propagation
top_files = sorted(scores)[:topk]
for f in top_files:
    extract_signatures(f)                        # interfaces, class methods, function sigs
```

**Output:** `context_output.txt`

**Example:**
```bash
npm run cli context ./src "user authentication jwt"
# Finds: auth.service.ts, user.repository.ts, jwt.strategy.ts
# Extracts their interfaces, class methods, function signatures
```

---

### `schema` — Database Only

Replays your dbmate migrations in order and outputs the current schema state.

```bash
# Search-driven (big DB):
npm run cli schema <migrations_path> --query "order status" [--topk N]

# Explicit tables:
npm run cli schema <migrations_path> --tables orders,users,payments

# Full dump (small DB):
npm run cli schema <migrations_path> --all

# Any mode with budget tracking:
npm run cli schema <migrations_path> --all --budget 3000
```

**What it does (Python mental model):**
```python
# The migration replay:
state = {}  # empty schema
for migration_file in sorted(glob("migrations/*.sql")):
    sql = extract_up_section(migration_file)     # only "-- migrate:up" block
    for statement in sql.split(";"):
        if "CREATE TABLE":  state[table] = parse_columns(statement)
        if "ALTER TABLE":   state[table].apply_change(statement)
        if "DROP TABLE":    del state[table]
        if "CREATE TYPE":   state.enums[name] = parse_enum_values(statement)

# Then if --query provided, score tables like we score files:
for table in state:
    score = match(table.name, table.columns, table.enums, table.fk_targets, query_terms)
    propagate_scores_through_fk_graph()
```

**Output:** `schema_context.yml`

**Enum detection** — The parser finds enum values from three places:
1. `CREATE TYPE status_type AS ENUM ('active', 'cancelled')` — Postgres enum types
2. `CHECK (status IN ('active', 'cancelled'))` — inline or table-level CHECK constraints
3. `ALTER TABLE ADD CONSTRAINT ... CHECK (...)` — constraints added in later migrations

**Output looks like:**
```yaml
schema:
  enums:
    order_status: [active | cancelled | pending | refunded]
  orders:
    pk: [id]
    cols:
      id: BIGINT, not null
      status: ENUM(order_status), not null, default active [active | cancelled | pending | refunded]
      user_id: BIGINT, not null -> users(id)
      total: DECIMAL(10,2), not null
      created_at: TIMESTAMP, not null  # partition key
```

---

### `full` — Code + Schema Merged (The Main Command)

This is the one you'll use most. Searches both code and DB, cross-references them, outputs one file.

```bash
# Targeted both sides (huge codebase, huge DB):
npm run cli full <code_path> <migrations_path> <query> [flags]

# Search code, dump all schema (most common for hexagonal apps):
npm run cli full <code_path> <migrations_path> <query> --all-schema

# Full dump (small codebase):
npm run cli full <code_path> <migrations_path> "x" --all
```

**Flags:**
- `--topk N` — max code files (default: 5)
- `--topk-tables N` — max tables (default: 10)
- `--tables t1,t2` — force-include specific tables
- `--budget N` — set token budget for the report
- `--all` — skip search on both sides, include everything
- `--all-schema` — dump ALL tables but still search code (recommended when schema is small)
- `--all-code` — dump ALL code but still search tables

**Real-world example:** On a codebase with 609 code files and 43 tables, the full dump is 143k tokens (97% code, 3% schema). The schema at ~4.5k tokens is cheap enough to always include fully. The code is where you need search. So the sweet spot is:

```bash
npm run cli full ./src ./db/migrations "job routing availability" \
  --all-schema --topk 8 --budget 8000
```

This gives you all 43 tables (~4.5k tokens) plus the top 8 relevant code files (~3-4k tokens), well within budget.

**The cross-reference trick:**

Code search runs first. If it finds `order.service.ts` and `payment.handler.ts`, those file names get passed to the schema search. The schema search then:
- Splits `order.service.ts` → terms: `["order", "service"]`
- Boosts any table whose name matches: `orders` gets +2.0

This means you don't need to mention table names in your query. Just describe the feature in business terms and both sides find the right stuff.

**Output:** `context_bundle.yml`

```yaml
# Context Bundle
# Query: order cancellation refund
# Format: Compact YAML (optimized for LLM token efficiency)
---

code:
  src/order/order.service.ts:
    class OrderService:
      private orderRepo: OrderRepository
      async cancelOrder(orderId: string, reason: CancelReason): Promise<Order>
      async processRefund(orderId: string): Promise<RefundResult>

  src/payment/refund.handler.ts:
    functions:
      export handleRefundWebhook(event: StripeEvent): Promise<void>

schema:
  enums:
    cancel_reason: [customer_request | duplicate | fraud | other]
  orders:
    pk: [id]
    cols:
      id: UUID, not null
      status: ENUM(order_status), not null [pending | confirmed | cancelled | refunded]
      cancel_reason: ENUM(cancel_reason)
      cancelled_at: TIMESTAMP
  refunds:
    pk: [id]
    cols:
      id: UUID, not null
      order_id: UUID, not null -> orders(id)
      amount: DECIMAL(10,2), not null
      stripe_refund_id: VARCHAR(255)
```

---

### `dump` — Full Codebase, No Search

For small codebases where it's faster to just give Claude everything.

```bash
npm run cli dump <code_path> [migrations_path] [--budget N]
```

**Output:** `context_bundle.yml` (same format, just unfiltered)

---

### `map` — Domain Entity Overview

Quick overview of what interfaces and classes exist where. Useful for orienting yourself (or Claude) in an unfamiliar codebase before doing targeted extraction.

```bash
npm run cli map <code_path>
```

**Output:** `domain_map.txt`
```
📁 src/order/order.entity.ts
   Interfaces: IOrder, IOrderItem
   Classes:    Order

📁 src/payment/payment.service.ts
   Classes:    PaymentService
```

---

### `tokens` — Analyze Any File

Run this on any file to see how many tokens it costs and what's eating the budget.

```bash
npm run cli tokens <file_path> [--budget N]
```

```
╔══════════════════════════════════════════════════╗
║            TOKEN USAGE REPORT                   ║
║  Total tokens:      1,847                       ║
║  Budget:            4,000 tokens                ║
║  Used:              1,847 (46%)                 ║
║  Remaining:         2,153                       ║
╠══════════════════════════════════════════════════╣
║  TOP ITEMS BY TOKEN USAGE                       ║
║  🗄 orders                           312 tk     ║
║  📄 order.service.ts                 287 tk     ║
║  🗄 payments                         245 tk     ║
╚══════════════════════════════════════════════════╝
```

If a single table or file is eating too many tokens, you know what to trim. Reduce `--topk` or use `--tables` to be more selective.

---

## Typical Workflows

### "I'm working on a feature in a big hexagonal codebase" (most common)

```bash
# 1. Orient yourself first
npm run cli map ./src

# 2. Get targeted context — all schema (cheap), searched code
npm run cli full ./src ./db/migrations "payment reconciliation" \
  --all-schema --topk 8 --budget 8000

# 3. Check the token report — if code is too heavy, lower topk
npm run cli full ./src ./db/migrations "payment reconciliation" \
  --all-schema --topk 5 --budget 6000

# 4. Drag context_bundle.yml into Claude
```

### "I'm building on a small microservice"

```bash
# Just dump everything — if it fits in budget, no reason to search
npm run cli dump ./src ./db/migrations --budget 6000

# If it's over budget, switch to search
npm run cli full ./src ./db/migrations "the feature" --all-schema --topk 8
```

### "Claude needs just the DB schema for a SQL query"

```bash
# All tables (small DB)
npm run cli schema ./db/migrations --all

# Only the tables relevant to the question (big DB)
npm run cli schema ./db/migrations --query "user subscription billing"

# Specific tables you already know
npm run cli schema ./db/migrations --tables users,subscriptions,invoices,payments
```

### "I want to see what the token cost would be before committing"

```bash
# Generate with budget — the report shows if you're over/under
npm run cli full ./src ./db/migrations "orders" --all-schema --budget 5000

# Adjust --topk and re-run until it fits
npm run cli full ./src ./db/migrations "orders" --all-schema --topk 3 --budget 5000

# Or analyze an existing file
npm run cli tokens ./context_bundle.yml --budget 5000
```

### Decision tree: which mode?

```
Is schema < 10k tokens?
├─ YES → always use --all-schema
│   Is code < 10k tokens?
│   ├─ YES → just use `dump`
│   └─ NO  → use `full --all-schema --topk N`
└─ NO  → use `full` (search both sides)
```

---

## How the Scoring Works (For Tuning)

### Code file scoring (search.ts)

| Signal | Weight | Example |
|--------|--------|---------|
| File name contains query term | 5.0 | `order.service.ts` matches "order" |
| Class/Interface/Function name | 3.0 | `class OrderService` matches "order" |
| JSDoc comment content | 2.0 | `/** Handles order lifecycle */` |
| Imported by a high-scoring file | 0.3× parent score | `utils.ts` imported by `order.service.ts` |

### Table scoring (schema-search.ts)

| Signal | Weight | Example |
|--------|--------|---------|
| Table name contains term | 5.0 | `orders` matches "order" |
| Table name partial match | 3.5 | `order_items` partial matches "order" |
| Column name match | 2.0 | `payment_method` matches "payment" |
| Enum value match | 3.0 | enum value `refunded` matches "refund" |
| FK target match | 2.5 | `user_id -> users(id)` matches "user" |
| Column comment match | 1.5 | comment text matches |
| FK graph propagation | 0.35× | `order_items` FK→`orders` gets boosted |
| Code cross-reference | 2.0 | `OrderService.ts` boosts `orders` table |

---

## Migration Format Expected

The parser expects **dbmate** format:

```sql
-- migrate:up
CREATE TABLE orders (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id),
    status VARCHAR(20) NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'confirmed', 'cancelled')),
    total DECIMAL(10,2) NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_orders_user ON orders(user_id);
CREATE INDEX idx_orders_status ON orders(status);

-- migrate:down
DROP TABLE IF EXISTS orders;
```

The parser only reads the `-- migrate:up` section. It handles:
- `CREATE TABLE` (with inline constraints, FKs, CHECKs)
- `ALTER TABLE` (ADD/DROP/MODIFY/RENAME COLUMN, ADD CONSTRAINT)
- `CREATE TYPE ... AS ENUM (...)`
- `CREATE INDEX` / `CREATE UNIQUE INDEX`
- `COMMENT ON COLUMN ...`
- `DROP TABLE`

It does **not** handle:
- PL/pgSQL procedural blocks (`DO $$ ... $$`)
- Conditional DDL (`IF NOT EXISTS` in PL/pgSQL context)
- Trigger definitions
- View or materialized view definitions (could be added)

---

## Why YAML over CSV

Your old approach with INFORMATION_SCHEMA CSV:

```csv
proj,dataset,orders,id,1,BIGINT,NO,NO
proj,dataset,orders,user_id,2,STRING,YES,NO
proj,dataset,orders,amount,3,DECIMAL(10,2),YES,NO
proj,dataset,orders,status,4,VARCHAR(20),NO,NO
proj,dataset,orders,created_at,5,TIMESTAMP,NO,YES
```

5 rows × ~80 chars = ~400 chars → ~105 tokens. And you can't see enums, FKs, or defaults.

Same table in compact YAML:

```yaml
orders:
  pk: [id]
  partition: RANGE(created_at)
  cols:
    id: BIGINT, not null
    user_id: STRING -> users(id)
    amount: DECIMAL(10,2)
    status: VARCHAR(20), not null, default pending [pending | confirmed | cancelled]
    created_at: TIMESTAMP, not null
```

~280 chars → ~74 tokens. **30% fewer tokens AND more information** (enums, FKs, defaults, partition key all visible).

The savings compound — on a 50-table schema, you save thousands of tokens.
