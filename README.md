# dsh-wsl-bridge

让 Windows 上的 DeepSeek Harness 把 WSL 里的 Linux 当作**自己的工作环境**，而不是把 Linux 当成一个外部目标：

* 工作区就是 Linux 目录（`/home/you/project`），GUI 里从 `/` 开始浏览；
* 模型执行的是 **bash**（跑在 WSL 发行版里），没有 pwsh；
* `read` / `write` / `edit` / `glob` / `grep` 的 I/O **全部在 WSL 内部完成**，不走 `\\wsl.localhost` 9P 共享；
* 模型看到的路径**只有 Linux 路径**——会话工作目录、工作区路径、文件工具返回的路径，全是 `/...`。

本插件是一个 bundle（`@local/dsh-wsl-bridge`），通过自己的 `cordis.patch.yml` 关掉随 Harness 发布的对应实现，再插入下面几个行。

## 插件的行

| 行 id | 模块 | 作用 |
| --- | --- | --- |
| `wsl-bash` | `index.js` | 用 `wsl.exe` 驱动的 bash 执行器，取代 `dsh-bash-local` / pwsh |
| `wsl-fs` | `fs.js` | Linux 原生的 `ctx.fs`：所有文件操作在 guest 内执行 |
| `wsl-workspace` | `workspace.js` | Linux 原生的 `ctx.workspaceRegistry`：工作区路径就是 Linux 路径 |
| `wsl-directory-picker` | `picker.js` | 从 `/` 开始浏览 guest 文件系统的目录选择器 |
| `wsl-directory-picker-browse-surface` | （上游模块） | 选择器的界面 |

`probe.js` 仍然随 bundle 发布（导入预检 + 可选端到端自检），但**默认不再挂行**——它已经完成了自己的使命。需要时用一行补丁就能挂回来：

```yaml
- id: wsl-probe
  name: '@local/dsh-wsl-bridge/probe'
  config:
    selfCheck: true
    selfCheckRoot: /tmp
```

被关掉的行：`pwsh-sandbox`、`tool-pwsh`、`fs-sandbox`、`workspace`、`directory-picker`；`tool-bash` 打开。`preset-standard` / `preset-ptc` 两个 preset 也被整体覆写，把 `tool-pwsh` 关掉、`tool-bash` 打开。

## 一条命令是怎么跑的

1. Harness 把命令文本交给执行器。
2. 执行器把它写进 `bash -l` 的 **stdin**，由 `wsl.exe [-d 发行版] --cd <Linux 工作目录> -- bash -l` 在 guest 内执行。

命令文本**绝不走 argv**：Windows 命令行往返会剥掉引号，并且会先用宿主环境**替换 `$NAME`**——`x=1; echo $x` 会输出空、`sed -n '2p'` 会报语法错。stdin 是逐字节无损的。输出、超时、后台任务、临时文件溢出等机制继承自 `dsh-bash-local`。

命令不做 Windows ACL 沙箱限制（WSL 里的进程无法被受限令牌约束），这一点通过一个系统提示词小节如实告知模型；Harness 自己的文件工具仍然受 `ctx.fs` 的写策略约束。

## 命令会加载 `~/.bashrc`

`bash -l` 启动的是**非交互**的登录 shell：它读 `/etc/profile` 和 `~/.profile`，Ubuntu 的 `~/.profile` 也确实会 `. ~/.bashrc`——但 `~/.bashrc` 开头就是

```sh
case $- in
    *i*) ;;
      *) return;;
esac
```

非交互 shell 在这里直接 `return`，后面的 `export`、`alias`、函数一个都不会生效。所以执行器在命令脚本最前面插一段序言：临时把 `return` 换成一个空函数，再 `. ~/.bashrc`，读完 `unset -f return` 恢复；同时 `shopt -s expand_aliases`，让 `~/.bashrc` 里定义的别名在命令里真正展开。

这样 shell 仍然是非交互的：`$-` 不变，信号、超时、退出码机制不变，不会打印提示符或作业控制消息。`rcFile` 默认 `~/.bashrc`（相对 guest 的 `$HOME`），设为空字符串即关闭，也可以填 guest 里的任意路径。

