import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import * as core from './gitCompareCore';
import * as ops from './compareOperations';
import { WORKING_TREE_REF } from './compareOperations';
import { LOCALE_STORAGE_KEY, parseLocale, readLocale, webviewLabels, type Locale } from './i18n';

function fsPathsEquivalent(a: string, b: string): boolean {
    const na = path.normalize(a);
    const nb = path.normalize(b);
    if (na === nb) {
        return true;
    }
    if (process.platform === 'win32' && na.toLowerCase() === nb.toLowerCase()) {
        return true;
    }
    try {
        const resolve = fs.realpathSync.native ?? fs.realpathSync;
        const ra = resolve(na);
        const rb = resolve(nb);
        if (ra === rb) {
            return true;
        }
        if (process.platform === 'win32' && ra.toLowerCase() === rb.toLowerCase()) {
            return true;
        }
    } catch {
        /* 文件暂不存在等 */
    }
    return false;
}

type WebviewState = {
    effectivePath: string | null;
    pinnedPath: string | null;
    basename: string;
    relPath: string;
    repoLabel: string;
    commits: { id: string; subject: string; author: string; date: string }[];
    stats: { add: number; del: number; mod: number };
    /** 历史列表与快照比较是否显示「工作区（未提交）」：相对 HEAD 有改动时为 true（基于磁盘与索引） */
    showWorkingTreeInSnapshot: boolean;
    hint: string | null;
    locale: Locale;
    strings: Record<string, string>;
};

