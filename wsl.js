/**
 * Path and environment translation between the Windows host and a WSL
 * distribution. Pure functions only: the executor and the directory browser
 * share them, and they are unit-testable without a Harness runtime.
 * @module @local/dsh-wsl-bridge/wsl
 */

/** A complete WSL UNC prefix addressing one distribution: `\\wsl.localhost\<d>\...` or `\\wsl$\<d>\...`. */
const WSL_UNC = /^\\\\wsl(?:\.localhost|\$)\\([^\\]+)(?:\\([\s\S]*))?$/iu;
/**
 * The same WSL UNC prefix in forward-slash spelling:
 * `//wsl.localhost/<d>/...` or `//wsl$/<d>/...`.
 *
 * Nobody types this spelling; a round trip through a URL-shaped path produces
 * it. The Harness turns the `processPath` spelling
 * ({@link windowsUncPath} → `\\wsl.localhost\<d>\...`) into a
 * `dsh-resource://file/…` address by normalizing backslashes to slashes, and the
 * Host then receives `//wsl.localhost/<d>/...` back as the file path. Without
 * this translation the value falls through as a POSIX path exactly as it was,
 * `posix.normalize` collapses its authority away to `/wsl.localhost/...`, and
 * the guest reports every such file missing — the Sidebar file tree and the
 * document preview then cannot open anything reached through that address.
 */
const WSL_UNC_FORWARD = /^\/\/wsl(?:\.localhost|\$)\/([^/]+)(?:\/([\s\S]*))?$/iu;
/** A drive-qualified Windows path: `C:\...` (a bare `C:` is drive-relative and refused). */
const DRIVE_ABSOLUTE = /^([A-Za-z]):\\([\s\S]*)$/u;
/** A bare drive root: `C:\`. */
const DRIVE_ROOT = /^([A-Za-z]):\\?$/u;
/** Any Windows-absolute form this module can hand to a Windows API. */
const WINDOWS_ABSOLUTE = /^(?:[A-Za-z]:\\|\\\\)/u;
/** WSLENV accepts only POSIX-ish environment names; anything else cannot be forwarded. */
const FORWARDABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u;
/** A variable name whose value is a host path WSL should translate instead of copying verbatim. */
const PATH_VALUED_NAME = /(?:^|_)(?:HOME|DIR|PATH|ROOT|FILE)$/u;

/** Whether a path can be passed to a Windows API as a fixed location. */
export function isWindowsAbsolute(candidate) {
	return typeof candidate === 'string' && WINDOWS_ABSOLUTE.test(candidate);
}

/**
 * Join already-split path segments into a Linux absolute path.
 * @param segments - the tail of a UNC path without the owner; `/`- or `\`-separated.
 * @returns the POSIX path.
 */
function linuxFromSegments(segments) {
	if (segments === undefined) return '/';
	const trimmed = segments.replace(/[\\/]+$/u, '').replace(/^[\\/]+/u, '');
	return trimmed === '' ? '/' : `/${trimmed.replace(/\\/gu, '/')}`;
}

/**
 * Translate one Windows path into the Linux path the target distribution sees.
 *
 * Three host spellings are accepted, in addition to an already-POSIX path: a
 * WSL UNC path in its native backslash spelling (`\\wsl.localhost\<d>\...`), the
 * same path as a URL round trip hands it back with forward slashes
 * (`//wsl.localhost/<d>/...`), and a drive path (`D:\work` → `/mnt/d/work`).
 * @param candidate - the Windows workdir: a WSL UNC path in either spelling, a drive path, or an already-POSIX path.
 * @param distro - the distribution the command runs in; an empty string accepts any UNC owner.
 * @returns the Linux path, or undefined when this module cannot express it.
 */
