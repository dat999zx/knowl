# Knowl — Core Engine Implementation Plan

Version: 1.0  
Status: Draft — Awaiting Approval  
Date: 2026-06-24

---

## 1. Tech Stack Decision

### Language: TypeScript (Node.js)

**Why TypeScript over alternatives:**

| Factor | TypeScript | Rust | Python | Go |
|---|---|---|---|---|
| MCP SDK | Tier 1 (official, best-supported) | Community, immature | Tier 2 | Community |
| SQLite | `better-sqlite3` (fast, sync) | rusqlite (great) | sqlite3 (ok) | go-sqlite3 (ok) |
| AI Integration | Vercel AI SDK (unified) | Limited | Best (but distribution hell) | Moderate |
| CLI Tooling | commander (solid) | clap (excellent) | click (good) | cobra (excellent) |
| Iteration Speed | Fast | Slow | Fast | Moderate |
| Distribution | npm / single binary via bun | Native binary | Painful | Native binary |
| Type Safety | Strong (with Zod) | Best | Weak | Strong |

**Decision: TypeScript** because:
1. MCP SDK is TypeScript-first — the bridge layer is a core requirement
2. Vercel AI SDK provides unified provider abstraction (OpenAI, Anthropic, Ollama, etc.)
3. Drizzle ORM + better-sqlite3 gives type-safe, high-performance local storage
4. Fast iteration for the complex knowledge pipeline
5. Can compile to a single binary later via `bun build --compile` if needed

### Core Dependencies

```
Runtime:          Node.js 20+
Language:         TypeScript 5.x
Build:            tsup (fast, esbuild-based bundler)
Test:             vitest

Storage:          better-sqlite3 + drizzle-orm + drizzle-kit
AI Abstraction:   Vercel AI SDK (@ai-sdk/openai, @ai-sdk/anthropic, ollama-ai-provider)
MCP:              @modelcontextprotocol/sdk + zod
CLI:              commander
Validation:       zod
IDs:              nanoid
```

---

## 2. Project Structure

```
knowl/
├── docs/
│   ├── master-spec.md
│   └── implementation-plan.md        ← this file
│
├── src/
│   ├── index.ts                      # CLI entry point
│   │
│   ├── core/
│   │   ├── types.ts                  # All core type definitions
│   │   ├── engine.ts                 # Knowledge Engine orchestrator
│   │   ├── config.ts                 # Configuration loader
│   │   └── errors.ts                 # Custom error types
│   │
│   ├── store/
│   │   ├── schema.ts                 # Drizzle schema (source of truth)
│   │   ├── database.ts               # Database connection & migrations
│   │   ├── repository.ts             # Knowledge CRUD operations
│   │   └── queries.ts                # Complex query builders
│   │
│   ├── pipeline/
│   │   ├── pipeline.ts               # Pipeline orchestrator
│   │   ├── filter.ts                 # Stage 1: Should this be stored?
│   │   ├── extract.ts                # Stage 2: Unstructured → Structured
│   │   ├── verify.ts                 # Stage 3: Duplicate/conflict check
│   │   ├── merge.ts                  # Stage 4: Merge into project state
│   │   └── compress.ts               # Stage 5: Collapse into conclusions
│   │
│   ├── ai/
│   │   ├── provider.ts               # AI provider manager
│   │   ├── prompts.ts                # All LLM prompt templates
│   │   └── schemas.ts                # Zod schemas for structured AI output
│   │
│   ├── mcp/
│   │   ├── server.ts                 # MCP server setup & transport
│   │   ├── tools.ts                  # MCP tool definitions
│   │   └── resources.ts              # MCP resource definitions
│   │
│   └── cli/
│       ├── index.ts                  # CLI router (commander setup)
│       └── commands/
│           ├── init.ts               # knowl init
│           ├── state.ts              # knowl state
│           ├── decide.ts             # knowl decide
│           ├── ask.ts                # knowl ask
│           └── serve.ts              # knowl serve (start MCP server)
│
├── tests/
│   ├── store/
│   ├── pipeline/
│   ├── ai/
│   └── mcp/
│
├── .knowl/                           # Created by `knowl init` in target project
│   ├── knowl.db                      # SQLite database
│   └── config.json                   # Project-level config
│
├── package.json
├── tsconfig.json
├── drizzle.config.ts
└── vitest.config.ts
```

---

