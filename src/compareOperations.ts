import * as path from 'path';
import * as vscode from 'vscode';
import * as core from './gitCompareCore';
import type { Locale } from './i18n';
import {
    diffTitleCommitIntro,
    diffTitleHeadWorking,
    diffTitleRefWorking,
    diffTitleTwoSnapshots,
    opErrMsg,
} from './i18n';

export type OpResult = { ok: true } | { ok: false; message: string };
export const WORKING_TREE_REF = '__WORKING_TREE__';

function shortRef(r: string): string {
    const t = r.trim();
    return t.length > 10 ? t.slice(0, 10) : t;
}

/** 单次提交：本文件在「父提交」与「该提交」之间的差异（左=父，右=本提交） */
export async function opCompareCommitVsParent(
    fsPath: string,
    commit: string,
    locale: Locale
): Promise<OpResult> {
    const c = commit.trim();
    if (!c) {
        return { ok: false, message: opErrMsg(locale, 'emptyCommit') };
    }
    const ctx = await core.getGitContext(fsPath);
    if (!ctx) {
        return { ok: false, message: opErrMsg(locale, 'notInRepo') };
    }
    const atCommit = await core.verifyBlobExists(ctx.gitRoot, c, ctx.relPath);
    if (!atCommit) {
        return { ok: false, message: opErrMsg(locale, 'commitMissingFile') };
    }
    const parent = await core.resolveFirstParentRef(ctx.gitRoot, c);
    const base = path.basename(fsPath);
    let leftUri: vscode.Uri;
    if (!parent) {
        leftUri = core.snapshotUri(base, '');
    } else {
        const parentHas = await core.verifyBlobExists(ctx.gitRoot, parent, ctx.relPath);
        if (!parentHas) {
            leftUri = core.snapshotUri(base, '');
        } else {
            leftUri = core.gitShowUri(ctx.gitRoot, parent, ctx.relPath);
        }
    }
    const rightUri = core.gitShowUri(ctx.gitRoot, c, ctx.relPath);
    const pShort = parent ? shortRef(parent) : locale === 'en' ? 'empty' : '空';
    const stat = await core.fetchCommitFileLineStats(ctx.gitRoot, c, ctx.relPath);
    const statSuffix =
        locale === 'en'
            ? ` +${stat.add}/-${stat.del}/~${stat.mod}`
            : ` +${stat.add}/-${stat.del}/~${stat.mod}`;
    await core.openGitDiff({
        leftUri,
        rightUri,
        title: `${diffTitleCommitIntro(locale, base, pShort, shortRef(c))}${statSuffix}`,
        keepWorktreeFsPath: fsPath,
    });
    const tip =
        locale === 'en'
            ? `This commit changes (est.): +${stat.add} / -${stat.del} / ~${stat.mod}`
            : `本次提交变更（估算）：+${stat.add} / -${stat.del} / ~${stat.mod}`;
    void vscode.window.showInformationMessage(tip);
    return { ok: true };
}

export async function opCompareWithHead(fsPath: string, locale: Locale): Promise<OpResult> {
    const ctx = await core.getGitContext(fsPath);
    if (!ctx) {
        return { ok: false, message: opErrMsg(locale, 'notInRepo') };
    }
    const headOk = await core.verifyBlobExists(ctx.gitRoot, 'HEAD', ctx.relPath);
    if (!headOk) {
        return { ok: false, message: opErrMsg(locale, 'headNoFile') };
    }
    const left = core.gitShowUri(ctx.gitRoot, 'HEAD', ctx.relPath);
    const text = await core.readWorkingCopy(fsPath);
    const right = core.snapshotUri(path.basename(fsPath), text);
    await core.openGitDiff({
        leftUri: left,
        rightUri: right,
        title: diffTitleHeadWorking(locale, path.basename(fsPath)),
        keepWorktreeFsPath: fsPath,
    });
    return { ok: true };
}

