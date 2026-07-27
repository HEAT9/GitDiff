import * as cp from 'child_process';
import { promisify } from 'util';
import * as vscode from 'vscode';
import * as core from './gitCompareCore';
import type { Locale } from './i18n';
import { readLocale } from './i18n';

const execFile = promisify(cp.execFile);

const ZERO = '0000000000000000000000000000000000000000';

/** 悬停大文件时可不走 stdin。行尾内联：仅未保存时用 --contents；未提交行不画行尾（避免再踩环境差异）。 */
const HOVER_BLAME_MAX_CONTENT_CHARS = 400_000;

function cfgHoverEnabled(): boolean {
    return vscode.workspace.getConfiguration('gitdiff').get<boolean>('lineBlameHover.enabled', true);
}

function cfgInlineAtCursor(): boolean {
    return vscode.workspace.getConfiguration('gitdiff').get<boolean>('lineBlame.inlineAtCursor', true);
}

/** 行尾文字色：非空则用 CSS 颜色（可 #rgb、rgba(…,0.5) 调深浅），空则用主题 descriptionForeground */
function cfgInlineForeground(): string | vscode.ThemeColor {
    const v = vscode.workspace.getConfiguration('gitdiff').get<string>('lineBlame.inlineColor', '')?.trim();
    if (v) {
        return v;
    }
    return new vscode.ThemeColor('descriptionForeground');
}

/** 行尾背景：非空则作为 CSS 颜色，空则不画背景 */
function cfgInlineBackground(): string | vscode.ThemeColor | undefined {
    const v = vscode.workspace.getConfiguration('gitdiff').get<string>('lineBlame.inlineBackgroundColor', '')?.trim();
    if (v) {
        return v;
    }
    return undefined;
}

function formatAbsoluteTime(epochSec: number, locale: Locale, authorTz: string): string {
    if (!epochSec) {
        return '—';
    }
    const d = new Date(epochSec * 1000);
    const loc = locale === 'en' ? 'en-US' : 'zh-CN';
    const base = d.toLocaleString(loc, { dateStyle: 'medium', timeStyle: 'short' });
    return authorTz ? `${base} (${authorTz})` : base;
}

function formatRelative(epochSec: number, locale: Locale): string {
    if (!epochSec) {
        return locale === 'en' ? 'just now' : '刚刚';
    }
    const now = Date.now();
    const diffMs = now - epochSec * 1000;
    const sec = Math.floor(diffMs / 1000);
    if (sec < 45) {
        return locale === 'en' ? 'just now' : '刚刚';
    }
    const min = Math.floor(sec / 60);
    if (min < 60) {
        return locale === 'en' ? `${min}m ago` : `${min} 分钟前`;
    }
    const hr = Math.floor(min / 60);
    if (hr < 24) {
        return locale === 'en' ? `${hr}h ago` : `${hr} 小时前`;
    }
    const day = Math.floor(hr / 24);
    if (day < 30) {
        return locale === 'en' ? `${day}d ago` : `${day} 天前`;
    }
    const mon = Math.floor(day / 30);
    if (mon < 12) {
        return locale === 'en' ? `${mon}mo ago` : `${mon} 个月前`;
    }
    const yr = Math.floor(mon / 12);
    return locale === 'en' ? `${yr}y ago` : `${yr} 年前`;
}

interface ParsedBlame {
    sha: string;
    author: string;
    authorMail: string;
    authorTime: number;
    authorTz: string;
    summary: string;
}

function parseLinePorcelain(block: string): ParsedBlame | undefined {
    const lines = block.split(/\r?\n/);
    const header = lines[0]?.trim() ?? '';
    const hm = /^([0-9a-f]{40})\s+(\d+)\s+(\d+)\s+(\d+)\s*$/.exec(header);
    if (!hm) {
        return undefined;
    }
    const [, sha] = hm;
    let author = '';
    let authorMail = '';
    let authorTime = 0;
    let authorTz = '';
    let summary = '';
    for (let i = 1; i < lines.length; i++) {
        const line = lines[i];
        if (!line || line.startsWith('\t')) {
            break;
        }
        const sp = line.indexOf(' ');
        if (sp < 0) {
            continue;
        }
        const key = line.slice(0, sp);
        const val = line.slice(sp + 1);
        switch (key) {
            case 'author':
                author = val;
                break;
            case 'author-mail':
                authorMail = val.replace(/^<|>$/g, '');
                break;
            case 'author-time':
                authorTime = parseInt(val, 10) || 0;
                break;
            case 'author-tz':
                authorTz = val;
                break;
            case 'summary':
                summary = val;
                break;
            default:
                break;
        }
    }
    return { sha, author, authorMail, authorTime, authorTz, summary };
}

