import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { loadToken, saveToken, type TokenData } from "../weixin/auth.js";

const REGISTRY_VERSION = 1;
const ACCOUNT_NAME_MAX_LENGTH = 64;

export interface AccountRecord {
  accountKey: string;
  accountName: string;
  accountId: string;
  userId: string;
  /** Storage directory relative to the registry root, or "." for legacy data. */
  storageDir: string;
  createdAt: string;
  updatedAt: string;
}

export interface AccountRegistry {
  version: 1;
  accounts: AccountRecord[];
}

export interface RegisteredAccount {
  record: AccountRecord;
  storageDir: string;
}

export function validateAccountName(accountName: string): string {
  const normalized = accountName.trim();
  if (!normalized) {
    throw new Error("Account name is required.");
  }
  if (normalized.length > ACCOUNT_NAME_MAX_LENGTH) {
    throw new Error(`Account name must be at most ${ACCOUNT_NAME_MAX_LENGTH} characters.`);
  }
  if (/[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new Error("Account name must not contain control characters.");
  }
  return normalized;
}

export function formatAccountName(account: Pick<AccountRecord, "accountName" | "accountId">): string {
  return `${account.accountName}-${account.accountId}`;
}

export function getAccountsPath(rootDir: string): string {
  return path.join(rootDir, "accounts.json");
}

export function loadAccountRegistry(rootDir: string): AccountRegistry {
  const registryPath = getAccountsPath(rootDir);
  if (!fs.existsSync(registryPath)) {
    return { version: REGISTRY_VERSION, accounts: [] };
  }

  const raw = JSON.parse(fs.readFileSync(registryPath, "utf-8")) as Partial<AccountRegistry>;
  if (raw.version !== REGISTRY_VERSION || !Array.isArray(raw.accounts)) {
    throw new Error(`Unsupported or invalid account registry: ${registryPath}`);
  }

  const accounts = raw.accounts.map((account) => validateAccountRecord(account));
  return { version: REGISTRY_VERSION, accounts };
}

export function listAccounts(rootDir: string): RegisteredAccount[] {
  return loadAccountRegistry(rootDir).accounts
    .map((record) => ({
      record,
      storageDir: resolveStorageDir(rootDir, record.storageDir),
    }))
    .sort((left, right) =>
      left.record.accountName.localeCompare(right.record.accountName, undefined, {
        sensitivity: "base",
      }),
    );
}

export function resolveAccount(rootDir: string, selector: string): RegisteredAccount {
  const normalized = selector.trim().toLocaleLowerCase();
  const matches = listAccounts(rootDir).filter(({ record }) =>
    record.accountKey.toLocaleLowerCase() === normalized ||
    record.accountName.toLocaleLowerCase() === normalized ||
    record.accountId.toLocaleLowerCase() === normalized ||
    formatAccountName(record).toLocaleLowerCase() === normalized
  );

  if (matches.length === 0) {
    throw new Error(`Unknown account: ${JSON.stringify(selector)}`);
  }
  if (matches.length > 1) {
    throw new Error(
      `Ambiguous account ${JSON.stringify(selector)}. Use the full name-accountId value.`,
    );
  }
  return matches[0];
}

/**
 * Register the pre-multi-account token at ~/.agent-shell/token.json without
 * moving runtime state. This makes migration additive and reversible.
 */
export function migrateLegacyToken(rootDir: string): RegisteredAccount | null {
  return withRegistryLock(rootDir, () => migrateLegacyTokenUnlocked(rootDir));
}

function migrateLegacyTokenUnlocked(rootDir: string): RegisteredAccount | null {
  const token = loadToken(rootDir);
  if (!token) return null;

  const registry = loadAccountRegistry(rootDir);
  const existing = registry.accounts.find((account) => account.accountId === token.accountId);
  if (existing) {
    return { record: existing, storageDir: resolveStorageDir(rootDir, existing.storageDir) };
  }

  const now = new Date().toISOString();
  const accountName = uniqueLegacyName(registry.accounts, token.accountName ?? "default");
  const record: AccountRecord = {
    accountKey: `legacy-${shortHash(token.accountId)}`,
    accountName,
    accountId: token.accountId,
    userId: token.userId,
    storageDir: ".",
    createdAt: token.savedAt || now,
    updatedAt: now,
  };

  saveToken(rootDir, { ...token, accountName });
  writeRegistry(rootDir, { version: REGISTRY_VERSION, accounts: [...registry.accounts, record] });
  return { record, storageDir: rootDir };
}

/**
 * Import token files created by the existing --instance implementation into
 * the account index. Existing directories and runtime state stay in place.
 */
export function migrateInstanceTokens(rootDir: string): void {
  withRegistryLock(rootDir, () => migrateInstanceTokensUnlocked(rootDir));
}

function migrateInstanceTokensUnlocked(rootDir: string): void {
  const instancesDir = path.join(rootDir, "instances");
  if (!fs.existsSync(instancesDir)) return;

  for (const entry of fs.readdirSync(instancesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const storageDir = path.join(instancesDir, entry.name);
    const token = loadToken(storageDir);
    if (!token) continue;

    const registry = loadAccountRegistry(rootDir);
    if (registry.accounts.some((account) => account.accountId === token.accountId)) {
      continue;
    }

    const now = new Date().toISOString();
    const accountName = uniqueLegacyName(
      registry.accounts,
      token.accountName ?? entry.name,
    );
    const record: AccountRecord = {
      accountKey: `instance-${shortHash(entry.name)}`,
      accountName,
      accountId: token.accountId,
      userId: token.userId,
      storageDir: path.join("instances", entry.name),
      createdAt: token.savedAt || now,
      updatedAt: now,
    };
    saveToken(storageDir, { ...token, accountName });
    writeRegistry(rootDir, {
      version: REGISTRY_VERSION,
      accounts: [...registry.accounts, record],
    });
  }
}

export function discoverAccounts(rootDir: string): RegisteredAccount[] {
  return withRegistryLock(rootDir, () => {
    migrateLegacyTokenUnlocked(rootDir);
    migrateInstanceTokensUnlocked(rootDir);
    return listAccounts(rootDir);
  });
}

export function registerAccount(params: {
  rootDir: string;
  token: TokenData;
  accountName: string;
  overwriteAccountKey?: string;
}): RegisteredAccount {
  return withRegistryLock(params.rootDir, () => registerAccountUnlocked(params));
}

function registerAccountUnlocked(params: {
  rootDir: string;
  token: TokenData;
  accountName: string;
  overwriteAccountKey?: string;
}): RegisteredAccount {
  const accountName = validateAccountName(params.accountName);
  const registry = loadAccountRegistry(params.rootDir);
  const byAccountId = registry.accounts.find(
    (account) => account.accountId === params.token.accountId,
  );
  const overwrite = params.overwriteAccountKey
    ? registry.accounts.find((account) => account.accountKey === params.overwriteAccountKey)
    : undefined;

  if (params.overwriteAccountKey && !overwrite) {
    throw new Error(`Account selected for overwrite no longer exists.`);
  }

  const target = byAccountId ?? overwrite;
  const duplicateName = registry.accounts.find(
    (account) =>
      account.accountKey !== target?.accountKey &&
      account.accountName.localeCompare(accountName, undefined, { sensitivity: "accent" }) === 0,
  );
  if (duplicateName) {
    throw new Error(
      `Account name ${JSON.stringify(accountName)} is already used by ${formatAccountName(duplicateName)}.`,
    );
  }

  const now = new Date().toISOString();
  const accountKey = target?.accountKey ?? crypto.randomUUID();
  const storageDir = target?.storageDir ?? path.join("instances", accountKey);
  const record: AccountRecord = {
    accountKey,
    accountName,
    accountId: params.token.accountId,
    userId: params.token.userId,
    storageDir,
    createdAt: target?.createdAt ?? now,
    updatedAt: now,
  };
  const absoluteStorageDir = resolveStorageDir(params.rootDir, storageDir);

  if (target && target.accountId !== params.token.accountId) {
    resetAccountRuntimeState(absoluteStorageDir);
  }
  saveToken(absoluteStorageDir, { ...params.token, accountName });
  writeRegistry(params.rootDir, {
    version: REGISTRY_VERSION,
    accounts: [
      ...registry.accounts.filter((account) => account.accountKey !== accountKey),
      record,
    ],
  });

  return { record, storageDir: absoluteStorageDir };
}

function withRegistryLock<T>(rootDir: string, action: () => T): T {
  fs.mkdirSync(rootDir, { recursive: true, mode: 0o700 });
  const lockPath = path.join(rootDir, ".accounts.lock");
  let fd: number | undefined;
  const deadline = Date.now() + 5_000;

  while (fd === undefined) {
    try {
      fd = fs.openSync(lockPath, "wx", 0o600);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      try {
        const ageMs = Date.now() - fs.statSync(lockPath).mtimeMs;
        if (ageMs > 30_000) {
          fs.rmSync(lockPath, { force: true });
          continue;
        }
      } catch {
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error("Timed out waiting for another account registry update.");
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }

  try {
    return action();
  } finally {
    fs.closeSync(fd);
    fs.rmSync(lockPath, { force: true });
  }
}

function writeRegistry(rootDir: string, registry: AccountRegistry): void {
  fs.mkdirSync(rootDir, { recursive: true, mode: 0o700 });
  const registryPath = getAccountsPath(rootDir);
  const tmpPath = path.join(rootDir, `.accounts-${process.pid}-${Date.now()}.tmp`);
  fs.writeFileSync(tmpPath, JSON.stringify(registry, null, 2) + "\n", {
    encoding: "utf-8",
    mode: 0o600,
  });
  try {
    fs.renameSync(tmpPath, registryPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (process.platform !== "win32" || (code !== "EEXIST" && code !== "EPERM")) {
      throw err;
    }
    fs.rmSync(registryPath, { force: true });
    fs.renameSync(tmpPath, registryPath);
  }
}

function validateAccountRecord(value: unknown): AccountRecord {
  if (!value || typeof value !== "object") {
    throw new Error("Invalid account record.");
  }
  const account = value as Partial<AccountRecord>;
  for (const field of [
    "accountKey",
    "accountName",
    "accountId",
    "userId",
    "storageDir",
    "createdAt",
    "updatedAt",
  ] as const) {
    if (typeof account[field] !== "string" || !account[field]) {
      throw new Error(`Invalid account record field: ${field}`);
    }
  }
  validateAccountName(account.accountName as string);
  return account as AccountRecord;
}

function resolveStorageDir(rootDir: string, relativeDir: string): string {
  const resolvedRoot = path.resolve(rootDir);
  const resolved = path.resolve(rootDir, relativeDir);
  const relative = path.relative(resolvedRoot, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Account storage directory escapes registry root: ${relativeDir}`);
  }
  return resolved;
}

function uniqueLegacyName(accounts: AccountRecord[], preferred: string): string {
  const base = validateAccountName(preferred);
  let candidate = base;
  let suffix = 2;
  while (
    accounts.some(
      (account) =>
        account.accountName.localeCompare(candidate, undefined, { sensitivity: "accent" }) === 0,
    )
  ) {
    candidate = `${base}-${suffix++}`;
  }
  return candidate;
}

function shortHash(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function resetAccountRuntimeState(storageDir: string): void {
  for (const fileName of ["sync-buf.json", "state.json", "runtime.json", "daemon.pid"]) {
    fs.rmSync(path.join(storageDir, fileName), { force: true });
  }
  fs.rmSync(path.join(storageDir, "inject"), { recursive: true, force: true });
}
