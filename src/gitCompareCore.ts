import * as cp from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import { promisify } from 'util';
import * as vscode from 'vscode';

const execFile = promisify(cp.execFile);

export const SCHEME_GIT = 'githist-gitshow';
export const SCHEME_SNAP = 'githist-snapshot';

const snapshots = new Map<string, string>();
const snapshotTimers = new Map<string, ReturnType<typeof setTimeout>>();

function scheduleSnapshotCleanup(nonce: string): void {
    const prev = snapshotTimers.get(nonce);
    if (prev) {
        clearTimeout(prev);
    }
    snapshotTimers.set(
        nonce,
        setTimeout(() => {
            snapshots.delete(nonce);
            snapshotTimers.delete(nonce);
        }, 10 * 60 * 1000)
    );
}

export async function runGit(
    gitRoot: string,
    args: string[]
): Promise<{ stdout: string; stderr: string }> {
    return execFile('git', args, {
        cwd: gitRoot,
        maxBuffer: 64 * 1024 * 1024,
        encoding: 'utf8',
    }) as Promise<{ stdout: string; stderr: string }>;
}

export async function getGitRootForFsPath(fsPath: string): Promise<string | undefined> {
    const dir = path.dirname(fsPath);
    try {
        const { stdout } = await runGit(dir, ['rev-parse', '--show-toplevel']);
        return stdout.trim() || undefined;
    } catch {
        return undefined;
    }
}

export function toPosixPath(gitRoot: string, fsPath: string): string {
    const rel = path.relative(gitRoot, fsPath);
    return rel.split(path.sep).join('/');
}

export function gitShowUri(gitRoot: string, ref: string, relPath: string): vscode.Uri {
    const q = encodeURIComponent(JSON.stringify({ gitRoot, ref, relPath }));
    return vscode.Uri.parse(`${SCHEME_GIT}:${encodeURIComponent(relPath)}?${q}`);
}

export function snapshotUri(fileName: string, content: string): vscode.Uri {
    const nonce = crypto.randomUUID();
    snapshots.set(nonce, content);
    scheduleSnapshotCleanup(nonce);
    const q = `nonce=${encodeURIComponent(nonce)}`;
    return vscode.Uri.parse(`${SCHEME_SNAP}:${encodeURIComponent(fileName)}?${q}`);
}

export async function getGitContext(
    fsPath: string,
    opts?: { silent?: boolean }
): Promise<{ gitRoot: string; relPath: string } | undefined> {
    const silent = opts?.silent ?? false;
    const gitRoot = await getGitRootForFsPath(fsPath);
    if (!gitRoot) {
        if (!silent) {
            void vscode.window.showErrorMessage('当前路径不在 Git 仓库中。');
        }
        return undefined;
    }
    const relPath = toPosixPath(gitRoot, fsPath);
    if (relPath.startsWith('..')) {
        if (!silent) {
            void vscode.window.showErrorMessage('该文件不在此 Git 仓库的工作目录范围内。');
        }
        return undefined;
    }
    return { gitRoot, relPath };
}

export async function verifyBlobExists(
    gitRoot: string,
    ref: string,
    relPath: string
): Promise<boolean> {
    try {
        await runGit(gitRoot, ['cat-file', '-e', `${ref}:${relPath}`]);
        return true;
    } catch {
        return false;
    }
}

/** 解析提交的第一父提交（merge 取第一父；根提交返回 undefined） */
export async function resolveFirstParentRef(
    gitRoot: string,
    commit: string
): Promise<string | undefined> {
    try {
        const { stdout } = await runGit(gitRoot, ['rev-parse', `${commit.trim()}^`]);
        const p = stdout.trim();
        return p || undefined;
    } catch {
        return undefined;
    }
}

export async function fetchRecentCommits(
    gitRoot: string,
    relPath: string,
    limit: number
): Promise<{ id: string; subject: string; author: string; date: string }[]> {
    try {
        const { stdout } = await runGit(gitRoot, [
            'log',
            '-n',
            String(limit),
            '--pretty=format:%h%x09%s%x09%an%x09%at',
            '--',
            relPath,
        ]);
        return stdout
            .split('\n')
            .filter(Boolean)
            .map((line) => {
                const parts = line.split('\t');
                const id = parts[0] ?? '';
                const subject = parts[1] ?? '';
                const author = parts[2] ?? '';
                const date = formatUnixTs(parts[3] ?? '');
                return { id, subject, author, date };
            });
    } catch {
        return [];
    }
}

function pad2(n: number): string {
    return n < 10 ? `0${n}` : String(n);
}

/** 兼容老版本 git：用 %at 时间戳在本地格式化 */
function formatUnixTs(raw: string): string {
    const sec = Number(raw);
    if (!Number.isFinite(sec) || sec <= 0) {
        return raw || '';
    }
    const d = new Date(sec * 1000);
    const y = d.getFullYear();
    const m = pad2(d.getMonth() + 1);
    const day = pad2(d.getDate());
    const hh = pad2(d.getHours());
    const mm = pad2(d.getMinutes());
    const ss = pad2(d.getSeconds());
    return `${y}-${m}-${day} ${hh}:${mm}:${ss}`;
}