export async function opCompareWorkingWithRef(
    fsPath: string,
    ref: string,
    locale: Locale
): Promise<OpResult> {
    const r = ref.trim();
    if (!r) {
        return { ok: false, message: opErrMsg(locale, 'emptyRef') };
    }
    const ctx = await core.getGitContext(fsPath);
    if (!ctx) {
        return { ok: false, message: opErrMsg(locale, 'notInRepo') };
    }
    const ok = await core.verifyBlobExists(ctx.gitRoot, r, ctx.relPath);
    if (!ok) {
        return { ok: false, message: opErrMsg(locale, 'blobMissing', { ref: r }) };
    }
    const left = core.gitShowUri(ctx.gitRoot, r, ctx.relPath);
    const text = await core.readWorkingCopy(fsPath);
    const right = core.snapshotUri(path.basename(fsPath), text);
    await core.openGitDiff({
        leftUri: left,
        rightUri: right,
        title: diffTitleRefWorking(locale, path.basename(fsPath), r),
        keepWorktreeFsPath: fsPath,
    });
    return { ok: true };
}

/** 两个提交点上的文件快照直接对比，不要求历史先后关系 */
export async function opCompareTwoRefs(
    fsPath: string,
    leftRef: string,
    rightRef: string,
    locale: Locale
): Promise<OpResult> {
    const L = leftRef.trim();
    const R = rightRef.trim();
    if (!L || !R) {
        return { ok: false, message: opErrMsg(locale, 'pickBoth') };
    }
    if (L === R) {
        return { ok: false, message: opErrMsg(locale, 'sameRef') };
    }
    const ctx = await core.getGitContext(fsPath);
    if (!ctx) {
        return { ok: false, message: opErrMsg(locale, 'notInRepo') };
    }
    const leftIsWorking = L === WORKING_TREE_REF;
    const rightIsWorking = R === WORKING_TREE_REF;
    if (!leftIsWorking) {
        const ok = await core.verifyBlobExists(ctx.gitRoot, L, ctx.relPath);
        if (!ok) {
            return {
                ok: false,
                message: opErrMsg(locale, 'sideBlobMissing', {
                    side: locale === 'en' ? 'Left' : '左侧',
                    ref: L,
                }),
            };
        }
    }
    if (!rightIsWorking) {
        const ok = await core.verifyBlobExists(ctx.gitRoot, R, ctx.relPath);
        if (!ok) {
            return {
                ok: false,
                message: opErrMsg(locale, 'sideBlobMissing', {
                    side: locale === 'en' ? 'Right' : '右侧',
                    ref: R,
                }),
            };
        }
    }
    if (!leftIsWorking && !rightIsWorking) {
        const leftOlder = await core.isAncestor(ctx.gitRoot, L, R);
        if (!leftOlder || L === R) {
            return { ok: false, message: opErrMsg(locale, 'leftMustBeOlderRightNewer') };
        }
    }
    const leftUri = leftIsWorking
        ? core.snapshotUri(path.basename(fsPath), await core.readWorkingCopy(fsPath))
        : core.gitShowUri(ctx.gitRoot, L, ctx.relPath);
    const leftTitleRef = leftIsWorking ? (locale === 'en' ? 'working' : '工作区') : L;
    const rightUri = rightIsWorking
        ? core.snapshotUri(path.basename(fsPath), await core.readWorkingCopy(fsPath))
        : core.gitShowUri(ctx.gitRoot, R, ctx.relPath);
    const rightTitleRef = rightIsWorking ? (locale === 'en' ? 'working' : '工作区') : R;
    await core.openGitDiff({
        leftUri,
        rightUri,
        title: diffTitleTwoSnapshots(locale, path.basename(fsPath), leftTitleRef, rightTitleRef),
        keepWorktreeFsPath: fsPath,
    });
    return { ok: true };
}

export async function showOpError(res: OpResult, locale: Locale): Promise<void> {
    if (!res.ok) {
        const p = locale === 'en' ? 'GitDiff: ' : 'GitDiff：';
        void vscode.window.showErrorMessage(p + res.message);
    }
}
