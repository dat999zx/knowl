KNOWL — MASTER VISION SPECIFICATION
A Knowledge Operating System for AI Agents

Version: Founding Vision

Status: Canonical Project Definition

1. The Problem

AI agents have a continuity problem.

People think agents suffer from lack of memory.

That is only partially true.

The deeper issue is:

They forget project decisions
They repeat solved mistakes
They retrieve outdated information
They lose project understanding
They never truly learn procedures
They accumulate garbage context
They cannot maintain evolving project truth

Current systems try to solve:

"How do we remember more?"

Knowl tries to solve:

"How do we understand and evolve knowledge better?"

2. The Core Thesis

Memory is the wrong abstraction.

Projects do not operate on conversations.

Projects operate on state.

Current systems store:

Conversation History

Knowl stores:

Project Understanding

Traditional memory systems ask:

Store → Retrieve

Knowl asks:

Observe → Extract → Verify → Compress → Store → Retrieve → Learn

3. The Fundamental Shift

Most AI memory products are:

Conversation Databases

Knowl is:

A Knowledge Operating System

Difference:

Memory stores what happened.

Knowledge stores what matters.

Example:

Conversation:

"We should switch from MongoDB to PostgreSQL because joins became difficult."

Memory System:

Stores entire conversation.

Knowl:

Decision:
Switch to PostgreSQL

Reason:
Need joins

Status:
Active

The conversation becomes disposable.

The knowledge survives.

4. The Real Problem With Current Memory Systems
Accumulation Problem

Projects generate enormous amounts of garbage.

Typical project:

80%:

Failed attempts
Brainstorming
Debugging noise
Temporary ideas
Wrong solutions

20%:

Actual knowledge

Most systems store everything.

Result:

Infinite memory growth.

Retrieval Pollution

Question:

Why PostgreSQL?

Traditional retrieval:

Search embeddings.

May retrieve:

MongoDB discussion
Docker discussion
Redis discussion
PostgreSQL discussion

Result:

Noise.

Context pollution.

Staleness

Project state changes.

Example:

2025:
MongoDB

2026:
PostgreSQL

Traditional systems often retrieve both.

Result:

Conflicting truth.

Self-Contamination

One of the most important problems.

Example:

Agent writes bad code.

User fixes code.

Both versions are stored.

Later:

Agent retrieves its own broken code.

Agent learns from failure.

Failure becomes memory.

This creates:

Self-Contamination Loops

Knowl must always prioritize validated outcomes.

No Learning

Current memory systems remember facts.

They do not learn skills.

Example:

User teaches Maven debugging 100 times.

Agent still forgets.

Humans learn procedures.

Most agents do not.

5. Core Philosophy

Projects are not conversations.

Projects are evolving systems.

The purpose of Knowl is to maintain the evolving understanding of a project.

The system should continuously answer:

What are we building?
Why are we building it?
What decisions were made?
What constraints exist?
What architecture exists?
What has changed?
What skills have been learned?
6. Project State vs Memory

This is the most important distinction.

Memory:

Historical information.

State:

Current truth.

Bad:

Database:

MongoDB
PostgreSQL

Good:

Current Database:
PostgreSQL

History:
MongoDB (Deprecated)

Retrieval should prioritize current truth.

History is secondary.

7. Source Of Truth

Knowl maintains a Dynamic Source Of Truth.

Not:

Store truth once.

Instead:

Continuously maintain truth.

Example:

Database:
MongoDB

↓

Decision:
Migrate

↓

Database:
PostgreSQL

Truth evolves.

The system must evolve with it.

8. Knowledge Model

All knowledge belongs to categories.

Facts

Objective truths.

Example:

Language:
TypeScript

Decisions

Choices with reasoning.

Example:

Use PostgreSQL

Reason:
Need joins

Alternatives:
MongoDB

Goals

Desired outcomes.

Example:

Support low-end hardware.

Constraints

Rules.

Example:

No cloud APIs.

Architecture

Structural understanding.

Example:

Frontend:
React

Backend:
Spring

Database:
PostgreSQL

State

Current activity.

Example:

Current Feature:
Authentication

Skills

Learned procedures.

Example:

Maven Debugging

Find first Caused By
Ignore stack traces
Check dependency tree
Historical Records

Archived knowledge.

Only used when necessary.

9. Project Brain

Conceptually:

Project Brain

├── Goals
├── Constraints
├── Current State
├── Architecture
├── Decisions
├── Facts
├── Skills
├── History
└── Archive

This hierarchy should influence retrieval.

10. Knowledge Lifecycle

Everything follows:

Observe
→ Filter
→ Extract
→ Verify
→ Merge
→ Compress
→ Store
→ Retrieve
→ Learn
→ Decay

11. Filtering

Most information should die.

Examples discarded:

Typographical mistakes
Temporary bugs
Failed experiments
Dead-end brainstorming
Draft code

Examples retained:

Decisions
Constraints
Architecture
Goals
Successful procedures

Storage should be selective.

Not archival.

12. Extraction

Convert unstructured information into structured knowledge.

Input:

Conversation

Output:

Decision
Fact
Goal
Constraint
Skill
State

13. Verification

Every new item must be checked.

Questions:

Is it duplicate?
Is it update?
Is it contradiction?
Is it obsolete?
Is it validated?
14. Merge

Knowledge should merge into project state.

Not endlessly append.

Knowl should maintain understanding.

Not maintain logs.

15. Compression

One of the most important systems.

100 messages

↓

1 conclusion

Example:

1000-message JWT discussion

↓

Decision:
Use JWT

Reason:
Stateless authentication

Alternatives:
Session auth

Status:
Active

Compression removes noise.

Knowledge survives.

Conversation dies.

16. Garbage Collection

Different from compression.

Compression creates knowledge.

Garbage Collection removes leftovers.

Example:

Raw discussion
→ Compressed
→ Intermediate messages deleted

Purpose:

Prevent accumulation.

17. Knowledge Commits

Inspired by Git.

Git stores:

Code evolution.

Knowl stores:

Understanding evolution.

Example:

Knowledge Commit #42

Decision:
Switch PostgreSQL

Reason:
Need joins

Supersedes:
MongoDB

Status:
Active

Knowledge commits become first-class entities.

18. Knowledge Evolution

Knowledge should evolve.

Fact:

Use PostgreSQL

↓

Rule:

When relational joins are required,
prefer PostgreSQL.

↓

Skill:

Database selection strategy.

The system should continuously move toward higher-level understanding.

19. Current Truth Engine

Every topic should have:

Current Truth

Examples:

Current Database
Current Language
Current Architecture
Current Constraints

This is the primary retrieval target.

20. Conflict Resolution

Statuses:

Active

Deprecated

Rejected

Archived

Superseded

Example:

MongoDB:
Deprecated

PostgreSQL:
Active

Conflict resolution updates truth.

Not duplicates truth.

21. Retrieval Philosophy

Traditional:

Question
→ Vector Search Everything

Knowl:

Question
→ Goals
→ Constraints
→ Current State
→ Architecture
→ Decisions
→ Skills
→ History

Retrieval is hierarchical.

Not flat.

22. Hierarchical Memory

L1:
Current State

L2:
Knowledge

L3:
Skills

L4:
Archive

Higher layers are loaded first.

History should be last resort.

23. Knowledge Graph Vision

Future direction.

Knowledge becomes relationships.

Example:

PostgreSQL

chosen_because → joins

replaced → MongoDB

supports → reporting

affects → auth service

Graphs represent understanding better than flat memory.

24. Skill Learning

Most memory systems stop at storage.

Knowl should eventually learn.

Example:

User corrects Spring services repeatedly.

System detects pattern.

Creates:

Skill:
Spring Service Pattern

Procedure:

Constructor injection
Service layer
ResponseEntity

Confidence:
0.92

25. Skill Metadata

Every skill tracks:

Confidence

Usage Count

Success Rate

Last Used

Creation Date

Source

26. Skill Decay

Skills can become obsolete.

Example:

Java 17 best practices.

Future:

Java 25.

Old skills must:

Decay

Archive

Be replaced

27. Learning vs Remembering

Critical distinction.

Remembering:

Store
Retrieve

Learning:

Observe
Generalize
Verify
Apply
Improve

Knowl ultimately aims for learning.

Not just remembering.

28. Performance Philosophy

Current memory systems:

Cheap write
Expensive read

Knowl:

Expensive write
Cheap read

Conversation processing can be expensive.

Retrieval should be extremely cheap.

Write once.

Read forever.

29. Security

Before storage:

Reject:

Passwords

API Keys

Tokens

Secrets

Private credentials

Support:

Encryption

Expiration

Retention policies

Memory classes

30. Repository Awareness

Future system.

Knowl should understand repository changes.

Examples:

package.json changes

pom.xml changes

Architecture changes

Framework migrations

Repository changes become state updates.

Not merely file changes.

31. Competitive Positioning

Not competing with:

Vector DBs

Embedding Stores

Conversation Archives

Competing with:

Manual project documentation

README files

Notion

Confluence

Agent Memory systems

The value proposition:

Automatically maintain project understanding.

32. CLI Vision

V1

knowl init

knowl state

knowl decide

knowl ask

V2

knowl ingest

V3

knowl sync

V4

knowl commit

knowl history

V5

knowl learn

knowl skills

33. MVP Scope

V1 should NOT include:

Skill Learning

Knowledge Graphs

Complex Retrieval

Multi-Agent Systems

Advanced AI Research

Focus:

Project State

Decisions

Current Truth

Knowledge Commits

34. Non-Goals

Knowl is not:

A chatbot

A vector database

Infinite memory

A replacement for LLMs

A conversation archive

A note-taking app

35. Long-Term Vision

Git manages code.

Knowl manages understanding.

Git remembers:

What changed.

Knowl remembers:

Why it changed.

Git preserves implementation.

Knowl preserves reasoning.

Git enables long-term software development.

Knowl enables long-term AI project continuity.

Ultimate Mission:

Create a Knowledge Operating System that continuously transforms conversations, documents, repositories, and experiences into verified project state, evolving knowledge, and learned skills while preventing memory bloat, self-contamination, stale information, retrieval pollution, forgotten decisions, and repeated mistakes.

Final Principle:

Do not store everything.

Understand what matters.