/**
 * WSL shell executor for DeepSeek Harness on Windows.
 *
 * Registers `ctx.shell` as a `wsl.exe`-backed twin of `@deepseek-ai/dsh-bash-local`,
 * so every model-facing command runs as a fresh login bash inside a WSL
 * distribution. The process mechanics — bounded spill-backed output, the
 * SIGTERM→SIGKILL grace period, deadline fusion, and background reads — are
 * inherited unchanged; only the shell argv, the spawn working directory, and
 * the guest environment differ.
 *
 * Every path is a Linux path: the workspace registry stores what the guest's
 * own `realpath` returns, the file tools act on those paths inside the
 * distribution, and this executor hands the session cwd to `wsl.exe --cd`
 * unchanged. A path that still arrives in a Windows spelling (an older session,
 * or a directory chosen outside the picker) is translated first, because WSL
 * already addresses Windows drives as `/mnt/<drive>/...`.
 *
 * Commands run without the Windows ACL sandbox: a Linux process inside WSL
 * cannot be confined by a restricted token, so `sandboxMode` stays undefined and
 * the `bash` tool advertises no escalation fields. File writes made through the
 * Harness' own filesystem tools remain governed by `ctx.fs`.
 * @module @local/dsh-wsl-bridge
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import z from '@deepseek-ai/schemastery';
import { LocalBashExecutor } from '@deepseek-ai/dsh-bash-local';
import { buildWslenv, isWindowsAbsolute, resolveWslExecutable, toLinuxPath } from './wsl.js';

/** Cordis plugin name. */
const name = 'wsl-bash';
/**
 * The subprocess seam supplies the managed-range mechanics this executor spawns
 * through; the sandbox policy supplies the mode the composition reports; the
 * prompt registry carries the unconfined disclosure the model reads.
 */
const inject = ['subprocess', 'sandboxPolicy', 'systemPrompt'];
/** Default per-stream spill cap, mirroring `@deepseek-ai/dsh-bash-local`. */
const DEFAULT_MAX_SPILL_BYTES = 64 * 1024 * 1024;
/** Default SIGTERM→SIGKILL grace period, mirroring `@deepseek-ai/dsh-bash-local`. */
const DEFAULT_GRACE_MS = 3e3;
/** Guest directory the per-command script files are written to. */
const DEFAULT_SCRIPT_DIR = '/tmp';
/**
 * Runtime configuration: `@deepseek-ai/dsh-bash-local`'s budgets verbatim plus
 * the WSL-shaped knobs. Budgets stay volatile so the Plugins page can retune
 * them live; the WSL knobs are read at spawn and need a reload to change.
 */
const Config = z.object({
	distro: z.string().default('').description('WSL distribution to run in; empty uses the WSL default distribution.'),
	wslPath: z.string().default('').description('Absolute path of wsl.exe; empty resolves %SystemRoot%\\System32\\wsl.exe.'),
	loginShell: z.boolean().default(true).description('Start bash as a login shell (-l), so /etc/profile and ~/.profile set up the guest PATH.'),
	rcFile: z.string().default('~/.bashrc').description("Guest rc file sourced before every command, the way an interactive shell would; empty disables it. A leading ~/ is expanded against the guest's $HOME."),
	defaultWorkdir: z.string().default('').description('Linux working directory used when the session workspace cannot be translated; empty leaves the choice to WSL.'),
	scriptDir: z.string().default(DEFAULT_SCRIPT_DIR).description('Guest directory holding the per-command script file (for example /tmp).'),
	cwd: z.string().volatile(),
	timeoutMs: z.number().default(12e4).volatile(),
	maxTimeoutMs: z.number().default(6e5).volatile(),
	maxOutputBytes: z.number().default(64e3).volatile(),
	maxSpillBytes: z.number().default(DEFAULT_MAX_SPILL_BYTES).volatile(),
	graceMs: z.number().default(DEFAULT_GRACE_MS).volatile()
});
/**
 * Bash executor whose every command is one `wsl.exe` invocation.
 *
 * It inherits `resolve()`, `executeArgv()`, and the whole settlement path from
 * `@deepseek-ai/dsh-bash-local`; only `execute` (the script file and the argv)
 * and `spawnSpec` (the working directory and the forwarded guest environment)
 * are replaced.
 */
