/**
 * Pure core of the guest-native `glob` / `grep` tools: path spelling, the two
 * bash bodies, the two stream parsers, and the model-facing rendering. No Cordis
 * context, no subprocess seam, no Harness import — the same rule `./wsl.js`
 * follows, so every rule here is unit-testable without a runtime, and the guest
 * scripts can be executed directly by a probe.
 *
 * Why the backend is replaced: the shipped `@deepseek-ai/dsh-tool-fs-search` row
 * runs the packaged Windows ripgrep, so it prints Windows paths (`tmp\a.txt`)
 * and its spill footer prints a Windows locator the model cannot `read`. A
 * guest-side `glob` / `grep` keeps the argument schema and the result shape but
 * prints only Linux paths, which round-trip straight back into `read` / `edit`.
 *
 * `glob`: bash `globstar` expansion under one absolute root, `stat -c %Y` per
 * hit so the host can order by modification time without a second round trip,
 * `nullglob dotglob globstar` for ripgrep's hidden-file / any-depth behaviour,
 * and a `case` prune for the VCS metadata directories (`GLOB_VCS_EXCLUDES`).
 * `grep`: GNU `grep -E`, one `-l` pass to enumerate matching files (skipping
 * binaries once) then one `-n` pass per file for line numbers, with a NUL after
 * each filename so a Linux filename containing `:` cannot break the parse. The
 * VCS directories and hidden entries ripgrep skips by default are excluded here.
 * @module @local/dsh-wsl-bridge/search-core
 */
import { posix } from 'node:path';
import { isWindowsAbsolute, toLinuxPath } from './wsl.js';

