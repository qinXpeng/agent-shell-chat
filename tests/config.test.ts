import assert from "node:assert/strict";
import test from "node:test";
import { BUILT_IN_AGENTS, resolveAgentSelection } from "../src/config.js";

test("codex preset uses the maintained adapter with the sandboxCwd fix", () => {
  assert.deepEqual(BUILT_IN_AGENTS.codex, {
    label: "Codex CLI",
    command: "npx",
    args: ["-y", "@agentclientprotocol/codex-acp@1.0.1"],
    description: "Codex ACP (official adapter)",
  });

  assert.deepEqual(resolveAgentSelection("codex"), {
    id: "codex",
    label: "Codex CLI",
    command: "npx",
    args: ["-y", "@agentclientprotocol/codex-acp@1.0.1"],
    env: undefined,
    source: "preset",
  });
});
