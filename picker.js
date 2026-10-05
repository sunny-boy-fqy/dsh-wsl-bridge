/**
 * Linux-native directory browser for the Web GUI's workspace flow.
 *
 * Replaces the host browser with one that lists the **guest** filesystem, so the
 * picker never mixes Windows drives with Linux paths: the root of the tree is
 * the distribution's `/`, every row it returns is a Linux path, and the path the
 * workspace dialog hands on is exactly the path the workspace registry stores.
 *
 * The listing itself is inherited behaviour (`browse` capability, one bounded
 * level, child-directory creation, breadcrumbs); only the four operations that
 * would otherwise run against the host filesystem are restated here. A path that
 * arrives in a Windows spelling is translated first (`D:\work` → `/mnt/d/work`),
 * so a client that remembers an old browsed directory still lands somewhere
 * sensible instead of failing.
 * @module @local/dsh-wsl-bridge/picker
 */
import { posix } from 'node:path';
import z from '@deepseek-ai/schemastery';
import { DirectoryPickerError } from '@deepseek-ai/dsh-host-directory-picker';
import BrowseDirectoryPicker from '@deepseek-ai/dsh-host-directory-picker-browse';
import { guestRun, resolveDefaultDistro, shellQuote } from './guest.js';
import { mirrorToLinux } from './mirror.js';
import { toLinuxPath } from './wsl.js';

/** Cordis plugin name. */
const name = 'wsl-directory-picker';
/** Guest calls stay well inside a dialog's patience. */
const DEFAULT_TIMEOUT_MS = 20000;
/** Exit code the listing script uses for "not a readable directory". */
const NOT_A_DIRECTORY = 3;

/** Runtime configuration: the browse backend's listing bound plus the guest knobs. */
const Config = z.object({
	maxEntries: z.natural().min(1).default(1e3),
	distro: z.string().default('').description('Distribution to browse; empty uses the launcher default.'),
	wslPath: z.string().default('').description('Absolute path of wsl.exe; empty resolves %SystemRoot%\\System32\\wsl.exe.'),
	timeoutMs: z.number().default(DEFAULT_TIMEOUT_MS),
	distroCacheMs: z.number().default(30000)
});

/** The breadcrumb chain from the filesystem root to `target`, inclusive. */
function guestCrumbs(target) {
	const segments = target.split('/').filter((segment) => segment.length > 0);
	const crumbs = [{ name: '/', path: '/', hidden: false }];
	let current = '';
	for (const segment of segments) {
		current += `/${segment}`;
		crumbs.push({ name: segment, path: current, hidden: false });
	}
	return crumbs;
}

/**
 * The `browse` backend over the guest filesystem.
 *
 * Every path this class returns is a Linux path; a Windows spelling is accepted
 * on input and translated, never echoed back.
 */
class WslDirectoryPicker extends BrowseDirectoryPicker {
	static Config = Config;
	constructor(ctx, config) {
		super(ctx, config);
		this.sampledDistro = undefined;
		this.sampledHome = undefined;
	}
	/** The distribution this browser lists: the configured one, else the launcher default. */
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
	/** The login user's home directory, read once per service life. */
	async home(signal) {
		if (this.sampledHome !== undefined) return this.sampledHome;
		const result = await this.guest('printf \'%s\' "$HOME"\n', signal);
		const sampled = result.stdout.toString('utf8').trim();
		this.sampledHome = sampled.startsWith('/') ? sampled : '/';
		return this.sampledHome;
	}
	/**
	 * Translate a client-supplied level into a guest path.
	 * @param path - the requested level, a guest path or a Windows spelling of one.
	 * @returns the Linux directory to list.
	 */
	async guestPath(path) {
		if (typeof path !== 'string' || path.length === 0) return await this.home();
		const translated = mirrorToLinux(path) ?? toLinuxPath(path, this.resolveDistro());
		if (translated === undefined || !translated.startsWith('/')) return await this.home();
		const normalized = posix.normalize(translated);
		return normalized.length > 1 ? normalized.replace(/\/+$/u, '') : '/';
	}
	/**
	 * List one level of the guest filesystem.
	 * @param path - the level to list; absent lists the guest home directory.
	 * @param signal - the caller's lifetime.
	 * @returns the listing, with Linux paths and Linux crumbs.
	 */
	async list(path, signal) {
		const target = await this.guestPath(path);
		const script = [
			`p=${shellQuote(target)}`,
			`if [ ! -d "$p" ]; then exit ${NOT_A_DIRECTORY}; fi`,
			'shopt -s nullglob dotglob',
			'for entry in "$p"/*; do',
			'  name=${entry##*/}',
			'  [ -d "$entry" ] || continue',
			"  printf '%s\\0' \"$name\"",
			'done'
		].join('\n');
		let result;
		try {
			result = await this.guest(script, signal);
		} catch (error) {
			signal?.throwIfAborted();
			throw new DirectoryPickerError('directory-unreadable', target, `cannot list ${target}: ${error.message}`);
		}
		if (result.code === NOT_A_DIRECTORY) throw new DirectoryPickerError('directory-unreadable', target, `cannot list ${target}: not a directory`);
		if (result.code !== 0) {
			const detail = result.stderr.toString('utf8').trim().split(/\r?\n/u).pop() ?? '';
			throw new DirectoryPickerError('directory-unreadable', target, `cannot list ${target}${detail.length > 0 ? `: ${detail}` : ''}`);
		}
		const names = result.stdout.toString('utf8').split('\0').filter((entry) => entry.length > 0);
		const entries = names.slice(0, this.config.maxEntries).map((entry) => ({
			name: entry,
			path: posix.join(target, entry),
			hidden: entry.startsWith('.')
		}));
		return {
			path: target,
			home: await this.home(signal),
			crumbs: guestCrumbs(target),
			entries,
			truncated: names.length > entries.length
		};
	}
	/**
	 * Create one child directory inside the guest.
	 * @param path - the guest parent path.
	 * @param name - one path segment.
	 * @returns the created guest path.
	 */
	async createDirectory(path, name) {
		const parent = await this.guestPath(path);
		const trimmed = typeof name === 'string' ? name.trim() : '';
		const target = posix.join(parent, trimmed);
		if (trimmed === '' || trimmed === '.' || trimmed === '..' || /[/\\]/u.test(trimmed)) throw new DirectoryPickerError('directory-create-failed', target, `"${name}" is not a single path segment`);
		const result = await this.guest([
			`t=${shellQuote(target)}`,
			'if [ -e "$t" ]; then exit 4; fi',
			'mkdir -- "$t" || exit 5'
		].join('\n'));
		if (result.code === 4) throw new DirectoryPickerError('directory-exists', target, `${target} already exists`);
		if (result.code !== 0) {
			const detail = result.stderr.toString('utf8').trim().split(/\r?\n/u).pop() ?? '';
			throw new DirectoryPickerError('directory-create-failed', target, `cannot create ${target}${detail.length > 0 ? `: ${detail}` : ''}`);
		}
		return target;
	}
}
/**
 * Load the Linux-native browse backend as `ctx.directoryPicker`.
 * @param ctx - Cordis context that owns the service.
 * @param config - the row's resolved configuration.
 */
function apply(ctx, config) {
	new WslDirectoryPicker(ctx, config);
}

export { Config, WslDirectoryPicker, apply, name };
