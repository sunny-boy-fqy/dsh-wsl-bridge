/**
 * Host-side shadow of the guest filesystem.
 *
 * A Workspace path is the guest's own spelling (`/home/you/project`), and every
 * bridge-owned tool talks to the guest directly. A few shipped Harness plugins,
 * however, still call Node's `fs` and `path` on the session cwd — the
 * agent-instruction walk (`AGENTS.md` discovery), `@file` reference completion,
 * and the session controller's own `mkdir(cwd, { recursive: true })`. On Windows
 * a leading `/` resolves against the **process's current drive**, so
 * `path.resolve('/home/you/project')` becomes `D:\home\you\project` and
 * `path.resolve('/mnt/d/tmp')` becomes `D:\mnt\d\tmp`.
 *
 * This module makes both spellings real:
 *
 * - A guest directory on the distribution's own filesystem (`/home`, `/root`, …)
 *   is exposed with one directory symlink `<drive>:\<top>` →
 *   `\\wsl.localhost\<distro>\<top>`. The WSL share serves the ext4 tree, so
 *   host-side `node:fs` reads the true guest files.
 * - A guest directory under `/mnt/<letter>` **is** Windows drive `<letter>:`
 *   (that is what drvfs mounts), so the share cannot serve it: the WSL share
 *   returns `EPERM` for anything under a drvfs mount. The host spelling is made
 *   real by pointing `<drive>:\mnt\<letter>` at `<letter>:\` instead, which maps
 *   `C:\mnt\d\tmp` onto the same directory the guest calls `/mnt/d/tmp`. One real
 *   `<drive>:\mnt` directory holds those per-drive links.
 *
 * Nothing here is on the model's path: these links only translate a host-side
 * spelling back into the guest path the tools already use. Existing entries are
 * never replaced, except a `<drive>:\mnt` symlink this module itself created in
 * an earlier version, whose UNC target cannot serve a drvfs mount.
 * @module @local/dsh-wsl-bridge/mirror
 */
import { existsSync, lstatSync, mkdirSync, readlinkSync, rmdirSync, symlinkSync } from 'node:fs';

/** A symlink this module owns points at the WSL share for some distribution. */
const WSL_TARGET = /^\\\\wsl(?:\.localhost|\$)\\/iu;
/** `<drive>:\<top>\<rest…>` — a drive-qualified path whose first segment may be a mirror. */
const DRIVE_TOP = /^([A-Za-z]):[\\/]+([^\\/]+)((?:[\\/][^\\/]*)*)$/u;
/** `<drive>:\mnt\<letter>\<rest…>` — the drive-relative spelling of `/mnt/<letter>/<rest…>`. */
const DRIVE_MNT = /^([A-Za-z]):[\\/]+mnt[\\/]+([A-Za-z])((?:[\\/][^\\/]*)*)$/u;

/** Verified mirror roots, keyed `D:\home` or `D:\mnt\d`; avoids re-lstat-ing on every call. */
const verified = new Map();

/** The drive letter of a Windows path, upper-cased, or undefined. */
function driveOf(path) {
	const matched = /^([A-Za-z]):/u.exec(path);
	return matched === null ? undefined : `${matched[1].toUpperCase()}:`;
}

/** Whether one entry is a directory symlink (not a real directory). */
function isDirectoryLink(path) {
	try {
		const info = lstatSync(path);
		return info.isSymbolicLink();
	} catch {
		return false;
	}
}

/** Whether one entry is a `\\wsl.localhost\…` symlink created by an earlier version of this module. */
function isWslLink(path) {
	try {
		return isDirectoryLink(path) && WSL_TARGET.test(readlinkSync(path));
	} catch {
		return false;
	}
}

/** The drives a host-side spelling can land on: the process's own drive, plus `C:` when it exists. */
export function mirrorDrives() {
	const drives = [];
	for (const drive of [driveOf(process.cwd()), 'C:']) {
		if (drive === undefined || drives.includes(drive)) continue;
		if (existsSync(`${drive}\\`)) drives.push(drive);
	}
	return drives;
}

/** Whether `<drive>:\<top>` is a symlink this module created (verified once, then cached). */
export function isMirrorRoot(drive, top) {
	const key = `${drive.toUpperCase()}\\${top}`;
	const cached = verified.get(key);
	if (cached !== undefined) return cached;
	let owned = false;
	try {
		owned = isDirectoryLink(key) && WSL_TARGET.test(readlinkSync(key));
	} catch {
		owned = false;
	}
	verified.set(key, owned);
	return owned;
}

/**
 * Whether `<drive>:\mnt\<letter>` already addresses the real `<letter>:` drive,
 * i.e. this module's drvfs mapping is in place (verified once, then cached).
 * @param drive - the host drive holding the `\mnt` directory (`C:`).
 * @param letter - the single lower-case drive letter the guest names (`d`).
 * @returns true when the link exists and points at the drive root.
 */
