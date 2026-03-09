<p align="center">
  <h1 align="center">⚒️ ctxforge</h1>
  <p align="center"><strong>Forge optimal context for every LLM inference call.</strong></p>
  <p align="center">
    A context engineering toolkit for solo developers shipping production software with AI.<br/>
    Zero model calls. Deterministic. Local-first.
  </p>
</p>

<p align="center">
  <a href="#quick-start">Quick Start</a> •
  <a href="#why-ctxforge">Why?</a> •
  <a href="#commands">Commands</a> •
  <a href="#how-it-works">How It Works</a> •
  <a href="#benchmarks">Benchmarks</a> •
  <a href="docs/USAGE_GUIDE.md">Full Usage Guide</a>
</p>

---

## The Problem

AI coding tools fail not because the model is dumb, but because **the context is bad**.

You paste 700K tokens of raw source code into a chat window. The model drowns in boilerplate, function bodies, and mock setups. It hallucinates APIs that don't exist. It misses the 3 files that actually matter.

Or worse — you manually copy-paste the "right" files every time, burning 10 minutes of context assembly for every inference call.

**The context window is a workspace, not a conversation log.** Every inference call should construct optimal context from scratch.

## The Solution

ctxforge compresses your codebase into a token-efficient YAML bundle containing **only what an LLM needs**: signatures, interfaces, types, JSDoc summaries, and behavioral hints. No function bodies. No boilerplate.

```bash
# Targeted: "I'm working on order cancellation"
npx tsx src/cli.ts full ./src ./db/migrations "order cancellation refund"

# Full dump: small codebase, just give the LLM everything
npx tsx src/cli.ts full ./src --all
```

**Output** — a compact YAML file you drag into any chat:

```yaml
code:
  order.service.ts:
    class OrderService:
      # Cancels order and triggers refund | iter → validateStatus → processRefund
      async cancelOrder(orderId: string, reason: CancelReason): Promise<Order>
      async processRefund(orderId: string): Promise<RefundResult>

schema:
  orders:
    pk: [id]
    cols:
      id: UUID, not null
      status: ENUM(order_status), not null [pending | confirmed | cancelled | refunded]
      cancel_reason: ENUM(cancel_reason)
      user_id: UUID, not null -> users(id)
```

That's it. The LLM knows: what the function accepts, what it returns, what it does (JSDoc), how it does it (body hint), and the full data model underneath. In ~2K tokens instead of ~60K.

---

## Quick Start

```bash
# Clone
git clone https://github.com/fran98m/ctxforge-ts.git
cd ctxforge-ts

# Install
npm install

# Run against your codebase
npx tsx src/cli.ts full /path/to/your/src --all

# With database migrations (dbmate format)
npx tsx src/cli.ts full /path/to/your/src /path/to/migrations "your feature query"

# Output lands in results/
# Drag the .yml file into Claude, ChatGPT, or your local LLM
```

### Requirements

