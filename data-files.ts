// The ZCode desktop app's on-disk facts, in one place. The app resolves its
// data dir as $ZCODE_DATA_BASE_DIR || homedir, then appends .zcode/v2 — the
// same layout on every platform (verified against the AppImage's
// getDataBaseDir). Both adapters (index.ts, usage.ts) read through here so
// the paths and app version are stated once.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const APP_VERSION = process.env.ZCODE_APP_VERSION ?? "3.16.3";
export const START_PLAN_PRESET_KEY = "builtin:zai-start-plan";

export function zcodeV2Dir(): string {
	const root = process.env.ZCODE_DATA_BASE_DIR?.trim() || homedir();
	return join(root, ".zcode", "v2");
}

export const CONFIG_FILE = join(zcodeV2Dir(), "config.json");
export const CREDENTIALS_FILE = join(zcodeV2Dir(), "credentials.json");
export const TELEMETRY_FILE = join(zcodeV2Dir(), "telemetry-state.json");

export function readJson<T>(path: string): T | null {
	try {
		if (!existsSync(path)) return null;
		return JSON.parse(readFileSync(path, "utf-8")) as T;
	} catch {
		return null;
	}
}