export class CompareSidebarViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewId = 'gitHistoryCompare.sidebar';

    private _view: vscode.WebviewView | undefined;
    private _pinnedFsPath: string | undefined;
    private _pushTimer: ReturnType<typeof setTimeout> | undefined;
    private _effFsWatcher: vscode.FileSystemWatcher | undefined;
    private _watchedEffPath: string | undefined;
    private _afterSavePushTimer: ReturnType<typeof setTimeout> | undefined;

    constructor(private readonly _ctx: vscode.ExtensionContext) {}

    resolveWebviewView(webviewView: vscode.WebviewView): void {
        this._view = webviewView;
        webviewView.webview.options = {
            enableScripts: true,
        };
        webviewView.webview.html = this._html();

        webviewView.webview.onDidReceiveMessage(
            async (msg: { type: string; locale?: string; ref?: string; left?: string; right?: string }) => {
                switch (msg.type) {
                    case 'mounted':
                    case 'refresh':
                        await this._pushState();
                        break;
                    case 'setLocale': {
                        const loc = parseLocale(msg.locale);
                        await this._ctx.globalState.update(LOCALE_STORAGE_KEY, loc);
                        await this._pushState();
                        break;
                    }
                    case 'pickFile': {
                        const locale = readLocale(this._ctx);
                        const L = webviewLabels(locale);
                        const picked = await vscode.window.showOpenDialog({
                            canSelectMany: false,
                            openLabel: L.chooseFileOpen,
                            filters: { [L.allFiles]: ['*'] },
                        });
                        const u = picked?.[0];
                        if (u?.scheme === 'file') {
                            this._pinnedFsPath = u.fsPath;
                            await this._pushState();
                        }
                        break;
                    }
                    case 'clearPin':
                        this._pinnedFsPath = undefined;
                        await this._pushState();
                        break;
                    case 'compareCommitVsParent': {
                        const p = this._effectivePath();
                        const locale = readLocale(this._ctx);
                        const L = webviewLabels(locale);
                        if (!p) {
                            void vscode.window.showWarningMessage(L.warnOpenFile);
                            return;
                        }
                        const r = await ops.opCompareCommitVsParent(p, msg.ref ?? '', locale);
                        await ops.showOpError(r, locale);
                        break;
                    }
                    case 'compareWorkingVsHead': {
                        const p = this._effectivePath();
                        const locale = readLocale(this._ctx);
                        const L = webviewLabels(locale);
                        if (!p) {
                            void vscode.window.showWarningMessage(L.warnOpenFile);
                            return;
                        }
                        const r = await ops.opCompareWithHead(p, locale);
                        await ops.showOpError(r, locale);
                        break;
                    }
                    case 'compareTwo': {
                        const p = this._effectivePath();
                        const locale = readLocale(this._ctx);
                        const L = webviewLabels(locale);
                        if (!p) {
                            void vscode.window.showWarningMessage(L.warnOpenFile);
                            return;
                        }
                        const r = await ops.opCompareTwoRefs(p, msg.left ?? '', msg.right ?? '', locale);
                        await ops.showOpError(r, locale);
                        break;
                    }
                    default:
                        break;
                }
            }
        );

        webviewView.onDidChangeVisibility(() => {
            if (webviewView.visible) {
                void this._pushState();
            }
        });

        void this._pushState();
    }

    public schedulePushState(): void {
        if (this._pushTimer) {
            clearTimeout(this._pushTimer);
        }
        this._pushTimer = setTimeout(() => {
            this._pushTimer = undefined;
            void this._pushState();
        }, 200);
    }

    private _effectivePath(): string | undefined {
        if (this._pinnedFsPath) {
            return this._pinnedFsPath;
        }
        const ed = vscode.window.activeTextEditor;
        if (ed?.document.uri.scheme === 'file') {
            return ed.document.uri.fsPath;
        }
        return undefined;
    }

    private async _buildState(): Promise<WebviewState> {
        const locale = readLocale(this._ctx);
        const str = webviewLabels(locale);
        const effective = this._effectivePath();
        if (!effective) {
            return {
                effectivePath: null,
                pinnedPath: this._pinnedFsPath ?? null,
                basename: '',
                relPath: '',
                repoLabel: '',
                commits: [],
                stats: { add: 0, del: 0, mod: 0 },
                showWorkingTreeInSnapshot: false,
                hint: str.hintOpen,
                locale,
                strings: str,
            };
        }
        const ctx = await core.getGitContext(effective, { silent: true });
        if (!ctx) {
            return {
                effectivePath: effective,
                pinnedPath: this._pinnedFsPath ?? null,
                basename: path.basename(effective),
                relPath: '',
                repoLabel: '',
                commits: [],
                stats: { add: 0, del: 0, mod: 0 },
                showWorkingTreeInSnapshot: false,
                hint: str.hintNotRepo,
                locale,
                strings: str,
            };
        }
        const commits = await core.fetchRecentCommits(ctx.gitRoot, ctx.relPath, 80);
        const stats = await core.fetchFileHistoryStats(ctx.gitRoot, ctx.relPath, 80);
        const showWorkingTreeInSnapshot = await core.hasUncommittedChanges(ctx.gitRoot, ctx.relPath);
        return {
            effectivePath: effective,
            pinnedPath: this._pinnedFsPath ?? null,
            basename: path.basename(effective),
            relPath: ctx.relPath,
            repoLabel: ctx.gitRoot,
            commits,
            stats,
            showWorkingTreeInSnapshot,
            hint: null,
            locale,
            strings: str,
        };
    }

    private async _pushState(): Promise<void> {
        if (!this._view) {
            return;
        }
        const s = await this._buildState();
        this._syncEffFileWatcher(s.effectivePath);
        void this._view.webview.postMessage({ type: 'state', payload: s });
    }

    /** 当前关注文件在磁盘上被改写（含外部/git 还原）时刷新侧栏 Git 状态 */
    private _syncEffFileWatcher(effectivePath: string | null): void {
        const eff = effectivePath ?? undefined;
        if (this._watchedEffPath === eff) {
            return;
        }
        this._effFsWatcher?.dispose();
        this._effFsWatcher = undefined;
        this._watchedEffPath = eff;
        if (!eff) {
            return;
        }
        try {
            const w = vscode.workspace.createFileSystemWatcher(
                new vscode.RelativePattern(vscode.Uri.file(path.dirname(eff)), path.basename(eff))
            );
            const bump = () => this.schedulePushState();
            w.onDidChange(bump);
            w.onDidCreate(bump);
            w.onDidDelete(bump);
            this._effFsWatcher = w;
        } catch {
            /* RelativePattern 在极少数路径下可能失败，忽略即可 */
        }
    }

    /** 保存/编辑事件里的路径可能与 `_effectivePath()` 在符号链接、规范化、盘符大小写上不一致 */
    private _isEventForEffectivePath(uri: vscode.Uri): boolean {
        if (uri.scheme !== 'file') {
            return false;
        }
        const eff = this._effectivePath();
        return !!eff && fsPathsEquivalent(eff, uri.fsPath);
    }

    /** 保存后稍晚再拉 Git 状态，避免编辑器刚落盘时 git 仍读到旧内容 */
    private _schedulePushStateAfterSave(): void {
        if (this._afterSavePushTimer) {
            clearTimeout(this._afterSavePushTimer);
        }
        this._afterSavePushTimer = setTimeout(() => {
            this._afterSavePushTimer = undefined;
            void this._pushState();
        }, 80);
    }

    registerWindowListeners(context: vscode.ExtensionContext): void {
        context.subscriptions.push(
            vscode.window.onDidChangeActiveTextEditor(() => this.schedulePushState()),
            vscode.workspace.onDidChangeTextDocument((e) => {
                if (this._isEventForEffectivePath(e.document.uri)) {
                    this.schedulePushState();
                }
            }),
            vscode.workspace.onDidSaveTextDocument((doc) => {
                if (this._isEventForEffectivePath(doc.uri)) {
                    this._schedulePushStateAfterSave();
                }
            }),
            new vscode.Disposable(() => {
                if (this._afterSavePushTimer) {
                    clearTimeout(this._afterSavePushTimer);
                    this._afterSavePushTimer = undefined;
                }
                this._effFsWatcher?.dispose();
                this._effFsWatcher = undefined;
                this._watchedEffPath = undefined;
            })
        );
    }

    private _html(): string {
        const csp = [
            "default-src 'none'",
            "style-src 'unsafe-inline'",
            "script-src 'unsafe-inline'",
        ].join('; ');
        return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <style>
    :root {
      --bg: var(--vscode-sideBar-background);
      --fg: var(--vscode-sideBar-foreground);
      --muted: var(--vscode-descriptionForeground);
      --border: var(--vscode-widget-border, rgba(127,127,127,.28));
      --btn-bg: var(--vscode-button-background);
      --btn-fg: var(--vscode-button-foreground);
      --link: var(--vscode-textLink-foreground);
    }
    body { margin: 0; padding: 10px 12px 16px; font-size: 13px; line-height: 1.45; color: var(--fg); background: var(--bg); font-family: var(--vscode-font-family); }
    h1 { font-size: 12px; font-weight: 600; margin: 0 0 8px; color: var(--muted); letter-spacing: .02em; }
    .path { word-break: break-all; font-family: var(--vscode-editor-font-family); font-size: 12px; margin-bottom: 6px; }
    .meta { color: var(--muted); font-size: 11px; margin-bottom: 8px; }
    .row { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 8px; align-items: center; }
    button {
      border: none; border-radius: 2px; cursor: pointer;
      padding: 6px 10px; font-size: 12px;
      background: var(--btn-bg); color: var(--btn-fg);
    }
    button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
    button.small { padding: 4px 8px; font-size: 11px; }
    button.lang-on { outline: 2px solid var(--link); outline-offset: 1px; }
    .section { border-top: 1px solid var(--border); padding-top: 12px; margin-top: 12px; }
    .hint { color: var(--muted); font-size: 12px; margin: 6px 0 10px; line-height: 1.45; }
    .stats { color: var(--muted); font-size: 11px; margin: -2px 0 8px; line-height: 1.4; }
    .commits { max-height: 240px; overflow-y: auto; border: 1px solid var(--border); border-radius: 2px; padding: 2px 0; }
    .commit { padding: 5px 8px; cursor: pointer; font-size: 11px; display: flex; gap: 8px; align-items: flex-start; }
    .commit:hover { background: var(--vscode-list-hoverBackground); }
    .commit.sel { background: var(--vscode-list-inactiveSelectionBackground); outline: 1px solid var(--link); }
    .commit-id { flex: 0 0 58px; color: var(--link); font-family: var(--vscode-editor-font-family); }
    .commit-sub { color: var(--muted); flex: 1; }
    .pill { display: inline-block; padding: 2px 6px; border-radius: 2px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); font-size: 10px; margin-left: 4px; vertical-align: middle; }
    .cols { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; align-items: start; }
    .col h2 { font-size: 11px; margin: 0 0 4px; color: var(--muted); font-weight: 600; }
    .col .commits { max-height: 200px; }
    .sel-hint { font-size: 10px; color: var(--muted); margin-top: 4px; min-height: 2em; word-break: break-all; }
    .lang-label { font-size: 11px; color: var(--muted); margin-right: 4px; }
  </style>