不使用交互模式（`bash -i`）是有意的：交互 shell 会忽略 `SIGTERM`，取消命令必须靠 `SIGKILL`，而且会往 stderr 打作业控制告警——两者都会破坏执行器已有的取消/超时语义。`/etc/bash.bashrc` 同样只服务交互 shell，本插件不读它。

## 文件 I/O 为什么放在 guest 内

`/mnt/*` 是 9P 共享（drvfs）。本次机器上实测 500 次建文件：ext4 15 ms vs drvfs 659 ms（约 44 倍）；单次 `stat` 的差距被进程启动成本掩盖（402 ms vs 653 ms，约 1.6 倍），真正的量级差距在建/写/重命名上。另外随 Harness 发布的 `dsh-fs-local` 用**硬链接**发布写入，9P 不支持（`ENOTSUP`），写文件会直接失败。所以 `wsl-fs` 把每个操作都交给 guest：

* `stat` / `lstat`：`stat -c '%f|%Y|%s'`，文件类型从**原始 `st_mode`** 解码——`%F` 会被本地化（中文环境返回 `普通文件`），`stat` 也没有单字母类型的占位符；
* 列目录：`find -printf '%y|%s|%f\n'`，类型字母在前、名字在后，名字里含 `|` 也不会解析错；
* 读：`cat` / `tail -c +N | head -c L`；
* 写：内容 base64 编码后由 guest 解码写入临时文件，再 `mv -f` **原子替换**（ext4 rename）。用 base64 而不是 heredoc，是因为 heredoc 会给没有结尾换行的内容补一个换行，而且内容里可能出现终止符行；
* 版本号 = `mtime:size`，`write`/`edit` 的 `createIfAbsent` / `replaceIfVersion` 语义照常工作；
* 写策略（`read-only` / `workspace-write`）在 `fence()` 里按 guest 路径判定，报错文本与随 Harness 发布的实现一致。

这些脚本集中在 `fsproto.js`（不依赖任何 `@deepseek-ai/*`），所以可以脱离 Harness 直接对真实发行版跑测试。它们已经抓出过三个真 bug：`%F` 被本地化、heredoc 多变一个换行、`stat` 的 `%y` 其实是“修改时间”而不是类型字母。

`glob` / `grep` 已经改成 guest 原生（见下节），不再经过宿主进程，所以 `processPath()` 是本 bundle 里**唯一**保留的宿主拼写，只给宿主工具（预览、ripgrep 之类的 Windows 消费者）用。

## 文件路径的四种拼写

`ctx.fs.resolve()` 把送进来的每一个绝对路径都交给 `toLinuxPath()` 翻译一次，所以下面四种拼写都落在同一个 guest 目标上：

| 拼写 | 谁在用 |
| --- | --- |
| `/mnt/c/Users/x/a.js` | 模型、会话 cwd、文件工具、工作区注册表 |
| `C:\Users\x\a.js` | 老会话记住的 Windows 目录；`/mnt/c/...` 的宿主拼写（`processPath()` 现在对 drvfs 路径返回它） |
| `\\wsl.localhost\Ubuntu\home\you\a.js` | guest 自己 filesystem（ext4）上路径的宿主拼写；WSL 共享对它是可读的 |
| `\\wsl.localhost\Ubuntu\mnt\c\...` | 旧版 `processPath()` 对 drvfs 的拼写，**Windows shell 打不开**（见下）；`resolve()` 仍接受并翻回 `/mnt/c/...` |
| `//wsl.localhost/Ubuntu/mnt/c/...` | **资源地址往返**：`dsh-resource://file/session/<id>/<path>` 会把 `\` 归一成 `/`，Host 再把它当文件路径收到 |

最后一种是 0.3.9 修的 bug：它虽然以 `/` 开头，但不是 guest 路径——旧版 `resolve()` 直接把它当 POSIX 路径接受，`posix.normalize()` 又把 UNC 的 authority 折叠掉，变成 guest 里不存在的 `/wsl.localhost/...`，于是**所有经过资源地址打开的文件**（Sidebar 文件树、文档预览、`@file` 引用、聊天里的文件链接）都报 `not found`。而 `\\wsl.localhost\...` 拼写碰巧能被 `toLinuxPath()` 认出来，所以表现为「同一个文件，有时能打开、有时不能」。现在两种 UNC 拼写都翻译成 guest 路径，`//` 开头的非 WSL 网络共享仍按原样当 POSIX 路径处理。