## 3. Database Schema

### 3.1 Core Tables

Using Drizzle ORM for type-safe schema definition. All tables stored in a single SQLite file (`.knowl/knowl.db`).

#### `projects` — Project Identity

```
id              TEXT PRIMARY KEY        (nanoid)
name            TEXT NOT NULL
description     TEXT
root_path       TEXT                    (absolute path to project root)
created_at      TEXT NOT NULL           (ISO 8601)
updated_at      TEXT NOT NULL           (ISO 8601)
```

#### `knowledge_items` — The Core Entity

Every piece of knowledge is a knowledge item with a category and status.

```
id              TEXT PRIMARY KEY        (nanoid)
project_id      TEXT NOT NULL           (FK → projects.id)
category        TEXT NOT NULL           (fact | decision | goal | constraint | architecture | state | skill)
status          TEXT NOT NULL DEFAULT 'active'
                                       (active | deprecated | rejected | archived | superseded)
title           TEXT NOT NULL           (human-readable summary)
content         TEXT NOT NULL           (the knowledge itself, markdown)
reasoning       TEXT                    (why this knowledge exists)
alternatives    TEXT                    (JSON array — for decisions)
tags            TEXT                    (JSON array — for filtering)
source          TEXT                    (where this came from: conversation, manual, ingest)
confidence      REAL DEFAULT 1.0       (0.0 - 1.0)
superseded_by   TEXT                    (FK → knowledge_items.id, when status = superseded)
version         INTEGER DEFAULT 1
created_at      TEXT NOT NULL           (ISO 8601)
updated_at      TEXT NOT NULL           (ISO 8601)
```

**Indexes:**
- `(project_id, category, status)` — hierarchical retrieval by category
- `(project_id, status)` — active knowledge query
- `(project_id, updated_at)` — recency queries

#### `knowledge_commits` — Version History

```
id              TEXT PRIMARY KEY        (nanoid)
project_id      TEXT NOT NULL           (FK → projects.id)
message         TEXT NOT NULL           (human-readable commit message)
changes         TEXT NOT NULL           (JSON: array of {item_id, action, before, after})
created_at      TEXT NOT NULL           (ISO 8601)
```

#### `skill_steps` — Procedure Steps for Skills

```
id              TEXT PRIMARY KEY        (nanoid)
knowledge_item_id TEXT NOT NULL         (FK → knowledge_items.id WHERE category='skill')
step_order      INTEGER NOT NULL
instruction     TEXT NOT NULL
created_at      TEXT NOT NULL           (ISO 8601)
```

#### `skill_metadata` — Tracking for Skills

```
knowledge_item_id TEXT PRIMARY KEY      (FK → knowledge_items.id)
usage_count     INTEGER DEFAULT 0
success_count   INTEGER DEFAULT 0
last_used       TEXT                    (ISO 8601)
```

### 3.2 SQLite Configuration

```sql
PRAGMA journal_mode = WAL;          -- concurrent read performance
PRAGMA foreign_keys = ON;           -- enforce FK constraints
PRAGMA busy_timeout = 5000;         -- 5s timeout on lock contention
```

---

## 4. Core Types

### 4.1 Knowledge Categories

```typescript
type KnowledgeCategory =
  | 'fact'           // Objective truths (Language: TypeScript)
  | 'decision'       // Choices with reasoning (Use PostgreSQL because...)
  | 'goal'           // Desired outcomes (Support low-end hardware)
  | 'constraint'     // Hard rules (No cloud APIs)
  | 'architecture'   // Structural understanding (Frontend: React)
  | 'state'          // Current activity (Working on: Auth)
  | 'skill';         // Learned procedures (Maven debugging steps)
```

### 4.2 Knowledge Status Lifecycle

```
                ┌──────────┐
       ┌───────→│  Active  │←──────────┐
       │        └────┬─────┘           │
       │             │                 │
  [created]    [supersede]        [reactivate]
       │             │                 │
       │        ┌────▼──────┐    ┌─────┴──────┐
       │        │ Superseded │    │  Archived  │
       │        └───────────┘    └────────────┘
       │             │                 ▲
       │        [deprecate]       [archive]
       │             │                 │
       │        ┌────▼──────┐          │
       └────────│ Deprecated ├─────────┘
                └────┬──────┘
                     │
                [reject]
                     │
                ┌────▼────┐
                │ Rejected │
                └─────────┘
```

