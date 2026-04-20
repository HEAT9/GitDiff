import * as vscode from 'vscode';
import { CompareSidebarViewProvider } from './compareSidebarView';
import * as ops from './compareOperations';
import * as core from './gitCompareCore';
import { opErrMsg, readLocale, webviewLabels } from './i18n';

async function resolveTargetUri(
    context: vscode.ExtensionContext,
    resource: vscode.Uri | undefined
): Promise<{ fsPath: string; uri: vscode.Uri } | undefined> {
    if (resource && resource.scheme === 'file') {
        return { fsPath: resource.fsPath, uri: resource };
    }
    const editor = vscode.window.activeTextEditor;
    if (editor?.document.uri.scheme === 'file') {
        return { fsPath: editor.document.uri.fsPath, uri: editor.document.uri };
    }
    const L = webviewLabels(readLocale(context));
    const picked = await vscode.window.showOpenDialog({
        canSelectMany: false,
        openLabel: L.chooseFileOpen,
        filters: { [L.allFiles]: ['*'] },
    });
    const u = picked?.[0];
    if (u?.scheme === 'file') {
        return { fsPath: u.fsPath, uri: u };
    }
    return undefined;
}

async function pickRef(
    gitRoot: string,
    relPath: string,
    placeHolder: string
): Promise<string | undefined> {
    let items: vscode.QuickPickItem[] = [];
    try {
        const { stdout } = await core.runGit(gitRoot, [
            'log',
            '-n',
            '40',
            '--pretty=format:%h\t%s',
            '--',
            relPath,
        ]);
        items = stdout
            .split('\n')
            .filter(Boolean)
            .map((line) => {
                const tab = line.indexOf('\t');
                const id = tab >= 0 ? line.slice(0, tab) : line;
                const sub = tab >= 0 ? line.slice(tab + 1) : '';
                return { label: id, description: sub };
            });
    } catch {
        /* empty */
    }
    const picked = await vscode.window.showQuickPick(
        [
            {
                label: '$(edit) 手动输入版本…',
                description: '分支 / 标签 / 提交哈希 / 如 HEAD~1',
                alwaysShow: true,
            },
            ...items,
        ],
        { placeHolder }
    );
    if (!picked) {
        return undefined;
    }
    if (picked.label.includes('手动输入')) {
        return vscode.window.showInputBox({
            placeHolder: '例如 HEAD~1、main、v1.0.0、abc1234',
            validateInput: (v) => (v.trim() ? undefined : '请输入非空的版本标识'),
        });
    }
    return picked.label;
}

async function pickTwoRefs(
    gitRoot: string,
    relPath: string
): Promise<{ left: string; right: string } | undefined> {
    const left = await pickRef(gitRoot, relPath, '选择左侧版本（较旧 / 第一个）');
    if (!left?.trim()) {
        return undefined;
    }
    const right = await pickRef(gitRoot, relPath, '选择右侧版本（较新 / 第二个）');
    if (!right?.trim()) {
        return undefined;
    }
    return { left: left.trim(), right: right.trim() };
}

export function activate(context: vscode.ExtensionContext): void {
    core.registerDocumentProviders(context);

    const sidebar = new CompareSidebarViewProvider(context);
    sidebar.registerWindowListeners(context);
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(CompareSidebarViewProvider.viewId, sidebar)
    );

    const compareWithHead = async (resource?: vscode.Uri) => {
        const t = await resolveTargetUri(context, resource);
        if (!t) {
            void vscode.window.showWarningMessage(opErrMsg(readLocale(context), 'noFileSel'));
            return;
        }
        await ops.showOpError(await ops.opCompareWithHead(t.fsPath, readLocale(context)), readLocale(context));
    };

    const compareWorkingWithRevision = async (resource?: vscode.Uri) => {
        const t = await resolveTargetUri(context, resource);
        if (!t) {
            void vscode.window.showWarningMessage(opErrMsg(readLocale(context), 'noFileSel'));
            return;
        }
        const ctx = await core.getGitContext(t.fsPath);
        if (!ctx) {
            return;
        }
        const ref = await pickRef(
            ctx.gitRoot,
            ctx.relPath,
            '选择要与工作区比较的版本（将显示在左侧）'
        );
        if (!ref) {
            return;
        }
        await ops.showOpError(
            await ops.opCompareWorkingWithRef(t.fsPath, ref, readLocale(context)),
            readLocale(context)
        );
    };

    const compareTwoRevisions = async (resource?: vscode.Uri) => {
        const t = await resolveTargetUri(context, resource);
        if (!t) {
            void vscode.window.showWarningMessage(opErrMsg(readLocale(context), 'noFileSel'));
            return;
        }
        const ctx = await core.getGitContext(t.fsPath);
        if (!ctx) {
            return;
        }
        const pair = await pickTwoRefs(ctx.gitRoot, ctx.relPath);
        if (!pair) {
            return;
        }
        await ops.showOpError(
            await ops.opCompareTwoRefs(t.fsPath, pair.left, pair.right, readLocale(context)),
            readLocale(context)
        );
    };

    const openSidebar = async () => {
        await vscode.commands.executeCommand('workbench.view.extension.gitdiff');
    };

    context.subscriptions.push(
        vscode.commands.registerCommand('gitHistoryCompare.compareWithHead', compareWithHead),
        vscode.commands.registerCommand(
            'gitHistoryCompare.compareWorkingWithRevision',
            compareWorkingWithRevision
        ),
        vscode.commands.registerCommand('gitHistoryCompare.compareTwoRevisions', compareTwoRevisions),
        vscode.commands.registerCommand('gitHistoryCompare.pickCompareHead', () => compareWithHead()),
        vscode.commands.registerCommand('gitHistoryCompare.pickCompareRevision', () =>
            compareWorkingWithRevision()
        ),
        vscode.commands.registerCommand('gitHistoryCompare.pickCompareTwoRevisions', () =>
            compareTwoRevisions()
        ),
        vscode.commands.registerCommand('gitHistoryCompare.openSidebar', openSidebar)
    );
}

export function deactivate(): void {
    core.disposeSnapshots();
}