async function getGitUserEmail(gitRoot: string): Promise<string | undefined> {
    try {
        const { stdout } = await core.runGit(gitRoot, ['config', 'user.email']);
        const e = stdout.trim();
        return e || undefined;
    } catch {
        return undefined;
    }
}

async function getGitUserName(gitRoot: string): Promise<string | undefined> {
    try {
        const { stdout } = await core.runGit(gitRoot, ['config', 'user.name']);
        const n = stdout.trim();
        return n || undefined;
    } catch {
        return undefined;
    }
}

/**
 * @param fileText 传入时先 `--contents` 与缓冲区一致；若 Git 抛错、stdout 空或 **解析失败**，再 blame 磁盘（避免「什么都不显示」）。
 */
async function blameOneLine(
    args: {
        gitRoot: string;
        relPath: string;
        line1Based: number;
        fileText?: string;
    },
    log?: vscode.OutputChannel
): Promise<ParsedBlame | undefined> {
    const { gitRoot, relPath, line1Based, fileText } = args;

    const execBlame = async (useContents: boolean): Promise<string> => {
        const gitArgs = ['blame', '--line-porcelain', '-L', `${line1Based},+1`, '--', relPath];
        if (useContents && fileText !== undefined) {
            gitArgs.splice(1, 0, '--contents=-');
        }
        const opts: cp.ExecFileOptionsWithStringEncoding & { input?: string } = {
            cwd: gitRoot,
            maxBuffer: 64 * 1024 * 1024,
            encoding: 'utf8',
            ...(useContents && fileText !== undefined ? { input: fileText } : {}),
        };
        const { stdout } = (await execFile('git', gitArgs, opts)) as { stdout: string };
        return stdout;
    };

    const parseOut = (stdout: string): ParsedBlame | undefined =>
        parseLinePorcelain(stdout.trimEnd());

    const blameDisk = async (): Promise<ParsedBlame | undefined> => {
        try {
            return parseOut(await execBlame(false));
        } catch (e) {
            const err = e as { stderr?: string; message?: string };
            log?.appendLine(
                `[inline blame] disk L${line1Based}: ${err.message ?? e}${err.stderr ? ` stderr=${err.stderr}` : ''}`
            );
            return undefined;
        }
    };

    if (fileText === undefined) {
        return blameDisk();
    }

    let contentStdout = '';
    try {
        contentStdout = await execBlame(true);
    } catch (e1) {
        const err1 = e1 as { stderr?: string; message?: string };
        log?.appendLine(
            `[inline blame] --contents L${line1Based} throw: ${err1.message ?? e1}${err1.stderr ? ` stderr=${err1.stderr}` : ''}`
        );
        return blameDisk();
    }

    const parsedContents = parseOut(contentStdout);
    if (parsedContents) {
        return parsedContents;
    }

    if (contentStdout.trim().length > 0) {
        log?.appendLine(
            `[inline blame] --contents L${line1Based} 无法解析 porcelain，stdout 前 160 字符: ${JSON.stringify(contentStdout.slice(0, 160))}`
        );
    } else {
        log?.appendLine(`[inline blame] --contents L${line1Based} stdout 为空，改试磁盘 blame`);
    }
    return blameDisk();
}

function isUncommitted(parsed: ParsedBlame): boolean {
    return (
        parsed.sha === ZERO ||
        parsed.authorMail === 'not.committed.yet' ||
        parsed.author === 'Not Committed Yet'
    );
}

/** 未提交行：展示本机「当前修改者」——优先 `git config user.name`，否则「你」 */
function displayLocalModifierName(gitUserName: string | undefined, locale: Locale): string {
    const n = gitUserName?.trim();
    if (n) {
        return n;
    }
    return locale === 'en' ? 'You' : '你';
}