### 4.3 Retrieval Priority (Hierarchical)

```
L1  →  Current State     (category = 'state', status = 'active')
L2  →  Knowledge          (category IN ('fact','decision','goal','constraint','architecture'), status = 'active')
L3  →  Skills             (category = 'skill', status = 'active')
L4  →  Archive            (status IN ('archived','deprecated','superseded'))
```

---

## 5. Knowledge Pipeline

The pipeline transforms raw input into verified, structured knowledge. Each stage is a discrete, testable module.

### 5.1 Pipeline Flow

```
Input (raw text / conversation)
  │
  ▼
┌─────────────────────────────────────────────────┐
│ Stage 1: FILTER                                  │
│ "Should this be stored at all?"                  │
│                                                  │
│ AI classifies input as:                          │
│   • knowledge (proceed)                          │
│   • noise (discard — typos, failed experiments)  │
│   • sensitive (reject — passwords, API keys)     │
│                                                  │
│ Output: FilterResult { pass: boolean, reason }   │
└─────────────┬───────────────────────────────────┘
              │ (if pass)
              ▼
┌─────────────────────────────────────────────────┐
│ Stage 2: EXTRACT                                 │
│ "What structured knowledge is in this text?"     │
│                                                  │
│ AI extracts one or more knowledge atoms:         │
│   { category, title, content, reasoning,         │
│     alternatives, tags, confidence }             │
│                                                  │
│ Uses structured output (Zod schema validation)   │
│                                                  │
│ Output: KnowledgeAtom[]                          │
└─────────────┬───────────────────────────────────┘
              │
              ▼
┌─────────────────────────────────────────────────┐
│ Stage 3: VERIFY                                  │
│ "Is this new, duplicate, or contradictory?"      │
│                                                  │
│ For each atom, query existing knowledge:         │
│   • Exact duplicate → discard                    │
│   • Update to existing → prepare merge           │
│   • Contradiction → flag for resolution          │
│   • Truly new → proceed                          │
│                                                  │
│ Uses DB queries + optional AI comparison         │
│                                                  │
│ Output: VerifiedAtom[] with merge instructions   │
└─────────────┬───────────────────────────────────┘
              │
              ▼
┌─────────────────────────────────────────────────┐
│ Stage 4: MERGE                                   │
│ "Integrate into project state"                   │
│                                                  │
│ Actions:                                         │
│   • INSERT new items                             │
│   • UPDATE existing items (bump version)         │
│   • SUPERSEDE old items (status change)          │
│   • Create knowledge commit                      │
│                                                  │
│ Output: MergeResult { committed items, commit }  │
└─────────────────────────────────────────────────┘
```

### 5.2 Compression (Background / On-Demand)

Compression is NOT part of the main pipeline — it runs separately:

```
Trigger: Manual (`knowl compress`) or periodic
Input: All knowledge items for a topic/category
Output: Compressed, merged knowledge atoms

Example:
  15 state items about "auth feature"
  → 1 summary state item: "Auth: JWT with refresh tokens, RBAC, OAuth2 Google"
```

### 5.3 Garbage Collection (Future — V3+)

Not in scope for initial build. Will handle:
- Removing raw sources after compression
- Archiving low-confidence items
- Expiring time-sensitive knowledge

---

## 6. AI Provider Layer

### 6.1 Architecture

Use Vercel AI SDK as the universal abstraction layer.

```typescript
// Configuration in .knowl/config.json
{
  "ai": {
    "provider": "openai",           // or "anthropic", "ollama", "custom"
    "model": "gpt-4o-mini",         // or "claude-sonnet-4-20250514", "llama3", etc.
    "apiKey": "${OPENAI_API_KEY}",  // env var reference
    "baseUrl": null,                // custom endpoint (for Ollama: http://localhost:11434)
    "options": {
      "temperature": 0.1            // low temp for deterministic extraction
    }
  }
}
```

### 6.2 Provider Resolution

```
config.ai.provider
  ├── "openai"     → @ai-sdk/openai
  ├── "anthropic"  → @ai-sdk/anthropic
  ├── "ollama"     → ollama-ai-provider
  └── "custom"     → config.ai.baseUrl (OpenAI-compatible API)
```

### 6.3 Core AI Operations

All pipeline stages that need AI call through a unified interface:

```typescript
// Pseudocode — actual implementation uses Vercel AI SDK's generateObject/generateText
class AIProvider {
  async classify(input: string): Promise<FilterResult>      // Stage 1
  async extract(input: string): Promise<KnowledgeAtom[]>    // Stage 2
  async compare(a: KnowledgeItem, b: KnowledgeAtom): Promise<CompareResult>  // Stage 3
  async compress(items: KnowledgeItem[]): Promise<KnowledgeAtom>             // Compression
}
```

All operations use **structured output** via Zod schemas — the AI returns validated JSON, not free-form text.

---

## 7. MCP Server

### 7.1 Purpose

The MCP server is how **any AI agent** connects to Knowl. It exposes Knowl's capabilities as MCP tools and resources. Any MCP-compatible client (Claude Desktop, Cursor, custom agents) can plug in.

### 7.2 Transport

- **Primary**: `stdio` — for local integrations (Claude Desktop, Cursor, etc.)
- **Future**: Streamable HTTP — for remote/multi-agent setups

### 7.3 MCP Tools

| Tool | Description | Key Parameters |
|---|---|---|
| `knowl_ingest` | Process raw text through the knowledge pipeline | `text`, `source?` |
| `knowl_store` | Directly store a structured knowledge item | `category`, `title`, `content`, `reasoning?` |
| `knowl_query` | Query knowledge by category, status, tags | `category?`, `status?`, `tags?`, `query?` |
| `knowl_state` | Get full current project state snapshot | — |
| `knowl_decide` | Record a decision with reasoning | `title`, `content`, `reasoning`, `alternatives?` |
| `knowl_ask` | Natural language question about the project | `question` |
| `knowl_update` | Update an existing knowledge item | `id`, `content?`, `status?`, `reasoning?` |
| `knowl_history` | View knowledge commit history | `limit?` |

### 7.4 MCP Resources

| Resource | URI Pattern | Description |
|---|---|---|
| Project Brain | `knowl://brain` | Full project state (L1+L2+L3) as structured markdown |
| Category | `knowl://category/{name}` | All active items in a category |
| Item | `knowl://item/{id}` | Single knowledge item with full metadata |

---

## 8. CLI Commands (V1)

| Command | Description |
|---|---|
| `knowl init` | Initialize `.knowl/` directory and database in current project |
| `knowl state` | Display current project state (L1+L2 knowledge) |
| `knowl decide <title>` | Interactive: record a decision with reasoning |
| `knowl ask <question>` | Query the knowledge base in natural language |
| `knowl serve` | Start the MCP server (stdio mode) |
| `knowl config` | View/edit AI provider configuration |
| `knowl status` | Show knowledge stats (item count by category, last commit, etc.) |

---

## 9. Configuration System

### 9.1 `.knowl/config.json`

Created by `knowl init`. Stores project-level settings.

```json
{
  "version": 1,
  "project": {
    "name": "my-project",
    "description": "A web application"
  },
  "ai": {
    "provider": "openai",
    "model": "gpt-4o-mini",
    "temperature": 0.1
  },
  "security": {
    "rejectSecrets": true,
    "secretPatterns": [
      "password", "api_key", "token", "secret",
      "private_key", "credential"
    ]
  }
}
```

### 9.2 Environment Variables

```
KNOWL_AI_PROVIDER=openai              # override config
KNOWL_AI_MODEL=gpt-4o-mini            # override config
OPENAI_API_KEY=sk-...                 # provider API key
ANTHROPIC_API_KEY=sk-ant-...          # provider API key
OLLAMA_BASE_URL=http://localhost:11434 # local model endpoint
```

---

## 10. Build Phases

### Phase 1: Foundation (Start Here)
**Goal: Project skeleton, types, database, basic CRUD**

- [ ] Initialize TypeScript project with tsup, vitest
- [ ] Define all core types (`types.ts`)
- [ ] Define Drizzle schema (`schema.ts`)
- [ ] Implement database connection & migration (`database.ts`)
- [ ] Implement knowledge repository — CRUD operations (`repository.ts`)
- [ ] Implement hierarchical retrieval queries (`queries.ts`)
- [ ] Write tests for store layer
- [ ] Implement `knowl init` CLI command

**Deliverable:** Can create a `.knowl/` directory, store and retrieve knowledge items programmatically.

---

### Phase 2: AI Provider Layer
**Goal: Pluggable AI that works with any model**