class WslBashExecutor extends LocalBashExecutor {
	static inject = ['subprocess', 'sandboxPolicy', 'systemPrompt'];
	static Config = Config;
	constructor(ctx, config) {
		super(ctx, config);
		this.mode = ctx.sandboxPolicy.defaultMode;
		this.defaultDistro = undefined;
		this.scriptCounter = 0;
	}
	/**
	 * The mode every consumer reads as this environment's own default: the
	 * deployment sandbox policy's mode, which is exactly what the shipped
	 * sandboxed executors report. Reporting it keeps the composition
	 * indistinguishable from a stock Windows host — the permission presets
	 * compose instead of refusing, their derived default preset is the same one
	 * the stock host derives, and the `bash` tool advertises the same escalation
	 * surface.
	 *
	 * Commands are still not confined: a Linux process inside WSL cannot be
	 * constrained by the Windows restricted-token sandbox, and this executor
	 * never consults `spec.sandboxPolicy`. The model is told so by the prompt
	 * section {@link apply} registers, and the README states the same limit.
	 * @returns the deployment policy's default mode.
	 */
	get sandboxMode() {
		return this.mode;
	}
	/** The configured distribution, or an empty string for WSL's own default. */
	get distro() {
		return typeof this.config.distro === 'string' ? this.config.distro : '';
	}
	/**
	 * The distribution this executor talks to: the configured one, else the
	 * account's default sampled once per process. A script file needs a concrete
	 * owner, because the share path that carries it names the distribution.
	 * @returns the distribution name, or an empty string when none could be read.
	 */
	resolveDistro() {
		const configured = this.distro;
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
	/**
	 * The Linux working directory for one command: the session workspace
	 * translated into the guest, else the configured fallback.
	 * @param spec - the resolved execution spec.
	 * @returns the absolute Linux path, or undefined to let WSL choose.
	 */
	linuxWorkdir(spec) {
		const translated = toLinuxPath(spec.workdir, this.distro);
		if (translated !== undefined) return translated;
		return typeof this.config.defaultWorkdir === 'string' && this.config.defaultWorkdir.length > 0 ? this.config.defaultWorkdir : undefined;
	}
	/**
	 * Shell prologue that loads the guest's rc file even though this shell is not
	 * interactive.
	 *
	 * A login shell reads `/etc/profile` and `~/.profile`, and Ubuntu's
	 * `~/.profile` sources `~/.bashrc` — but `~/.bashrc` opens with
	 * `case $- in *i*) ;; *) return;; esac`, so on a non-interactive shell that
	 * source returns before the first export, alias, or function. The command
	 * therefore never sees what the user's interactive shell sees.
	 *
	 * Sourcing the file here, with `return` temporarily shadowed by a no-op
	 * function, applies the whole file while the shell stays non-interactive:
	 * `$-` keeps its real value, the signal and exit-code mechanics are
	 * untouched, and `expand_aliases` is switched on so the aliases the file
	 * defines actually expand in the script. A `~` path is expanded by the guest.
	 * @returns the prologue text, or an empty string when `rcFile` is empty.
	 */
	rcPrologue() {
		const rc = typeof this.config.rcFile === 'string' ? this.config.rcFile.trim() : '';
		if (rc === '') return '';
		let target;
		if (rc === '~') target = '"$HOME"';
		else if (rc.startsWith('~/')) target = `"$HOME/${rc.slice(2)}"`;
		else target = `'${rc.replace(/'/gu, "'\\''")}'`;
		return [
			'# dsh wsl-bridge: load the guest rc file into this non-interactive shell.',
			`if [ -f ${target} ]; then`,
			'\tshopt -s expand_aliases',
			'\treturn() { :; }',
			`\t. ${target}`,
			'\tunset -f return',
			'fi',
			''
		].join('\n');
	}
	/**
	 * The complete script handed to the guest shell: the rc prologue, then the
	 * command verbatim. Both travel in the same byte-exact place.
	 * @param spec - the resolved execution spec.
	 * @returns the script text.
	 */
	scriptBody(spec) {
		return `${this.rcPrologue()}${spec.command}`;
	}
	/**
	 * Write the command as a guest-side script file and describe the argv that
	 * runs it.
	 *
	 * The command must never travel through the Windows command line: that round
	 * trip strips quoting, so `"` collapses, and it substitutes `$NAME` from the
	 * environment before bash ever sees the text — silently breaking shell
	 * variables, `$?`, awk fields, and every `sed` script. Writing the text
	 * verbatim through the guest's UNC share, then running the file, keeps every
	 * byte intact and leaves the command's own stdin free.
	 * @param spec - the resolved execution spec.
	 * @returns the argv plus the host path to delete afterwards, or undefined when the guest filesystem is unreachable.
	 */
	scriptInvocation(spec) {
		const distro = this.resolveDistro();
		if (distro === '') return undefined;
		this.scriptCounter += 1;
		const guestScript = `${this.config.scriptDir.replace(/\/+$/u, '')}/dsh-wsl-${process.pid}-${this.scriptCounter}-${Date.now().toString(36)}.sh`;
		const argv = [resolveWslExecutable(this.config.wslPath), '-d', distro];
		const workdir = this.linuxWorkdir(spec);
		if (workdir !== undefined) argv.push('--cd', workdir);
		argv.push('--', 'bash');
		if (this.config.loginShell !== false) argv.push('-l');
		argv.push(guestScript);
		return { argv, guestScript };
	}
	/**
	 * Write the script to the guest script file **from inside the guest**.
	 *
	 * The obvious route — writing the file through the `\\wsl.localhost` share —
	 * was observed to lose the file intermittently: the same command then died
	 * with `bash: /tmp/dsh-wsl-….sh: No such file or directory` even though an
	 * independent probe writing the same way succeeded twelve times in a row.
	 * Putting the script on `cat`'s stdin instead removes the Windows→guest hop
	 * entirely: the guest writes the file it is about to run, so the bytes can
	 * never be racing a share that has not caught up.
	 * @param guestScript - the absolute guest path to create.
	 * @param body - the script text, byte-exact on stdin.
	 * @param signal - the execution's cancellation signal.
	 * @returns true when the guest confirmed the write.
	 */
	async putScript(guestScript, body, signal) {
		const distro = this.resolveDistro();
		const argv = [resolveWslExecutable(this.config.wslPath)];
		if (distro !== '') argv.push('-d', distro);
		argv.push('--', 'bash', '-l', '-c', `cat > ${guestScript}`);
		return await new Promise((resolve) => {
			const child = spawn(argv[0], argv.slice(1), { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true });
			let settled = false;
			const finish = (value) => {
				if (settled) return;
				settled = true;
				signal?.removeEventListener('abort', onAbort);
				resolve(value);
			};
			const onAbort = () => finish(false);
			signal?.addEventListener('abort', onAbort, { once: true });
			child.on('error', () => finish(false));
			child.on('close', (code) => finish(code === 0));
			child.stdin.on('error', () => {});
			child.stdin.end(`# dsh wsl-bridge\n${body}\n`);
		});
	}
	/** Remove a spent script file; fire-and-forget, so it never delays a command. */
	dropScript(guestScript) {
		const distro = this.resolveDistro();
		const argv = [resolveWslExecutable(this.config.wslPath)];
		if (distro !== '') argv.push('-d', distro);
		argv.push('--', 'bash', '-l', '-c', `rm -f ${guestScript}`);
		try {
			const child = spawn(argv[0], argv.slice(1), { stdio: 'ignore', windowsHide: true });
			child.on('error', () => {});
		} catch {
			/* a leftover script file is harmless */
		}
	}
	/**
	 * The argv that carries the command inline — the degraded path, taken only
	 * when the guest filesystem cannot be written, where quoting and `$NAME`
	 * substitution are back in play.
	 * @param spec - the resolved execution spec.
	 * @param body - the script body, rc prologue included.
	 * @returns the argv to spawn.
	 */
	inlineArgv(spec, body) {
		const argv = [resolveWslExecutable(this.config.wslPath)];
		const distro = this.distro;
		if (distro !== '') argv.push('-d', distro);
		const workdir = this.linuxWorkdir(spec);
		if (workdir !== undefined) argv.push('--cd', workdir);
		argv.push('--', 'bash', this.config.loginShell === false ? '-c' : '-lc', body);
		return argv;
	}
	async execute(spec) {
		const body = this.scriptBody(spec);
		const invocation = this.scriptInvocation(spec);
		if (invocation === undefined) return this.executeArgv(spec, this.inlineArgv(spec, body));
		const written = await this.putScript(invocation.guestScript, body, spec.signal);
		if (written === false) return this.executeArgv(spec, this.inlineArgv(spec, body));
		const proc = await this.executeArgv(spec, invocation.argv);
		const drop = () => this.dropScript(invocation.guestScript);
		proc.done.then(drop, drop);
		return proc;
	}
	/**
	 * The Windows directory `wsl.exe` itself starts in. Any Windows-absolute
	 * workspace is usable, including a `\\wsl.localhost\...` UNC path — WSL then
	 * translates it as an independent fallback for `--cd`. A workspace we cannot
	 * express on Windows leaves the harness directory as the spawn cwd, which is
	 * harmless because `--cd` already pinned the guest directory.
	 * @param workdir - the resolved spec's working directory.
	 * @returns an existing Windows directory to spawn in.
	 */
	spawnCwd(workdir) {
		return isWindowsAbsolute(workdir) && existsSync(workdir) ? workdir : process.cwd();
	}
	/**
	 * Layer the `WSLENV` bridge over the inherited spawn spec. WSL shares no
	 * ambient Windows variable with the guest, so the trusted `DSH_*` snapshot
	 * and the model-friendly terminal overrides only arrive when `WSLENV` names
	 * them; path-valued names get WSL's `/p` translation.
	 */
	spawnSpec(spec, argv, stdoutMaxBytes, signal) {
		const base = super.spawnSpec(spec, argv, stdoutMaxBytes, signal);
		const env = {
			...base.env,
			WSLENV: buildWslenv(base.env, process.env.WSLENV)
		};
		return {
			...base,
			cwd: this.spawnCwd(spec.workdir),
			env
		};
	}
}
/**
 * Load the WSL bash executor as `ctx.shell`.
 * @param ctx - Cordis context that owns the service.
 * @param config - the row's resolved configuration.
 */
function apply(ctx, config) {
	new WslBashExecutor(ctx, config);
	ctx.systemPrompt.section({
		name: 'tool:bash/wsl-unconfined',
		order: ctx.systemPrompt.getSectionOrder('TOOL_BASH'),
		text: 'The shell executor runs commands inside WSL and never confines them: in every permission mode a command has the guest user\'s own file authority, so treat shell file effects as unconfined. Every path here is a Linux path — the session working directory, the workspace, and every path the file tools report are the same absolute Linux paths (`/home/...`), with no Windows spelling to translate. The session\'s permission mode still governs the Harness\' own file tools (`read`, `write`, `edit`, `glob`, `grep`).'
	});
}

export { Config, WslBashExecutor, apply, inject, name };