</head>
<body>
  <div class="row" style="margin-bottom:10px">
    <span class="lang-label" id="lblLang">语言</span>
    <button type="button" class="secondary small" id="btnLangZh">中文</button>
    <button type="button" class="secondary small" id="btnLangEn">English</button>
  </div>

  <h1 id="tFile">当前文件</h1>
  <div id="pathLine" class="path">—</div>
  <div id="metaLine" class="meta"></div>
  <div class="row">
    <button type="button" class="secondary small" id="btnRefresh">刷新</button>
    <button type="button" class="secondary small" id="btnPick">改选文件…</button>
    <button type="button" class="secondary small" id="btnClearPin" style="display:none">跟活动编辑器</button>
  </div>
  <p id="hint" class="hint" style="display:none"></p>

  <div class="section">
    <h1><span id="tHist">本文件修改历史</span> <span class="pill" id="pillHist">0</span> <span class="pill" id="pillHistUnit">条</span></h1>
    <p id="histHint" class="hint"></p>
    <p id="histStats" class="stats"></p>
    <div id="commitsMain" class="commits"></div>
  </div>

  <div class="section">
    <h1 id="tTwo">两个历史版本</h1>
    <p id="twoHint" class="hint"></p>
    <div class="cols">
      <div class="col">
        <h2 id="tColA">左侧</h2>
        <div id="commitsLeft" class="commits"></div>
        <div id="selLeftHint" class="sel-hint"></div>
      </div>
      <div class="col">
        <h2 id="tColB">右侧</h2>
        <div id="commitsRight" class="commits"></div>
        <div id="selRightHint" class="sel-hint"></div>
      </div>
    </div>
    <div class="row" style="margin-top:10px">
      <button type="button" id="btnTwo">比较</button>
    </div>
  </div>

  <script>
    const vscode = acquireVsCodeApi();
    var selLeft = '';
    var selRight = '';

    function el(id) { return document.getElementById(id); }

    function applyStrings(t) {
      el('lblLang').textContent = t.lang;
      el('btnLangZh').textContent = t.zh;
      el('btnLangEn').textContent = t.en;
      el('tFile').textContent = t.fileTitle;
      el('btnRefresh').textContent = t.refresh;
      el('btnPick').textContent = t.pickFile;
      el('btnClearPin').textContent = t.followEditor;
      el('tHist').textContent = t.historyTitle;
      el('pillHistUnit').textContent = t.count;
      el('histHint').textContent = t.historyHint;
      el('tTwo').textContent = t.twoTitle;
      el('twoHint').textContent = t.twoHint;
      el('tColA').textContent = t.colA;
      el('tColB').textContent = t.colB;
      el('btnTwo').textContent = t.btnTwo;
    }

    function renderMainList(commits, showWork) {
      var box = el('commitsMain');
      box.innerHTML = '';
      var t = window.__labels || {};
      if (showWork) {
        var wr = document.createElement('div');
        wr.className = 'commit';
        wr.title = t.workingTree || 'Working tree (uncommitted)';
        var wsid = document.createElement('span'); wsid.className = 'commit-id'; wsid.textContent = 'WORK';
        var wss = document.createElement('span'); wss.className = 'commit-sub'; wss.textContent = t.workingTree || 'Working tree (uncommitted)';
        wr.appendChild(wsid); wr.appendChild(wss);
        wr.addEventListener('click', function() {
          vscode.postMessage({ type: 'compareWorkingVsHead' });
        });
        box.appendChild(wr);
      }
      (commits || []).forEach(function(c) {
        var row = document.createElement('div');
        row.className = 'commit';
        var hover = (t.hoverMeta || 'Author: {author} | Date: {date}')
          .replace('{author}', c.author || '')
          .replace('{date}', c.date || '');
        row.title = hover;
        var sid = document.createElement('span'); sid.className = 'commit-id'; sid.textContent = c.id;
        var ss = document.createElement('span'); ss.className = 'commit-sub'; ss.textContent = c.subject || '';
        row.appendChild(sid); row.appendChild(ss);
        row.addEventListener('click', function() {
          vscode.postMessage({ type: 'compareCommitVsParent', ref: c.id });
        });
        box.appendChild(row);
      });
    }

    function renderSideList(container, commits, col, onPick, t, showWork) {
      container.innerHTML = '';
      if ((col === 'L' || col === 'R') && showWork) {
        var wr = document.createElement('div');
        wr.className = 'commit';
        wr.title = t.workingTree || 'Working tree (uncommitted)';
        var wsid = document.createElement('span'); wsid.className = 'commit-id'; wsid.textContent = 'WORK';
        var wss = document.createElement('span'); wss.className = 'commit-sub'; wss.textContent = t.workingTree || 'Working tree (uncommitted)';
        wr.appendChild(wsid); wr.appendChild(wss);
        wr.addEventListener('click', function() {
          Array.prototype.forEach.call(container.querySelectorAll('.commit'), function(x) { x.classList.remove('sel'); });
          wr.classList.add('sel');
          onPick('__WORKING_TREE__');
        });
        if (col === 'L' && selLeft === '__WORKING_TREE__') wr.classList.add('sel');
        if (col === 'R' && selRight === '__WORKING_TREE__') wr.classList.add('sel');
        container.appendChild(wr);
      }
      (commits || []).forEach(function(c) {
        var row = document.createElement('div');
        row.className = 'commit';
        var hover = (t.hoverMeta || 'Author: {author} | Date: {date}')
          .replace('{author}', c.author || '')
          .replace('{date}', c.date || '');
        row.title = hover;
        var sid = document.createElement('span'); sid.className = 'commit-id'; sid.textContent = c.id;
        var ss = document.createElement('span'); ss.className = 'commit-sub'; ss.textContent = c.subject || '';
        row.appendChild(sid); row.appendChild(ss);
        row.addEventListener('click', function() {
          Array.prototype.forEach.call(container.querySelectorAll('.commit'), function(x) { x.classList.remove('sel'); });
          row.classList.add('sel');
          onPick(c.id);
        });
        if (col === 'L' && selLeft === c.id) row.classList.add('sel');
        if (col === 'R' && selRight === c.id) row.classList.add('sel');
        container.appendChild(row);
      });
    }

    function setState(s) {
      var t = s.strings || {};
      window.__labels = t;
      applyStrings(t);
      document.documentElement.lang = s.locale === 'en' ? 'en' : 'zh-CN';

      el('btnLangZh').className = 'secondary small' + (s.locale === 'zh' ? ' lang-on' : '');
      el('btnLangEn').className = 'secondary small' + (s.locale === 'en' ? ' lang-on' : '');

      var pathLine = el('pathLine');
      var metaLine = el('metaLine');
      var hint = el('hint');
      var btnClear = el('btnClearPin');
      var pillHist = el('pillHist');
      var histStats = el('histStats');

      selLeft = ''; selRight = '';
      el('selLeftHint').textContent = t.none;
      el('selRightHint').textContent = t.none;

      if (!s.effectivePath) {
        pathLine.textContent = t.noFile;
        metaLine.textContent = '';
        hint.style.display = s.hint ? 'block' : 'none';
        hint.textContent = s.hint || '';
        btnClear.style.display = 'none';
        pillHist.textContent = '0';
        el('commitsMain').innerHTML = '';
        el('commitsLeft').innerHTML = '';
        el('commitsRight').innerHTML = '';
        histStats.textContent = '';
        return;
      }

      pathLine.textContent = s.basename;
      metaLine.textContent = (s.relPath ? s.relPath + ' · ' : '') + (s.pinnedPath ? t.pinFixed : t.pinFollow);
      hint.style.display = s.hint ? 'block' : 'none';
      hint.textContent = s.hint || '';
      btnClear.style.display = s.pinnedPath ? 'inline-block' : 'none';

      var sw = !!s.showWorkingTreeInSnapshot;
      var n = (s.commits || []).length + (sw ? 1 : 0);
      pillHist.textContent = String(n);
      histStats.textContent = (t.historyStats || 'Commits: {count} · Added: {add} · Deleted: {del} · Modified: {mod}')
        .replace('{count}', String((s.commits || []).length))
        .replace('{add}', String((s.stats && s.stats.add) || 0))
        .replace('{del}', String((s.stats && s.stats.del) || 0))
        .replace('{mod}', String((s.stats && s.stats.mod) || 0));

      renderMainList(s.commits, sw);
      renderSideList(el('commitsLeft'), s.commits, 'L', function(id) {
        selLeft = id;
        el('selLeftHint').textContent = t.picked + (id === '__WORKING_TREE__' ? (t.workingTree || 'Working tree') : id);
      }, t, sw);
      renderSideList(el('commitsRight'), s.commits, 'R', function(id) {
        selRight = id;
        el('selRightHint').textContent = t.picked + (id === '__WORKING_TREE__' ? (t.workingTree || 'Working tree') : id);
      }, t, sw);
    }

    window.addEventListener('message', function(event) {
      var msg = event.data;
      if (msg && msg.type === 'state' && msg.payload) {
        setState(msg.payload);
      }
    });

    el('btnLangZh').addEventListener('click', function() { vscode.postMessage({ type: 'setLocale', locale: 'zh' }); });
    el('btnLangEn').addEventListener('click', function() { vscode.postMessage({ type: 'setLocale', locale: 'en' }); });
    el('btnPick').addEventListener('click', function() { vscode.postMessage({ type: 'pickFile' }); });
    el('btnClearPin').addEventListener('click', function() { vscode.postMessage({ type: 'clearPin' }); });
    el('btnRefresh').addEventListener('click', function() { vscode.postMessage({ type: 'refresh' }); });
    el('btnTwo').addEventListener('click', function() {
      vscode.postMessage({ type: 'compareTwo', left: selLeft, right: selRight });
    });

    vscode.postMessage({ type: 'mounted' });
  </script>
</body>
</html>`;
    }
}