- [ ] Implement AI provider manager using Vercel AI SDK (`provider.ts`)
- [ ] Define all prompt templates (`prompts.ts`)
- [ ] Define Zod schemas for structured AI output (`schemas.ts`)
- [ ] Support OpenAI, Anthropic, Ollama providers
- [ ] Implement configuration system (`config.ts`)
- [ ] Write tests with mock provider

**Deliverable:** Can call any supported AI model with structured output for extraction/classification tasks.

---

### Phase 3: Knowledge Pipeline
**Goal: The core intelligence — filter, extract, verify, merge**

- [ ] Implement Filter stage (`filter.ts`)
- [ ] Implement Extract stage (`extract.ts`)
- [ ] Implement Verify stage (`verify.ts`)
- [ ] Implement Merge stage with knowledge commits (`merge.ts`)
- [ ] Implement Pipeline orchestrator (`pipeline.ts`)
- [ ] Write integration tests for full pipeline flow

**Deliverable:** Can process raw text input and produce verified, structured knowledge items in the database.

---

### Phase 4: MCP Server
**Goal: Any AI agent can connect to Knowl**

- [ ] Implement MCP server with stdio transport (`server.ts`)
- [ ] Define all MCP tools (`tools.ts`)
- [ ] Define MCP resources (`resources.ts`)
- [ ] Test with Claude Desktop / Cursor
- [ ] Implement `knowl serve` CLI command

**Deliverable:** Running `knowl serve` starts an MCP server that Claude/Cursor can connect to.

---

### Phase 5: CLI & Polish
**Goal: Complete V1 CLI experience**

- [ ] Implement `knowl state` (pretty-print project state)
- [ ] Implement `knowl decide` (interactive decision recording)
- [ ] Implement `knowl ask` (natural language query)
- [ ] Implement `knowl config` (view/edit configuration)
- [ ] Implement `knowl status` (knowledge stats)
- [ ] Add error handling, user-friendly messages, colors
- [ ] Write end-to-end tests

**Deliverable:** Full V1 CLI as described in the master spec.

---

### Phase 6: Compression (V2)
**Goal: Collapse verbose knowledge into conclusions**

- [ ] Implement Compress stage (`compress.ts`)
- [ ] Implement `knowl compress` CLI command
- [ ] Test compression quality

**Deliverable:** Can compress many related knowledge items into concise summaries.

---

## 11. Security Considerations

### What Gets Rejected (Filter Stage)

The filter stage rejects any input containing:
- Passwords / passphrases
- API keys (patterns: `sk-`, `pk-`, `api_`, etc.)
- Tokens (JWT, OAuth)
- Private keys (PEM blocks)
- Connection strings with credentials

### Configurable Patterns

Users can add custom rejection patterns in `.knowl/config.json` under `security.secretPatterns`.

---

## 12. Testing Strategy

### Unit Tests
- Store layer: CRUD, queries, status transitions
- Pipeline stages: Each stage independently with mock AI
- AI provider: Mock provider for deterministic testing

### Integration Tests
- Full pipeline: Raw text → stored knowledge
- MCP server: Tool invocations → correct responses
- CLI: Command execution → expected output

### Test Database
- Use in-memory SQLite (`:memory:`) for test speed
- Seed with known fixtures for query testing

---

## 13. Open Design Decisions

### 13.1 Knowledge Item Granularity
**Question:** Should a single `knowl_ingest` call produce one item or many?  
**Current answer:** Many — the extraction stage can produce multiple atoms from a single input.

### 13.2 Conflict Resolution UX
**Question:** When the verify stage detects a contradiction, should it auto-resolve or ask the user?  
**Current answer:** In MCP mode, return the conflict to the agent. In CLI mode, prompt the user interactively.

### 13.3 Project Scope
**Question:** One `.knowl/` per project root, or a global knowledge store?  
**Current answer:** Per-project. Each `knowl init` creates an isolated knowledge base. A global layer can be added later.

---

## Summary

| Aspect | Choice |
|---|---|
| Language | TypeScript |
| Storage | SQLite via Drizzle ORM + better-sqlite3 |
| AI | Vercel AI SDK (pluggable: OpenAI, Anthropic, Ollama) |
| Bridge | MCP server (stdio transport) |
| CLI | commander |
| Testing | vitest |
| Build | tsup |
| Start Phase | Phase 1: Foundation |
