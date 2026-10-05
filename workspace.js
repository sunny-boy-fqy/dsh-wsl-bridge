/**
 * Linux-native workspace registry.
 *
 * The shipped registry (`@deepseek-ai/dsh-workspace`) canonicalizes a workspace
 * path with the **host's** `node:fs.realpath` and requires the result to be a
 * host directory. On Windows that makes a guest path impossible: `/home/you`
 * resolves against the process's current drive to `D:\home\you`, and a
 * `\\wsl.localhost\…` spelling is what ends up stored — which then puts a
 * Windows path in the session cwd, in the system prompt, and in every model
 * command.
 *
 * This subclass keeps the entire registry (durability, ordering, pinning,
 * archiving, the session-path index) and replaces exactly the four places that
 * touch the filesystem, so the stored path, the session cwd, and the model's
 * view of it are the guest's own Linux path:
 *
 * - `create` / `initializeDefault` / `resolveByPath` canonicalize **inside the
 *   guest** (`realpath`) and require a guest directory;
 * - `indexHeader` indexes session cwds in guest spelling;
 * - the registry's entities are wrapped so `attachSession` validates against the
 *   guest path and `status` asks the guest whether the directory still exists.
 *
 * Entities are wrapped with `Object.create(base)` — the base entity carries no
 * private fields, so a wrapper that inherits its state and `mutate` chain is
 * equivalent, which is why no part of the shipped registry has to be restated.
 * @module @local/dsh-wsl-bridge/workspace
 */
import { posix } from 'node:path';
import { Service } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import { WorkspaceRegistry } from '@deepseek-ai/dsh-workspace';
import { guestRun, resolveDefaultDistro, shellQuote } from './guest.js';
import { ensureMirror, mirrorToLinux } from './mirror.js';
import { toLinuxPath } from './wsl.js';

/** Cordis plugin name. */
const name = 'wsl-workspace';
/** Cordis services this provider needs; the base class's own list. */
const inject = ['storageDomain', 'sessionPersistence'];
/** Default deadline for one guest call. */
const DEFAULT_TIMEOUT_MS = 30000;
/** Exit code the canonicalization script uses for "not a directory". */
const NOT_A_DIRECTORY = 3;

/** Row configuration. */
const Config = z.object({
	distro: z.string().default('').description('Distribution to run in; empty uses the launcher default.'),
	wslPath: z.string().default('').description('Absolute path of wsl.exe; empty resolves %SystemRoot%\\System32\\wsl.exe.'),
	timeoutMs: z.number().default(DEFAULT_TIMEOUT_MS)
});

/** Lexically normalize an absolute Linux path (no filesystem access). */
function normalizeLinux(path) {
	const normalized = posix.normalize(path);
	const trimmed = normalized.length > 1 ? normalized.replace(/\/+$/u, '') : normalized;
	return trimmed.length === 0 ? '/' : trimmed;
}

/** The default title of a workspace: its final segment, else the root spelling. */
function titleFor(path) {
	const trimmed = path.replace(/\/+$/u, '');
	const segment = trimmed.slice(trimmed.lastIndexOf('/') + 1);
	return segment.length > 0 ? segment : path;
}