function displayAuthorCommitted(parsed: ParsedBlame, selfMail: string | undefined, locale: Locale): string {
    if (selfMail && parsed.authorMail && parsed.authorMail.toLowerCase() === selfMail.toLowerCase()) {
        return locale === 'en' ? 'You' : '你';
    }
    return parsed.author || (locale === 'en' ? '(unknown)' : '（未知）');
}

function sanitizeDecorText(s: string, maxLen: number): string {
    const one = s.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (one.length <= maxLen) {
        return one;
    }
    return `${one.slice(0, maxLen - 1)}…`;
}

/** 行尾内联：仅已提交行「作者 · 时间 · 短哈希」（未提交行不显示行尾） */
function buildInlineDecorLabel(parsed: ParsedBlame, selfMail: string | undefined, locale: Locale): string {
    const sep = ' \u00b7 '; // middle dot
    const who = displayAuthorCommitted(parsed, selfMail, locale);
    const when = formatRelative(parsed.authorTime, locale);
    const short = parsed.sha.slice(0, 8);
    return `${who}${sep}${when}${sep}${short}`;
}

function buildHoverMarkdown(
    parsed: ParsedBlame,
    selfMail: string | undefined,
    locale: Locale,
    gitUserName: string | undefined
): vscode.MarkdownString {
    const md = new vscode.MarkdownString();
    md.isTrusted = false;
    md.supportHtml = false;
    md.appendMarkdown(
        locale === 'en' ? '### GitDiff · line blame\n\n' : '### GitDiff · 行 blame\n\n'
    );

    const uncommitted = isUncommitted(parsed);

    const nowSec = Math.floor(Date.now() / 1000);
    const who = uncommitted
        ? displayLocalModifierName(gitUserName, locale)
        : displayAuthorCommitted(parsed, selfMail, locale);
    const whenRel = uncommitted ? formatRelative(nowSec, locale) : formatRelative(parsed.authorTime, locale);
    const whenAbs = uncommitted
        ? formatAbsoluteTime(nowSec, locale, '')
        : formatAbsoluteTime(parsed.authorTime, locale, parsed.authorTz);
    const shortSha = parsed.sha === ZERO ? '' : parsed.sha.slice(0, 8);

    if (uncommitted) {
        md.appendMarkdown(`**${who}**`);
        md.appendMarkdown(' &nbsp;·&nbsp; ');
        md.appendMarkdown(`*${whenRel}*`);
        md.appendMarkdown(' &nbsp;·&nbsp; ');
        md.appendMarkdown(`*${whenAbs}*`);
        md.appendMarkdown(' &nbsp;·&nbsp; ');
        md.appendMarkdown(locale === 'en' ? '*Uncommitted*' : '*未提交*');
        md.appendMarkdown('\n\n');
        const sub =
            parsed.summary && parsed.summary !== 'Uncommitted changes'
                ? parsed.summary
                : locale === 'en'
                  ? 'This line differs from the last commit (or is new). Revert to match HEAD to see last commit blame again.'
                  : '该行与上次提交不一致（或为新行）。若改回与 HEAD 一致，将恢复显示上一次提交信息。';
        md.appendMarkdown(`_${sub}_`);
    } else {
        md.appendMarkdown(`**${who}**`);
        md.appendMarkdown(' &nbsp;·&nbsp; ');
        md.appendMarkdown(`*${whenRel}*`);
        md.appendMarkdown(' &nbsp;·&nbsp; ');
        md.appendMarkdown(`*${whenAbs}*`);
        if (shortSha) {
            md.appendMarkdown(' &nbsp;·&nbsp; ');
            md.appendMarkdown(`\`${shortSha}\``);
        }
        md.appendMarkdown('\n\n');
        const sum = parsed.summary || (locale === 'en' ? '(no message)' : '（无说明）');
        md.appendMarkdown(`**${locale === 'en' ? 'Commit' : '提交'}** — ${sum}`);
    }

    return md;
}

let selfIdentityCache: { root: string; mail: string | undefined; name: string | undefined } | undefined;

