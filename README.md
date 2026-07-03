# Knowl — A Knowledge Operating System for AI Agents

Knowl is a local-first, model-agnostic knowledge operating system built specifically for AI developers and agents. Instead of storing messy, raw conversation transcripts, Knowl extracts, verifies, and maintains structured, versioned project understanding (decisions, architecture, goals, constraints, facts, states, and skills) in a local SQLite database.

It exposes this knowledge through a clean Command Line Interface (CLI) and a Model Context Protocol (MCP) server bridge.

---

## 🚀 Key Features

*   **Model-Agnostic Ingestion:** Extract structured knowledge atoms from unstructured transcripts, chats, or documentation.
*   **Active Conflict Detection & Verification:** Compares incoming knowledge against existing entries using title-based Jaccard similarity and LLMs, auto-superseding outdated facts or warning about contradictions.
*   **Hierarchical Project Memory:** Organizes memory layers (Goals, Constraints, Active State, Architecture, Decisions, General Facts, and Skills) to supply context to AI models.
*   **Model Context Protocol (MCP) Integration:** Direct bridge for AI systems like Cursor, Claude Desktop, or custom agent systems.
*   **100% Local Storage:** Programmatic SQLite database powered by Drizzle ORM initialized on a per-project basis under `.knowl/`.

---

## 📦 Installation

To build and install the binary globally from source:

```bash
# Clone the repository
git clone <repo-url>
cd knowl

# Install dependencies and build project
npm install
npm run build

# Link the executable globally
npm link
```

Verify that it is installed:
```bash
knowl --version
```

---

## 📖 Quick Start

### 1. Initialize a Project
Create a new directory (or navigate to an existing codebase) and initialize Knowl:
```bash
knowl init "My Awesome Project"
```
This creates a local database and a configuration file under `.knowl/`. It also creates or updates `AGENTS.md` with guidance telling Codex-style agents to query Knowl before answering project-specific questions and to save durable project knowledge back into Knowl.

### 2. Directly Record Decisions & Facts
```bash
knowl decide "Use SQLite" "We decided to use SQLite for lightweight, local persistence." -r "Serverless and zero-setup" -a MongoDB,PostgreSQL -t database,storage
```

### 3. Print Brain State
See the complete hierarchical active project state:
```bash
knowl state
```

### 4. Optional: Configure AI for Standalone Smart Commands
Knowl's MCP server and direct storage commands do not require API keys. Configure an AI provider only if you want standalone raw-text extraction or natural-language answers from the CLI:
```bash
knowl config ai.provider openai
knowl config ai.model gpt-4o-mini
knowl config ai.apiKey ${OPENAI_API_KEY}
```
Environment variables are resolved at runtime.

Then use AI-backed commands:
```bash
knowl ask "Why did we choose SQLite as our database?"
knowl ingest "We switched to SQLite because the project must stay local-first."
```

---

## 🔌 Connecting to Claude Desktop / Cursor (MCP Setup)

To use Knowl as an MCP server with **Claude Desktop** or **Cursor**, add the following server configuration to your global settings:

MCP mode is API-key free by default. The client model (for example Codex, Claude, or Cursor) should reason over project context and call Knowl's structured tools such as `knowl_store`, `knowl_decide`, `knowl_ingest_atoms`, `knowl_query`, and `knowl_state`.

**Claude Desktop Configuration (`%APPDATA%\Claude\claude_desktop_config.json`):**
```json
{
  "mcpServers": {
    "knowl": {
      "command": "knowl",
      "args": ["serve"]
    }
  }
}
```

**Cursor Configuration:**
Add a new MCP server under Settings -> Features -> MCP:
*   Name: `knowl`
*   Type: `command`
*   Command: `knowl serve`

---

## 🛠️ CLI Commands Reference

| Command | Description |
|---|---|
| `knowl init [name]` | Initialize a Knowl project in the current directory |
| `knowl status` | Print current project info, metrics, and recent commit history |
| `knowl state` | Print the full hierarchical active knowledge state of the project |
| `knowl decide [title] [content]` | Record a project decision (runs interactively if parameters are missing) |
| `knowl ask <question>` | Ask a natural language question about the project state (requires explicit AI config) |
| `knowl ingest <text>` | Ingest raw text to filter, extract, and merge project state (requires explicit AI config) |
| `knowl config [key] [value]` | Show, set, or get project configuration (e.g. `knowl config ai.provider openai`) |
| `knowl serve` | Run standard stdio Model Context Protocol (MCP) server |
