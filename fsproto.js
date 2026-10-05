/**
 * The guest-side file protocol: every bash script the WSL filesystem provider
 * speaks and every parser that reads its output.
 *
 * Kept free of `@deepseek-ai/*` imports on purpose, so the exact scripts can be
 * run against a real distribution without a running Harness — the bugs this
 * module has already caught (a locale-translated `stat -c %F`, a heredoc that
 * appended a trailing newline) were script bugs, and they are only visible when
 * the script actually runs.
 * @module @local/dsh-wsl-bridge/fsproto
 */
import { shellQuote } from './guest.js';

/**
 * Map a `find -printf %y` type letter onto the seam's entry type.
 * @param letter - `f`, `d`, `l`, or anything else.
 * @returns the seam's entry type.
 */
export function entryType(letter) {
	return letter === 'f' ? 'file' : letter === 'd' ? 'directory' : 'other';
}

/** Decode one file-type field from a raw `st_mode` (`stat -c %f`), which no locale can translate. */
function modeType(mode) {
	switch (Number.parseInt(mode, 16) & 0xf000) {
		case 0x8000: return 'file';
		case 0x4000: return 'directory';
		case 0xa000: return 'symlink';
		default: return 'other';
	}
}

/**
 * Parse one `%y|%Y|%s` metadata row.
 * `%y` is a type letter, not a localized name: `%F` returns `普通文件` on a
 * Chinese guest and silently misclassified every file as `other`.
 * @param line - one stdout line.
 * @returns the seam's `type`, plus its version and size.
 */
export function parseStatLine(line) {
	const [mode, mtime, size] = line.split('|');
	return {
		type: modeType(mode),
		version: `${mtime}:${size}`,
		...(size !== undefined && Number.isFinite(Number(size)) ? { size: Number(size) } : {})
	};
}

/**
 * Metadata of one path; `deref` follows symlinks, exactly like `fs.stat` vs
 * `fs.lstat`.
 *
 * The type comes from the raw `st_mode` (`%f`), not from a human-readable
 * field: `stat -c %F` is a translated message (`普通文件` on a Chinese guest),
 * `stat` has no single-letter type specifier (`%y` there means "last
 * modification time"), and `find -L` does not dereference its own starting
 * point — so none of the obvious spellings survives a non-English guest.
 * @param key - absolute guest path.
 * @param deref - follow a symlink and report its target, like `fs.stat`.
 * @returns the bash script that prints `mode|mtime|size`.
 */
export function statScript(key, deref = true) {
	return `stat ${deref ? '-L ' : ''}-c '%f|%Y|%s' -- ${shellQuote(key)}`;
}

/** Child entries of one directory, type letter first and name last so a name containing `|` survives. */
export function listScript(key) {
	return `find -- ${shellQuote(key)} -mindepth 1 -maxdepth 1 -printf '%y|%s|%f\\n'`;
}

/**
 * Parse a {@link listScript} listing into child targets.
 * @param stdout - the raw stdout text.
 * @param key - the listing directory's guest path.
 * @returns one row per child, in the order the guest printed them.
 */
export function parseListing(stdout, key) {
	const base = key.replace(/\/+$/u, '');
	const rows = [];
	for (const line of stdout.split(/\n/u)) {
		if (line.length === 0) continue;
		const [letter, size, ...rest] = line.split('|');
		const name = rest.join('|');
		if (name.length === 0) continue;
		const child = `${base}/${name}`;
		const parsed = Number(size);
		rows.push({
			name,
			type: entryType(letter),
			target: { targetKey: child, displayPath: child },
			...(Number.isFinite(parsed) && letter === 'f' ? { size: parsed } : {})
		});
	}
	return rows;
}

/** The whole contents of one regular file. */
export function readScript(key) {
	return `cat -- ${shellQuote(key)}`;
}

/** A byte window of one file. */
export function rangeScript(key, offset, length) {
	return `tail -c +${offset + 1} -- ${shellQuote(key)} | head -c ${length}`;
}

/** Whether a path is a directory in the guest. */
export function directoryScript(key) {
	return `[ -d ${shellQuote(key)} ]`;
}

/**
 * Publish `content` to `key` atomically.
 *
 * The bytes travel base64-encoded: the content is decoded by the guest rather
 * than typed into a heredoc, so content that does not end with a newline keeps
 * its exact bytes and no content can collide with a terminator line. The
 * `mv` is an ext4 rename — atomic, and it never touches the 9P share.
 * @param key - absolute guest path of the file.
 * @param content - the complete new text.
 * @returns the bash script that writes it.
 */
export function publishScript(key, content) {
	const temporary = `${key}.dsh-wsl-${process.pid}-${Date.now()}.tmp`;
	const encoded = Buffer.from(content, 'utf8').toString('base64');
	return {
		temporary,
		script: [
			`mkdir -p -- ${shellQuote(key.replace(/\/[^/]*$/u, '') || '/')}`,
			`printf '%s' ${encoded} | base64 -d > ${shellQuote(temporary)}`,
			`chmod --reference=${shellQuote(key)} ${shellQuote(temporary)} 2>/dev/null || true`,
			`mv -f -- ${shellQuote(temporary)} ${shellQuote(key)}`,
			`rm -f -- ${shellQuote(temporary)}`
		].join('\n')
	};
}

