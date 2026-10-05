/**
 * One guest-shell call, shared by every part of the bridge that needs an answer
 * from inside the distribution (the workspace registry and the directory
 * browser).
 *
 * The script travels on **stdin**, never in `argv`: a Windows command line
 * strips quoting and substitutes `$NAME` from the host environment before bash
 * ever sees the text, which silently breaks variables, `$?`, awk fields, and
 * every `sed` script. stdin is byte-exact in both directions.
 * @module @local/dsh-wsl-bridge/guest
 */
import { spawn, spawnSync } from 'node:child_process';
import { resolveWslExecutable } from './wsl.js';

/** Deadline for one guest call when the caller does not choose one. */
export const DEFAULT_GUEST_TIMEOUT_MS = 120000;
/** Byte bound on one call's combined output, so a runaway guest command cannot grow the host heap. */
export const DEFAULT_GUEST_MAX_BYTES = 8 * 1024 * 1024;

/**
 * Quote one string for a POSIX shell as a single-quoted word.
 * @param value - the raw string; `$`, backticks, and quotes all become literal.
 * @returns a word safe to interpolate into a script.
 */
export function shellQuote(value) {
	return `'${String(value).replace(/'/gu, `'\\''`)}'`;
}

/**
 * Run one bash script inside the guest.
 * @param options - wslPath, distro, timeoutMs, maxOutputBytes.
 * @param script - the bash body; it is written to `bash -l` on stdin and closed.
 * @param signal - the caller's lifetime; aborting kills the child.
 * @returns the exit code and the collected stdout/stderr buffers.
 */
export function guestRun(options, script, signal) {
	const timeoutMs = typeof options.timeoutMs === 'number' && options.timeoutMs > 0 ? options.timeoutMs : DEFAULT_GUEST_TIMEOUT_MS;
	const maxBytes = typeof options.maxOutputBytes === 'number' && options.maxOutputBytes > 0 ? options.maxOutputBytes : DEFAULT_GUEST_MAX_BYTES;
	return new Promise((resolve, reject) => {
		const distro = typeof options.distro === 'string' ? options.distro : '';
		const argv = [resolveWslExecutable(options.wslPath)];
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
		const onAbort = () => finish(reject, signal.reason ?? new Error('guest call aborted'));
		const timer = setTimeout(() => finish(reject, new Error(`guest call timed out after ${timeoutMs}ms`)), timeoutMs);
		if (signal?.aborted === true) {
			finish(reject, signal.reason ?? new Error('guest call aborted'));
			return;
		}
		signal?.addEventListener('abort', onAbort, { once: true });
		for (const [stream, sink] of [[child.stdout, out], [child.stderr, err]]) {
			stream.on('data', (chunk) => {
				size += chunk.length;
				if (size > maxBytes) {
					finish(reject, new Error('guest call produced more output than the byte bound'));
					return;
				}
				sink.push(chunk);
			});
		}
		child.on('error', (error) => finish(reject, error));
		child.on('close', (code) => finish(resolve, { code, stdout: Buffer.concat(out), stderr: Buffer.concat(err) }));
		child.stdin.on('error', () => {});
		child.stdin.end(`${script}\n`);
	});
}

/**
 * The distribution the bridge talks to when the row does not name one: the
 * launcher's own default, i.e. the first distribution `wsl.exe -l -q` reports.
 * @param wslPath - configured `wsl.exe` path; empty resolves the System32 one.
 * @returns the distribution name, or an empty string when none could be sampled.
 */
export function resolveDefaultDistro(wslPath) {
	try {
		const probed = spawnSync(resolveWslExecutable(wslPath), ['-l', '-q'], { timeout: 10000, windowsHide: true });
		const line = String(probed.stdout ?? '')
			.replace(/\0/gu, '')
			.split(/\r?\n/u)
			.map((entry) => entry.trim())
			.filter((entry) => entry.length > 0)[0];
		return typeof line === 'string' ? line : '';
	} catch {
		return '';
	}
}
