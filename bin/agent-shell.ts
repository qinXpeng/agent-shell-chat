#!/usr/bin/env node

/**
 * agent-shell CLI entry point.
 *
 * Usage:
 *   agent-shell --agent "claude code"
 *   agent-shell --agent "gemini" --cwd /path/to/project
 *   agent-shell --agent "npx tsx ./agent.ts" --login
 *   agent-shell --agent "claude code" --daemon
 *   agent-shell stop
 *   agent-shell status
 *   agent-shell inject --text "今日 AI 资讯"
 */

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline/promises";
import qrcodeTerminal from "qrcode-terminal";
import { AgentShellBridge } from "../src/bridge.js";
import {
  defaultConfig,
  defaultStorageDir,
  listBuiltInAgents,
  resolveAgentSelection,
  validateCommandAliases,
  validateInstanceName,
} from "../src/config.js";
import type { AgentShellConfig } from "../src/config.js";
import { queueInjectedMessage } from "../src/inject/queue.js";
import { DEFAULT_INJECTION_TARGET } from "../src/inject/types.js";
import {
  discoverAccounts,
  formatAccountName,
  registerAccount,
  resolveAccount,
  validateAccountName,
  type RegisteredAccount,
} from "../src/storage/accounts.js";
import {
  claimRuntime,
  inspectRuntime,
  releaseRuntime,
  type RuntimeRecord,
} from "../src/storage/runtime.js";
import { loadToken, login } from "../src/weixin/auth.js";
import {
  initTelemetry,
  trackEvent,
  trackException,
  shutdownTelemetry,
} from "../src/telemetry/index.js";
import packageJson from "../package.json" with { type: "json" };

function usage(): void {
  const presets = listBuiltInAgents()
    .map(({ id }) => id)
    .join(", ");

  console.log(`
agent-shell v${packageJson.version} — Bridge WeChat to any ACP-compatible AI agent

Usage:
  agent-shell --agent <preset|command>  [options]
  agent-shell agents                        List built-in agent presets
  agent-shell accounts                      List saved WeChat accounts
  agent-shell login                         Log in and save a WeChat account
  agent-shell inject --text <text>          Inject a local message into the daemon
  agent-shell stop                          Select and stop a running account
  agent-shell status                        List account process status

Options:
  --agent <value>     Built-in preset name or raw agent command
                      Presets: ${presets}
                      Examples: "copilot", "claude", "npx tsx ./agent.ts"
  --cwd <dir>         Working directory for agent (default: current dir)
  --login             Force re-login (new QR code)
  --daemon            Run in background after login
  --account <value>   Saved account name, accountId, or name-accountId
  --account-name <n>  Name for a newly added account (required without a TTY)
  --config <file>     Config file path (JSON)
  --instance <name>   Run as a named, isolated instance.
                      Storage, token, daemon pid/log, and telemetry id are
                      scoped to ~/.agent-shell/instances/<name>/.
                      Lets you run multiple bridges side by side, each with
                      its own WeChat account and project cwd.
  --inbox-dir <path>  Directory to save binary files received from WeChat
                      (default: <storage.dir>/inbox). The agent sees the
                      saved absolute path in the prompt so it can read the
                      file directly.
  --no-inbox          Disable saving received files. The agent will only
                      see a "[Received file: name, N bytes]" notice and
                      will not be able to read the file content.
  --idle-timeout <m>  Session idle timeout in minutes (default: 1440)
                      Use 0 to disable idle cleanup
  --max-sessions <n>  Max concurrent user sessions (default: 10)
  --hide-thoughts     Do not forward agent thinking to WeChat (default: forwarded)
  --show-diffs        Forward ACP file diffs to WeChat (default: hidden)
  --auto-send-media <mode>
                      Auto-send media mode: off, tagged, all (default: tagged)
                        all    - send all file references in replies
                        tagged - only send @send: tagged files
                        off    - never auto-send media
  --system-prompt <text>
                      System prompt injected at the start of each new session
                      (e.g. language preference, communication conventions)
  --text <text>       Message text for "inject"
  --file <path>       Read injected message text from a file
  --to <target>       Injection target (default: ${DEFAULT_INJECTION_TARGET})
  --context-token <t> Override stored context token for "inject"
  -v, --verbose       Verbose logging
  -V, --version       Print version and exit
  -h, --help          Show this help
`);
}