0.3.10 修的是反方向的第二个 bug：**`processPath()` 曾把每个 guest 路径都映射到 `\\wsl.localhost\<d>\...`**，但 `/mnt/<盘>` 是 drvfs（guest 里的 Windows 盘），WSL 的 9P 共享**服务不了 drvfs 挂载**——对共享下的 drvfs 路径，`File.Exists` 为 false、`SHCreateItemFromParsingName` 直接 `E_ACCESSDENIED`。于是文档预览能渲染（走 guest 读），但右上角「用记事本打开 / 在文件夹中显示 / 默认应用打开」全部在 Windows shell 里失败，而且没有任何提示能指出路径拼写不对。现在 `/mnt/<盘>` 的宿主拼写是盘符本身（`C:\Users\...`），ext4 路径仍是 UNC；Host 侧的 `processPathFromHostPath` → `processPath` 往返对两种拼写都成立，所以会话控制器的「已验证宿主路径」检查也放行。顺带修好了 Markdown 预览里引用 `C:` 工作区图片的 `api/file?path=` 加载。

## 工作区路径为什么必须是 Linux 路径

随 Harness 发布的 `dsh-workspace` 用**宿主的** `node:fs.realpath` + `stat` 规范化工作区路径。在 Windows 上 `/home/you` 会被解析成 `D:\home\you`，于是只有 `\\wsl.localhost\...` 这样的拼写能存下来——随之而来的就是把 UNC 路径塞进会话 cwd、塞进系统提示词、塞进模型写的每条命令。

`wsl-workspace` 继承同一个注册表，只替换四处碰文件系统的地方：

* `create` / `initializeDefault` / `resolveByPath`：在 **guest 内** `realpath` 并确认是目录；
* `indexHeader`：用 guest 拼写建立 cwd 索引；
* 注册表返回的实体被包一层，`attachSession` 用 guest 路径校验、`status` 问 guest 目录还在不在。

持久化、排序、置顶、归档、会话索引全部继承。实体用 `Object.create(base)` 包装（基类没有私有字段，所以包装对象等价）。**默认导出必须是类本身**：Cordis 只在“构造函数分支”才调用 `[Service.init]`，用 `apply()` 包一层会让 domain 永远打不开，第一个读取者就报 `workspace registry is not started yet`。

## 目录选择器

`picker.js` 完全替换 `list` / `createDirectory`，返回的一律是 Linux 路径；根是 guest 的 `/`，默认落在 guest 的 `$HOME`，不给任何 Windows 盘符入口。客户端如果送进来一个 Windows 拼写（老会话记得的旧目录），会先被翻译成 `/mnt/<盘>/...`。

## glob / grep：guest 原生实现

随 Harness 发布的 `@deepseek-ai/dsh-tool-fs-search` 通过 `ctx.subprocess` 启动它自己打包的 **Windows ripgrep**，子进程在宿主上跑。后果是它打印的永远是 Windows 拼写（工作区内是 `tmp\a.txt`），spill 落点也写成 `C:\Users\...\AppData\Local\Temp\dsh-spill-...` —— 模型把结果贴回 `read` 只会得到 `not found`。改写参数（早期的 `searchpaths.js` 把绝对 `path` 改写成相对路径）只能让 ripgrep 找得到文件，改不了它打印的分隔符。所以本 bundle 直接**接管这两个工具**：预设里把 `tool-fs-search` 标成 `disabled: true`，再挂上 `@local/dsh-wsl-bridge/search`。

