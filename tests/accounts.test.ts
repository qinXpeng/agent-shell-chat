import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  discoverAccounts,
  formatAccountName,
  listAccounts,
  registerAccount,
  resolveAccount,
  validateAccountName,
} from "../src/storage/accounts.js";
import { claimRuntime, inspectRuntime, releaseRuntime } from "../src/storage/runtime.js";
import { loadToken, saveToken, type TokenData } from "../src/weixin/auth.js";

function tempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agent-shell-accounts-"));
}

function token(accountId: string): TokenData {
  return {
    token: `token-${accountId}`,
    baseUrl: "https://example.test",
    accountId,
    userId: `user-${accountId}`,
    savedAt: "2026-06-27T00:00:00.000Z",
  };
}

test("registers and resolves multiple named accounts", (t) => {
  const root = tempRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const work = registerAccount({ rootDir: root, token: token("wx-work"), accountName: "工作号" });
  registerAccount({ rootDir: root, token: token("wx-test"), accountName: "测试号" });

  assert.equal(listAccounts(root).length, 2);
  assert.equal(resolveAccount(root, "工作号").record.accountId, "wx-work");
  assert.equal(resolveAccount(root, "wx-work").record.accountKey, work.record.accountKey);
  assert.equal(resolveAccount(root, "工作号-wx-work").record.accountKey, work.record.accountKey);
  assert.equal(formatAccountName(work.record), "工作号-wx-work");
  assert.equal(loadToken(work.storageDir)?.accountName, "工作号");
});

test("migrates the legacy global token as the default account", (t) => {
  const root = tempRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  saveToken(root, token("wx-legacy"));

  const accounts = discoverAccounts(root);

  assert.equal(accounts.length, 1);
  assert.equal(accounts[0].record.accountName, "default");
  assert.equal(accounts[0].record.accountId, "wx-legacy");
  assert.equal(accounts[0].storageDir, root);
  assert.equal(loadToken(root)?.accountName, "default");
});

test("indexes existing --instance token directories without moving them", (t) => {
  const root = tempRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const instanceDir = path.join(root, "instances", "project-a");
  saveToken(instanceDir, token("wx-instance"));

  const accounts = discoverAccounts(root);

  assert.equal(accounts.length, 1);
  assert.equal(accounts[0].record.accountName, "project-a");
  assert.equal(accounts[0].storageDir, instanceDir);
  assert.equal(loadToken(instanceDir)?.accountName, "project-a");
});

test("overwriting an account with a different WeChat identity resets sync state", (t) => {
  const root = tempRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const existing = registerAccount({
    rootDir: root,
    token: token("wx-old"),
    accountName: "工作号",
  });
  fs.writeFileSync(path.join(existing.storageDir, "sync-buf.json"), "{}");
  fs.writeFileSync(path.join(existing.storageDir, "state.json"), "{}");

  const replaced = registerAccount({
    rootDir: root,
    token: token("wx-new"),
    accountName: "工作号",
    overwriteAccountKey: existing.record.accountKey,
  });

  assert.equal(replaced.record.accountKey, existing.record.accountKey);
  assert.equal(listAccounts(root).length, 1);
  assert.equal(loadToken(replaced.storageDir)?.accountId, "wx-new");
  assert.equal(fs.existsSync(path.join(replaced.storageDir, "sync-buf.json")), false);
  assert.equal(fs.existsSync(path.join(replaced.storageDir, "state.json")), false);
});

test("runtime claim prevents a second process for the same account", (t) => {
  const root = tempRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runtime = {
    pid: process.pid,
    accountKey: "key",
    accountName: "工作号",
    accountId: "wx-work",
    agent: "codex",
    cwd: root,
    startedAt: new Date().toISOString(),
    daemon: false,
  };

  claimRuntime(root, runtime);
  assert.equal(inspectRuntime(root).running, true);
  assert.throws(() => claimRuntime(root, runtime), /already running/);
  releaseRuntime(root, process.pid);
  assert.equal(inspectRuntime(root).running, false);
});

test("account names are mandatory and bounded", () => {
  assert.throws(() => validateAccountName("   "), /required/);
  assert.throws(() => validateAccountName("x".repeat(65)), /at most 64/);
  assert.equal(validateAccountName("  工作号  "), "工作号");
});
