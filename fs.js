/**
 * WSL-native filesystem provider for DeepSeek Harness on Windows.
 *
 * Registers `ctx.fs` so every file operation the Harness performs — `read`,
 * `write`, `edit`, the observation policy, the workspace diff recorder — runs
 * **inside the distribution** through `wsl.exe`, never through a Windows
 * service and never through the `\\wsl.localhost` 9P bridge. On a WSL2 host the
 * share costs one host RPC per metadata call (measured: ~176x slower `stat`,
 * ~125x slower create), so doing the I/O in the guest is the difference between
 * a usable and an unusable Linux workspace.
 *
 * Paths are Linux paths everywhere the model or the UI can see them: a
 * {@link FsTarget}'s `targetKey` and `displayPath` are both the guest path, so a
 * conversation shows `/home/you/proj/main.py`, never a UNC spelling. The
 * one host-visible spelling, {@link WslFileSystem.processPath}, is what
 * host-side consumers need (glob/grep's packaged ripgrep, previews, terminals);
 * it maps the guest path back onto the share.
 *
 * Commands are delivered to the guest on `bash -l`'s **stdin**, never through
 * argv: an argument that crosses the Windows command line loses its quoting and
 * has `$NAME` substituted from the environment before bash sees it, which
 * silently corrupts shell scripts. stdin is byte-exact.
 * @module @local/dsh-wsl-bridge/fs
 */
import { spawn, spawnSync } from 'node:child_process';
import { posix } from 'node:path';
import z from '@deepseek-ai/schemastery';
import { FsError, FileSystem } from '@deepseek-ai/dsh-fs';
import { listScript, parseListing, parseStatLine, publishScript, rangeScript, readScript, statScript } from './fsproto.js';
import { mirrorToLinux } from './mirror.js';
import { resolveWslExecutable, toLinuxPath, windowsUncPath } from './wsl.js';

/** Cordis plugin name. */
const name = 'wsl-fs';
/** The deployment sandbox policy supplies the mode this provider reports as its default. */
const inject = ['sandboxPolicy'];
/** Default guest cwd for relative paths. */
const DEFAULT_CWD = '/';
/** Default poll interval for {@link WslFileSystem.watch}, in milliseconds. */
const DEFAULT_WATCH_MS = 750;
/** Read cap for one command's raw stdout, so a runaway guest command cannot grow the host heap. */
const RAW_CAP_BYTES = 32 * 1024 * 1024;
/** Deadline for one guest round trip. */
const CALL_TIMEOUT_MS = 120000;

/** Runtime configuration. */
const Config = z.object({
	distro: z.string().default('').description('WSL distribution to operate in; empty uses the WSL default distribution.'),
	wslPath: z.string().default('').description('Absolute path of wsl.exe; empty resolves %SystemRoot%\\System32\\wsl.exe.'),
	cwd: z.string().default(DEFAULT_CWD).description('Guest working directory for relative paths.'),
	watchIntervalMs: z.number().default(DEFAULT_WATCH_MS).description('Poll interval backing watch(), in milliseconds.')
});

/**
 * The guest-backed filesystem provider.
 *
 * Every mutation publishes with a guest-side `temp + mv`: an ext4 rename is
 * atomic, keeps the file on the fast filesystem, and sidesteps the hard-link
 * publication that makes the Windows share fail with `ENOTSUP`.
 */
