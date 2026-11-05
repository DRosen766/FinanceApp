# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

FinanceApp is a personal finance tracker that pulls data from the owner's bank accounts via the **Plaid API**. It is planned as several components sharing one backend data source:

1. **MCP server**: gives the owner's AI agents **read-only** access to financial data (accounts, balances, transactions).
2. **Web dashboard**: runs locally first, then moves to a remote deployment.
3. **iOS app**: later.

The repo is in its bootstrap phase. No language, framework, or build tooling has been chosen yet. When the stack is set up, add the build/lint/test commands (including how to run a single test) to a **Commands** section here.

## Git workflow (required)

- **Never commit or push directly to `main`.** Every change goes through a PR.
- For each new feature, create a **git worktree as a sibling of the main checkout** (`/Users/dannyrosen/FinanceApp_parent/FinanceApp`), and **pull the latest `main` first**:
  ```bash
  cd /Users/dannyrosen/FinanceApp_parent/FinanceApp
  git checkout main && git pull --ff-only origin main
  git worktree add ../FinanceApp-<feature> -b <feature-branch> main
  cd ../FinanceApp-<feature>
  ```
- Open the PR with `gh pr create --base main --reviewer DRosen766`.
- After merge, clean up with `git worktree remove ../FinanceApp-<feature>` and delete the branch.

## Security (top priority)

Security takes precedence over convenience, speed, and features. When a design choice trades security for something else, choose the secure option, or stop and ask.

Invariants every component must preserve:

- **The MCP server is strictly read-only.** It must never expose Plaid endpoints that move money or change state, such as Transfer, Payment Initiation, or item removal or updates. Enforce this in code with an allowlist of Plaid calls. A tool description saying "read-only" does not count.
- **Plaid `access_token`s stay on the backend.** Never return them to the MCP clients, the dashboard frontend, the iOS app, or logs. Encrypt them at rest.
- **Minimize what leaves the backend.** Don't return full account or routing numbers or raw Plaid payloads through the MCP server or UI unless a feature explicitly requires it.
- **Authenticate every surface.** The MCP server and the dashboard need authentication even when they run on localhost. Remote deployment must not weaken that.
- **Use the Plaid Sandbox environment for development and tests.** Never put real financial data in fixtures, test snapshots, or commits.