* `glob`（`search-core.js` 的 `globScript`）：在 guest 里用 bash `globstar` 展开（`nullglob dotglob globstar`），`stat -c %Y` 记录 mtime 后按修改时间排序，`case` 剔除 `.git` / `.svn` / `.hg` / `.bzr` / `.jj` / `.sl`，默认最多 100 条。
* `grep`（`grepScript`）：在 guest 里用 GNU `grep -E`；先 `-r -l -Z` 列匹配文件（二进制只跳过一次），再逐文件 `-n` 取行号；**文件名后用 NUL 而不是 `:` 分隔**，所以 Linux 文件名里带 `:` 也不会解析错；默认跳过隐藏文件/目录与 VCS 目录（与 ripgrep 默认一致），`include` 支持 `{a,b}` 展开。注意 GNU grep 的一个坑：`--include` 必须写在任何 `--exclude` **之前**，否则会被静默忽略。
* 两者输出**只有 Linux 路径**：工作区内给相对路径、工作区外给绝对路径，全部是 `/`；T6 要求「结果必须是相对路径或 Linux 绝对路径且能直接回喂 `read`」因此是结构性成立的，而不是靠字符串修补。
* 上限（100 / 250）之外的完整结果仍然尝试交给 `ctx.spillStore`，但落点会先翻译成 Linux 拼写（`C:\Users\...` → `/mnt/c/Users/...`）；没有 spill 后端时只写一行提示，任何情况下都不会把 Windows 路径写进模型可见文本。
* 与上游保持一致的契约：工具名、参数 schema 与描述、`{root, paths}` / `{matches}` 输出形状、卡片 `presentationMeta`、`No files found` / `No matches found` 文案、`include` 的三条校验文案。

**与 ripgrep 的语义差异**（已在描述里写明）：正则是 POSIX ERE（不是 Rust regex，`\d` 之类不支持）；`.gitignore` 不生效，只按固定 VCS 目录名排除；`include` 的 `!` 取反不支持。

## 宿主侧的影子目录（mirror）

两个随 Harness 发布的插件仍然用宿主 `node:fs` 读会话 cwd：`agent-instructions`（找 `AGENTS.md`）和 `file-reference-local`（`@file` 补全）。Windows 上以 `/` 开头的路径按**进程当前盘**解析，所以它们会把 `/home/you/project` 变成 `D:\home\you\project`。

第三个是 session controller 自己：新建会话时会 `mkdir(cwd, { recursive: true })`，用的是宿主 `node:fs`。

`mirror.js` 让这两种宿主拼写都真实存在：

* guest 自身文件系统上的目录（`/home`、`/root` …）：建**目录符号链接** `<盘>:\<一级目录>` → `\\wsl.localhost\<发行版>\<一级目录>`（junction 不行：Windows 要求 junction 指向本地卷；符号链接可以，但需要开发者模式或管理员权限）。
* `/mnt/<盘>/...`：这**就是** Windows 的 `<盘>:`（drvfs 挂载）。WSL 的 9P 共享在 drvfs 下会回 `EPERM`，所以不能沿用上面的做法；改成建真实目录 `<盘>:\mnt`，再在里面建目录符号链接 `<盘>:\mnt\<盘>` → `<盘>:\`。于是 `C:\mnt\d\tmp` 落到真正的 `D:\tmp`，与 guest 看到的 `/mnt/d/tmp` 是同一个目录。这就是「新建 `/mnt/d/...` 工作区时报 `EPERM: operation not permitted, mkdir 'C:\mnt\d\tmp'`」的修复：宿主 `mkdir -p` 现在只是命中已存在的真实目录。
* 早期版本留在 `<盘>:\mnt` 上的那条 UNC 符号链接会被替换成真实目录（它指向的共享本来就服务不了 drvfs）。

宿主侧的 `node:fs` 于是能读到真正的 guest 文件，而模型、shell、文件工具看到的仍然是同一个 Linux 路径。影子是宿主侧的兼容层，不在模型路径上；创建失败只会让上面那三个功能失效，不影响其它部分。想彻底清掉，删掉 `<盘>:\<一级目录名>`（例如 `D:\home`）与 `<盘>:\mnt\<盘>` 这些符号链接即可。

## 配置

`cordis.patch.yml` 里每个行都有 `distro`（空 = WSL 默认发行版）、`wslPath`（空 = `%SystemRoot%\System32\wsl.exe`）与 `timeoutMs`；执行器另有 `loginShell`、`rcFile`（默认 `~/.bashrc`，空字符串关闭）和输出/超时预算，文件系统有 `cwd` 与 `watchIntervalMs`（轮询间隔，WSL 没有宿主可订阅的 inotify 流）。

## 验证

```bash
# 协议级：真实的 bash 脚本 + 真实的解析器（不需要 Harness 运行）
ELECTRON_RUN_AS_NODE=1 "<Electron>" ".dsh-plugdev/tools/wsl-bridge-pretest-fsproto.mjs"
# 纯函数级：路径翻译、引号、选择器列表脚本、影子链接（含 drvfs 盘符映射）
ELECTRON_RUN_AS_NODE=1 "<Electron>" ".dsh-plugdev/tools/wsl-bridge-pretest-standalone.mjs"
# guest 原生搜索：真实的 bash glob/grep 脚本 + 解析 + 渲染 + 路径回读
node ".dsh-plugdev/tools/wsl-bridge-pretest-search.mjs"
```

端到端自检（会在 guest 的 `/tmp` 下建夹具、注册一个 Linux 工作区，并打印一行 JSON）：

```yaml
- id: wsl-probe
  config:
    selfCheck: true
    selfCheckRoot: /tmp