- Node.js ≥ 18
- TypeScript codebase (`.ts` files)
- For schema extraction: [dbmate](https://github.com/amacneil/dbmate)-format SQL migrations

---

## Why ctxforge?

### Before ctxforge

```
You: *pastes 800 lines of raw source code*
LLM: "I see you have a function called processOrder..."
     *hallucinates a .save() method that doesn't exist*
     *misses the 3 tables connected by foreign keys*
     *suggests refactoring code it can't even see fully*
```

### After ctxforge

```
You: *drags context_bundle.yml into chat*
LLM: "Based on the OrderService interface and the orders/refunds table schema,
      here's how to implement cascading cancellation..."
     *uses the exact method signatures from your code*
     *references the actual FK relationships*
     *stays within your architecture*
```

### Key properties

| Property | Detail |
|----------|--------|
| **Zero model calls** | Pure AST analysis + regex. No LLM in the loop. Deterministic output. |
| **5x compression** | 700K tokens → 140K signatures. Or 60K → 2K for search-driven extraction. |
| **Search-driven** | TF-IDF scoring + import graph propagation. Describe your feature in plain English, get the right files. |
| **Schema-aware** | Replays SQL migrations → current DB state. FK graph propagation cross-references with code. |
| **JSDoc passthrough** | First-sentence JSDoc summaries preserved — the LLM knows *what* each function does. |
| **Body hints** | One-line "action chains" extracted from function bodies — the LLM knows *how* it works. |
| **Token budgeting** | Built-in estimation and per-file/table breakdown so you never blow your context window. |

---

## Commands

### `full` — The Main Command

Searches code + schema, cross-references them, outputs one YAML bundle.

```bash
# Search both sides (large codebase)
npx tsx src/cli.ts full ./src ./db/migrations "payment reconciliation"

# All code, no DB
npx tsx src/cli.ts full ./src --all

# All schema + searched code (sweet spot for hexagonal architectures)
npx tsx src/cli.ts full ./src ./db/migrations "order flow" --all-schema --topk 8

# Full dump of everything
npx tsx src/cli.ts full ./src ./db/migrations --all
```

### `context` — Code Only (Targeted)

```bash
npx tsx src/cli.ts context ./src "user authentication jwt"
```

### `schema` — Database Only

```bash
# Full dump
npx tsx src/cli.ts schema ./db/migrations --all

# Search-driven
npx tsx src/cli.ts schema ./db/migrations --query "billing subscription"

# Explicit tables
npx tsx src/cli.ts schema ./db/migrations --tables orders,users,payments
```

### `map` — Domain Entity Overview

Quick scan of interfaces and classes across your codebase.

```bash
npx tsx src/cli.ts map ./src
```

### `dump` — Full Codebase, No Search

```bash
npx tsx src/cli.ts dump ./src ./db/migrations
```

### `tokens` — Analyze Token Usage

```bash
npx tsx src/cli.ts tokens ./results/context_bundle.yml --budget 8000
```

### Flags

| Flag | Description |
|------|-------------|
| `--all` | Dump everything (no search) |
| `--all-schema` | Dump all tables, search code |
| `--all-code` | Dump all code, search tables |
| `--topk N` | Max code files to include (default: 5) |
| `--topk-tables N` | Max tables to include (default: 10) |
| `--tables t1,t2` | Force-include specific tables |
| `--budget N` | Token budget for reporting |

---

## How It Works

### Architecture

```
┌─────────────────────────────────────────────────────┐
│                     CLI (cli.ts)                     │
│         Routes commands, manages output paths        │
└──────────┬──────────┬──────────┬───────────┬────────┘
           │          │          │           │
     ┌─────▼────┐ ┌──▼───┐ ┌───▼───┐ ┌─────▼──────┐
     │ search.ts│ │schema│ │schema │ │  tokens.ts │
     │ TF-IDF + │ │ .ts  │ │search │ │  Estimation│
     │ import   │ │Migra-│ │ .ts   │ │  & budget  │
     │ graph    │ │tion  │ │FK prop│ │  reporting │
     └─────┬────┘ │replay│ │agation│ └────────────┘
           │      └──┬───┘ └───┬───┘
     ┌─────▼─────────▼────────▼──────┐
     │       compactor.ts             │
     │  Merges code + schema → YAML   │
     │  JSDoc summaries + body hints  │
     └──────────┬─────────────────────┘
                │
     ┌──────────▼──────────┐
     │    fetcher.ts       │
     │  ts-morph AST       │
     │  Signature extractor│
     └─────────────────────┘
```

### The Search Pipeline

1. **Tokenize query** — split on whitespace, camelCase-split, stem, remove stop words
2. **Score code files** — TF-IDF-like: filename (5.0×), identifiers (3.0×), JSDoc (2.0×)
3. **Propagate through import graph** — if `OrderService.ts` scores high, `utils.ts` that it imports gets a boost (0.2×), and files that import it get a bigger boost (0.4×)
4. **Score DB tables** — table name (5.0×), column names (2.0×), enum values (3.0×), FK targets (2.5×)
5. **Propagate through FK graph** — `order_items` FK→`orders` means a high-scoring `orders` boosts `order_items`
6. **Cross-reference** — code file `OrderService.ts` automatically boosts the `orders` table (2.0×)
7. **Extract & compact** — signatures + JSDoc + body hints → YAML

### What Gets Extracted

| Element | Extracted | Example in output |
|---------|-----------|-------------------|
| Function signatures | ✅ | `cancelOrder(orderId: string): Promise<Order>` |
| Interface fields | ✅ | `userId: string` |
| Class methods + props | ✅ | `private readonly repo: OrderRepository` |
| JSDoc (first sentence) | ✅ | `# Cancels order and triggers refund` |
| Body action chain | ✅ | `iter → validateStatus → processRefund` |
| Function bodies | ❌ | Stripped — this is the compression |
| Test files | ❌ | Excluded from output |
| Import statements | ❌ | Used for scoring, not in output |

### Body Hint Language

Body hints use a compact notation:

| Symbol | Meaning |
|--------|---------|
| `new X` | Constructs an instance of X |
| `iter` | Loop (`for`, `.forEach`) |
| `map` / `filter` / `sort` / `reduce` | Array transforms |
| `fs` | File system operations |
| `regex` | Pattern matching (`.match`, `.test`, `matchAll`) |
| `methodName` | Notable method calls in execution order |

Example: `# Full compaction: code + schema → single YAML | new Date → filter → toISOString → filter → join`

This tells the LLM: "this function builds a date-stamped header, filters sections, and joins them" — without reading 30 lines of code.

---

## Benchmarks

Real-world results on production codebases:

### Large Codebase (609 files, 43 tables, 326 migrations)

| Metric | Raw | Compact | Savings |
|--------|-----|---------|---------|
| **Code tokens** | 698,396 | 138,966 | **5.0× smaller** |
| **Schema tokens** | 24,965 | 4,564 | **5.5× smaller** |
| **Total tokens** | 723,361 | 143,530 | **80.2% reduction** |

### Medium Codebase (121 files, 12 tables)

| Metric | Raw | Compact | Savings |
|--------|-----|---------|---------|
| **Code tokens** | 61,192 | 16,765 | **3.6× smaller** |
| **Schema tokens** | 2,381 | 1,030 | **2.3× smaller** |
| **Total tokens** | 63,573 | 17,795 | **72.0% reduction** |

### With Search-Driven Extraction

On the large codebase, using `--all-schema --topk 8`:

| Component | Tokens |
|-----------|--------|
| Schema (all 43 tables) | ~4,500 |
| Code (top 8 files) | ~3,500 |
| **Total context** | **~8,000** |

That's **723K → 8K tokens** — a **90× reduction** — while keeping everything the LLM needs to answer a domain-specific question.

---

## YAML vs CSV — Why This Format?

The old approach: `INFORMATION_SCHEMA` CSV dumps.

```csv
proj,dataset,orders,id,1,BIGINT,NO,NO
proj,dataset,orders,user_id,2,STRING,YES,NO
proj,dataset,orders,status,4,VARCHAR(20),NO,NO
```

~105 tokens. No FKs, no enums, no defaults.

The ctxforge approach:

```yaml
orders:
  pk: [id]
  cols:
    id: BIGINT, not null
    user_id: STRING -> users(id)
    status: VARCHAR(20), not null, default pending [pending | confirmed | cancelled]
```

~74 tokens. **30% fewer tokens AND more information** — enums, foreign keys, defaults, and partition keys all visible. The savings compound across dozens of tables.

---

## Running Tests

```bash
# Run all 124 tests
npm test

# Watch mode
npm run test:watch
```

Test suite covers:
- Token estimation accuracy
- Search ranking and scoring
- Schema migration parsing (CREATE, ALTER, DROP, ENUMs)
- Schema search with FK propagation
- Compactor output format
- AST signature extraction
- CLI integration (end-to-end)
- Self-benchmarks (compression ratios, search precision)

---

## Project Structure

```
src/
├── cli.ts            ← Entry point — routes commands, manages output
├── search.ts         ← TF-IDF scoring + import graph propagation
├── fetcher.ts        ← ts-morph AST → signature extraction
├── schema.ts         ← SQL migration replay → current DB state
├── schema-search.ts  ← Table scoring + FK graph propagation
├── compactor.ts      ← Merges code + schema → compact YAML
├── tokens.ts         ← Token estimation and budget reporting
└── __tests__/        ← 124 tests across 8 test files
docs/
└── USAGE_GUIDE.md    ← Detailed usage with examples and tuning guide
results/              ← Generated context bundles land here
```

---

## Philosophy

This tool was born from the [Context Engineering Framework](https://github.com/fran98m/CtxForge) — a methodology for solo developers shipping production software with AI on local hardware (single RTX 3090).

Built around three principles:

1. **The context window is a workspace.** Don't append to conversation history. Construct optimal context for every call.
2. **Deterministic beats generative.** AST parsing and regex are faster, cheaper, and more reliable than asking a model to summarize code.
3. **Use the right tool for each phase.** Frontier models (free) for hard reasoning. Local models for execution. Deterministic scripts for everything else.

---

## Contributing

Contributions welcome. Some ideas:

- **Language support** — add extractors for Python, Go, Rust (pluggable AST backends)
- **More migration formats** — Prisma, Knex, Rails-style
- **View/materialized view parsing** — currently not handled
- **Custom scoring weights** — configurable via `ctxforge.config.json`
- **Editor integration** — VS Code extension that generates context on save

---

## License

MIT — [Francisco Montalvo](https://github.com/fran98m)

See [LICENSE.txt](LICENSE.txt) for details.