async function handleInject(
  config: AgentShellConfig,
  args: ReturnType<typeof parseArgs>,
): Promise<void> {
  if (!config.storage.injectDir) {
    throw new Error("storage.injectDir is not configured");
  }
  if (!args.injectText && !args.injectFile) {
    throw new Error('inject requires --text <text> or --file <path>');
  }
  if (args.injectText && args.injectFile) {
    throw new Error("inject accepts only one of --text or --file");
  }

  const text = args.injectFile
    ? fs.readFileSync(path.resolve(args.injectFile), "utf-8")
    : args.injectText!;

  const { job, filePath } = await queueInjectedMessage({
    injectDir: config.storage.injectDir,
    text,
    target: args.injectTo,
    contextToken: args.injectContextToken,
  });

  console.log(`Queued injection ${job.id}`);
  console.log(`Target: ${job.target}`);
  console.log(`File: ${filePath}`);
  console.log("It will be processed by any running agent-shell instance using the same storage directory.");
}

function parseArgs(argv: string[]): {
  command?: string;
  agent?: string;
  cwd?: string;
  forceLogin: boolean;
  daemon: boolean;
  configFile?: string;
  account?: string;
  accountName?: string;
  instance?: string;
  inboxDir?: string;
  disableInbox: boolean;
  idleTimeout?: number;
  maxSessions?: number;
  injectText?: string;
  injectFile?: string;
  injectTo?: string;
  injectContextToken?: string;
  hideThoughts: boolean;
  showDiffs: boolean;
  autoSendMedia?: string;
  systemPrompt?: string;
  verbose: boolean;
  version: boolean;
  help: boolean;
} {
  const result = {
    forceLogin: false,
    daemon: false,
    disableInbox: false,
    hideThoughts: true,
    showDiffs: false,
    verbose: false,
    version: false,
    help: false,
  } as ReturnType<typeof parseArgs>;

  const args = argv.slice(2);
  let i = 0;

  // Check for subcommand
  if (args[0] && !args[0].startsWith("-")) {
    result.command = args[0];
    i = 1;
  }

  while (i < args.length) {
    const arg = args[i];
    switch (arg) {
      case "--agent":
        result.agent = args[++i];
        break;
      case "--cwd":
        result.cwd = args[++i];
        break;
      case "--login":
        result.forceLogin = true;
        break;
      case "--daemon":
        result.daemon = true;
        break;
      case "--config":
        result.configFile = args[++i];
        break;
      case "--account":
        result.account = args[++i];
        break;
      case "--account-name":
        result.accountName = args[++i];
        break;
      case "--instance":
        result.instance = args[++i];
        break;
      case "--inbox-dir":
        result.inboxDir = args[++i];
        break;
      case "--no-inbox":
        result.disableInbox = true;
        break;
      case "--idle-timeout":
        result.idleTimeout = parseInt(args[++i], 10);
        break;
      case "--max-sessions":
        result.maxSessions = parseInt(args[++i], 10);
        break;
      case "--text":
        result.injectText = args[++i];
        break;
      case "--file":
        result.injectFile = args[++i];
        break;
      case "--to":
        result.injectTo = args[++i];
        break;
      case "--context-token":
        result.injectContextToken = args[++i];
        break;
      case "--hide-thoughts":
        result.hideThoughts = true;
        break;
      case "--show-diffs":
        result.showDiffs = true;
        break;
      case "--auto-send-media":
        result.autoSendMedia = args[++i];
        break;
      case "--system-prompt":
        result.systemPrompt = args[++i];
        break;
      case "-v":
      case "--verbose":
        result.verbose = true;
        break;
      case "-V":
      case "--version":
        result.version = true;
        break;
      case "-h":
      case "--help":
        result.help = true;
        break;
      default:
        if (arg?.startsWith("-")) {
          console.error(`Unknown option: ${arg}`);
          process.exit(1);
        }
    }
    i++;
  }

  return result;
}

