import { createHmac, timingSafeEqual } from "node:crypto";
import { chmod, cp, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { PluginAPI, ShellFunction, WebhookEvent, WebhookHandlerContext } from "@ampcode/plugin";

export const description =
	"Mirrors skills/** from GitHub pushes on the default branch into the Amp personal skills repo";

const SOURCE_REPO = "Hopsken/pi-suite";
const SOURCE_URL = `https://github.com/${SOURCE_REPO}.git`;
const BRANCH = "main";
const SKILLS_DIR = "skills";
const SKILL_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SECRET_ENV = "PI_SUITE_SKILLS_WEBHOOK_SECRET";
const MAX_BODY_BYTES = 8_000_000;
const MAX_REMEMBERED_DELIVERIES = 200;

const CACHE_DIR = join(homedir(), ".cache", "pi-suite-skills-sync");
const SOURCE_CHECKOUT = join(CACHE_DIR, "source");
const TARGET_CHECKOUT = join(CACHE_DIR, "personal-skills");
const STATE_FILE = join(CACHE_DIR, "state.json");
const WEBHOOK_URL_FILE = join(CACHE_DIR, "webhook-url");

type ShellResult = Awaited<ReturnType<ShellFunction>>;

type PushPayload = {
	ref?: string;
	deleted?: boolean;
	size?: number;
	repository?: { full_name?: string };
	commits?: { added?: string[]; modified?: string[]; removed?: string[] }[];
};

type SyncPlan = { names: Set<string>; removed: Set<string>; full: boolean };

type SyncState = { deliveries: string[]; owned: string[]; lastSyncedSha: string | null };

type SyncResult = { sha: string; changed: boolean; synced: string[]; removed: string[] };

export default async function (amp: PluginAPI) {
	const secret = process.env[SECRET_ENV];
	if (!secret) {
		amp.logger.log(`${SECRET_ENV} is not set, so the skills sync webhook stays unregistered`);
		return;
	}

	const { url } = await amp.createWebhook({
		key: "skills-sync",
		headers: ["x-github-event", "x-github-delivery", "x-hub-signature-256"],
		handler: (event, ctx) => handleDelivery(amp.$, secret, event, ctx),
	});

	await rememberWebhookUrl(url);
	amp.logger.log(`Skills sync webhook is ready for ${SOURCE_REPO} ${BRANCH} pushes`);
}

async function handleDelivery(
	$: ShellFunction,
	secret: string,
	event: WebhookEvent,
	ctx: WebhookHandlerContext,
): Promise<void> {
	if (!hasValidSignature(secret, event.body, event.headers["x-hub-signature-256"])) {
		ctx.logger.log("Ignored a delivery with a missing or invalid signature");
		return;
	}
	if (event.headers["x-github-event"] !== "push") return;
	if (event.body.byteLength > MAX_BODY_BYTES) {
		ctx.logger.log(`Ignored a push payload of ${event.body.byteLength} bytes`);
		return;
	}

	const payload = readPushPayload(event.body);
	const plan = payload && isTargetPush(payload) ? planSync(payload) : null;
	if (!plan) return;

	const delivery = event.headers["x-github-delivery"] ?? event.id;
	await enqueue(async () => {
		const state = await readState();
		if (state.deliveries.includes(delivery)) {
			ctx.logger.log(`Skipped duplicate delivery ${delivery}`);
			return;
		}

		if (ctx.signal.aborted) return;

		const result = await syncSkills($, plan, new Set(state.owned));
		const removed = new Set(result.removed);
		const owned = [...new Set([...state.owned, ...result.synced])].filter((name) => !removed.has(name));
		await writeState({
			deliveries: [...state.deliveries, delivery].slice(-MAX_REMEMBERED_DELIVERIES),
			owned,
			lastSyncedSha: result.sha,
		});
		ctx.logger.log(
			result.changed
				? `Synced ${result.synced.join(", ") || "no skills"} and removed ${result.removed.join(", ") || "nothing"} at ${result.sha}`
				: `Delivery ${delivery} matched ${SOURCE_REPO}@${result.sha}, nothing to sync`,
		);
	});
}

function hasValidSignature(secret: string, body: Uint8Array, header: string | undefined): boolean {
	const prefix = "sha256=";
	if (!header?.startsWith(prefix)) return false;
	const received = Buffer.from(header.slice(prefix.length), "hex");
	if (received.length !== 32) return false;
	return timingSafeEqual(received, createHmac("sha256", secret).update(body).digest());
}

function readPushPayload(body: Uint8Array): PushPayload | null {
	try {
		const value: unknown = JSON.parse(new TextDecoder().decode(body));
		return typeof value === "object" && value !== null ? (value as PushPayload) : null;
	} catch {
		return null;
	}
}

function isTargetPush(payload: PushPayload): boolean {
	return (
		payload.repository?.full_name?.toLowerCase() === SOURCE_REPO.toLowerCase() &&
		payload.ref === `refs/heads/${BRANCH}` &&
		payload.deleted !== true
	);
}

function planSync(payload: PushPayload): SyncPlan | null {
	const commits = payload.commits ?? [];
	const names = new Set<string>();
	const removed = new Set<string>();

	for (const commit of commits) {
		for (const path of [...(commit.added ?? []), ...(commit.modified ?? [])]) {
			const name = skillNameFromPath(path);
			if (name) names.add(name);
		}
		for (const path of commit.removed ?? []) {
			const name = skillNameFromPath(path);
			if (name) {
				names.add(name);
				removed.add(name);
			}
		}
	}

	// GitHub truncates the commit list, so a truncated push resyncs every skill instead of guessing.
	const full = commits.length === 0 || (payload.size ?? commits.length) > commits.length;
	if (!full && names.size === 0) return null;
	return { names, removed, full };
}

function skillNameFromPath(path: string): string | null {
	if (!path.startsWith(`${SKILLS_DIR}/`)) return null;
	const [name] = path.slice(SKILLS_DIR.length + 1).split("/");
	return name && SKILL_NAME.test(name) ? name : null;
}

async function syncSkills($: ShellFunction, plan: SyncPlan, owned: Set<string>): Promise<SyncResult> {
	await ensureSourceCheckout($);
	const sha = (await run($`git -C ${SOURCE_CHECKOUT} rev-parse HEAD`, "git rev-parse")).trim();
	await ensureTargetCheckout($);

	const names = plan.full ? new Set([...(await listSourceSkills()), ...owned, ...plan.names]) : plan.names;
	const synced: string[] = [];
	const removed: string[] = [];

	for (const name of names) {
		const from = join(SOURCE_CHECKOUT, SKILLS_DIR, name);
		const to = join(TARGET_CHECKOUT, name);
		if (await isFile(join(from, "SKILL.md"))) {
			await rm(to, { recursive: true, force: true });
			await cp(from, to, { recursive: true });
			synced.push(name);
			continue;
		}
		if ((await isDirectory(to)) && (owned.has(name) || plan.removed.has(name))) {
			await rm(to, { recursive: true, force: true });
			removed.push(name);
		}
	}

	if (!(await run($`git -C ${TARGET_CHECKOUT} status --porcelain`, "git status")).trim()) {
		return { sha, changed: false, synced, removed: [] };
	}

	const summary = [...synced.map((name) => `+${name}`), ...removed.map((name) => `-${name}`)].join(" ");
	await run($`git -C ${TARGET_CHECKOUT} add --all`, "git add");
	await run(
		$`git -C ${TARGET_CHECKOUT} commit --message ${`Sync ${summary} from ${SOURCE_REPO}@${sha.slice(0, 7)}`}`,
		"git commit",
	);
	await pushTarget($);
	return { sha, changed: true, synced, removed };
}

async function ensureSourceCheckout($: ShellFunction): Promise<void> {
	if (await isDirectory(join(SOURCE_CHECKOUT, ".git"))) {
		await run($`git -C ${SOURCE_CHECKOUT} fetch --depth 1 origin ${BRANCH}`, "git fetch source");
		await run($`git -C ${SOURCE_CHECKOUT} reset --hard FETCH_HEAD`, "git reset source");
		await run($`git -C ${SOURCE_CHECKOUT} clean -fdq`, "git clean source");
		return;
	}
	await mkdir(CACHE_DIR, { recursive: true, mode: 0o700 });
	await rm(SOURCE_CHECKOUT, { recursive: true, force: true });
	await run(
		$`git clone --depth 1 --single-branch --branch ${BRANCH} ${SOURCE_URL} ${SOURCE_CHECKOUT}`,
		"git clone source",
	);
}

async function ensureTargetCheckout($: ShellFunction): Promise<void> {
	if (await isDirectory(join(TARGET_CHECKOUT, ".git"))) {
		await run($`git -C ${TARGET_CHECKOUT} fetch --prune origin`, "git fetch personal skills");
		await run($`git -C ${TARGET_CHECKOUT} reset --hard origin/${BRANCH}`, "git reset personal skills");
		return;
	}
	await mkdir(CACHE_DIR, { recursive: true, mode: 0o700 });
	await rm(TARGET_CHECKOUT, { recursive: true, force: true });
	await run($`amp clone user-skills ${TARGET_CHECKOUT}`, "amp clone user-skills");
}

async function pushTarget($: ShellFunction): Promise<void> {
	const pushed = await $`git -C ${TARGET_CHECKOUT} push origin HEAD:${BRANCH}`;
	if (pushed.exitCode === 0) return;

	await run($`git -C ${TARGET_CHECKOUT} pull --rebase origin ${BRANCH}`, "git pull personal skills");
	await run($`git -C ${TARGET_CHECKOUT} push origin HEAD:${BRANCH}`, "git push personal skills");
}

async function listSourceSkills(): Promise<string[]> {
	const entries = await readdir(join(SOURCE_CHECKOUT, SKILLS_DIR), { withFileTypes: true });
	const skills: string[] = [];
	for (const entry of entries) {
		if (!entry.isDirectory() || !SKILL_NAME.test(entry.name)) continue;
		if (await isFile(join(SOURCE_CHECKOUT, SKILLS_DIR, entry.name, "SKILL.md"))) skills.push(entry.name);
	}
	return skills;
}

async function run(command: Promise<ShellResult>, label: string): Promise<string> {
	const result = await command;
	if (result.exitCode !== 0) {
		throw new Error(`${label} failed: ${(result.stderr || result.stdout).trim().slice(0, 500)}`);
	}
	return result.stdout;
}

async function isDirectory(path: string): Promise<boolean> {
	try {
		return (await stat(path)).isDirectory();
	} catch {
		return false;
	}
}

async function isFile(path: string): Promise<boolean> {
	try {
		return (await stat(path)).isFile();
	} catch {
		return false;
	}
}

async function readState(): Promise<SyncState> {
	try {
		const value = JSON.parse(await readFile(STATE_FILE, "utf8"));
		return {
			deliveries: stringList(value.deliveries),
			owned: stringList(value.owned),
			lastSyncedSha: typeof value.lastSyncedSha === "string" ? value.lastSyncedSha : null,
		};
	} catch {
		return { deliveries: [], owned: [], lastSyncedSha: null };
	}
}

function stringList(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

async function writeState(state: SyncState): Promise<void> {
	await mkdir(CACHE_DIR, { recursive: true, mode: 0o700 });
	await writeFile(`${STATE_FILE}.tmp`, JSON.stringify(state, null, "\t"));
	await rename(`${STATE_FILE}.tmp`, STATE_FILE);
}

async function rememberWebhookUrl(url: string): Promise<void> {
	await mkdir(CACHE_DIR, { recursive: true, mode: 0o700 });
	await writeFile(WEBHOOK_URL_FILE, `${url}\n`, { mode: 0o600 });
	await chmod(WEBHOOK_URL_FILE, 0o600);
}

let pending: Promise<unknown> = Promise.resolve();

function enqueue(work: () => Promise<void>): Promise<void> {
	const next = pending.then(work, work);
	pending = next.catch(() => undefined);
	return next;
}