/**
 * 统计某文件历史中的“行级增删改估算”：
 * - 基于 git log --numstat 聚合每次提交的 added/deleted 行数
 * - 每次提交的“修改行”估算为 min(added, deleted)
 * - 剩余 added/deleted 计入“新增/删除”
 */
export async function fetchFileHistoryStats(
    gitRoot: string,
    relPath: string,
    limit: number
): Promise<{ add: number; del: number; mod: number }> {
    try {
        const { stdout } = await runGit(gitRoot, [
            'log',
            '-n',
            String(limit),
            '--numstat',
            '--pretty=format:@@@',
            '--',
            relPath,
        ]);

        let add = 0;
        let del = 0;
        let mod = 0;
        for (const raw of stdout.split('\n')) {
            const line = raw.trim();
            if (!line || line === '@@@') {
                continue;
            }

            // numstat: "<added>\t<deleted>\t<path>"
            // 二进制文件会是 "-\t-\t<path>"，这里跳过
            const parts = line.split('\t');
            if (parts.length < 3) {
                continue;
            }
            const a = Number(parts[0]);
            const d = Number(parts[1]);
            if (!Number.isFinite(a) || !Number.isFinite(d)) {
                continue;
            }

            const m = Math.min(a, d);
            mod += m;
            add += a - m;
            del += d - m;
        }
        return { add, del, mod };
    } catch {
        return { add: 0, del: 0, mod: 0 };
    }
}

export async function readWorkingCopy(fsPath: string): Promise<string> {
    const editor = vscode.window.visibleTextEditors.find(
        (e) => e.document.uri.scheme === 'file' && e.document.uri.fsPath === fsPath
    );
    if (editor) {
        return editor.document.getText();
    }
    const bg = vscode.workspace.textDocuments.find(
        (d) => d.uri.scheme === 'file' && d.uri.fsPath === fsPath && !d.isClosed
    );
    if (bg) {
        return bg.getText();
    }
    try {
        return await fs.readFile(fsPath, 'utf8');
    } catch {
        return '';
    }
}

/**
 * 将工作区文件以「非预览」方式打开到编辑器，避免打开 diff 后原标签被预览替换、关 diff 后原文件不见。
 * preserveFocus：尽量不抢当前焦点，随后 diff 仍会获得焦点。
 */
export async function ensureWorktreeFileTab(fsPath: string): Promise<void> {
    try {
        const uri = vscode.Uri.file(fsPath);
        const doc = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(doc, {
            preview: false,
            preserveFocus: true,
        });
    } catch {
        /* 忽略：例如路径无效 */
    }
}

export async function openGitDiff(args: {
    title: string;
    leftUri: vscode.Uri;
    rightUri: vscode.Uri;
    /** 当前比较所基于的工作区文件；传入则先固定该文件标签再打开 diff */
    keepWorktreeFsPath?: string;
}): Promise<void> {
    if (args.keepWorktreeFsPath) {
        await ensureWorktreeFileTab(args.keepWorktreeFsPath);
    }
    await vscode.commands.executeCommand('vscode.diff', args.leftUri, args.rightUri, args.title);
}

export function registerDocumentProviders(context: vscode.ExtensionContext): void {
    const gitProvider = new (class implements vscode.TextDocumentContentProvider {
        async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
            let q: { gitRoot: string; ref: string; relPath: string };
            try {
                q = JSON.parse(decodeURIComponent(uri.query)) as {
                    gitRoot: string;
                    ref: string;
                    relPath: string;
                };
            } catch {
                return '// GitDiff: invalid document URI\n';
            }
            try {
                const { stdout } = await runGit(q.gitRoot, ['show', `${q.ref}:${q.relPath}`]);
                return stdout.endsWith('\n') || stdout.length === 0 ? stdout : `${stdout}\n`;
            } catch (e) {
                const msg = e instanceof Error ? e.message : String(e);
                void vscode.window.showErrorMessage(
                    `无法读取版本 ${q.ref} 中的文件：${q.relPath}。${msg}`
                );
                return `// GitDiff: failed to load ${q.ref}:${q.relPath}\n// ${msg}\n`;
            }
        }
    })();

    const snapProvider = new (class implements vscode.TextDocumentContentProvider {
        provideTextDocumentContent(uri: vscode.Uri): string {
            const params = new URLSearchParams(uri.query);
            const nonce = params.get('nonce');
            if (!nonce) {
                return '';
            }
            return snapshots.get(nonce) ?? '';
        }
    })();

    context.subscriptions.push(
        vscode.workspace.registerTextDocumentContentProvider(SCHEME_GIT, gitProvider),
        vscode.workspace.registerTextDocumentContentProvider(SCHEME_SNAP, snapProvider)
    );
}

export function disposeSnapshots(): void {
    for (const t of snapshotTimers.values()) {
        clearTimeout(t);
    }
    snapshotTimers.clear();
    snapshots.clear();
}
