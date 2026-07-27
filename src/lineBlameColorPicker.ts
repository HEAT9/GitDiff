import * as vscode from 'vscode';

function getNonce(): string {
    let t = '';
    const c = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
        t += c.charAt(Math.floor(Math.random() * c.length));
    }
    return t;
}

/** 解析常见 rgba / #hex，失败则返回 undefined */
export function parseCssColor(input: string): { r: number; g: number; b: number; a: number } | undefined {
    const s = input.trim();
    if (!s) {
        return undefined;
    }
    const rgba =
        /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([0-9.]+)\s*)?\)$/i.exec(s);
    if (rgba) {
        const a = rgba[4] !== undefined ? Math.min(1, Math.max(0, parseFloat(rgba[4]))) : 1;
        return {
            r: clamp255(+rgba[1]),
            g: clamp255(+rgba[2]),
            b: clamp255(+rgba[3]),
            a,
        };
    }
    const hex = /^#?([0-9a-f]{6})$/i.exec(s);
    if (hex) {
        const n = parseInt(hex[1], 16);
        return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: 1 };
    }
    return undefined;
}

function clamp255(n: number): number {
    return Math.max(0, Math.min(255, Math.round(n)));
}

function readInitialRgba(cfg: vscode.WorkspaceConfiguration, key: 'lineBlame.inlineColor' | 'lineBlame.inlineBackgroundColor'): {
    r: number;
    g: number;
    b: number;
    a: number;
} {
    const raw = cfg.get<string>(key, '')?.trim() ?? '';
    const p = parseCssColor(raw);
    if (p) {
        return p;
    }
    if (key === 'lineBlame.inlineColor') {
        return { r: 107, g: 114, b: 128, a: 0.88 };
    }
    return { r: 128, g: 128, b: 128, a: 0.1 };
}