export function toLinuxPath(candidate, distro) {
	if (typeof candidate !== 'string' || candidate.length === 0) return undefined;
	const forward = WSL_UNC_FORWARD.exec(candidate);
	if (forward !== null) {
		const owner = forward[1];
		if (distro !== '' && owner.toLowerCase() !== distro.toLowerCase()) return undefined;
		return linuxFromSegments(forward[2]);
	}
	if (candidate.startsWith('/')) return candidate;
	const normalized = candidate.replace(/\//gu, '\\');
	if (normalized.startsWith('\\\\')) {
		const unc = WSL_UNC.exec(normalized);
		if (unc === null) return undefined;
		const owner = unc[1];
		if (distro !== '' && owner.toLowerCase() !== distro.toLowerCase()) return undefined;
		return linuxFromSegments(unc[2]);
	}
	const rooted = DRIVE_ABSOLUTE.exec(normalized);
	if (rooted !== null) return `/mnt/${rooted[1].toLowerCase()}/${rooted[2].replace(/\\/gu, '/')}`;
	const root = DRIVE_ROOT.exec(normalized);
	if (root !== null) return `/mnt/${root[1].toLowerCase()}`;
	return undefined;
}

/**
 * Build the `WSLENV` value that forwards exactly this spawn's environment into
 * the distribution. Path-valued names use WSL's `/p` translation so the guest
 * sees `/mnt/c/...` rather than `C:\...`; every other name is copied verbatim
 * with `/u`. Entries already present in an inherited `WSLENV` survive unless
 * this spawn re-declares the same name.
 * @param env - the complete environment being handed to `wsl.exe`.
 * @param inherited - an outer `WSLENV` value to preserve, when the caller has one.
 * @returns the merged `WSLENV` value, or an empty string when nothing is forwarded.
 */
export function buildWslenv(env, inherited) {
	const declared = new Map();
	for (const key of Object.keys(env)) {
		if (key === 'WSLENV' || !FORWARDABLE_NAME.test(key)) continue;
		declared.set(key, PATH_VALUED_NAME.test(key) ? '/p' : '/u');
	}
	const base = typeof inherited === 'string' && inherited.length > 0 ? inherited : typeof env.WSLENV === 'string' ? env.WSLENV : '';
	const kept = [];
	for (const entry of base.split(':')) {
		if (entry.length === 0) continue;
		const name = entry.split('/')[0];
		if (name.length === 0 || declared.has(name)) continue;
		kept.push(entry);
	}
	for (const [key, flag] of declared) kept.push(`${key}${flag}`);
	return kept.join(':');
}

/** Resolve the `wsl.exe` to spawn: an explicit path, else the System32 one, else PATH lookup. */
export function resolveWslExecutable(configured) {
	if (typeof configured === 'string' && configured.trim().length > 0) return configured.trim();
	const systemRoot = process.env.SystemRoot ?? process.env.windir;
	if (typeof systemRoot === 'string' && systemRoot.length > 0) return `${systemRoot.replace(/[\\/]+$/u, '')}\\System32\\wsl.exe`;
	return 'wsl.exe';
}

/**
 * The Windows UNC path that addresses one guest path, so the host can read and
 * write it without any command-line hop. A command text must never travel
 * through argv: the Windows command-line round trip strips quoting and — worse —
 * substitutes `$NAME` from the environment before bash sees the text, which
 * silently breaks variables, `$?`, awk fields, and every `sed` script. Writing
 * the text through this share keeps every byte intact.
 * @param distro - the distribution whose filesystem is addressed; required, since the UNC prefix names it.
 * @param linuxPath - an absolute guest path.
 * @returns the UNC path, or undefined when the inputs cannot name one.
 */
export function windowsUncPath(distro, linuxPath) {
	if (typeof distro !== 'string' || distro.length === 0) return undefined;
	if (typeof linuxPath !== 'string' || !linuxPath.startsWith('/')) return undefined;
	return `\\\\wsl.localhost\\${distro}${linuxPath.replace(/\//gu, '\\')}`;
}

/**
 * The Windows path a host-side consumer must use for one guest path.
 *
 * A guest path under `/mnt/<letter>` **is** Windows drive `<letter>:` — that is
 * what drvfs mounts — and the WSL UNC share cannot serve a drvfs mount: the
 * share answers `E_ACCESSDENIED` for anything below it, so `SHCreateItemFromParsingName`
 * fails, Explorer cannot open the file, and every "open with" gesture dies before
 * an application is even asked. Those paths therefore map onto the drive itself.
 *
 * Every other guest path lives on the distribution's own (ext4) filesystem,
 * which has no drive letter: the WSL UNC share is the only Windows spelling, and
 * the Shell serves it fine.
 *
 * This is the inverse of {@link toLinuxPath}: both drive spellings round-trip,
 * which is what `processPathFromHostPath` + `processPath` must do for the
 * Session controller's "verified Host path" check.
 * @param distro - the distribution whose share addresses non-drive paths; required for those.
 * @param linuxPath - an absolute guest path.
 * @returns the Windows path, or undefined when the inputs cannot name one.
 */
export function linuxToWindowsPath(distro, linuxPath) {
	if (typeof linuxPath !== 'string' || !linuxPath.startsWith('/')) return undefined;
	const drive = /^\/mnt\/([A-Za-z])(?:\/([\s\S]*))?$/u.exec(linuxPath);
	if (drive !== null) {
		const rest = (drive[2] ?? '').replace(/\/+$/u, '');
		return rest === '' ? `${drive[1].toUpperCase()}:\\` : `${drive[1].toUpperCase()}:\\${rest.replace(/\//gu, '\\')}`;
	}
	return windowsUncPath(distro, linuxPath);
}