class WslFileSystem extends FileSystem {
	static Config = Config;
	static inject = ['sandboxPolicy'];
	constructor(ctx, config) {
		super(ctx);
		this.config = config;
		this.mode = ctx.sandboxPolicy.defaultMode;
		this.defaultDistro = undefined;
	}
	/**
	 * The sandbox mode this provider enforces by default: the deployment policy's
	 * mode, exactly what `@deepseek-ai/dsh-fs-sandbox` reports. This provider does
	 * fence mutations ({@link WslFileSystem.fence}), so reporting the fact keeps
	 * the tool layer's escalation surface honest and identical to a stock host.
	 * @returns the deployment policy's default mode.
	 */
	get sandboxMode() {
		return this.mode;
	}
	/** The distribution this provider talks to: the configured one, else the account's default. */
	resolveDistro() {
		const configured = typeof this.config.distro === 'string' ? this.config.distro : '';
		if (configured !== '') return configured;
		if (this.defaultDistro !== undefined) return this.defaultDistro;
		let sampled = '';
		try {
			const probed = spawnSync(resolveWslExecutable(this.config.wslPath), ['-l', '-q'], { timeout: 10000, windowsHide: true });
			const first = String(probed.stdout ?? '').replace(/\0/gu, '').split(/\r?\n/u).map((line) => line.trim()).filter((line) => line.length > 0)[0];
			if (typeof first === 'string') sampled = first;
		} catch {
			/* an unreadable roster leaves the launcher's own default in charge */
		}
		this.defaultDistro = sampled;
		return sampled;
	}
	/** The guest cwd relative paths resolve against. */
	get cwd() {
		return typeof this.config.cwd === 'string' && this.config.cwd.startsWith('/') ? this.config.cwd : DEFAULT_CWD;
	}
	/**
	 * Run one bash script inside the guest with the script on stdin.
	 *
	 * stdin is the only byte-exact channel: argv strips quoting and substitutes
	 * `$NAME` before bash runs, and a script file would need a second round trip
	 * per call.
	 * @param script - the bash body; `$` and quotes reach the guest verbatim.
	 * @param signal - the caller's lifetime.
	 * @returns the exit code and the raw stdout/stderr buffers.
	 */
	guest(script, signal) {
		return new Promise((resolve, reject) => {
			const distro = this.resolveDistro();
			const argv = [resolveWslExecutable(this.config.wslPath)];
			if (distro !== '') argv.push('-d', distro);
			argv.push('--', 'bash', '-l');
			const child = spawn(argv[0], argv.slice(1), { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
			const out = [];
			const err = [];
			let size = 0;
			let settled = false;
			const finish = (settle, value) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				signal?.removeEventListener('abort', onAbort);
				if (!child.killed) child.kill();
				settle(value);
			};
			const onAbort = () => finish(reject, signal.reason ?? new FsError('filesystem call aborted', 'FS_IO_ERROR'));
			const timer = setTimeout(() => finish(reject, new FsError(`guest call timed out after ${CALL_TIMEOUT_MS}ms`, 'FS_IO_ERROR')), CALL_TIMEOUT_MS);
			if (signal?.aborted === true) {
				finish(reject, signal.reason ?? new FsError('filesystem call aborted', 'FS_IO_ERROR'));
				return;
			}
			signal?.addEventListener('abort', onAbort, { once: true });
			for (const [stream, sink] of [[child.stdout, out], [child.stderr, err]]) {
				stream.on('data', (chunk) => {
					size += chunk.length;
					if (size > RAW_CAP_BYTES) {
						finish(reject, new FsError('guest call produced more output than the byte cap', 'FS_IO_ERROR'));
						return;
					}
					sink.push(chunk);
				});
			}
			child.on('error', (error) => finish(reject, new FsError(`cannot run wsl.exe: ${error.message}`, 'FS_IO_ERROR')));
			child.on('close', (code) => finish(resolve, { code, stdout: Buffer.concat(out), stderr: Buffer.concat(err) }));
			child.stdin.on('error', () => {});
			child.stdin.end(`export LC_ALL=C\nexport LANG=C\n${script}\n`);
		});
	}
	/** Throw the guest's own message as a typed I/O failure. */
	fail(action, path, result) {
		const detail = result.stderr.toString('utf8').trim().split(/\r?\n/u).pop() ?? '';
		throw new FsError(`cannot ${action} "${path}"${detail.length > 0 ? `: ${detail}` : ''}`, 'FS_IO_ERROR');
	}
	/** Whether one canonical guest path contains another (lexical, provider-owned identity). */
	containsKey(parent, child) {
		const root = parent.replace(/\/+$/u, '') || '/';
		return child === root || child.startsWith(root === '/' ? '/' : `${root}/`);
	}
	/** Reproduce the sandbox fence the shipped provider applies, in guest-path terms. */
	fence(target, sandboxPolicy) {
		const mode = sandboxPolicy?.mode;
		if (mode === undefined || mode === 'danger-full-access') return;
		const denied = (by) => new FsError(`cannot write "${target.displayPath}": file access denied under ${by} mode`, 'FS_SANDBOX_DENIED');
		if (mode === 'read-only') throw denied('read-only');
		const declared = typeof sandboxPolicy.workspaceRoot === 'string' ? mirrorToLinux(sandboxPolicy.workspaceRoot) ?? toLinuxPath(sandboxPolicy.workspaceRoot, this.resolveDistro()) ?? sandboxPolicy.workspaceRoot : undefined;
		if (declared === undefined || declared.startsWith('/') === false || !this.containsKey(declared, target.targetKey)) throw denied('workspace-write');
	}
	/** The guest path behind a target key. */
	key(target) {
		return typeof target?.targetKey === 'string' ? target.targetKey : String(target?.targetKey ?? '');
	}
	/**
	 * Resolve one accepted path spelling onto its canonical guest path.
	 *
	 * `toLinuxPath` passes an already-POSIX path through untouched, so it is the
	 * single gate for every host spelling: a drive path, the backslash UNC path
	 * host APIs use, and the forward-slash UNC path a `dsh-resource://file/…`
	 * address round trip hands back. That last one must not be mistaken for a
	 * guest path — `posix.normalize('//wsl.localhost/<d>/…')` would turn it into
	 * `/wsl.localhost/…`, which no distribution has, and the file tree/preview
	 * would report every file under it missing.
	 * @param path - an absolute path in any supported spelling, or a relative one.
	 * @param opts - the relative path's base directory; defaults to the provider cwd.
	 * @returns the canonical guest target.
	 */
	async resolve(path, opts = {}) {
		if (typeof path !== 'string' || path.length === 0) throw new FsError('cannot resolve an empty path', 'FS_IO_ERROR');
		const distro = this.resolveDistro();
		const translated = mirrorToLinux(path) ?? toLinuxPath(path, distro);
		const guest = translated ?? posix.resolve(opts.cwd ?? this.cwd, path);
		const canonical = posix.normalize(guest);
		return { targetKey: canonical, displayPath: canonical };
	}
	processPath(target) {
		const key = this.key(target);
		return windowsUncPath(this.resolveDistro(), key) ?? key;
	}
	processPathFromHostPath(hostPath) {
		return mirrorToLinux(hostPath) ?? toLinuxPath(hostPath, this.resolveDistro());
	}
	fileUrl(target) {
		return `file://${this.key(target).split('/').map((segment) => encodeURIComponent(segment)).join('/')}`;
	}
	contains(parent, child) {
		return this.containsKey(this.key(parent), this.key(child));
	}
	async stat(target, signal) {
		const key = this.key(target);
		const result = await this.guest(statScript(key, true), signal);
		if (result.code !== 0) return undefined;
		const parsed = parseStatLine(result.stdout.toString('utf8').trim());
		return { version: parsed.version, type: parsed.type, ...parsed.size !== undefined ? { size: parsed.size } : {} };
	}
	async lstat(path, opts = {}, signal) {
		const target = await this.resolve(path, { cwd: opts.cwd });
		const result = await this.guest(statScript(this.key(target), false), signal);
		if (result.code !== 0) return undefined;
		const parsed = parseStatLine(result.stdout.toString('utf8').trim());
		return { version: parsed.version, type: parsed.type, ...parsed.size !== undefined ? { size: parsed.size } : {} };
	}
	/** Read a whole regular file as raw bytes, rejecting anything past `maxBytes`. */
	async bytes(target, signal, maxBytes) {
		const key = this.key(target);
		if (maxBytes !== undefined) {
			const current = await this.stat(target, signal);
			if (current !== undefined && current.size !== undefined && current.size > maxBytes) throw new FsError(`"${target.displayPath}" exceeds the ${maxBytes} byte cap`, 'FS_TOO_LARGE');
		}
		const result = await this.guest(readScript(key), signal);
		if (result.code !== 0) this.fail('read', target.displayPath, result);
		if (maxBytes !== undefined && result.stdout.length > maxBytes) throw new FsError(`"${target.displayPath}" exceeds the ${maxBytes} byte cap`, 'FS_TOO_LARGE');
		return result.stdout;
	}
	async readText(target, signal) {
		const raw = await this.bytes(target, signal, undefined);
		if (raw.includes(0)) throw new FsError(`cannot read "${target.displayPath}": not UTF-8 text`, 'FS_IO_ERROR');
		return raw.toString('utf8');
	}
	async streamText(target, signal) {
		const text = await this.readText(target, signal);
		return (async function* chunks() {
			const size = 64 * 1024;
			for (let at = 0; at < text.length; at += size) yield text.slice(at, at + size);
		})();
	}
	readBytes(target, signal, maxBytes) {
		return this.bytes(target, signal, maxBytes);
	}
	async readByteRange(target, range, signal) {
		const key = this.key(target);
		const offset = Math.max(0, Math.trunc(range.offset));
		const length = Math.max(0, Math.trunc(range.length));
		if (length === 0) return new Uint8Array();
		const result = await this.guest(rangeScript(key, offset, length), signal);
		if (result.code !== 0) this.fail('read', target.displayPath, result);
		return result.stdout;
	}
	async listDir(target, signal) {
		const key = this.key(target);
		const result = await this.guest(listScript(key), signal);
		if (result.code !== 0) this.fail('list', target.displayPath, result);
		return parseListing(result.stdout.toString('utf8'), key).sort((left, right) => left.name.localeCompare(right.name));
	}
	/**
	 * Publish text through a guest-side `temp + mv`.
	 * @param target - the resolved file target.
	 * @param content - the complete new content.
	 * @param intent - `createIfAbsent` refuses an existing file; `replaceIfVersion` refuses a changed one.
	 * @returns the produced version and the content it replaced.
	 */
	async publish(target, content, intent, signal) {
		const key = this.key(target);
		const before = intent?.kind === 'createIfAbsent' ? null : await this.readText(target, signal).catch(() => null);
		const exists = await this.stat(target, signal);
		if (intent?.kind === 'createIfAbsent' && exists !== undefined) throw new FsError(`cannot write "${target.displayPath}": file already exists`, 'FS_STALE_VERSION');
		if (intent?.kind === 'replaceIfVersion' && exists !== undefined && exists.version !== intent.version) throw new FsError(`cannot write "${target.displayPath}": file changed since it was read`, 'FS_STALE_VERSION');
		const { script } = publishScript(key, content);
		const result = await this.guest(script, signal);
		if (result.code !== 0) this.fail('write', target.displayPath, result);
		const after = await this.stat(target, signal);
		if (after === undefined) throw new FsError(`cannot write "${target.displayPath}": the file is missing after publication`, 'FS_IO_ERROR');
		return { version: after.version, before, after: content };
	}
	async writeText(target, content, expected, signal, sandboxPolicy) {
		this.fence(target, sandboxPolicy);
		const produced = await this.publish(target, content, expected, signal);
		return {
			operation: produced.before === null ? 'create' : 'update',
			version: produced.version,
			before: produced.before,
			after: produced.after
		};
	}
	async editText(target, edit, expected, signal, sandboxPolicy) {
		this.fence(target, sandboxPolicy);
		const before = await this.readText(target, signal);
		if (expected?.version !== undefined) {
			const current = await this.stat(target, signal);
			if (current === undefined || current.version !== expected.version) throw new FsError(`cannot edit "${target.displayPath}": file changed since it was read`, 'FS_STALE_VERSION');
		}
		if (!before.includes(edit.oldString)) throw new FsError(`cannot edit "${target.displayPath}": the search text was not found`, 'FS_IO_ERROR');
		/* A function replacement, so `$&`/`$1` inside the new text stay literal. */
		const after = edit.replaceAll ? before.split(edit.oldString).join(edit.newString) : before.replace(edit.oldString, () => edit.newString);
		const produced = await this.publish(target, after, undefined, signal);
		return { version: produced.version, before, after };
	}
	/**
	 * Observe a target by polling its guest metadata. WSL exposes no inotify
	 * stream the host can subscribe to, so the watcher is one interval timer per
	 * caller; the callback fires on any version change.
	 */
	async watch(target, changed, signal) {
		const key = this.key(target);
		const stable = { targetKey: key, displayPath: key };
		let previous;
		try {
			previous = (await this.stat(stable, undefined))?.version;
		} catch (error) {
			changed(error);
		}
		const timer = setInterval(() => {
			void (async () => {
				try {
					const next = (await this.stat(stable, undefined))?.version;
					if (next !== previous) {
						previous = next;
						changed();
					}
				} catch (error) {
					changed(error);
				}
			})();
		}, Math.max(100, this.config.watchIntervalMs));
		signal.addEventListener('abort', () => clearInterval(timer), { once: true });
		return async () => clearInterval(timer);
	}
}
/**
 * Load the WSL-native filesystem provider as `ctx.fs`.
 * @param ctx - Cordis context that owns the service.
 * @param config - the row's resolved configuration.
 */
function apply(ctx, config) {
	new WslFileSystem(ctx, config);
}

export { Config, WslFileSystem, apply, inject, name };