async function cachedSelfIdentity(gitRoot: string): Promise<{ mail: string | undefined; name: string | undefined }> {
    if (selfIdentityCache?.root === gitRoot) {
        return { mail: selfIdentityCache.mail, name: selfIdentityCache.name };
    }
    const [mail, name] = await Promise.all([getGitUserEmail(gitRoot), getGitUserName(gitRoot)]);
    selfIdentityCache = { root: gitRoot, mail, name };
    return { mail, name };
}

function registerHover(context: vscode.ExtensionContext): vscode.Disposable {
    const sel: vscode.DocumentSelector = { scheme: 'file' };

    const provider: vscode.HoverProvider = {
        provideHover: async (document, position, token) => {
            if (!cfgHoverEnabled()) {
                return undefined;
            }
            if (document.uri.scheme !== 'file') {
                return undefined;
            }
            const line = document.lineAt(position.line);
            const line1Based = line.lineNumber + 1;
            const locale = readLocale(context);

            try {
                const fsPath = document.uri.fsPath;
                const ctx = await core.getGitContext(fsPath, { silent: true });
                if (!ctx || token.isCancellationRequested) {
                    return undefined;
                }
                const tracked = await core.isPathTracked(ctx.gitRoot, ctx.relPath);
                if (!tracked) {
                    return undefined;
                }
                if (token.isCancellationRequested) {
                    return undefined;
                }

                const full = document.getText();
                const useContents =
                    document.isDirty || full.length <= HOVER_BLAME_MAX_CONTENT_CHARS;
                const parsed = await blameOneLine({
                    gitRoot: ctx.gitRoot,
                    relPath: ctx.relPath,
                    line1Based,
                    fileText: useContents ? full : undefined,
                });
                if (!parsed) {
                    const msg =
                        locale === 'en'
                            ? 'Could not load blame for this line.'
                            : '无法获取该行的 blame 信息。';
                    const md = new vscode.MarkdownString(
                        `**GitDiff**\n\n${msg}\n\n_${locale === 'en' ? 'If the file is very large, save and try again, or check Git output.' : '若文件很大，可先保存后重试，或检查 Git 是否正常。'}_`
                    );
                    md.isTrusted = false;
                    return new vscode.Hover(md, line.range);
                }

                const { mail: selfMail, name: gitUserName } = await cachedSelfIdentity(ctx.gitRoot);
                const md = buildHoverMarkdown(parsed, selfMail, locale, gitUserName);
                return new vscode.Hover(md, line.range);
            } catch (err) {
                const msg =
                    locale === 'en'
                        ? `GitDiff blame error: ${String(err)}`
                        : `GitDiff blame 出错：${String(err)}`;
                const md = new vscode.MarkdownString(msg);
                md.isTrusted = false;
                return new vscode.Hover(md, line.range);
            }
        },
    };

    return vscode.languages.registerHoverProvider(sel, provider);
}

