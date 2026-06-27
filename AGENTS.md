# Repository Guidelines

## Project Structure & Module Organization

This repository is a strict TypeScript Node.js package that bridges WeChat’s iLink bot API to ACP-compatible agents.

- `bin/agent-shell.ts` defines the command-line entry point.
- `src/` contains the public API and bridge orchestration.
- `src/acp/`, `src/weixin/`, `src/storage/`, `src/inject/`, and `src/telemetry/` group protocol, transport, persistence, injection, and telemetry concerns.
- `tests/*.test.ts` contains Node test-runner suites organized by feature.
- `dist/` is generated build output; do not edit or commit it.
- `.github/workflows/` defines CI and npm publishing.

Keep new code in the narrowest relevant module. Export supported public APIs through `src/index.ts`.

## Build, Test, and Development Commands

Use Node.js 20 or newer.

- `npm ci` installs the exact locked dependency set (preferred for clean checkouts and CI).
- `npm run build` runs `tsc`, emitting JavaScript, declarations, and source maps into `dist/`.
- `npm test` runs all TypeScript tests through Node’s built-in test runner and `tsx`.
- `npm run dev` watches TypeScript sources and rebuilds on changes.
- `npm start -- --help` runs the compiled CLI; build first.

Before submitting changes, run `npm run build && npm test`, matching CI.

## Coding Style & Naming Conventions

Follow the existing TypeScript style: strict types, ES modules, double-quoted strings, semicolons, and trailing commas in multiline constructs. Preserve the indentation used in the file you edit; no formatter or linter is currently configured.

Use `camelCase` for variables and functions, `PascalCase` for types and classes, and descriptive lowercase filenames such as `agent-manager.ts`. Internal imports must include the emitted `.js` extension (for example, `./config.js`) because the project uses `NodeNext`.

## Testing Guidelines

Tests use `node:test` and `node:assert/strict`. Name files `<feature>.test.ts` and write behavior-focused test names, such as `test("sendMessage rejects non-zero ...")`. Add regression coverage for bug fixes and isolate external services by replacing globals or using local fakes. There is no stated coverage threshold; prioritize meaningful branch and error-path coverage.

## Commit & Pull Request Guidelines

Git history is not included in this checkout, so no repository-specific commit format can be confirmed. Use short, imperative subjects (for example, `Fix duplicate intermediate message flush`) and keep each commit focused.

Pull requests should explain the behavior change, motivation, verification commands, and any configuration or compatibility impact. Link relevant issues. Include terminal output for CLI changes and screenshots only when user-visible visual output changes. Do not include tokens, account data, `.env` files, or contents from `~/.agent-shell`.
