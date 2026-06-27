import fs from "node:fs";
import path from "node:path";

export interface RuntimeRecord {
  pid: number;
  accountKey: string;
  accountName: string;
  accountId: string;
  agent: string;
  cwd: string;
  startedAt: string;
  daemon: boolean;
}

export interface RuntimeStatus {
  running: boolean;
  pid?: number;
  runtime?: RuntimeRecord;
  stale: boolean;
}

export function getPidPath(storageDir: string): string {
  return path.join(storageDir, "daemon.pid");
}

export function getRuntimePath(storageDir: string): string {
  return path.join(storageDir, "runtime.json");
}

export function inspectRuntime(storageDir: string, cleanupStale = false): RuntimeStatus {
  const pidPath = getPidPath(storageDir);
  const runtimePath = getRuntimePath(storageDir);
  if (!fs.existsSync(pidPath)) {
    return { running: false, stale: false };
  }

  const pid = Number.parseInt(fs.readFileSync(pidPath, "utf-8").trim(), 10);
  if (!Number.isSafeInteger(pid) || pid <= 0 || !isProcessRunning(pid)) {
    if (cleanupStale) {
      fs.rmSync(pidPath, { force: true });
      fs.rmSync(runtimePath, { force: true });
    }
    return {
      running: false,
      ...(Number.isSafeInteger(pid) && pid > 0 ? { pid } : {}),
      stale: true,
    };
  }

  let runtime: RuntimeRecord | undefined;
  try {
    const parsed = JSON.parse(fs.readFileSync(runtimePath, "utf-8")) as RuntimeRecord;
    if (parsed.pid === pid) {
      runtime = parsed;
    }
  } catch {
    // A legacy daemon may only have daemon.pid.
  }
  return { running: true, pid, runtime, stale: false };
}

export function claimRuntime(storageDir: string, runtime: RuntimeRecord): void {
  fs.mkdirSync(storageDir, { recursive: true, mode: 0o700 });
  const existing = inspectRuntime(storageDir, true);
  if (existing.running) {
    throw new Error(
      `Account ${runtime.accountName}-${runtime.accountId} is already running (PID ${existing.pid}).`,
    );
  }

  const pidPath = getPidPath(storageDir);
  let fd: number | undefined;
  try {
    fd = fs.openSync(pidPath, "wx", 0o600);
    fs.writeFileSync(fd, String(runtime.pid), "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(
        `Account ${runtime.accountName}-${runtime.accountId} is already being started.`,
      );
    }
    throw err;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }

  try {
    writeRuntime(storageDir, runtime);
  } catch (err) {
    fs.rmSync(pidPath, { force: true });
    throw err;
  }
}

export function releaseRuntime(storageDir: string, pid: number): void {
  const status = inspectRuntime(storageDir);
  if (status.pid !== pid) return;
  fs.rmSync(getPidPath(storageDir), { force: true });
  fs.rmSync(getRuntimePath(storageDir), { force: true });
}

export function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function writeRuntime(storageDir: string, runtime: RuntimeRecord): void {
  const runtimePath = getRuntimePath(storageDir);
  const tmpPath = path.join(storageDir, `.runtime-${process.pid}-${Date.now()}.tmp`);
  fs.writeFileSync(tmpPath, JSON.stringify(runtime, null, 2) + "\n", {
    encoding: "utf-8",
    mode: 0o600,
  });
  try {
    fs.renameSync(tmpPath, runtimePath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (process.platform !== "win32" || (code !== "EEXIST" && code !== "EPERM")) {
      throw err;
    }
    fs.rmSync(runtimePath, { force: true });
    fs.renameSync(tmpPath, runtimePath);
  }
}