function registerInlineAtCursor(context: vscode.ExtensionContext, log: vscode.OutputChannel): vscode.Disposable {
    // 与可显示的 0.9.93 一致：不要用 isWholeLine + 整行 range（部分环境下行尾 after 不渲染）
    const decType = vscode.window.createTextEditorDecorationType({});
    let debounce: ReturnType<typeof setTimeout> | undefined;
    let seq = 0;

    const clearAllEditors = (): void => {
        for (const e of vscode.window.visibleTextEditors) {
            e.setDecorations(decType, []);
        }
    };

    const run = async (): Promise<void> => {
        const mySeq = ++seq;
        const editor = vscode.window.activeTextEditor;
        if (!editor || editor.document.uri.scheme !== 'file') {
            clearAllEditors();
            return;
        }
        if (!cfgInlineAtCursor()) {
            clearAllEditors();
            return;
        }

        for (const e of vscode.window.visibleTextEditors) {
            if (e !== editor) {
                e.setDecorations(decType, []);
            }
        }

        const doc = editor.document;
        const fsPath = doc.uri.fsPath;
        const ctx = await core.getGitContext(fsPath, { silent: true });
        if (mySeq !== seq) {
            return;
        }
        if (!ctx) {
            log.appendLine(`[inline] 无 Git 上下文（文件不在仓库或无法 rev-parse）：${fsPath}`);
            editor.setDecorations(decType, []);
            return;
        }
        const tracked = await core.isPathTracked(ctx.gitRoot, ctx.relPath);
        if (mySeq !== seq) {
            return;
        }
        if (!tracked) {
            log.appendLine(
                `[inline] 文件未被 Git 跟踪（git ls-files）：relPath=${ctx.relPath} root=${ctx.gitRoot}`
            );
            editor.setDecorations(decType, []);
            return;
        }

        const locale = readLocale(context);
        const { mail: selfMail } = await cachedSelfIdentity(ctx.gitRoot);
        if (mySeq !== seq) {
            return;
        }
        const fileText = doc.isDirty ? doc.getText() : undefined;
        const lineNums = [...new Set(editor.selections.map((s) => s.active.line))].filter(
            (ln) => ln >= 0 && ln < doc.lineCount
        );

        const blameRows = await Promise.all(
            lineNums.map(async (lineNum) => {
                const parsed = await blameOneLine(
                    {
                        gitRoot: ctx.gitRoot,
                        relPath: ctx.relPath,
                        line1Based: lineNum + 1,
                        fileText,
                    },
                    log
                );
                return { lineNum, parsed };
            })
        );
        if (mySeq !== seq) {
            return;
        }

        const options: vscode.DecorationOptions[] = [];
        for (const { lineNum, parsed } of blameRows) {
            if (!parsed) {
                log.appendLine(`[inline] git blame 无结果：行 ${lineNum + 1}，请查看上一条错误`);
                continue;
            }
            if (isUncommitted(parsed)) {
                continue;
            }
            const line = doc.lineAt(lineNum);
            const raw = ` ${buildInlineDecorLabel(parsed, selfMail, locale)}`;
            const contentText = sanitizeDecorText(raw, 96);
            const end = line.range.end;
            const fg = cfgInlineForeground();
            const bg = cfgInlineBackground();
            const after: vscode.ThemableDecorationAttachmentRenderOptions = {
                contentText,
                color: fg,
                fontStyle: 'italic',
                margin: '0 0 0 2ch',
            };
            if (bg !== undefined) {
                after.backgroundColor = bg;
            }
            options.push({
                range: new vscode.Range(end, end),
                renderOptions: { after },
            });
        }

        if (mySeq !== seq) {
            return;
        }
        editor.setDecorations(decType, options);
    };

    const schedule = (): void => {
        if (debounce !== undefined) {
            clearTimeout(debounce);
        }
        debounce = setTimeout(() => {
            debounce = undefined;
            void run();
        }, 80);
    };

    schedule();

    const subs: vscode.Disposable[] = [
        vscode.window.onDidChangeTextEditorSelection((e) => {
            if (e.textEditor === vscode.window.activeTextEditor) {
                schedule();
            }
        }),
        vscode.window.onDidChangeActiveTextEditor(() => schedule()),
        vscode.workspace.onDidOpenTextDocument(() => {
            if (vscode.window.activeTextEditor?.document.uri.scheme === 'file') {
                schedule();
            }
        }),
        vscode.workspace.onDidChangeTextDocument((e) => {
            if (vscode.window.activeTextEditor?.document === e.document) {
                schedule();
            }
        }),
        vscode.workspace.onDidChangeConfiguration((e) => {
            if (e.affectsConfiguration('gitdiff')) {
                schedule();
            }
        }),
    ];

    return vscode.Disposable.from(
        decType,
        ...subs,
        new vscode.Disposable(() => {
            if (debounce !== undefined) {
                clearTimeout(debounce);
            }
            seq++;
            clearAllEditors();
        })
    );
}

export function registerLineBlameHover(context: vscode.ExtensionContext): vscode.Disposable {
    const log = vscode.window.createOutputChannel('GitDiff');
    log.appendLine(
        'GitDiff 行尾 blame：仅显示**已提交**行的作者/时间；未提交行不显示行尾。点一行后看 [inline] 摘要。命令「GitDiff: 打开行 blame 输出」。'
    );
    const showLog = vscode.commands.registerCommand('gitdiff.showLineBlameOutput', () => {
        log.show(true);
    });
    return vscode.Disposable.from(
        registerHover(context),
        registerInlineAtCursor(context, log),
        showLog,
        log
    );
}
