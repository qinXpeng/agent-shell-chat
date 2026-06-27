/**
 * WeChat QR login flow + token persistence.
 */

import fs from "node:fs";
import path from "node:path";
import { getBotQrcode, getQrcodeStatus } from "./api.js";

export interface TokenData {
  /**
   * User-provided label for this WeChat account. Optional only so legacy
   * token.json files written before multi-account support remain readable.
   */
  accountName?: string;
  token: string;
  baseUrl: string;
  accountId: string;
  userId: string;
  savedAt: string;
}

function getTokenPath(storageDir: string): string {
  return path.join(storageDir, "token.json");
}

export function loadToken(storageDir: string): TokenData | null {
  const tokenPath = getTokenPath(storageDir);
  if (!fs.existsSync(tokenPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(tokenPath, "utf-8")) as TokenData;
  } catch {
    return null;
  }
}

export function saveToken(storageDir: string, data: TokenData): void {
  fs.mkdirSync(storageDir, { recursive: true, mode: 0o700 });
  const tokenPath = getTokenPath(storageDir);
  const tmpPath = path.join(storageDir, `.token-${process.pid}-${Date.now()}.tmp`);
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2) + "\n", {
    encoding: "utf-8",
    mode: 0o600,
  });
  try {
    fs.renameSync(tmpPath, tokenPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (process.platform !== "win32" || (code !== "EEXIST" && code !== "EPERM")) {
      throw err;
    }
    fs.rmSync(tokenPath, { force: true });
    fs.renameSync(tmpPath, tokenPath);
  }
}

export async function login(params: {
  baseUrl: string;
  botType?: string;
  storageDir: string;
  persist?: boolean;
  log: (msg: string) => void;
  renderQrUrl?: (url: string) => void;
}): Promise<TokenData> {
  const { baseUrl, botType, storageDir, persist = true, log, renderQrUrl } = params;

  log("Starting WeChat QR login...");

  const qrResp = await getBotQrcode({ baseUrl, botType });
  const qrcodeUrl = qrResp.qrcode_img_content;

  log("Please scan the QR code with WeChat:");
  if (renderQrUrl) {
    renderQrUrl(qrcodeUrl);
  } else {
    log(`QR URL: ${qrcodeUrl}`);
  }

  const deadline = Date.now() + 5 * 60_000;
  let currentQrcode = qrResp.qrcode;
  let refreshCount = 0;

  while (Date.now() < deadline) {
    const statusResp = await getQrcodeStatus({ baseUrl, qrcode: currentQrcode });

    switch (statusResp.status) {
      case "wait":
        break;
      case "scaned":
        log("QR scanned, please confirm in WeChat...");
        break;
      case "expired": {
        refreshCount++;
        if (refreshCount > 3) {
          throw new Error("QR code expired multiple times, please retry");
        }
        log(`QR expired, refreshing (${refreshCount}/3)...`);
        const newQr = await getBotQrcode({ baseUrl, botType });
        currentQrcode = newQr.qrcode;
        if (renderQrUrl) {
          renderQrUrl(newQr.qrcode_img_content);
        } else {
          log(`New QR URL: ${newQr.qrcode_img_content}`);
        }
        break;
      }
      case "confirmed": {
        log("Login successful!");
        const tokenData: TokenData = {
          token: statusResp.bot_token!,
          baseUrl: statusResp.baseurl || baseUrl,
          accountId: statusResp.ilink_bot_id!,
          userId: statusResp.ilink_user_id!,
          savedAt: new Date().toISOString(),
        };
        if (persist) {
          saveToken(storageDir, tokenData);
        }
        log(`Bot ID: ${tokenData.accountId}`);
        if (persist) {
          log(`Token saved to ${getTokenPath(storageDir)}`);
        }
        return tokenData;
      }
    }

    await new Promise((r) => setTimeout(r, 1500));
  }

  throw new Error("Login timeout (5 minutes)");
}