/** The registry with every workspace-identity decision made in guest terms. */
class WslWorkspaceRegistry extends WorkspaceRegistry {
	static Config = Config;
	static inject = inject;
	constructor(ctx, config) {
		super(ctx);
		this.config = config;
		this.sampledDistro = undefined;
		this.canonicalCache = new Map();
	}
	/**
	 * Open the domain, then repair one piece of durable state the shipped
	 * registry leaves dangling: a `defaultWorkspaceId` whose record no longer
	 * exists keeps `initializeDefault` returning `undefined` forever, because it
	 * short-circuits on the id before it ever checks eligibility. Clearing the
	 * stale id restores the documented behaviour — automatic creation becomes
	 * eligible again for a profile with no history — and keeps memory and disk
	 * consistent, since every later write is stamped from the in-memory state.
	 */
	async [Service.init]() {
		await super[Service.init]();
		this.exposeStoredWorkspaces();
		const state = this.requireState();
		const dangling = state.defaultWorkspaceId;
		if (dangling === undefined || this.requireTable().get(dangling) !== undefined) return;
		await this.setState({
			...state,
			defaultWorkspaceId: void 0
		});
		this.ctx.logger.warn(`cleared the dangling default Workspace id '${dangling}': its record no longer exists`);
	}
	/**
	 * Expose every workspace already on disk, not just the ones created in this
	 * process. A workspace restored from `workspace.json` was never passed to
	 * {@link expose}, so `/mnt/d/tmp` would keep the host spelling
	 * `C:\mnt\d\tmp` with no link behind it — and the shipped session
	 * controller's `mkdir(cwd, { recursive: true })` then fails with
	 * `EPERM: operation not permitted, mkdir 'C:\mnt\d\tmp'`. Failures here are
	 * logged by {@link expose} and never stop the registry from starting.
	 */
	exposeStoredWorkspaces() {
		for (const entity of this.entities.values()) {
			const path = entity?.record?.path ?? entity?.path;
			if (typeof path === 'string' && path.startsWith('/')) this.expose(path);
		}
	}
	/** The distribution this registry talks to: the configured one, else the launcher default. */
	resolveDistro() {
		const configured = typeof this.config.distro === 'string' ? this.config.distro : '';
		if (configured !== '') return configured;
		if (this.sampledDistro === undefined) this.sampledDistro = resolveDefaultDistro(this.config.wslPath);
		return this.sampledDistro;
	}
	/** Run one script inside the guest. */
	guest(script, signal) {
		return guestRun({ wslPath: this.config.wslPath, distro: this.resolveDistro(), timeoutMs: this.config.timeoutMs }, script, signal);
	}
	/**
	 * The guest spelling of any accepted path, without touching the filesystem.
	 * Accepts a guest path, a WSL UNC path, a Windows drive path (`D:\work` →
	 * `/mnt/d/work`), and the mirror spelling this bridge creates on the host
	 * (`D:\home\you` → `/home/you`).
	 * @param candidate - the path to translate.
	 * @returns the normalized guest path, or undefined when no spelling applies.
	 */
	textualLinux(candidate) {
		if (typeof candidate !== 'string' || candidate.length === 0) return undefined;
		const translated = mirrorToLinux(candidate) ?? toLinuxPath(candidate, this.resolveDistro());
		if (translated === undefined || !translated.startsWith('/')) return undefined;
		return normalizeLinux(translated);
	}
	/**
	 * Canonicalize an existing guest directory: `realpath` inside the guest
	 * resolves symlinks and `..`, so two spellings of one directory collide
	 * exactly as the shipped registry intends. Successes are cached for the
	 * process; failures are not, so a directory created later still works.
	 * @param candidate - the requested path in any accepted spelling.
	 * @param signal - caller lifetime.
	 * @returns the canonical guest path.
	 */
	async canonicalize(candidate, signal) {
		const textual = this.textualLinux(candidate);
		if (textual === undefined) throw new TypeError(`Workspace path is not fully qualified: '${candidate}'`);
		const cached = this.canonicalCache.get(textual);
		if (cached !== undefined) return await cached;
		const pending = (async () => {
			const result = await this.guest(`p=${shellQuote(textual)}\nif [ ! -d "$p" ]; then exit ${NOT_A_DIRECTORY}; fi\nexec realpath -- "$p"\n`, signal);
			if (result.code === NOT_A_DIRECTORY) throw new Error(`cannot create a workspace at '${textual}': path is not a directory`);
			if (result.code !== 0) {
				const detail = result.stderr.toString('utf8').trim().split(/\r?\n/u).pop() ?? '';
				throw new Error(`cannot create a workspace at '${textual}'${detail.length > 0 ? `: ${detail}` : ''}`);
			}
			const raw = result.stdout.toString('utf8').trim();
			if (!raw.startsWith('/')) throw new Error(`cannot create a workspace at '${textual}': the guest returned no canonical path`);
			const canonical = normalizeLinux(raw);
			/* Every accepted spelling funnels through here, so this is the one place
			   that guarantees the host-side shadow exists before a consumer that uses
			   host node:fs (the session controller's mkdir) runs. */
			this.expose(canonical);
			return canonical;
		})();
		this.canonicalCache.set(textual, pending);
		try {
			return await pending;
		} catch (error) {
			this.canonicalCache.delete(textual);
			throw error;
		}
	}
	/** Expose one workspace's guest directory to host-side plugins through the drive-relative spelling. */
	expose(canonical) {
		const created = ensureMirror(this.resolveDistro(), canonical, (message) => this.ctx.logger.warn(message));
		for (const link of created) this.ctx.logger.info(`workspace '${canonical}' is also readable by host-side plugins at ${link}`);
	}
	async create(path, title) {
		const canonical = await this.canonicalize(path);
		this.expose(canonical);
		return await this.enqueueOperation(() => this.createCanonical(canonical, title));
	}
	async resolveByPath(path) {
		const canonical = await this.canonicalize(path);
		return this.entityByPath(canonical);
	}
	initializeDefault(resolveDirectory) {
		return this.enqueueOperation(async () => {
			const state = this.requireState();
			if (state.defaultWorkspaceId !== undefined) return this.entities.get(state.defaultWorkspaceId);
			const sessions = this.ctx.get('sessions');
			if (sessions === undefined) throw new Error('default Workspace initialization requires the Session store');
			if (state.workspaceIds.length > 0 || state.archivedSessionIds.length > 0 || sessions.list().length > 0 || (await this.listStoredHeaders()).length > 0) return undefined;
			const requested = await resolveDirectory();
			const textual = this.textualLinux(requested);
			if (textual === undefined) throw new TypeError(`Workspace path is not fully qualified: '${requested}'`);
			await this.guest(`mkdir -p -- ${shellQuote(textual)}\n`);
			const canonical = await this.canonicalize(textual);
			if ((await this.listStoredHeaders()).length > 0 || sessions.list().length > 0) return undefined;
			this.expose(canonical);
			return this.createCanonical(canonical, titleFor(canonical), true);
		});
	}
	/** The entity owning one canonical guest path. */
	entityByPath(canonical) {
		for (const entity of this.entities.values()) if (entity.path === canonical) return entity;
		return undefined;
	}
	/**
	 * Index one session header by its cwd in guest spelling. The shipped index
	 * stats the host path; here the guest path is the identity, and the
	 * directory's existence is reported by `status` instead, so opening a session
	 * costs no guest round trip.
	 */
	async indexHeader(header) {
		this.headers.set(header.id, header);
		this.sessionPaths.delete(header.id);
		if (header.cwd === undefined) {
			this.invalidSessionPaths.set(header.id, 'header has no cwd');
			return;
		}
		const textual = this.textualLinux(header.cwd);
		if (textual === undefined) {
			this.invalidSessionPaths.set(header.id, `cwd '${header.cwd}' is not a guest path`);
			return;
		}
		this.sessionPaths.set(header.id, textual);
		this.invalidSessionPaths.delete(header.id);
	}
	async createCanonical(canonical, title, firstUse = false) {
		const existing = this.entityByPath(canonical);
		if (existing !== undefined) return existing;
		const created = await super.createCanonical(canonical, title, firstUse);
		const wrapped = this.wrapEntity(created);
		this.entities.set(created.id, wrapped);
		return wrapped;
	}
	rebuildEntities() {
		super.rebuildEntities();
		for (const [id, entity] of [...this.entities]) this.entities.set(id, this.wrapEntity(entity));
	}
	/**
	 * Wrap one entity so the two operations that touch the filesystem ask the
	 * guest. The wrapper inherits the base entity wholesale, including its
	 * `mutate` chain and its own-property record snapshot.
	 * @param entity - the registry's own entity.
	 * @returns the wrapper the registry hands out.
	 */
	wrapEntity(entity) {
		if (entity === undefined) return entity;
		const registry = this;
		const wrapper = Object.create(entity);
		wrapper.attachSession = async (sessionId) => {
			if (!wrapper.record.sessionIds.includes(sessionId)) {
				const header = await registry.readSessionHeader(sessionId);
				if (header.cwd === undefined) throw new Error(`cannot attach session '${sessionId}' to workspace '${wrapper.record.path}': its stored header carries no cwd to validate against`);
				const cwd = registry.textualLinux(header.cwd);
				if (cwd !== wrapper.record.path) throw new Error(`cannot attach session '${sessionId}' to workspace '${wrapper.record.path}': its cwd resolves to '${cwd ?? header.cwd}'`);
				registry.host.rememberSessionPath(sessionId, cwd);
			}
			await wrapper.mutate((record) => record.sessionIds.includes(sessionId) ? record : {
				...record,
				sessionIds: [sessionId, ...record.sessionIds]
			});
		};
		wrapper.status = async () => {
			try {
				const result = await registry.guest(`[ -d ${shellQuote(wrapper.record.path)} ]\n`);
				return result.code === 0 ? 'ok' : 'missing-dir';
			} catch {
				return 'missing-dir';
			}
		};
		return wrapper;
	}
}
/**
 * Load the Linux-native registry as `ctx.workspaceRegistry`.
 * @param ctx - Cordis context that owns the service.
 * @param config - the row's resolved configuration.
 */
function apply(ctx, config) {
	new WslWorkspaceRegistry(ctx, config);
}

/**
 * The module default must be the service class itself, exactly as
 * `@deepseek-ai/dsh-workspace` ships it. Cordis runs `[Service.init]` only on
 * the constructor branch of its fiber (`new callback(ctx, config)` followed by
 * `instance[Service.init]()`); a plain `apply` wrapper is the *function* branch,
 * which runs the body and never calls the init hook. Wrapped that way the
 * registry is constructed and provided, so every consumer is released, but its
 * domain is never opened — `state` and `table` stay undefined and the first
 * reader dies with `workspace registry is not started yet`.
 */
export default WslWorkspaceRegistry;
export { Config, WslWorkspaceRegistry, apply, inject, name };