```

自检覆盖 `ctx.fs` 的写/读/列目录/`processPath`、`ctx.workspaceRegistry` 的 `create`/`resolveByPath`/`status`/`list`、`ctx.directoryPicker` 的 `list`/`createDirectory`，以及 `glob` / `grep` 这两个真实注册的工具定义（执行 + 渲染，并检查模型可见文本里没有 `\` / 盘符、每条路径都能被 `ctx.fs` 读回）。结果以一行 JSON 打进日志与 stdout。它只在按上面的补丁挂上 `wsl-probe` 行时才会运行。

## 已知限制

* **shell 不受限**：命令拥有 guest 用户自己的文件权限，任何权限模式下都一样。
* **老会话的 cwd 仍是 Windows 拼写**：会话头部里存的是创建时的 cwd。老会话照常能跑（执行器会把 `D:\...` 翻成 `/mnt/d/...`），但它的归档分组和提示词里的 cwd 仍是旧拼写；新建会话就是纯 Linux。
* 事件监听是轮询实现，每个 watcher 一个定时器、一次 `wsl.exe` 调用。
* `defaultWorkspaceId` 指向已删除的记录时，随 Harness 发布的注册表会永远短路返回 `undefined`。`wsl-workspace` 在 `[Service.init]` 会清掉这种悬空 id（内存与磁盘一起），所以它不会再累积；但历史非空（存在归档会话或旧会话）时自动建默认工作区本来就不符合条件，工作区请在界面上手动添加。

## 回滚

把 `~/.dsh/profiles/<profile>/package.json` 里本 bundle 的依赖和 `dsh.profile.bundles` 里的 `@local/dsh-wsl-bridge` 去掉，重新 `pnpm install` 即可；本 bundle 自己的 `cordis.patch.yml` 会随之失效。已经建好的 Linux 工作区记录仍然留在 `~/.dsh/storages/workspace.json` 里（路径是 Linux 路径，随 Harness 发布的注册表读不了它们），需要的话手动删掉。

## 更新本 bundle

源码改动后必须让 **manifest / lockfile / node_modules 三者一致**，否则下一次 `pnpm install` 会静默退回旧版本：

```bash
cd dsh-wsl-bridge && node <pnpm-bin> pack --pack-destination <dist>   # 先改 package.json 的 version
# 把 profile 的 package.json 依赖指向新的 tgz，然后
pnpm install
```

注意：从 WSL 调 Windows 的 `node.exe` / `pnpm.mjs` 时，**可执行文件本身用 `/mnt/...`，参数用 `D:/...`**；反过来会把 `/mnt/d/...` 改写成 `D:\mnt\d\...`。