/** Directory names never entered by `grep`, matching ripgrep's VCS-ignore defaults. */
export const VCS_EXCLUDES = ['.git', '.svn', '.hg', '.bzr', '.jj', '.sl'];
/** Quote one string for a POSIX shell as a single-quoted word. */
function shellQuote(value) {
	return `'${String(value).replace(/'/gu, `'\\''`)}'`;
}
/** Paths one `glob` call returns inline before the remainder moves to the spill file. */
export const GLOB_MAX_RESULTS = 100;
/** Matches one `grep` call returns inline before the remainder moves to the spill file. */
export const GREP_MAX_MATCHES = 250;
/** Byte bound on one matched-line preview. */
export const GREP_MAX_LINE_BYTES = 2000;

/**
 * Translate any accepted spelling of one search target into its guest path.
 * @param value - an absolute Linux path, a WSL UNC path, or a Windows drive path.
 * @param distro - the target distribution; an empty string accepts any UNC owner.
 * @returns the normalized Linux path, or undefined when the spelling is relative.
 */
export function toGuestPath(value, distro) {
	if (typeof value !== 'string' || value.length === 0) return undefined;
	if (value.startsWith('/')) return posix.normalize(value);
	if (isWindowsAbsolute(value)) {
		const translated = toLinuxPath(value, distro);
		return translated === undefined ? undefined : posix.normalize(translated);
	}
	return undefined;
}

/**
 * The absolute guest directory (or file) one call searches.
 * @param cwd - the session's guest working directory.
 * @param requested - the tool's `path` argument, or undefined.
 * @param distro - the target distribution.
 * @returns the absolute Linux target.
 */
export function resolveSearchTarget(cwd, requested, distro) {
	const base = typeof cwd === 'string' && cwd.startsWith('/') ? posix.normalize(cwd) : '/';
	if (typeof requested !== 'string' || requested.length === 0) return base;
	const absolute = toGuestPath(requested, distro);
	if (absolute !== undefined) return absolute;
	return posix.normalize(posix.join(base, requested));
}

/**
 * How one result path is shown to the model: workdir-relative when it is inside
 * the session workspace, otherwise the absolute Linux path. Both forms keep
 * forward slashes, so the spelling always round-trips through `read` / `edit`.
 * @param absolute - the absolute Linux result path.
 * @param cwd - the session's guest working directory.
 * @returns the display spelling.
 */
export function linuxDisplay(absolute, cwd) {
	if (typeof cwd !== 'string' || !cwd.startsWith('/')) return absolute;
	const rel = posix.relative(posix.normalize(cwd), absolute);
	if (rel === '') return '.';
	if (rel === '..' || rel.startsWith('../')) return absolute;
	return rel;
}

/**
 * Bound one matched line to `maxBytes` without splitting a UTF-8 sequence.
 * @param line - the matched line text.
 * @param maxBytes - the per-line preview budget.
 * @returns the preview, suffixed with ` (line truncated)` when bytes were cut.
 */
export function previewLine(line, maxBytes) {
	const buffer = Buffer.from(line, 'utf8');
	if (buffer.length <= maxBytes) return line;
	let end = maxBytes;
	while (end > 0 && (buffer[end] & 0xc0) === 0x80) end -= 1;
	return `${buffer.subarray(0, end).toString('utf8')} (line truncated)`;
}

/**
 * The bash body that expands one glob pattern under one root and prints
 * `mtime<TAB>path<NUL>` per file. `IFS=` keeps a pattern containing spaces one
 * word, so the pattern is never re-split by the shell.
 * @param root - the absolute guest search root.
 * @param pattern - the model's glob pattern.
 * @returns the bash script, written to `bash -l` on stdin.
 */
export function globScript(root, pattern) {
	const relative = pattern.includes('/') ? pattern : `**/${pattern}`;
	const pruned = VCS_EXCLUDES.map((dir) => `*/${dir}/*`).join('|');
	return [
		`root=${shellQuote(root)}`,
		`pattern=${shellQuote(relative)}`,
		'if [ ! -d "$root" ]; then exit 3; fi',
		'shopt -s nullglob dotglob globstar',
		'IFS=',
		'for f in "$root"/$pattern; do',
		'  [ -f "$f" ] || continue',
		`  case "$f" in ${pruned}) continue;; esac`,
		`  printf '%s\\t%s\\0' "$(stat -c %Y -- "$f" 2>/dev/null)" "$f"`,
		'done'
	].join('\n');
}

/**
 * Expand `{a,b}` alternation into separate globs, the way ripgrep's `--glob`
 * accepts a brace group. GNU `--include` takes one glob and does no brace
 * expansion, so `*.{js,jsx}` has to become two arguments here.
 * @param pattern - one glob, possibly with brace groups.
 * @returns every expanded glob.
 */
export function expandBraces(pattern) {
	const open = pattern.indexOf('{');
	if (open < 0) return [pattern];
	const close = pattern.indexOf('}', open);
	if (close < 0) return [pattern];
	const alternatives = pattern.slice(open + 1, close).split(',');
	const expanded = [];
	for (const alternative of alternatives) {
		for (const rest of expandBraces(`${pattern.slice(0, open)}${alternative}${pattern.slice(close + 1)}`)) expanded.push(rest);
	}
	return expanded;
}

/**
 * The bash body that walks one root with GNU `grep` and prints one
 * `path<NUL>lineNumber:text<NUL>` record per match: one `-l -Z` pass enumerates
 * matching files, then one `-n -E` pass per file supplies line numbers.
 * @param root - the absolute guest search root.
 * @param pattern - the extended regular expression.
 * @param includes - zero or more `--include` globs (already brace-expanded).
 * @returns the bash script, written to `bash -l` on stdin.
 */
export function grepScript(root, pattern, includes) {
	/* GNU grep ordering matters: an `--include` given after any `--exclude` is
	   ignored outright, so every include must precede every exclude. */
	const filters = includes.map((include) => `--include=${shellQuote(include)}`);
	filters.push(...VCS_EXCLUDES.map((dir) => `--exclude-dir=${shellQuote(dir)}`));
	/* ripgrep skips hidden files and hidden directories unless `--hidden` is given. */
	filters.push(`--exclude=${shellQuote('.*')}`, `--exclude-dir=${shellQuote('.*')}`);
	const common = `-I -E ${filters.join(' ')} -e ${shellQuote(pattern)}`;
	return [
		`root=${shellQuote(root)}`,
		'count=0',
		'if [ ! -e "$root" ]; then exit 2; fi',
		"while IFS= read -r -d '' f; do",
		`  while IFS= read -r rec; do printf '%s\\0%s\\0' "$f" "$rec"; count=$((count+1)); done < <(grep -n ${common} -- "$f")`,
		`done < <(grep -r -l -Z ${common} -- "$root")`,
		'if [ "$count" -eq 0 ]; then exit 1; fi'
	].join('\n');
}

/**
 * Parse the guest `glob` stream: `mtime<TAB>path<NUL>` records.
 * @param stdout - the raw guest stdout.
 * @returns every `{modifiedMs, path}`, newest first, ties broken by path.
 */
export function parseGlobRecords(stdout) {
	const records = [];
	for (const record of stdout.split('\0')) {
		if (record.length === 0) continue;
		const tab = record.indexOf('\t');
		if (tab < 0) continue;
		const modifiedMs = Number(record.slice(0, tab)) * 1000;
		records.push({ modifiedMs: Number.isFinite(modifiedMs) ? modifiedMs : 0, path: record.slice(tab + 1) });
	}
	records.sort((left, right) => right.modifiedMs - left.modifiedMs || (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
	return records;
}

/**
 * Parse the guest `grep` stream: `path<NUL>lineNumber:text<NUL>` records.
 * @param stdout - the raw guest stdout.
 * @returns every `{path, lineNumber, line}` in traversal order.
 */
export function parseGrepRecords(stdout) {
	const records = stdout.split('\0');
	const matches = [];
	for (let index = 0; index + 1 < records.length; index += 2) {
		const path = records[index];
		const body = records[index + 1];
		if (path.length === 0 || body.length === 0) continue;
		const colon = body.indexOf(':');
		if (colon < 0) continue;
		const lineNumber = Number(body.slice(0, colon));
		if (!Number.isInteger(lineNumber)) continue;
		matches.push({ path, lineNumber, line: body.slice(colon + 1).replace(/\r?\n$/u, '') });
	}
	return matches;
}

/** Reject an `include` the shipped schema rejects, with the shipped messages. */
export function validateInclude(include) {
	if (include === undefined) return undefined;
	if (typeof include !== 'string' || include.length === 0) throw new Error('include must be a non-empty glob when given');
	if (include.startsWith('!')) throw new Error('include must be a positive glob filter; negated patterns ("!…") are not supported');
	let depth = 0;
	for (const character of include) {
		if (character === '{') depth += 1;
		else if (character === '}') depth = Math.max(0, depth - 1);
		else if (character === ',' && depth === 0) throw new Error('include must be one glob, not a comma-separated list (use {a,b} alternation instead)');
	}
	return include;
}

/** Group `grep` matches by file, in first-seen order. */
export function groupMatches(matches) {
	const files = [];
	const index = new Map();
	for (const match of matches) {
		let group = index.get(match.path);
		if (group === undefined) {
			group = { path: match.path, matches: [] };
			index.set(match.path, group);
			files.push(group);
		}
		group.matches.push(match);
	}
	return files;
}

/** Bound a search-card payload to `maxBytes` by dropping trailing entries. */
export function capMeta(meta, maxBytes) {
	const whole = (value) => Buffer.byteLength(JSON.stringify(value), 'utf8') <= maxBytes;
	if (whole(meta)) return meta;
	const trimmed = { ...meta, truncated: true };
	const list = meta.shape === 'paths' ? meta.paths : meta.files;
	while (list.length > 1 && !whole(trimmed)) list.pop();
	return trimmed;
}

/** The search-card payload for one completed `glob` call. */
export function globMeta(paths, total, maxBytes) {
	return capMeta({ shape: 'paths', paths: [...paths], truncated: total > paths.length, total }, maxBytes);
}

/** The search-card payload for one completed `grep` call. */
export function grepMeta(matches, total, maxBytes) {
	const files = groupMatches(matches).map((group) => ({ path: group.path, matches: group.matches.map((match) => ({ lineNumber: match.lineNumber, line: match.line })) }));
	return capMeta({ shape: 'matches', files, truncated: total > matches.length, total }, maxBytes);
}

/** The model-facing `glob` page, with the recovery path for a capped result. */
export function renderGlob(paths, total, locator) {
	if (paths.length === 0) return 'No files found';
	if (total <= paths.length) return paths.join('\n');
	const recovery = locator === undefined
		? 'The complete result could not be saved; narrow pattern or path to see more.'
		: `Full sorted result stored at: ${locator}. Read it to see the rest.`;
	return `${paths.join('\n')}\n\n(Showing ${paths.length} of ${total} paths. ${recovery})`;
}

/** The model-facing `grep` page, with the recovery path for a capped result. */
export function renderGrep(matches, total, locator) {
	if (total === 0) return 'No matches found';
	const header = total > matches.length ? `Found ${matches.length} of ${total} matches` : `Found ${total} ${total === 1 ? 'match' : 'matches'}`;
	const body = groupMatches(matches).map((group) => `${group.path}\n${group.matches.map((match) => `Line ${match.lineNumber}: ${match.line}`).join('\n')}`).join('\n\n');
	if (total <= matches.length) return `${header}\n\n${body}`;
	const recovery = locator === undefined
		? 'The complete result could not be saved; narrow pattern, path, or include to see more.'
		: `Full grep result stored at: ${locator}. Read it to see the rest.`;
	return `${header}\n\n${body}\n\n(${recovery})`;
}