function loadConfigFile(filePath: string): Partial<AgentShellConfig> {
  const content = fs.readFileSync(filePath, "utf-8");
  return JSON.parse(content) as Partial<AgentShellConfig>;
}

function handleAgents(config: AgentShellConfig): void {
  console.log("Built-in ACP agent presets:\n");
  for (const { id, preset } of listBuiltInAgents(config.agents)) {
    const commandLine = [preset.command, ...preset.args].join(" ");
    console.log(`${id.padEnd(10)} ${commandLine}`);
    if (preset.description) {
      console.log(`           ${preset.description}`);
    }
  }
}

function handleAccounts(rootDir: string): void {
  const accounts = discoverAccounts(rootDir);
  if (accounts.length === 0) {
    console.log("No saved WeChat accounts.");
    return;
  }
  console.log("Saved WeChat accounts:\n");
  accounts.forEach((account, index) => {
    console.log(`${String(index + 1).padStart(2)}. ${formatAccountName(account.record)}`);
  });
}

async function handleStop(
  rootDir: string,
  selector?: string,
  fallback?: RegisteredAccount,
): Promise<void> {
  const accounts = discoverAccounts(rootDir);
  let candidates = fallback
    ? [fallback]
    : selector
      ? [resolveAccount(rootDir, selector)]
      : accounts;
  candidates = candidates.filter((account) => inspectRuntime(account.storageDir, true).running);

  if (candidates.length === 0) {
    console.log(selector ? "Selected account is not running." : "No account process is running.");
    return;
  }

  const account = candidates.length === 1
    ? candidates[0]
    : await selectAccount(candidates, "Select an account process to stop");
  const status = inspectRuntime(account.storageDir, true);
  if (!status.running || !status.pid) {
    console.log(`${formatAccountName(account.record)} is not running.`);
    return;
  }

  try {
    process.kill(status.pid, "SIGTERM");
    console.log(`Stop signal sent to ${formatAccountName(account.record)} (PID ${status.pid}).`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ESRCH") {
      throw err;
    }
    releaseRuntime(account.storageDir, status.pid);
    console.log(`Cleaned stale process record for ${formatAccountName(account.record)}.`);
  }
}

function handleStatus(
  rootDir: string,
  selector?: string,
  fallback?: RegisteredAccount,
): void {
  const accounts = fallback
    ? [fallback]
    : selector
      ? [resolveAccount(rootDir, selector)]
      : discoverAccounts(rootDir);
  if (accounts.length === 0) {
    console.log("No saved WeChat accounts.");
    return;
  }
  printAccountStatuses(accounts);
}

function printAccountStatuses(accounts: RegisteredAccount[]): void {
  const rows = accounts.map((account) => {
    const status = inspectRuntime(account.storageDir, true);
    const runtime = status.runtime;
    return {
      account: formatAccountName(account.record),
      pid: status.running ? String(status.pid) : "-",
      agent: runtime?.agent ?? "-",
      state: status.running ? "running" : "stopped",
      uptime: runtime && status.running ? formatDuration(Date.now() - Date.parse(runtime.startedAt)) : "-",
    };
  });
  const widths = {
    account: Math.max("ACCOUNT".length, ...rows.map((row) => row.account.length)),
    pid: Math.max("PID".length, ...rows.map((row) => row.pid.length)),
    agent: Math.max("AGENT".length, ...rows.map((row) => row.agent.length)),
    state: Math.max("STATE".length, ...rows.map((row) => row.state.length)),
  };
  console.log(
    `${"ACCOUNT".padEnd(widths.account)}  ${"PID".padEnd(widths.pid)}  ` +
      `${"AGENT".padEnd(widths.agent)}  ${"STATE".padEnd(widths.state)}  UPTIME`,
  );
  for (const row of rows) {
    console.log(
      `${row.account.padEnd(widths.account)}  ${row.pid.padEnd(widths.pid)}  ` +
        `${row.agent.padEnd(widths.agent)}  ${row.state.padEnd(widths.state)}  ${row.uptime}`,
    );
  }
}