export function isDriveMirror(drive, letter) {
	const key = `${drive.toUpperCase()}\\mnt\\${letter}`;
	const cached = verified.get(key);
	if (cached !== undefined) return cached;
	let owned = false;
	try {
		if (isDirectoryLink(key)) {
			const target = readlinkSync(key).replace(/[\\/]+$/u, '').toUpperCase();
			owned = target === `${letter.toUpperCase()}:`;
		}
	} catch {
		owned = false;
	}
	verified.set(key, owned);
	return owned;
}

/**
 * Translate a host-side spelling of a guest path back into the guest path.
 * @param candidate - a path such as `D:\home\you\project` or `C:\mnt\d\tmp`.
 * @returns the guest path (`/home/you/project`, `/mnt/d/tmp`), or undefined when this is not a mirrored path.
 */
export function mirrorToLinux(candidate) {
	if (typeof candidate !== 'string') return undefined;
	const mnt = DRIVE_MNT.exec(candidate);
	if (mnt !== null && isDriveMirror(`${mnt[1]}:`, mnt[2].toLowerCase())) {
		return `/mnt/${mnt[2].toLowerCase()}${mnt[3].replace(/\\/gu, '/')}`;
	}
	const matched = DRIVE_TOP.exec(candidate);
	if (matched === null) return undefined;
	if (!isMirrorRoot(`${matched[1]}:`, matched[2])) return undefined;
	return `/${matched[2]}${matched[3].replace(/\\/gu, '/')}`;
}

/**
 * Expose one guest path under `/mnt/<letter>` at the drive letter it actually
 * is: `<drive>:\mnt\<letter>` → `<letter>:\`. A pre-existing `<drive>:\mnt`
 * directory is reused; a `<drive>:\mnt` symlink pointing at the WSL share (what
 * an earlier version created, and what drvfs makes `EPERM`) is replaced with a
 * real directory, because the share cannot serve it.
 * @param letter - the single lower-case drive letter.
 * @param onFailure - receives one message per link that could not be created.
 * @returns the link paths that were created.
 */
function ensureDriveMirror(letter, onFailure) {
	const created = [];
	for (const drive of mirrorDrives()) {
		const base = `${drive}\\mnt`;
		if (existsSync(base)) {
			if (isWslLink(base)) {
				try {
					rmdirSync(base);
					mkdirSync(base);
				} catch (error) {
					onFailure?.(`cannot replace the host link ${base} with a real directory: ${error.message}`);
					continue;
				}
			}
		} else {
			try {
				mkdirSync(base);
			} catch (error) {
				onFailure?.(`cannot expose '/mnt/${letter}' to host-side plugins at ${base}: ${error.message}`);
				continue;
			}
		}
		const link = `${base}\\${letter}`;
		if (existsSync(link)) {
			if (!isDriveMirror(drive, letter)) onFailure?.(`${link} exists but does not address ${letter.toUpperCase()}:; host-side plugins cannot read '/mnt/${letter}'`);
			continue;
		}
		try {
			symlinkSync(`${letter.toUpperCase()}:\\`, link, 'dir');
			verified.set(`${drive.toUpperCase()}\\mnt\\${letter}`, true);
			created.push(link);
		} catch (error) {
			verified.set(`${drive.toUpperCase()}\\mnt\\${letter}`, false);
			onFailure?.(`cannot expose '/mnt/${letter}' to host-side plugins at ${link}: ${error.message}`);
		}
	}
	return created;
}

/**
 * Make one guest path readable to host-side plugins at the drive-relative
 * spelling of that same path. Existing entries are never touched or replaced,
 * and a failure to create a link (no symlink privilege) only costs the
 * host-side plugins that read through `node:fs` — nothing else depends on it.
 * @param distro - the distribution whose share the links address; empty does nothing.
 * @param linuxPath - an absolute guest path; its first segment is what gets linked.
 * @param onFailure - receives one message per link that could not be created.
 * @returns the link paths that were created.
 */
export function ensureMirror(distro, linuxPath, onFailure) {
	if (typeof distro !== 'string' || distro.length === 0) return [];
	if (typeof linuxPath !== 'string' || !linuxPath.startsWith('/')) return [];
	const segments = linuxPath.split('/').filter((segment) => segment.length > 0);
	const top = segments[0];
	if (top === undefined) return [];
	if (top === 'mnt' && /^[A-Za-z]$/u.test(segments[1] ?? '')) return ensureDriveMirror(segments[1].toLowerCase(), onFailure);
	const created = [];
	for (const drive of mirrorDrives()) {
		const link = `${drive}\\${top}`;
		if (existsSync(link)) {
			if (!isMirrorRoot(drive, top)) verified.set(`${drive}\\${top}`, false);
			continue;
		}
		try {
			symlinkSync(`\\\\wsl.localhost\\${distro}\\${top}`, link, 'dir');
			verified.set(`${drive}\\${top}`, true);
			created.push(link);
		} catch (error) {
			verified.set(`${drive}\\${top}`, false);
			onFailure?.(`cannot expose the guest directory '/${top}' to host-side plugins at ${link}: ${error.message}`);
		}
	}
	return created;
}