function buildHtml(webview: vscode.Webview, nonce: string, fg: { r: number; g: number; b: number; a: number }, bg: {
    r: number;
    g: number;
    b: number;
    a: number;
}, bgEnabled: boolean): string {
    const csp = [
        `default-src 'none'`,
        `style-src ${webview.cspSource} 'unsafe-inline'`,
        `script-src 'nonce-${nonce}'`,
    ].join('; ');
    const embeddedInit = JSON.stringify({ fg, bg, bgEnabled }).replace(/</g, '\\u003c');
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>GitDiff 行 blame 颜色</title>
  <style>
    * { box-sizing: border-box; }
    body {
      padding: 16px 20px 24px;
      font-family: var(--vscode-font-family);
      font-size: 13px;
      color: var(--vscode-editor-foreground);
      background: var(--vscode-editor-background);
    }
    h2 { font-size: 14px; font-weight: 600; margin: 18px 0 10px; border-bottom: 1px solid var(--vscode-widget-border); padding-bottom: 6px; }
    h2:first-of-type { margin-top: 0; }
    .row { display: flex; align-items: center; gap: 12px; margin: 8px 0; }
    .row label { width: 52px; flex-shrink: 0; color: var(--vscode-descriptionForeground); }
    input[type="range"] { flex: 1; min-width: 120px; height: 20px; }
    .val { width: 44px; text-align: right; font-variant-numeric: tabular-nums; color: var(--vscode-descriptionForeground); }
    .preview {
      margin-top: 10px; padding: 10px 12px; border-radius: 6px;
      background: var(--vscode-editor-inactiveSelectionBackground);
      border: 1px solid var(--vscode-widget-border);
      font-style: italic;
    }
    .sv {
      width: 100%; height: 160px; border-radius: 6px; border: 1px solid var(--vscode-widget-border);
      cursor: crosshair; touch-action: none; margin: 8px 0 4px;
    }
    .hue {
      width: 100%; height: 14px; border-radius: 6px; border: 1px solid var(--vscode-widget-border);
      cursor: pointer; margin: 4px 0 12px;
      background: linear-gradient(to right,
        hsl(0,100%,50%), hsl(60,100%,50%), hsl(120,100%,50%), hsl(180,100%,50%),
        hsl(240,100%,50%), hsl(300,100%,50%), hsl(360,100%,50%));
    }
    .btns { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 20px; }
    button {
      padding: 8px 16px; cursor: pointer;
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none; border-radius: 4px; font-size: 13px;
    }
    button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
    .hint { color: var(--vscode-descriptionForeground); font-size: 12px; margin-top: 6px; line-height: 1.45; }
    .chk { display: flex; align-items: center; gap: 8px; margin: 10px 0; }
  </style>
</head>
<body>
  <p class="hint">在下方<strong>色域</strong>点选饱和度/明度，拖动<strong>色相条</strong>与<strong>透明度</strong>横杆；与 Windows 调色类似。预览为行尾 blame 示例。</p>

  <h2>文字颜色</h2>
  <div class="row"><label>色相</label><input type="range" id="fgH" min="0" max="360" value="210" /><span class="val" id="fgHv">210</span></div>
  <canvas class="sv" id="fgSv" width="320" height="160"></canvas>
  <div class="row"><label>透明</label><input type="range" id="fgA" min="0" max="100" value="88" /><span class="val" id="fgAv">88%</span></div>
  <div class="preview" id="fgPreview"> Zhang San · 3d ago · a1b2c3d4</div>

  <h2>背景（可选）</h2>
  <div class="chk"><input type="checkbox" id="bgOn" /><label for="bgOn" style="width:auto">启用行尾背景色</label></div>
  <div class="row"><label>色相</label><input type="range" id="bgH" min="0" max="360" value="0" /><span class="val" id="bgHv">0</span></div>
  <canvas class="sv" id="bgSv" width="320" height="160"></canvas>
  <div class="row"><label>透明</label><input type="range" id="bgA" min="0" max="100" value="10" /><span class="val" id="bgAv">10%</span></div>
  <div class="preview" id="bgPreview">（背景预览区域）</div>

  <div class="btns">
    <button id="btnSave">保存到用户设置</button>
    <button class="secondary" id="btnWs">保存到工作区</button>
    <button class="secondary" id="btnReset">恢复默认</button>
  </div>
  <p class="hint">「恢复默认」会清空自定义颜色，行尾将跟随主题 descriptionForeground，且无背景。</p>

  <script nonce="${nonce}">
  (function() {
    const vscode = acquireVsCodeApi();
    const init = ${embeddedInit};

    function hslToRgb(h, s, l) {
      s /= 100; l /= 100;
      const c = (1 - Math.abs(2 * l - 1)) * s;
      const x = c * (1 - Math.abs((h / 60) % 2 - 1));
      const m = l - c / 2;
      let rp = 0, gp = 0, bp = 0;
      if (h < 60) { rp = c; gp = x; }
      else if (h < 120) { rp = x; gp = c; }
      else if (h < 180) { gp = c; bp = x; }
      else if (h < 240) { gp = x; bp = c; }
      else if (h < 300) { rp = x; bp = c; }
      else { rp = c; bp = x; }
      return {
        r: Math.round((rp + m) * 255),
        g: Math.round((gp + m) * 255),
        b: Math.round((bp + m) * 255)
      };
    }
    function rgbToHsl(r, g, b) {
      r /= 255; g /= 255; b /= 255;
      const max = Math.max(r, g, b), min = Math.min(r, g, b);
      let h = 0, s = 0;
      const l = (max + min) / 2;
      const d = max - min;
      if (d > 1e-6) {
        s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
        switch (max) {
          case r: h = ((g - b) / d + (g < b ? 6 : 0)); break;
          case g: h = (b - r) / d + 2; break;
          default: h = (r - g) / d + 4;
        }
        h *= 60;
      }
      return { h: Math.round(h) % 360, s: Math.round(s * 100), l: Math.round(l * 100) };
    }

    const state = {
      fg: { h: 210, s: 10, l: 52, a: init.fg.a },
      bg: { h: 0, s: 0, l: 50, a: init.bg.a },
      bgOn: init.bgEnabled
    };
    const ih = rgbToHsl(init.fg.r, init.fg.g, init.fg.b);
    state.fg.h = ih.h; state.fg.s = ih.s; state.fg.l = ih.l;
    const ib = rgbToHsl(init.bg.r, init.bg.g, init.bg.b);
    state.bg.h = ib.h; state.bg.s = ib.s; state.bg.l = ib.l;

    const fgSv = document.getElementById('fgSv');
    const bgSv = document.getElementById('bgSv');
    const fgH = document.getElementById('fgH');
    const bgH = document.getElementById('bgH');
    const fgA = document.getElementById('fgA');
    const bgA = document.getElementById('bgA');
    const bgOn = document.getElementById('bgOn');

    function drawSv(canvas, h) {
      const ctx = canvas.getContext('2d');
      const w = canvas.width, ht = canvas.height;
      const wM = Math.max(1, w - 1);
      const hM = Math.max(1, ht - 1);
      const img = ctx.createImageData(w, ht);
      for (let y = 0; y < ht; y++) {
        const l = 100 - (y / hM) * 100;
        for (let x = 0; x < w; x++) {
          const s = (x / wM) * 100;
          const { r, g, b } = hslToRgb(h, s, l);
          const i = (y * w + x) * 4;
          img.data[i] = r; img.data[i + 1] = g; img.data[i + 2] = b; img.data[i + 3] = 255;
        }
      }
      ctx.putImageData(img, 0, 0);
    }

    function fgRgba() {
      const { r, g, b } = hslToRgb(state.fg.h, state.fg.s, state.fg.l);
      const a = (+fgA.value) / 100;
      return { r, g, b, a };
    }
    function bgRgba() {
      const { r, g, b } = hslToRgb(state.bg.h, state.bg.s, state.bg.l);
      const a = (+bgA.value) / 100;
      return { r, g, b, a };
    }
    function fmtRgba(o) {
      const rr = Math.round(o.r), gg = Math.round(o.g), bb = Math.round(o.b);
      const aa = Math.round(o.a * 1000) / 1000;
      return 'rgba(' + rr + ',' + gg + ',' + bb + ',' + aa + ')';
    }

    function paintFgMarker() {
      const ctx = fgSv.getContext('2d');
      drawSv(fgSv, +fgH.value);
      const w = fgSv.width, ht = fgSv.height;
      const wM = Math.max(1, w - 1);
      const hM = Math.max(1, ht - 1);
      const mx = (state.fg.s / 100) * wM;
      const my = (1 - state.fg.l / 100) * hM;
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(mx, my, 6, 0, 6.28); ctx.stroke();
      ctx.strokeStyle = '#000';
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(mx, my, 6, 0, 6.28); ctx.stroke();
    }
    function paintBgMarker() {
      const ctx = bgSv.getContext('2d');
      drawSv(bgSv, +bgH.value);
      const w = bgSv.width, ht = bgSv.height;
      const wM = Math.max(1, w - 1);
      const hM = Math.max(1, ht - 1);
      const mx = (state.bg.s / 100) * wM;
      const my = (1 - state.bg.l / 100) * hM;
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(mx, my, 6, 0, 6.28); ctx.stroke();
      ctx.strokeStyle = '#000';
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(mx, my, 6, 0, 6.28); ctx.stroke();
    }

    fgH.value = state.fg.h;
    bgH.value = state.bg.h;
    fgA.value = String(Math.round(init.fg.a * 100));
    bgA.value = String(Math.round(init.bg.a * 100));
    bgOn.checked = init.bgEnabled;

    document.getElementById('fgHv').textContent = fgH.value;
    document.getElementById('bgHv').textContent = bgH.value;
    document.getElementById('fgAv').textContent = fgA.value + '%';
    document.getElementById('bgAv').textContent = bgA.value + '%';

    function refresh() {
      state.fg.h = +fgH.value;
      state.bg.h = +bgH.value;
      document.getElementById('fgHv').textContent = fgH.value;
      document.getElementById('bgHv').textContent = bgH.value;
      document.getElementById('fgAv').textContent = fgA.value + '%';
      document.getElementById('bgAv').textContent = bgA.value + '%';
      paintFgMarker();
      paintBgMarker();
      const f = fgRgba();
      const b = bgRgba();
      const fp = document.getElementById('fgPreview');
      fp.style.color = fmtRgba(f);
      fp.style.background = bgOn.checked ? fmtRgba(b) : 'transparent';
      const bp = document.getElementById('bgPreview');
      bp.style.background = fmtRgba(b);
      bp.style.color = f.r + f.g + f.b > 400 ? '#111' : '#eee';
    }

    function pickSv(canvas, which, e) {
      const rect = canvas.getBoundingClientRect();
      const x = Math.max(0, Math.min(canvas.width - 1, (e.clientX - rect.left) * (canvas.width / rect.width)));
      const y = Math.max(0, Math.min(canvas.height - 1, (e.clientY - rect.top) * (canvas.height / rect.height)));
      const wM = Math.max(1, canvas.width - 1);
      const hM = Math.max(1, canvas.height - 1);
      state[which].s = (x / wM) * 100;
      state[which].l = 100 - (y / hM) * 100;
      refresh();
    }
    let drag = null;
    fgSv.addEventListener('mousedown', function(e) { drag = { c: fgSv, w: 'fg', e }; pickSv(fgSv, 'fg', e); });
    bgSv.addEventListener('mousedown', function(e) { drag = { c: bgSv, w: 'bg', e }; pickSv(bgSv, 'bg', e); });
    window.addEventListener('mousemove', function(e) {
      if (!drag) return;
      pickSv(drag.c, drag.w, e);
    });
    window.addEventListener('mouseup', function() { drag = null; });

    fgH.addEventListener('input', function() { refresh(); });
    bgH.addEventListener('input', function() { refresh(); });
    fgA.addEventListener('input', refresh);
    bgA.addEventListener('input', refresh);
    bgOn.addEventListener('change', refresh);

    document.getElementById('btnSave').addEventListener('click', function() {
      const f = fgRgba();
      const b = bgRgba();
      vscode.postMessage({
        type: 'apply',
        target: 'global',
        fg: fmtRgba(f),
        bg: bgOn.checked ? fmtRgba(b) : ''
      });
    });
    document.getElementById('btnWs').addEventListener('click', function() {
      const f = fgRgba();
      const b = bgRgba();
      vscode.postMessage({
        type: 'apply',
        target: 'workspace',
        fg: fmtRgba(f),
        bg: bgOn.checked ? fmtRgba(b) : ''
      });
    });
    document.getElementById('btnReset').addEventListener('click', function() {
      vscode.postMessage({ type: 'reset' });
    });

    refresh();
  })();
  </script>
</body>
</html>`;
}

export function registerLineBlameColorPicker(context: vscode.ExtensionContext): vscode.Disposable {
    return vscode.commands.registerCommand('gitdiff.openLineBlameColorUI', () => {
        const cfg = vscode.workspace.getConfiguration('gitdiff');
        const fg = readInitialRgba(cfg, 'lineBlame.inlineColor');
        const bg = readInitialRgba(cfg, 'lineBlame.inlineBackgroundColor');
        const bgRaw = cfg.get<string>('lineBlame.inlineBackgroundColor', '')?.trim() ?? '';
        const bgEnabled = bgRaw.length > 0;

        const panel = vscode.window.createWebviewPanel(
            'gitdiffLineBlameColor',
            'GitDiff：行 blame 颜色',
            vscode.ViewColumn.One,
            { enableScripts: true, retainContextWhenHidden: true }
        );
        const nonce = getNonce();
        panel.webview.html = buildHtml(panel.webview, nonce, fg, bg, bgEnabled);

        const sub = panel.webview.onDidReceiveMessage(
            (msg: { type: string; target?: string; fg?: string; bg?: string }) => {
                const c = vscode.workspace.getConfiguration('gitdiff');
                const t =
                    msg.target === 'workspace'
                        ? vscode.ConfigurationTarget.Workspace
                        : vscode.ConfigurationTarget.Global;
                if (msg.type === 'apply' && msg.fg !== undefined) {
                    void c.update('lineBlame.inlineColor', msg.fg, t, false);
                    void c.update('lineBlame.inlineBackgroundColor', msg.bg ?? '', t, false);
                    void vscode.window.showInformationMessage(
                        msg.target === 'workspace'
                            ? '行 blame 颜色已写入工作区设置。'
                            : '行 blame 颜色已写入用户设置。'
                    );
                } else if (msg.type === 'reset') {
                    void c.update('lineBlame.inlineColor', '', vscode.ConfigurationTarget.Global, false);
                    void c.update('lineBlame.inlineBackgroundColor', '', vscode.ConfigurationTarget.Global, false);
                    void c.update('lineBlame.inlineColor', '', vscode.ConfigurationTarget.Workspace, false);
                    void c.update('lineBlame.inlineBackgroundColor', '', vscode.ConfigurationTarget.Workspace, false);
                    void vscode.window.showInformationMessage('已恢复默认（用户与工作区中的这两项均已清空）。');
                    panel.dispose();
                }
            },
            undefined
        );

        panel.onDidDispose(() => sub.dispose());
    });
}