function daemonize(config: AgentShellConfig, runtime: RuntimeRecord): never {
  const logFile = config.daemon.logFile;

  fs.mkdirSync(path.dirname(logFile), { recursive: true });

  const out = fs.openSync(logFile, "a");
  const err = fs.openSync(logFile, "a");

  // Re-run ourselves with --no-daemon (internal flag) as a detached process
  const args = process.argv.slice(1).filter((a) => a !== "--daemon" && a !== "--login");
  if (!args.includes("--account") && !args.includes("--instance")) {
    args.push("--account", runtime.accountKey);
  }
  const child = spawn(process.execPath, args, {
    detached: true,
    stdio: ["ignore", out, err],
    env: { ...process.env, AGENT_SHELL_DAEMON: "1" },
    windowsHide: true,
  });

  if (!child.pid) {
    child.kill();
    throw new Error("Failed to start daemon process.");
  }
  try {
    claimRuntime(config.storage.dir, {
      ...runtime,
      pid: child.pid,
      daemon: true,
      startedAt: new Date().toISOString(),
    });
  } catch (error) {
    child.kill();
    throw error;
  }
  child.unref();
  console.log(`Daemon started (PID ${child.pid})`);
  console.log(`Logs: ${logFile}`);
  process.exit(0);
}

async function selectAccount(
  accounts: RegisteredAccount[],
  prompt: string,
): Promise<RegisteredAccount> {
  if (accounts.length === 0) {
    throw new Error("No saved WeChat accounts.");
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("Account selection requires a TTY. Specify --account <name|accountId>.");
  }

  console.log(`\n${prompt}:`);
  accounts.forEach((account, index) => {
    console.log(`  ${index + 1}. ${formatAccountName(account.record)}`);
  });
  const answer = await ask(`Choose 1-${accounts.length}: `);
  const index = Number.parseInt(answer, 10) - 1;
  if (!Number.isInteger(index) || !accounts[index]) {
    throw new Error("Invalid account selection.");
  }
  return accounts[index];
}

async function ask(prompt: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(prompt)).trim();
  } finally {
    rl.close();
  }
}

function formatDuration(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return [hours, minutes, seconds].map((value) => String(value).padStart(2, "0")).join(":");
}

function renderQrInTerminal(url: string): void {
  qrcodeTerminal.generate(url, { small: true }, (qr: string) => {
    console.log(qr);
  });
}

