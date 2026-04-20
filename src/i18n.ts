import type { ExtensionContext } from 'vscode';

export type Locale = 'zh' | 'en';

export const LOCALE_STORAGE_KEY = 'gitdiff.locale';

export function parseLocale(v: string | undefined): Locale {
    return v === 'en' ? 'en' : 'zh';
}

export function readLocale(ctx: ExtensionContext): Locale {
    return parseLocale(ctx.globalState.get<string>(LOCALE_STORAGE_KEY));
}

/** 侧栏 Webview 用到的文案（由扩展注入 payload） */
export function webviewLabels(locale: Locale): Record<string, string> {
    if (locale === 'en') {
        return {
            lang: 'Language',
            zh: '中文',
            en: 'English',
            fileTitle: 'File',
            noFile: '(No file open)',
            pinFixed: 'Pinned file',
            pinFollow: 'From active editor',
            refresh: 'Refresh',
            pickFile: 'Choose file…',
            allFiles: 'All files',
            chooseFileOpen: 'Choose file',
            followEditor: 'Use active editor',
            warnOpenFile: 'Open a workspace file in the editor first.',
            hintOpen: 'Open a workspace file in the editor, or choose a file.',
            hintNotRepo: 'Not inside a Git repository, or outside the repo root.',
            historyTitle: 'History (this file)',
            historyHint:
                'Click a commit: diff is this file at the parent vs at this commit (the change introduced by that commit).',
            historyStats:
                'Commits: {count} · Added lines: {add} · Deleted lines: {del} · Modified lines (est.): {mod}',
            hoverMeta: 'Author: {author} | Date: {date}',
            commitChangeStats:
                'This commit changes (est.): +{add} / -{del} / ~{mod}',
            twoTitle: 'Compare two versions',
            twoHint:
                'When both sides are commits, left must be older and right newer. Both sides support Working tree (uncommitted).',
            colA: 'Left (version A)',
            colB: 'Right (version B)',
            none: 'None',
            picked: 'Selected:',
            btnTwo: 'Compare A and B',
            workingTree: 'Working tree (uncommitted)',
            count: 'commits',
        };
    }
    return {
        lang: '语言',
        zh: '中文',
        en: 'English',
        fileTitle: '当前文件',
        noFile: '（未打开文件）',
        pinFixed: '已固定文件',
        pinFollow: '来自活动编辑器',
        refresh: '刷新',
        pickFile: '改选文件…',
        allFiles: '所有文件',
        chooseFileOpen: '选择文件',
        followEditor: '跟活动编辑器',
        warnOpenFile: '请先在编辑器中打开要比较的工作区文件。',
        hintOpen: '请在编辑器中打开工作区文件，或点击「改选文件」。',
        hintNotRepo: '当前文件不在 Git 仓库内，或不在仓库根目录之下。',
        historyTitle: '本文件修改历史',
        historyHint:
            '点击某条提交：对比内容为「该提交中的本文件」相对「其父提交中的同一文件」的差异（即本次提交对该文件的改动）。',
        historyStats: '提交数：{count} · 新增行：{add} · 删除行：{del} · 修改行（估算）：{mod}',
        hoverMeta: '提交者：{author} | 日期：{date}',
        commitChangeStats: '本次提交变更（估算）：+{add} / -{del} / ~{mod}',
        twoTitle: '两个历史版本（快照对比）',
        twoHint:
            '当两侧都选择历史提交时，要求左侧更旧、右侧更新。左右两侧都支持“工作区（未提交）”。',
        colA: '左侧（版本 A）',
        colB: '右侧（版本 B）',
        none: '未选择',
        picked: '已选：',
        btnTwo: '比较所选两个版本',
        workingTree: '工作区（未提交）',
        count: '条',
    };
}

const opErr = {
    notInRepo: { zh: '不在 Git 仓库内，或文件不在工作区内。', en: 'Not in a Git repository or file is outside the work tree.' },
    headNoFile: {
        zh: 'HEAD 中不存在该文件（可能未跟踪）。',
        en: 'File is not in HEAD (possibly untracked).',
    },
    emptyRef: { zh: '请填写版本标识。', en: 'Enter a revision.' },
    blobMissing: {
        zh: '版本 {ref} 中找不到该文件。',
        en: 'File not found at revision {ref}.',
    },
    sideBlobMissing: {
        zh: '「{side}」版本 {ref} 中不存在该文件。',
        en: 'File missing on {side} at {ref}.',
    },
    pickBoth: { zh: '请在左右两侧各选择一个版本。', en: 'Pick a revision on both sides.' },
    sameRef: { zh: '左右不能为同一提交。', en: 'Left and right revisions must differ.' },
    leftMustBeOlderRightNewer: {
        zh: '当两侧都为历史提交时，左侧版本必须更旧、右侧版本必须更新（左侧应是右侧的历史祖先）。',
        en: 'When both sides are commits, left must be older and right newer (left must be an ancestor of right).',
    },
    commitMissingFile: {
        zh: '该提交中不包含此文件（可能在本提交中被删除）。',
        en: 'This commit does not contain this file (it may have been deleted in this commit).',
    },
    emptyCommit: { zh: '提交标识为空。', en: 'Commit is empty.' },
    noFileSel: {
        zh: '未选择文件。请先打开工作区中的文件，或使用「手动选择文件」类命令。',
        en: 'No file selected. Open a file in the workspace or use a command that picks a file.',
    },
} as const;

export type OpErrKey = keyof typeof opErr;

export function opErrMsg(locale: Locale, key: OpErrKey, vars?: Record<string, string>): string {
    let s: string = opErr[key][locale];
    if (vars) {
        for (const [k, v] of Object.entries(vars)) {
            s = s.replace(`{${k}}`, v);
        }
    }
    return s;
}

export function diffTitleCommitIntro(
    locale: Locale,
    base: string,
    parentShort: string,
    commitShort: string
): string {
    if (locale === 'en') {
        return `${base} (${parentShort} \u2192 ${commitShort}, commit vs parent)`;
    }
    return `${base}（${parentShort} \u2192 ${commitShort}，相对父提交）`;
}

export function diffTitleTwoSnapshots(locale: Locale, base: string, a: string, b: string): string {
    if (locale === 'en') {
        return `${base} (${a} \u2194 ${b})`;
    }
    return `${base}（${a} \u2194 ${b}）`;
}

export function diffTitleHeadWorking(locale: Locale, base: string): string {
    return locale === 'en' ? `${base} (HEAD \u2194 working tree)` : `${base}（HEAD \u2194 工作区）`;
}

export function diffTitleRefWorking(locale: Locale, base: string, ref: string): string {
    return locale === 'en' ? `${base} (${ref} \u2194 working tree)` : `${base}（${ref} \u2194 工作区）`;
}