async function loginAndRegisterAccount(params: {
  config: AgentShellConfig;
  rootDir: string;
  selected?: RegisteredAccount;
  accountName?: string;
}): Promise<RegisteredAccount> {
  const accounts = discoverAccounts(params.rootDir);
  if (accounts.length > 0) {
    console.log("Saved WeChat accounts and process status:\n");
    printAccountStatuses(accounts);
  } else {
    console.log("No saved WeChat accounts.");
  }

  let overwrite = params.selected;
  let accountName = params.accountName;

  if (!overwrite && !accountName) {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      throw new Error(
        "Login selection requires a TTY. Use --account to overwrite or --account-name to add.",
      );
    }
    console.log("\nLogin action:");
    console.log("  A. Add a new account");
    accounts.forEach((account, index) => {
      console.log(`  ${index + 1}. Overwrite ${formatAccountName(account.record)}`);
    });
    const choice = await ask(
      accounts.length > 0
        ? `Choose A or 1-${accounts.length}: `
        : "Choose A to add a new account: ",
    );
    if (/^a(dd)?$/i.test(choice)) {
      accountName = validateAccountName(await ask("Enter a name for the new account: "));
    } else {
      const index = Number.parseInt(choice, 10) - 1;
      if (!Number.isInteger(index) || !accounts[index]) {
        throw new Error("Invalid login action.");
      }
      overwrite = accounts[index];
    }
  }

  if (overwrite) {
    const status = inspectRuntime(overwrite.storageDir, true);
    if (status.running) {
      throw new Error(
        `Cannot overwrite ${formatAccountName(overwrite.record)} while it is running (PID ${status.pid}).`,
      );
    }
    accountName = accountName
      ? validateAccountName(accountName)
      : overwrite.record.accountName;
    console.log(`\nSelected overwrite: ${formatAccountName(overwrite.record)}`);
  } else {
    accountName = validateAccountName(accountName ?? "");
    console.log(`\nSelected add: ${accountName}`);
  }

  console.log("Starting QR login...");
  const token = await login({
    baseUrl: params.config.wechat.baseUrl,
    botType: params.config.wechat.botType,
    storageDir: params.rootDir,
    persist: false,
    log: (message) => console.log(message),
    renderQrUrl: renderQrInTerminal,
  });

  const sameAccount = accounts.find(
    (account) => account.record.accountId === token.accountId,
  );
  if (sameAccount && sameAccount.record.accountKey !== overwrite?.record.accountKey) {
    throw new Error(
      `The scanned WeChat account is already saved as ${formatAccountName(sameAccount.record)}. ` +
        "Run login again and choose that account to overwrite.",
    );
  }

  const registered = registerAccount({
    rootDir: params.rootDir,
    token,
    accountName,
    overwriteAccountKey: overwrite?.record.accountKey,
  });
  console.log(`Saved account: ${formatAccountName(registered.record)}`);
  console.log(`Token directory: ${registered.storageDir}`);
  return registered;
}

function applyAccountStorage(config: AgentShellConfig, account: RegisteredAccount): void {
  config.storage.instance = account.record.accountKey;
  config.storage.dir = account.storageDir;
  config.daemon.logFile = path.join(account.storageDir, "agent-shell.log");
  config.daemon.pidFile = path.join(account.storageDir, "daemon.pid");
}

function runtimeForAccount(
  account: RegisteredAccount,
  config: AgentShellConfig,
  pid: number,
  daemon: boolean,
): RuntimeRecord {
  return {
    pid,
    accountKey: account.record.accountKey,
    accountName: account.record.accountName,
    accountId: account.record.accountId,
    agent: config.agent.preset ?? config.agent.command,
    cwd: config.agent.cwd,
    startedAt: new Date().toISOString(),
    daemon,
  };
}

function accountForLegacyStorage(storageDir: string, name: string): RegisteredAccount {
  const token = loadToken(storageDir);
  const runtime = inspectRuntime(storageDir).runtime;
  const now = new Date().toISOString();
  return {
    record: {
      accountKey: name,
      accountName: token?.accountName ?? runtime?.accountName ?? name,
      accountId: token?.accountId ?? runtime?.accountId ?? "unknown",
      userId: token?.userId ?? "unknown",
      storageDir: ".",
      createdAt: token?.savedAt ?? runtime?.startedAt ?? now,
      updatedAt: token?.savedAt ?? runtime?.startedAt ?? now,
    },
    storageDir,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);

  if (args.version) {
    console.log(packageJson.version);
    process.exit(0);
  }

  if (args.help) {
    usage();
    process.exit(0);
  }

  if (args.instance !== undefined) {
    try {
      validateInstanceName(args.instance);
    } catch (err) {
      console.error(`Error: ${(err as Error).message}`);
      process.exit(1);
    }
  }
  if (args.instance && args.account) {
    console.error("Error: --instance and --account cannot be used together.");
    process.exit(1);
  }

  const config = defaultConfig({ instance: args.instance });
  const accountRoot = defaultStorageDir();
  let selectedAccount: RegisteredAccount | undefined;

  // Load config file if specified
  let configFileSetInboxDir = false;
  let configFileSetStateFile = false;
  let configFileSetInjectDir = false;
  if (args.configFile) {
    const fileConfig = loadConfigFile(args.configFile);
    Object.assign(config.wechat, fileConfig.wechat ?? {});
    Object.assign(config.agent, fileConfig.agent ?? {});
    Object.assign(config.agents, fileConfig.agents ?? {});
    Object.assign(config.session, fileConfig.session ?? {});
    Object.assign(config.daemon, fileConfig.daemon ?? {});
    if (Object.prototype.hasOwnProperty.call(fileConfig, "commandAliases")) {
      // Assign the raw value (even if malformed) so the post-merge
      // validateCommandAliases() below can reject it with a clean error.
      config.commandAliases = fileConfig.commandAliases;
    }
    // Track whether the user explicitly set inboxDir so we don't
    // overwrite their choice with a re-derived default below. We check
    // before Object.assign because checking after can't distinguish
    // "user wrote inboxDir: null to disable" from "user didn't write it".
    if (
      fileConfig.storage &&
      Object.prototype.hasOwnProperty.call(fileConfig.storage, "inboxDir")
    ) {
      configFileSetInboxDir = true;
    }
    if (
      fileConfig.storage &&
      Object.prototype.hasOwnProperty.call(fileConfig.storage, "stateFile")
    ) {
      configFileSetStateFile = true;
    }
    if (
      fileConfig.storage &&
      Object.prototype.hasOwnProperty.call(fileConfig.storage, "injectDir")
    ) {
      configFileSetInjectDir = true;
    }
    Object.assign(config.storage, fileConfig.storage ?? {});
  }

  if (args.command === "agents") {
    handleAgents(config);
    return;
  }
  if (args.command === "accounts") {
    handleAccounts(accountRoot);
    return;
  }
  const configuredStorageDir = args.instance
    ? defaultStorageDir(args.instance)
    : path.resolve(config.storage.dir);
  const legacyCommandAccount =
    !args.account && path.resolve(configuredStorageDir) !== path.resolve(accountRoot)
      ? accountForLegacyStorage(configuredStorageDir, args.instance ?? "custom")
      : undefined;
  if (args.command === "status") {
    handleStatus(accountRoot, args.account ?? args.instance, legacyCommandAccount);
    return;
  }
  if (args.command === "stop") {
    await handleStop(accountRoot, args.account ?? args.instance, legacyCommandAccount);
    return;
  }

  // CLI --instance always wins over config-file storage.dir so users can
  // run a config in multiple isolated instances without editing the file.
  if (args.instance) {
    config.storage.instance = args.instance;
    config.storage.dir = defaultStorageDir(args.instance);
    config.daemon.logFile = path.join(config.storage.dir, "agent-shell.log");
    config.daemon.pidFile = path.join(config.storage.dir, "daemon.pid");
  }

  const customStorageMode =
    !args.account &&
    (Boolean(args.instance) || path.resolve(config.storage.dir) !== path.resolve(accountRoot));

  if (!customStorageMode) {
    const accounts = discoverAccounts(accountRoot);
    if (args.account) {
      selectedAccount = resolveAccount(accountRoot, args.account);
    }

    if (args.command === "login" || args.forceLogin) {
      selectedAccount = await loginAndRegisterAccount({
        config,
        rootDir: accountRoot,
        selected: selectedAccount,
        accountName: args.accountName,
      });
      args.forceLogin = false;
    } else if (accounts.length === 0) {
      if (args.command === "inject") {
        throw new Error("No saved account is available for injection. Run `agent-shell login` first.");
      }
      selectedAccount = await loginAndRegisterAccount({
        config,
        rootDir: accountRoot,
        accountName: args.accountName,
      });
    } else {
      if (!process.env.AGENT_SHELL_DAEMON) {
        console.log("Saved WeChat accounts and process status:\n");
        printAccountStatuses(accounts);
      }
      if (!selectedAccount) {
        selectedAccount = await selectAccount(accounts, "Select a WeChat account to start");
      }
    }
    applyAccountStorage(config, selectedAccount);
  } else {
    const token = loadToken(config.storage.dir);
    if (token) {
      selectedAccount = {
        record: {
          accountKey: args.instance ?? "custom",
          accountName: token.accountName ?? args.instance ?? "custom",
          accountId: token.accountId,
          userId: token.userId,
          storageDir: ".",
          createdAt: token.savedAt,
          updatedAt: token.savedAt,
        },
        storageDir: config.storage.dir,
      };
    }
  }

  if (args.command === "login") {
    return;
  }

  // Resolve the final inbox directory. Precedence (highest first):
  //   1. --no-inbox            (explicit disable)
  //   2. --inbox-dir <path>    (explicit CLI override)
  //   3. config.storage.inboxDir explicitly set in the config file
  //      (relative paths are resolved against cwd)
  //   4. Default: <storage.dir>/inbox, re-derived from whatever the
  //      final storage.dir is. This is what keeps a config file that
  //      only sets storage.dir consistent with the documented
  //      "default: <storage.dir>/inbox", and also covers the
  //      --instance case for free.
  if (args.disableInbox) {
    config.storage.inboxDir = null;
  } else if (args.inboxDir) {
    config.storage.inboxDir = path.resolve(args.inboxDir);
  } else if (configFileSetInboxDir) {
    if (config.storage.inboxDir && !path.isAbsolute(config.storage.inboxDir)) {
      config.storage.inboxDir = path.resolve(config.storage.inboxDir);
    }
  } else {
    config.storage.inboxDir = path.join(config.storage.dir, "inbox");
  }

  if (configFileSetStateFile) {
    if (config.storage.stateFile && !path.isAbsolute(config.storage.stateFile)) {
      config.storage.stateFile = path.resolve(config.storage.stateFile);
    }
  } else {
    config.storage.stateFile = path.join(config.storage.dir, "state.json");
  }

  if (configFileSetInjectDir) {
    if (config.storage.injectDir && !path.isAbsolute(config.storage.injectDir)) {
      config.storage.injectDir = path.resolve(config.storage.injectDir);
    }
  } else {
    config.storage.injectDir = path.join(config.storage.dir, "inject");
  }

  try {
    validateCommandAliases(config.commandAliases);
  } catch (err) {
    console.error(`Error: ${(err as Error).message}`);
    process.exit(1);
  }

  // Handle storage-scoped subcommands
  if (args.command === "inject") {
    await handleInject(config, args);
    return;
  }

  const agentSelection = args.agent ?? config.agent.preset;

  // Require preset or raw command
  if (!agentSelection && !config.agent.command) {
    console.error("Error: --agent is required\n");
    usage();
    process.exit(1);
  }

  if (agentSelection) {
    const resolvedAgent = resolveAgentSelection(agentSelection, config.agents);
    config.agent.preset = resolvedAgent.id;
    config.agent.command = resolvedAgent.command;
    config.agent.args = resolvedAgent.args;
    if (resolvedAgent.env) {
      config.agent.env = { ...(config.agent.env ?? {}), ...resolvedAgent.env };
    }
  }

  if (args.cwd) config.agent.cwd = path.resolve(args.cwd);
  if (args.idleTimeout !== undefined) {
    if (!Number.isFinite(args.idleTimeout) || args.idleTimeout < 0) {
      console.error("Error: invalid --idle-timeout value");
      console.error('Use a non-negative integer minute value, where "0" means unlimited.');
      process.exit(1);
    }
    config.session.idleTimeoutMs = args.idleTimeout * 60_000;
  }
  if (args.maxSessions) config.session.maxConcurrentUsers = args.maxSessions;
  if (args.hideThoughts) config.agent.showThoughts = false;
  if (args.showDiffs) config.agent.showDiffs = true;
  if (args.autoSendMedia !== undefined) {
    const mode = args.autoSendMedia.toLowerCase();
    if (mode !== "off" && mode !== "tagged" && mode !== "all") {
      console.error(`Error: invalid --auto-send-media value "${args.autoSendMedia}". Must be: off, tagged, or all.`);
      process.exit(1);
    }
    config.agent.autoSendMedia = mode as "off" | "tagged" | "all";
  }
  if (args.systemPrompt !== undefined) {
    config.agent.systemPrompt = args.systemPrompt;
  }
  config.daemon.enabled = args.daemon;

  if (!selectedAccount) {
    const token = loadToken(config.storage.dir);
    if (token) {
      selectedAccount = {
        record: {
          accountKey: config.storage.instance ?? "custom",
          accountName: token.accountName ?? config.storage.instance ?? "custom",
          accountId: token.accountId,
          userId: token.userId,
          storageDir: ".",
          createdAt: token.savedAt,
          updatedAt: token.savedAt,
        },
        storageDir: config.storage.dir,
      };
    }
  }
  if (!selectedAccount) {
    throw new Error("No saved account is available. Run `agent-shell login` first.");
  }

  const runtime = runtimeForAccount(selectedAccount, config, process.pid, args.daemon);

  // Handle daemon mode
  if (args.daemon && !process.env.AGENT_SHELL_DAEMON) {
    daemonize(config, runtime);
  }

  const ownsRuntime = !process.env.AGENT_SHELL_DAEMON;
  if (ownsRuntime) {
    claimRuntime(config.storage.dir, runtime);
  }

  // Initialize telemetry. No-op when AGENT_SHELL_TELEMETRY=0/false/off.
  initTelemetry({
    version: packageJson.version,
    storageDir: config.storage.dir,
    agentPreset: config.agent.preset ?? "raw",
    daemon: config.daemon.enabled,
  });
  trackEvent("app.start", {
    agentPreset: config.agent.preset ?? "raw",
    daemon: config.daemon.enabled,
  });
  const startedAt = Date.now();

  // Create and start bridge
  const bridge = new AgentShellBridge(config, (msg) => {
    const ts = new Date().toISOString().substring(11, 19);
    console.log(`[${ts}] ${msg}`);
  });

  // Handle graceful shutdown
  const shutdown = async (reason: "signal" | "error" | "normal") => {
    trackEvent("app.stop", { reason, uptimeSec: Math.round((Date.now() - startedAt) / 1000) });
    await bridge.stop();
    await shutdownTelemetry();
    releaseRuntime(config.storage.dir, process.pid);
    process.exit(reason === "error" ? 1 : 0);
  };
  process.on("SIGINT", () => void shutdown("signal"));
  process.on("SIGTERM", () => void shutdown("signal"));

  try {
    await bridge.start({
      forceLogin: args.forceLogin,
      renderQrUrl: renderQrInTerminal,
    });
    releaseRuntime(config.storage.dir, process.pid);
  } catch (err) {
    if ((err as Error).message === "aborted") {
      // Normal shutdown
    } else {
      trackException(err, "main");
      trackEvent("app.stop", { reason: "error", uptimeSec: Math.round((Date.now() - startedAt) / 1000) });
      await shutdownTelemetry();
      releaseRuntime(config.storage.dir, process.pid);
      console.error(`Fatal: ${String(err)}`);
      process.exit(1);
    }
  }
}

main().catch((err) => {
  console.error(`Fatal: ${String(err)}`);
  process.exit(1);
});
